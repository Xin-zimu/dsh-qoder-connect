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

/** What a completed tool call's argument text amounts to. */
type QoderArgumentShape =
  | { kind: 'complete' }
  /** Began as JSON and did not survive: a closed object plus a tail, or no close at all. */
  | { kind: 'damaged'; detail: string }
  /** Never looked like JSON: nothing to answer, so the stream is corrupt. */
  | { kind: 'foreign' }

function isJsonObject(text: string): boolean {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return false
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Index just past the first complete JSON value, or undefined when none closed. */
function closedValueEnd(text: string): number | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (inString) {
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth < 0) return undefined
      if (depth === 0) return index + 1
    }
  }
  return undefined
}

/**
 * Classify one call's arguments.
 *
 * The upstream has shipped three damaged shapes for #21 across live runs - a closed
 * object plus a 1-char tail, the same plus a 5-char tail, and one that never closed -
 * all with `finish_reason: tool_calls`, so the shape cannot decide whether a turn
 * dies. What can: whether the bytes ever claimed to be JSON. A damaged JSON attempt
 * is answered as a tool-input error (with a diagnostic); a payload that is not JSON
 * at all is still provider corruption.
 */
function classifyArguments(text: string): QoderArgumentShape {
  if (isJsonObject(text)) return { kind: 'complete' }
  const first = text.trimStart()[0]
  if (first !== '{' && first !== '[') return { kind: 'foreign' }
  const end = closedValueEnd(text)
  if (end === undefined) return { kind: 'damaged', detail: `${text.length} chars, never closed` }
  const head = text.slice(0, end)
  if (!isJsonObject(head)) return { kind: 'foreign' }
  return { kind: 'damaged', detail: `closed at ${end} chars, ${text.length - end}-char tail` }
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

function finishKind(value: string | null | undefined): SuccessfulFinishKind | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'stop') return 'stop'
  if (value === 'length') return 'max-tokens'
  if (value === 'tool_calls' || value === 'toolUse') return 'tool-calls'
  if (value === 'content_filter') {
    throw new QoderLlmError('Qoder blocked the response through its content filter.', 'PROVIDER_ERROR')
  }
  throw malformed(`Qoder returned unknown finish reason "${value}".`)
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
          terminalKind = finishKind(choice.finish_reason) ?? terminalKind
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
              let hasNewName = false
              if (rawCall.function?.name !== undefined) {
                const name = rawCall.function.name
                if (name === '' || name === null) {
                  // Upstream models and gateways often emit empty or null names in parameter deltas.
                  // Tolerate and ignore when a name is already established, or wait for later chunks.
                } else if (typeof name !== 'string') {
                  throw malformed('Qoder tool call has an invalid name.')
                } else {
                  if (state.name && state.name !== name) throw malformed('Qoder changed a streamed tool-call name.')
                  if (state.name !== name) {
                    state.name = name
                    hasNewName = true
                  }
                }
              }
              if (rawCall.function?.arguments !== undefined) {
                if (typeof rawCall.function.arguments !== 'string') {
                  throw malformed('Qoder tool-call arguments delta is not a string.')
                }
                state.arguments += rawCall.function.arguments
              }

              const wasOpen = state.blockIndex !== undefined
              for (const chunk of openToolCall(state)) yield chunk
              if (wasOpen && state.blockIndex !== undefined && state.emittedArguments < state.arguments.length) {
                const argumentsDelta = state.arguments.slice(state.emittedArguments)
                state.emittedArguments = state.arguments.length
                yield {
                  type: 'tool-call-delta',
                  index: state.blockIndex,
                  id: ToolCallId(state.id),
                  ...state.name ? { name: state.name } : {},
                  argumentsDelta,
                }
              } else if (wasOpen && state.blockIndex !== undefined && hasNewName) {
                yield {
                  type: 'tool-call-delta',
                  index: state.blockIndex,
                  id: ToolCallId(state.id),
                  name: state.name,
                  argumentsDelta: '',
                }
              }
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

  // An unidentifiable call cannot be executed at all, so it stays provider corruption unless
  // the provider already admitted it ran out of output. Arguments are judged by whether they
  // ever claimed to be JSON: a damaged attempt (#21) reaches the harness as a tool-input error
  // and is reported here, while a payload that is not JSON at all stays fatal.
  const truncated = terminalKind === 'max-tokens'
  let emittedCalls = 0
  for (const [, state] of [...toolCalls.entries()].sort(([left], [right]) => left - right)) {
    const normalizedArguments = state.arguments.trim() ? state.arguments : '{}'
    if (!state.id || !state.name) {
      if (truncated) continue
      throw malformed('Qoder completed an unidentifiable tool call.')
    }
    const shape = classifyArguments(normalizedArguments)
    if (shape.kind === 'damaged') {
      // The block carries the bytes upstream sent; only deltas cross the shim, so pi-ai still
      // answers this as a tool-input error. The point is that the turn survives - and that the
      // shape is visible instead of silent.
      options.onDiag?.(`tool call "${state.name}" carried damaged arguments (${shape.detail})`)
    } else if (shape.kind === 'foreign' && !truncated) {
      throw malformed(`Qoder completed tool call "${state.name}" with malformed JSON arguments.`)
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
        failure: { message: 'Model returned a completed response with no content.', code: EMPTY_RESPONSE_CODE },
      },
    }
    return
  }
  yield { type: 'finish', reason: { kind: emittedCalls > 0 ? 'tool-calls' : terminalKind } }
}
