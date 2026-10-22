import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { createQoderAdapter } from '../src/adapter.ts'
import { QoderCredentialStore } from '../src/auth.ts'
import { QoderCatalog } from '../src/catalog.ts'
import { createQueueHint } from '../src/queue-hint.ts'
import { createQoderTransport } from '../src/qoder/transport/index.ts'
import type { QoderQueueWait } from '../src/qoder/transport/chat.ts'
import { QODER_PURPOSE_HEADER, QODER_SESSION_HEADER, qoderSessionHeaders, readQoderPurposeHeader, readQoderSessionHeader, withQoderRequestPurpose } from '../src/request-session.ts'
import { createQoderShim, type QoderShim } from '../src/shim.ts'
import { QoderUpstreamClient } from '../src/upstream.ts'
import { CHINA_VARIANT } from '../src/variants.ts'

const shims: QoderShim[] = []
afterEach(async () => {
  await Promise.all(shims.splice(0).map(shim => shim.close()))
  vi.restoreAllMocks()
})

interface HintEvent {
  type: string
  data: { commandId: string }
}

function target() {
  const events: HintEvent[] = []
  return { events, append(type: string, data: unknown) { events.push({ type, data: data as HintEvent['data'] }) } }
}

const queueBody = JSON.stringify({
  code: '10605',
  message: JSON.stringify({ isQueued: true, retryAfterSeconds: 30, queueType: 'p3' }),
})
const body = JSON.stringify({ model: 'queue-model', messages: [{ role: 'user', content: 'hello' }] })

