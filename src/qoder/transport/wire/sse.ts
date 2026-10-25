/** Decode Qoder's outer SSE envelope and inner model chunks. */

import {
  ToolCallId,
  EMPTY_RESPONSE_CODE,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { QoderLlmError, qoderHttpError } from '../../errors.ts'
import { QoderThinkingParser, type QoderContentSegment } from './thinking.ts'
import type { QoderInnerChunk, QoderSseEnvelope } from './wire-types.ts'

const doneMarker = '[DONE]'
export const defaultMaxSseBufferChars = 2 * 1024 * 1024

export interface QoderSseOptions {
  onActivity?: () => void
  maxBufferChars?: number
  /** One-line diagnostic sink; reports a tolerated damaged tool-call argument block. */
  onDiag?: (message: string) => void
  /**
   * Called once per notice: the upstream filtered the reply, or named a finish reason this
   * client does not know. Both end as a normal stop, so these are the only user-visible
   * traces that the answer may be incomplete.
   */
  onNotice?: (notice: QoderSseNotice) => void
}

interface TextualBlockState {
  type: 'text' | 'reasoning'
  index: number
  text: string
}

interface ToolCallState {
  id: string
  name: string
  arguments: string
  emittedArguments: number
  blockIndex?: number
}

type SuccessfulFinishKind = 'stop' | 'tool-calls' | 'max-tokens'

function malformed(message: string): QoderLlmError {
  return new QoderLlmError(message, 'MALFORMED_RESPONSE')
}

/**
 * Describe a completed call's arguments for the diagnostic log, never for control flow.
 *
 * The official client does not judge argument text at the transport layer: it concatenates
 * the deltas, tries `JSON.parse` once at block end, and on failure hands the caller an empty
 * input plus the raw string. The tool layer then answers `Error: Invalid parameters provided`
 * as a tool result, so the model re-emits the call and the turn survives. Every "damaged
 * shape" this file used to classify was a case of the transport deciding to die where the
 * client upstream of it would not, so the judgment is gone; what remains is a log line.
 */
function argumentsIssue(text: string): string | undefined {
  if (!text.trim()) return undefined
  try {
    JSON.parse(text)
    return undefined
  } catch {
    return `${text.length} chars, not valid JSON`
  }
}

function parseEnvelope(rawData: string): QoderSseEnvelope {
  let value: unknown
  try {
    value = JSON.parse(rawData)
  } catch {
    throw malformed('Malformed outer SSE JSON payload received from Qoder.')
  }
  if (value === null || typeof value !== 'object') throw malformed('Malformed outer SSE envelope received from Qoder.')
  const envelope = value as QoderSseEnvelope
  if (envelope.statusCodeValue !== undefined && typeof envelope.statusCodeValue !== 'number') {
    throw malformed('Qoder SSE envelope has an invalid status code.')
  }
  if (envelope.statusCodeValue !== undefined
    && (!Number.isInteger(envelope.statusCodeValue)
      || envelope.statusCodeValue < 100
      || envelope.statusCodeValue > 599)) {
    throw malformed('Qoder SSE envelope has an invalid status code.')
  }
  if (envelope.statusCodeValue !== undefined && envelope.statusCodeValue !== 200) {
    const status = envelope.statusCodeValue
    // Forward the envelope body into the message: a rejected chat arrives as a 200
    // SSE whose first envelope carries the reason. The body is also handed to the
    // classifier, so a 401/403 carrying queue markers reads as a throttle.
    throw qoderHttpError(
      envelope.body
        ? `Qoder service returned upstream error status ${status}: ${envelope.body}`
        : `Qoder service returned upstream error status ${status}.`,
      { status },
      envelope.body,
    )
  }
  if (envelope.body !== undefined && typeof envelope.body !== 'string') {
    throw malformed('Qoder SSE envelope has an invalid model body.')
  }
  return envelope
}

function parseInner(body: string): QoderInnerChunk {
  try {
    const value = JSON.parse(body) as unknown
    if (value === null || typeof value !== 'object') throw new Error('not an object')
    return value as QoderInnerChunk
  } catch {
    throw malformed('Malformed inner model payload received from Qoder.')
  }
}

function tokenUsage(innerChunk: QoderInnerChunk): TokenUsage | undefined {
  if (!innerChunk.usage) return undefined
  const usage = innerChunk.usage
  const promptTokens = usage.prompt_tokens ?? 0
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
  const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens ?? 0
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens),
    outputTokens: usage.completion_tokens ?? 0,
    ...cacheReadTokens > 0 ? { cacheReadTokens } : {},
    ...cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
  }
}

