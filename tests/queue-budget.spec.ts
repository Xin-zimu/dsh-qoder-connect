import { describe, expect, it } from 'vitest'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { QoderCatalogModel } from '../src/qoder/catalog.ts'
import { QoderLlmError } from '../src/qoder/errors.ts'
import { streamQoderChat, type QoderChatDependencies } from '../src/qoder/transport/chat.ts'

/**
 * The queue wait's two boundaries, at the transport level.
 *
 * The configured budget is the only thing that may end a wait: a replay count, a
 * per-round ceiling or the transport's stream-idle window must never stand in for
 * it. Both regressions below were observed in the field as "the setting says ten
 * minutes, the wait died at five".
 */

const MODEL: QoderCatalogModel = {
  id: 'queue-model',
  name: 'Queue model',
  contextWindow: 1000,
}

const CREDENTIALS = { userID: 'queue-budget-user', authToken: 'queue-budget-token', name: 'n', email: 'e' }

const options: GenerateOptions = {
  provider: 'qoder',
  model: 'queue-model',
  messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
}

/**
 * One Qoder queue rejection. The hint is 1 s because the transport rejects a
 * zero hint; the compressed poll ceiling below is what keeps the rounds short.
 */
const queueRejection = JSON.stringify({
  code: '10605',
  message: JSON.stringify({ isQueued: true, retryAfterSeconds: 1, queueType: 'p3' }),
})

interface Counter {
  chatPosts: number
  polls: number
}

/**
 * A fake upstream: every chat POST is throttled, and the queue-status endpoint
 * answers whatever the test wants.
 */
function fakeFetch(status: () => unknown): { fetch: typeof fetch, counter: Counter } {
  const counter: Counter = { chatPosts: 0, polls: 0 }
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    if (url.includes('/agent_chat_generation')) {
      counter.chatPosts += 1
      return new Response(queueRejection, { status: 403 })
    }
    if (url.includes('/ask/queue/status')) {
      counter.polls += 1
      return new Response(JSON.stringify(status()))
    }
    throw new Error(`unexpected upstream request: ${url}`)
  }) as typeof fetch
  return { fetch: fetchImpl, counter }
}

function dependencies(fetchImpl: typeof fetch, extra: Partial<QoderChatDependencies> = {}): QoderChatDependencies {
  return {
    fetch: fetchImpl,
    region: 'china',
    responseHeaderTimeoutMs: 5_000,
    streamIdleTimeoutMs: 30,
    queueWaitBudgetMs: 400,
    // 1 ms floor / 2 ms ceiling instead of the production 2 s / 30 s: the pacing
    // is the same code path, only the wall clock is compressed.
    queuePollFloorMs: 1,
    queuePollCeilingMs: 2,
    ...extra,
  }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<{ error?: unknown, chunks: StreamChunk[] }> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of stream) chunks.push(chunk)
    return { chunks }
  } catch (error: unknown) {
    return { chunks, error }
  }
}

async function chat(deps: QoderChatDependencies): Promise<{ error?: unknown, chunks: StreamChunk[] }> {
  return await drain(streamQoderChat(options, MODEL, CREDENTIALS, [], deps))
}

/** The queue failure the ride hands back once its budget is spent. */
function expectQueueFailure(error: unknown): void {
  expect(error, 'the wait must end with the upstream queue answer').toBeInstanceOf(QoderLlmError)
  // `qoderHttpError` classifies a 403 carrying queue markers as RATE_LIMIT.
  expect((error as QoderLlmError).failure.code).toBe('RATE_LIMIT')
}

/** One Qoder-native SSE answer, the shape the transport parses. */
const grantedAnswer = [
  `data: ${JSON.stringify({ statusCodeValue: 200, body: JSON.stringify({ choices: [{ delta: { content: '你好' }, finish_reason: 'stop' }] }) })}`,
  `data: ${JSON.stringify({ statusCodeValue: 200, body: '[DONE]' })}`,
].join('\n\n')

describe('queue wait boundaries', () => {
  it('keeps replaying past the ten-round mark the official client uses', async () => {
    // Each grant→replay cycle costs one POST and one poll. The old code stopped
    // after ten of them, which silently capped any longer setting.
    const { fetch: fetchImpl, counter } = fakeFetch(() => ({
      isQueued: false,
      serviceAvailable: true,
      queueCount: 0,
      retryAfterSeconds: 0,
    }))
    // A cycle costs one POST plus one poll, so the budget is what decides how many
    // rounds happen; 1.5 s leaves plenty of room above the old cap of ten.
    const result = await chat(dependencies(fetchImpl, { queueWaitBudgetMs: 1_500 }))
    expectQueueFailure(result.error)
    expect(counter.chatPosts).toBeGreaterThan(12)
  })

  it('does not let the stream-idle window end a wait the budget still allows', async () => {
    // The idle window is 100 ms and the budget 300 ms: a transport that treated the
    // wait as a stalled stream would give up a third of the way in.
    const { fetch: fetchImpl, counter } = fakeFetch(() => ({
      isQueued: true,
      serviceAvailable: true,
      queueCount: 2,
      waitTime: 30,
      retryAfterSeconds: 0,
    }))
    const startedAt = Date.now()
    const result = await chat(dependencies(fetchImpl, {
      queuePollFloorMs: 2,
      queueWaitBudgetMs: 300,
      streamIdleTimeoutMs: 100,
    }))
    const elapsedMs = Date.now() - startedAt
    expectQueueFailure(result.error)
    // Past the idle window the timer would have fired in: the polls kept it alive.
    expect(elapsedMs).toBeGreaterThan(150)
    expect(counter.polls).toBeGreaterThan(1)
  })

  it('still ends the ride as soon as the upstream grants the entry', async () => {
    // A cleared entry is a grant, not a wait: the replay must happen and the
    // answer must be forwarded, however many rounds it took to get there.
    let posts = 0
    let polls = 0
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      if (url.includes('/agent_chat_generation')) {
        posts += 1
        return posts === 1
          ? new Response(queueRejection, { status: 403 })
          : new Response(grantedAnswer, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (url.includes('/ask/queue/status')) {
        polls += 1
        return new Response(JSON.stringify(polls < 3
          ? { isQueued: true, serviceAvailable: true, queueCount: 1, waitTime: 5, retryAfterSeconds: 0 }
          : { isQueued: false, serviceAvailable: true, queueCount: 0, retryAfterSeconds: 0 }))
      }
      throw new Error(`unexpected upstream request: ${url}`)
    }) as typeof fetch
    const result = await chat(dependencies(fetchImpl, { queueWaitBudgetMs: 1_000 }))
    expect(result.error).toBeUndefined()
    expect(result.chunks.length).toBeGreaterThan(0)
    expect(posts).toBe(2)
    expect(polls).toBeGreaterThanOrEqual(3)
  })
})