function request(sessionId?: string, signal?: AbortSignal): GenerateOptions {
  return {
    provider: 'qoder',
    model: 'queue-model',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    ...sessionId === undefined ? {} : { sessionId: sessionId as NonNullable<GenerateOptions['sessionId']> },
    ...signal === undefined ? {} : { signal },
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function harness(onWait?: (info: QoderQueueWait, options: GenerateOptions) => void) {
  const sessions = new Map<string, ReturnType<typeof target>>()
  const requests: { sessionId: string | undefined, purpose: GenerateOptions['purpose'], waits: QoderQueueWait[] }[] = []
  const outboundHeaders: Headers[] = []
  const transport = createQoderTransport({
    region: 'china',
    resolvePat: async () => 'pt-queue-session-test',
    resolveMachineId: () => 'queue-session-test-machine',
    // Each test reaches two polls and then the real budget-exhaustion path.
    queueWaitBudgetMs: () => 100,
    createQueueWaitHandler: options => {
      const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
      const record = { sessionId, purpose: options.purpose, waits: [] as QoderQueueWait[] }
      requests.push(record)
      const notify = createQueueHint({ sessionId, purpose: options.purpose, displayName: 'Qoder', resolveSession: id => sessions.get(id) })
      return info => {
        record.waits.push(info)
        notify(info)
        onWait?.(info, options)
      }
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      outboundHeaders.push(new Headers(init?.headers))
      if (url.includes('/jobToken/exchange')) return new Response(JSON.stringify({ token: 'jt-queue-session-test' }))
      if (url.includes('/userinfo')) return new Response(JSON.stringify({ id: 'queue-session-test-user' }))
      if (url.includes('/agent_chat_generation')) return new Response(queueBody, { status: 403 })
      if (url.includes('/ask/queue/status')) {
        return new Response(JSON.stringify({ isQueued: true, serviceAvailable: true, queueCount: 2, waitTime: 30, retryAfterSeconds: 30 }))
      }
      throw new Error(`unexpected upstream request: ${url}`)
    }) as typeof fetch,
  })
  const client = new QoderUpstreamClient({ region: 'china', providerId: 'qoder', getPat: async () => 'pt-queue-session-test', transport })
  function addSession(id: string) {
    const session = target()
    sessions.set(id, session)
    return session
  }
  return { transport, client, requests, outboundHeaders, addSession }
}

function assertOwnRows(session: ReturnType<typeof target>, count: number) {
  const runs = session.events.filter(event => event.type === 'command/run')
  const dones = session.events.filter(event => event.type === 'command/done')
  expect(runs).toHaveLength(count)
  const ids = new Set(runs.map(event => event.data.commandId))
  expect(ids.size).toBe(count)
  expect(dones.every(event => ids.has(event.data.commandId))).toBe(true)
  return { ids, dones }
}

describe('queue session attribution across the request pipeline', () => {
  it('preserves concurrent direct, prepared and unowned calls through the real HTTP shim', async () => {
    const controllers = new Map<string | undefined, AbortController>([
      ['session/A', new AbortController()],
      ['session-B', new AbortController()],
      [undefined, new AbortController()],
    ])
    const h = harness((info, options) => {
      if (info.attempt >= 2) controllers.get(options.sessionId)?.abort('two polls observed')
    })
    const a = h.addSession('session/A')
    const b = h.addSession('session-B')
    const store = new QoderCredentialStore({ variant: CHINA_VARIANT, ownPath: 'tests/unused-queue-session-auth.json' })
    vi.spyOn(store, 'resolve').mockResolvedValue({ pat: 'pt-queue-session-test', region: 'china', source: 'card' })
    const catalog = new QoderCatalog([{ id: 'queue-model', name: 'Queue model', contextWindow: 1000, supportsImages: false, billing: { free: false } }])
    const shim = createQoderShim({ store, client: h.client, catalog, providerId: 'qoder' })
    shims.push(shim)
    await shim.ready
    const { adapter } = createQoderAdapter({ store, catalog, shim })
    const prepared = await adapter.prepareCall('qoder', 'queue-model')
    const results = await Promise.allSettled([
      collect(adapter.stream(request('session/A', controllers.get('session/A')!.signal))),
      collect(prepared.stream(request('session-B', controllers.get('session-B')!.signal))),
      collect(prepared.stream(request(undefined, controllers.get(undefined)!.signal))),
    ])
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason.code).toBe('ABORTED')
      else {
        const finish = result.value.find(chunk => chunk.type === 'finish')
        expect(finish, JSON.stringify({ finish, requests: h.requests })).toMatchObject({ reason: { kind: 'aborted' } })
      }
    }
    expect(h.requests.map(entry => entry.sessionId).sort()).toEqual(['session-B', 'session/A', undefined])
    for (const entry of h.requests) {
      expect(entry.waits.length).toBeGreaterThanOrEqual(2)
      expect(entry.waits.every(info => info.sessionId === entry.sessionId)).toBe(true)
    }
    const first = assertOwnRows(a, 1)
    const second = assertOwnRows(b, 1)
    expect(first.dones.length).toBeGreaterThanOrEqual(2)
    expect(second.dones.length).toBeGreaterThanOrEqual(2)
    expect([...first.ids].some(id => second.ids.has(id))).toBe(false)
    expect(h.outboundHeaders.every(headers => !headers.has(QODER_SESSION_HEADER) && !headers.has(QODER_PURPOSE_HEADER))).toBe(true)
  }, 15000)

  it.each(['direct', 'prepared'] as const)('prints only the conversation queue when a %s title call shares its session', async titleEntry => {
    const controllers = [new AbortController(), new AbortController(), new AbortController()]
    const h = harness(() => {
      if (h.requests.length === 3 && h.requests.every(entry => entry.waits.length >= 2)) {
        for (const controller of controllers) controller.abort('all queue polls observed')
      }
    })
    const a = h.addSession('session-A')
    const b = h.addSession('session-B')
    const store = new QoderCredentialStore({ variant: CHINA_VARIANT, ownPath: 'tests/unused-queue-title-auth.json' })
    vi.spyOn(store, 'resolve').mockResolvedValue({ pat: 'pt-queue-title-test', region: 'china', source: 'card' })
    const catalog = new QoderCatalog([{ id: 'queue-model', name: 'Queue model', contextWindow: 1000, supportsImages: false, billing: { free: false } }])
    const shim = createQoderShim({ store, client: h.client, catalog, providerId: 'qoder' })
    shims.push(shim)
    await shim.ready
    const { adapter } = createQoderAdapter({ store, catalog, shim })
    const prepared = await adapter.prepareCall('qoder', 'queue-model')
    const title: GenerateOptions = { ...request('session-A', controllers[1]!.signal), purpose: 'session-title' }
    await Promise.allSettled([
      collect(adapter.stream(request('session-A', controllers[0]!.signal))),
      collect(titleEntry === 'direct' ? adapter.stream(title) : prepared.stream(title)),
      collect(prepared.stream(request('session-B', controllers[2]!.signal))),
    ])
    expect(h.requests).toHaveLength(3)
    expect(h.requests.every(entry => entry.waits.length >= 2)).toBe(true)
    expect(h.requests.filter(entry => entry.purpose === 'session-title')).toMatchObject([{ sessionId: 'session-A' }])
    expect(h.requests.filter(entry => entry.purpose === undefined).map(entry => entry.sessionId).sort()).toEqual(['session-A', 'session-B'])
    const first = assertOwnRows(a, 1)
    const second = assertOwnRows(b, 1)
    expect(first.dones).toHaveLength(2)
    expect(second.dones).toHaveLength(2)
    expect([...first.ids].some(id => second.ids.has(id))).toBe(false)
  }, 15000)

  it('opens fresh rows after abort and timeout while another session keeps waiting', async () => {
    const controller = new AbortController()
    let shouldAbort = true
    const h = harness((_info, options) => {
      if (options.sessionId === 'session-A' && shouldAbort) {
        shouldAbort = false
        controller.abort('test cancellation')
      }
    })
    const a = h.addSession('session-A')
    const b = h.addSession('session-B')
    const other = h.client.chatStream(body, undefined, 'session-B')
    const aborted = await h.client.chatStream(body, controller.signal, 'session-A')
    expect(aborted.ok).toBe(false)
    const retry = await h.client.chatStream(body, undefined, 'session-A')
    expect(retry.ok).toBe(false)
    expect((await other).ok).toBe(false)
    const afterTimeout = await h.client.chatStream(body, undefined, 'session-A')
    expect(afterTimeout.ok).toBe(false)
    const first = assertOwnRows(a, 3)
    const second = assertOwnRows(b, 1)
    expect(first.dones.length).toBeGreaterThanOrEqual(5)
    expect(second.dones.length).toBeGreaterThanOrEqual(2)
    expect([...first.ids].some(id => second.ids.has(id))).toBe(false)
    expect(h.requests).toHaveLength(4)
  })
})