/**
 * The finish reasons the official client treats as a filtered reply.
 *
 * `qodercli` classifies `content_filter`, `refusal` and `sensitive` as a refusal stop
 * reason (`Ffo` in its bundle). The harness has no refusal kind, so the caller reports a
 * normal stop plus a visible notice; what it must NOT do is let a filtered response carry
 * executable tool calls, which is why {@link parseQoderSse} withholds them.
 */
const filteredFinishReasons: ReadonlySet<string> = new Set(['content_filter', 'refusal', 'sensitive'])

/** What a caller may need to tell the user about how one stream ended. */
export type QoderSseNotice = { kind: 'filtered', reason: string }

/**
 * Map one upstream finish reason onto the harness vocabulary.
 *
 * A filtered reply becomes `stop`: the official client would call it `refusal`, which the
 * harness cannot express, and the caller adds a visible notice instead. An unrecognised
 * reason fails the stream as non-retryable, exactly as the official chat client does
 * (`UnsupportedFinishReasonError`, `retryable = false`); guessing a normal stop there would
 * hide a vocabulary drift as a complete answer.
 */
function finishKind(
  value: string | null | undefined,
  onDiag?: (message: string) => void,
): SuccessfulFinishKind | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'stop') return 'stop'
  if (value === 'length') return 'max-tokens'
  if (value === 'tool_calls' || value === 'toolUse' || value === 'function_call') return 'tool-calls'
  if (filteredFinishReasons.has(value)) {
    onDiag?.(`upstream filtered the response (${value}); reporting a normal stop`)
    return 'stop'
  }
  // `UNSUPPORTED_` is the prefix the host classifies as a non-retryable client failure, so
  // this surfaces as a clear error instead of a retried 5xx.
  throw new QoderLlmError(`Qoder returned unsupported finish reason "${value}".`, 'UNSUPPORTED_FINISH_REASON')
}