describe('loopback session header', () => {
  it('binds purpose across lazy iteration and cancellation without leaking to other calls', async () => {
    const closed: (string | null | undefined)[] = []
    async function* source() {
      try {
        await Promise.resolve()
        yield qoderSessionHeaders('A')[QODER_PURPOSE_HEADER]
        await Promise.resolve()
        yield qoderSessionHeaders('A')[QODER_PURPOSE_HEADER]
      } finally {
        closed.push(qoderSessionHeaders('A')[QODER_PURPOSE_HEADER])
      }
    }
    const title = withQoderRequestPurpose('session-title', source())
    const conversation = withQoderRequestPurpose(undefined, source())
    const compaction = withQoderRequestPurpose('compaction', source())
    const first = await Promise.all([title.next(), conversation.next(), compaction.next()])
    expect(first.map(next => next.value)).toEqual(['session-title', null, 'compaction'])
    expect(qoderSessionHeaders('A')[QODER_PURPOSE_HEADER]).toBeNull()
    await title.return(undefined)
    expect(closed).toEqual(['session-title'])
    expect((await conversation.next()).value).toBeNull()
    await conversation.return(undefined)
    await compaction.return(undefined)
    expect(closed).toEqual(['session-title', null, 'compaction'])
    expect(qoderSessionHeaders('A')[QODER_PURPOSE_HEADER]).toBeNull()
  })

  it('recognizes only declared auxiliary request purposes', () => {
    expect(readQoderPurposeHeader('session-title')).toBe('session-title')
    expect(readQoderPurposeHeader('compaction')).toBe('compaction')
    expect(readQoderPurposeHeader('unknown')).toBeUndefined()
    expect(readQoderPurposeHeader(['session-title'])).toBeUndefined()
    expect(readQoderPurposeHeader(undefined)).toBeUndefined()
  })

  it('encodes a session independently of other headers without mutating the input', () => {
    const original = { 'X-DSH-QODER-SESSION-ID': 'stale', 'x-extra': 'kept' }
    const headers = qoderSessionHeaders('session/A', original)
    expect(readQoderSessionHeader(headers[QODER_SESSION_HEADER] as string)).toBe('session/A')
    expect(headers['X-DSH-QODER-SESSION-ID']).toBeUndefined()
    expect(headers['x-extra']).toBe('kept')
    expect(original['X-DSH-QODER-SESSION-ID']).toBe('stale')
    expect(qoderSessionHeaders(undefined, original)[QODER_SESSION_HEADER]).toBeNull()
  })

  it.each([undefined, '', '%', ['A', 'B']])('leaves malformed or missing session attribution unowned: %j', value => {
    expect(readQoderSessionHeader(value)).toBeUndefined()
  })
})