export async function* parseQoderSse(
  stream: ReadableStream<Uint8Array>,
  options: QoderSseOptions = {},
): AsyncGenerator<StreamChunk> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const thinkingParser = new QoderThinkingParser()
  const toolCalls = new Map<number, ToolCallState>()
  let buffer = ''
  let sourceEnded = false
  let sawDone = false
  let nextBlockIndex = 0
  let activeTextual: TextualBlockState | undefined
  let pendingUsage: TokenUsage | undefined
  let terminalKind: SuccessfulFinishKind = 'stop'
  let sawContent = false
  // The notices are user-visible rows, so report each at most once per stream even when
  // the upstream repeats the reason on several choices.
  let filteredReason: string | undefined
  const maxBufferChars = options.maxBufferChars ?? defaultMaxSseBufferChars

  const closeTextual = (): StreamChunk[] => {
    if (activeTextual === undefined) return []
    const state = activeTextual
    activeTextual = undefined
    return [{
      type: 'block-end',
      index: state.index,
      block: state.type === 'text'
        ? { type: 'text', text: state.text }
        : { type: 'reasoning', text: state.text },
    }]
  }

  const appendSegment = (segment: QoderContentSegment): StreamChunk[] => {
    if (!segment.text) return []
    const chunks: StreamChunk[] = []
    sawContent = true
    if (activeTextual?.type !== segment.type) {
      chunks.push(...closeTextual())
      activeTextual = { type: segment.type, index: nextBlockIndex++, text: '' }
      chunks.push({ type: 'block-start', index: activeTextual.index, blockType: segment.type })
    }
    activeTextual.text += segment.text
    chunks.push(segment.type === 'text'
      ? { type: 'text-delta', index: activeTextual.index, text: segment.text }
      : { type: 'reasoning-delta', index: activeTextual.index, text: segment.text })
    return chunks
  }

  const openToolCall = (state: ToolCallState): StreamChunk[] => {
    if (!state.id || state.blockIndex !== undefined) return []
    const chunks = closeTextual()
    state.blockIndex = nextBlockIndex++
    sawContent = true
    chunks.push({ type: 'block-start', index: state.blockIndex, blockType: 'tool-call' })
    const argumentsDelta = state.arguments.slice(state.emittedArguments)
    state.emittedArguments = state.arguments.length
    chunks.push({
      type: 'tool-call-delta',
      index: state.blockIndex,
      id: ToolCallId(state.id),
      ...state.name ? { name: state.name } : {},
      argumentsDelta,
    })
    return chunks
  }

  try {
    while (!sourceEnded && !sawDone) {
      const { done, value } = await reader.read()
      if (done) {
        sourceEnded = true
        buffer += decoder.decode()
        if (buffer.length > 0 && !buffer.endsWith('\n')) buffer += '\n'
      } else {
        options.onActivity?.()
        buffer += decoder.decode(value, { stream: true })
        if (buffer.length > maxBufferChars) {
          throw malformed('Qoder SSE frame exceeded its size limit.')
        }
      }

      while (!sawDone) {
        const lineEnd = buffer.indexOf('\n')
        if (lineEnd === -1) break
        let line = buffer.substring(0, lineEnd)
        buffer = buffer.substring(lineEnd + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        line = line.trim()
        if (!line.startsWith('data:')) continue

        const rawData = line.substring(5).trim()
        if (!rawData) continue
        if (rawData === doneMarker) {
          sawDone = true
          break
        }

        const envelope = parseEnvelope(rawData)
        const body = envelope.body?.trim()
        if (!body) continue
        if (body === doneMarker) {
          sawDone = true
          break
        }
        const innerChunk = parseInner(body)
        pendingUsage = tokenUsage(innerChunk) ?? pendingUsage

        for (const choice of innerChunk.choices ?? []) {
          if (typeof choice.finish_reason === 'string'
            && filteredFinishReasons.has(choice.finish_reason)
            && filteredReason === undefined) {
            filteredReason = choice.finish_reason
            options.onNotice?.({ kind: 'filtered', reason: choice.finish_reason })
          }
          terminalKind = finishKind(choice.finish_reason, options.onDiag) ?? terminalKind
          const delta = choice.delta
          if (!delta) continue

          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            for (const segment of thinkingParser.pushReasoning(delta.reasoning_content)) {
              for (const chunk of appendSegment(segment)) yield chunk
            }
          }
          if (typeof delta.content === 'string' && delta.content) {
            for (const segment of thinkingParser.pushContent(delta.content)) {
              for (const chunk of appendSegment(segment)) yield chunk
            }
          }

          if (delta.tool_calls !== undefined) {
            if (!Array.isArray(delta.tool_calls)) throw malformed('Qoder tool-call delta is not an array.')
            for (const rawCall of delta.tool_calls) {
              if (typeof rawCall !== 'object' || rawCall === null || Array.isArray(rawCall)) {
                throw malformed('Qoder tool-call delta is not an object.')
              }
              const upstreamIndex = rawCall.index ?? 0
              if (!Number.isInteger(upstreamIndex) || upstreamIndex < 0) {
                throw malformed('Qoder tool-call delta has an invalid index.')
              }
              let state = toolCalls.get(upstreamIndex)
              if (state === undefined) {
                state = { id: '', name: '', arguments: '', emittedArguments: 0 }
                toolCalls.set(upstreamIndex, state)
              }
              if (rawCall.id !== undefined) {
                if (rawCall.id === '' || rawCall.id === null) {
                  // Upstream models and gateways often emit empty or null IDs in parameter deltas.
                  // Tolerate and ignore when an ID is already established, or wait for later chunks.
                } else if (typeof rawCall.id !== 'string') {
                  throw malformed('Qoder tool call has an invalid id.')
                } else {
                  if (state.id && state.id !== rawCall.id) throw malformed('Qoder changed a streamed tool-call id.')
                  state.id = rawCall.id
                }
              }
              if (rawCall.function?.name !== undefined) {
                const name = rawCall.function.name
                if (name === '' || name === null) {
                  // Upstream models and gateways often emit empty or null names in parameter deltas.
                  // Tolerate and ignore when a name is already established, or wait for later chunks.
                } else if (typeof name !== 'string') {
                  throw malformed('Qoder tool call has an invalid name.')
                } else {
                  if (state.name && state.name !== name) throw malformed('Qoder changed a streamed tool-call name.')
                  state.name = name
                }
              }
              if (rawCall.function?.arguments !== undefined) {
                if (typeof rawCall.function.arguments !== 'string') {
                  throw malformed('Qoder tool-call arguments delta is not a string.')
                }
                state.arguments += rawCall.function.arguments
              }

              // Tool blocks are NOT opened while streaming. `finish_reason` arrives in a later
              // chunk, so a call opened here would already be a dangling block when a filter
              // is announced; the harness assembles an unclosed tool call from its deltas and
              // then executes it (BlockAssembler only drops calls on max-tokens). Buffering the
              // arguments until the stream ends is what makes "filtered replies carry no calls"
              // true for the real ordering, at the cost of showing the call once it completes.
            }
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }

  // Load-bearing wording: pi-ai reclassifies failures from this text, and TRANSPORT
  // requires the exact "stream ended without" phrase with no status digits.
  if (!sawDone) throw new QoderLlmError('Qoder SSE stream ended without [DONE].', 'TRANSPORT')

  for (const segment of thinkingParser.finish()) {
    for (const chunk of appendSegment(segment)) yield chunk
  }
  for (const chunk of closeTextual()) yield chunk

  // An unidentifiable call cannot execute at all, so it stays provider corruption unless the
  // provider already admitted it ran out of output. The ARGUMENTS are never judged here: the
  // official client concatenates them, parses once, and hands an unparsable payload on as an
  // empty input plus the raw text, which the tool layer answers as an invalid-argument error
  // so the model can retry. Sending the bytes through keeps that behavior, whatever shape.
  //
  // A FILTERED reply is the one case that must not carry calls: the harness plans tools from
  // the blocks, not from the finish kind, so an emitted call would run something the upstream
  // refused to deliver. Calls are only opened here, at the end, so skipping this loop leaves
  // the downstream with text alone.
  const truncated = terminalKind === 'max-tokens'
  let emittedCalls = 0
  if (filteredReason !== undefined && toolCalls.size > 0) {
    options.onDiag?.(`withheld ${toolCalls.size} tool call(s): the reply was filtered (${filteredReason})`)
  }
  for (const [, state] of filteredReason === undefined
    ? [...toolCalls.entries()].sort(([left], [right]) => left - right)
    : []) {
    const normalizedArguments = state.arguments.trim() ? state.arguments : '{}'
    if (!state.id || !state.name) {
      if (truncated) continue
      throw malformed('Qoder completed an unidentifiable tool call.')
    }
    const issue = argumentsIssue(normalizedArguments)
    if (issue !== undefined) {
      options.onDiag?.(`tool call "${state.name}" carried unparsable arguments (${issue})`)
    }
    for (const chunk of openToolCall(state)) yield chunk
    if (state.blockIndex === undefined) throw malformed('Qoder failed to open a completed tool call.')
    if (state.emittedArguments === 0 && normalizedArguments === '{}') {
      yield {
        type: 'tool-call-delta',
        index: state.blockIndex,
        id: ToolCallId(state.id),
        name: state.name,
        argumentsDelta: '{}',
      }
    }
    emittedCalls += 1
    yield {
      type: 'block-end',
      index: state.blockIndex,
      block: {
        type: 'tool-call',
        id: ToolCallId(state.id),
        name: state.name,
        arguments: normalizedArguments,
      },
    }
  }

  if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
  if (!sawContent && !truncated) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: filteredReason === undefined
            ? 'Model returned a completed response with no content.'
            : `Qoder filtered the reply (${filteredReason}) before returning any content.`,
          code: EMPTY_RESPONSE_CODE,
        },
      },
    }
    return
  }
  yield { type: 'finish', reason: { kind: emittedCalls > 0 ? 'tool-calls' : terminalKind } }
}
