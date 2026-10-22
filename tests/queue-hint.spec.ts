import { describe, expect, it, vi } from 'vitest'
import { createQueueHint, type QueueHintSession } from '../src/queue-hint.ts'
import { emitNoticeRow, installJobTokenHint } from '../src/job-token-hint.ts'

interface HintEvent {
  type: string
  data: { commandId: string, text?: string, kind?: string }
}

function session() {
  const events: HintEvent[] = []
  return {
    events,
    append(type: string, data: unknown) { events.push({ type, data: data as HintEvent['data'] }) },
  }
}

const wait = (attempt: number) => ({ attempt, waitMs: 2000, waitTimeMs: 30000 })
const runs = (target: ReturnType<typeof session>) => target.events.filter(event => event.type === 'command/run')
const dones = (target: ReturnType<typeof session>) => target.events.filter(event => event.type === 'command/done')

function observer(sessionId: string | undefined, sessions: Map<string, QueueHintSession>) {
  return createQueueHint({ sessionId, displayName: 'Qoder', resolveSession: id => sessions.get(id) })
}

describe('request-owned queue hints', () => {
  it('updates one row on every poll, including polls less than five seconds apart', () => {
    const a = session()
    const notify = observer('A', new Map([['A', a]]))
    notify(wait(1))
    notify(wait(2))
    notify(wait(3))
    expect(runs(a)).toHaveLength(1)
    expect(dones(a)).toHaveLength(3)
    expect(new Set(a.events.map(event => event.data.commandId)).size).toBe(1)
    expect(dones(a).at(-1)?.data.text).toMatch(/第 3 次|poll 3/)
  })

  it('keeps concurrent sessions independent when another request clears its queue', () => {
    const a = session()
    const b = session()
    const sessions = new Map([['A', a], ['B', b]])
    const first = observer('A', sessions)
    const second = observer('B', sessions)
    first(wait(1))
    second(wait(1))
    first({ ...wait(1), cleared: true })
    second(wait(2))
    first(wait(2))
    expect(runs(a)).toHaveLength(1)
    expect(runs(b)).toHaveLength(1)
    expect(dones(a)).toHaveLength(2)
    expect(dones(b)).toHaveLength(2)
    expect(runs(a)[0]?.data.commandId).not.toBe(runs(b)[0]?.data.commandId)
    expect(dones(a).every(event => event.data.commandId === runs(a)[0]?.data.commandId)).toBe(true)
    expect(dones(b).every(event => event.data.commandId === runs(b)[0]?.data.commandId)).toBe(true)
  })

  it('keeps simultaneous requests in the same session from overwriting each other', () => {
    const a = session()
    const sessions = new Map([['A', a]])
    const first = observer('A', sessions)
    const second = observer('A', sessions)
    first(wait(1))
    second(wait(1))
    first(wait(2))
    second(wait(2))
    expect(runs(a)).toHaveLength(2)
    const [firstId, secondId] = runs(a).map(event => event.data.commandId)
    expect(firstId).not.toBe(secondId)
    expect(dones(a).map(event => event.data.commandId)).toEqual([firstId, secondId, firstId, secondId])
  })

  it('keeps title-only queue polls silent even after the conversation has stopped', () => {
    const a = session()
    const resolveSession = vi.fn(() => a)
    const onDiag = vi.fn()
    const notify = createQueueHint({ sessionId: 'A', purpose: 'session-title', displayName: 'Qoder', resolveSession, onDiag })
    notify(wait(1))
    notify({ ...wait(1), cleared: true })
    notify(wait(2))
    expect(resolveSession).not.toHaveBeenCalled()
    expect(a.events).toEqual([])
    expect(onDiag).toHaveBeenCalledWith('hint skipped: purpose=session-title session=A attempt=2')
  })

  it('continues showing queue updates for foreground context compaction', () => {
    const a = session()
    const notify = createQueueHint({ sessionId: 'A', purpose: 'compaction', displayName: 'Qoder', resolveSession: () => a })
    notify(wait(1))
    notify(wait(2))
    expect(runs(a)).toHaveLength(1)
    expect(dones(a)).toHaveLength(2)
  })

  it('does not print unowned requests into the last running agent', () => {
    const a = session()
    let listener: ((payload: unknown) => void) | undefined
    installJobTokenHint({ on: (_name: string, callback: (payload: unknown) => void) => { listener = callback } } as never)
    listener?.({ status: 'running', agent: { id: 'A', session: a } })
    const resolveSession = vi.fn(() => a)
    const notify = createQueueHint({ sessionId: undefined, displayName: 'Qoder', resolveSession })
    notify(wait(1))
    notify(wait(2))
    expect(resolveSession).not.toHaveBeenCalled()
    expect(a.events).toEqual([])
  })

  it('waits for its own session to become available without redirecting the hint', () => {
    const a = session()
    const b = session()
    const sessions = new Map<string, QueueHintSession>([['B', b]])
    const notify = observer('A', sessions)
    notify(wait(1))
    expect(b.events).toEqual([])
    sessions.set('A', a)
    notify(wait(2))
    notify(wait(3))
    expect(runs(a)).toHaveLength(1)
    expect(dones(a)).toHaveLength(2)
    expect(b.events).toEqual([])
  })

  it('keeps an open row attached to the session object that created it', () => {
    const a = session()
    const replacement = session()
    const sessions = new Map<string, QueueHintSession>([['A', a]])
    const notify = observer('A', sessions)
    notify(wait(1))
    sessions.set('A', replacement)
    notify(wait(2))
    expect(dones(a)).toHaveLength(2)
    expect(replacement.events).toEqual([])
  })

  it('starts a fresh request without inheriting a previous unfinished row', () => {
    const a = session()
    const sessions = new Map([['A', a]])
    observer('A', sessions)(wait(1))
    const next = observer('A', sessions)
    next(wait(1))
    next(wait(2))
    expect(runs(a)).toHaveLength(2)
    const [oldId, newId] = runs(a).map(event => event.data.commandId)
    expect(oldId).not.toBe(newId)
    expect(dones(a).map(event => event.data.commandId)).toEqual([oldId, newId, newId])
  })

  it('prints a one-off filtered-reply notice as its own run/done pair', () => {
    const a = session()
    emitNoticeRow(a, 'error', '回复被上游内容安全策略过滤（content_filter），内容可能不完整')
    expect(runs(a)).toHaveLength(1)
    expect(dones(a)).toHaveLength(1)
    expect(dones(a)[0]?.data.commandId).toBe(runs(a)[0]?.data.commandId)
    expect(dones(a)[0]?.data.kind).toBe('error')
    expect(dones(a)[0]?.data.text).toContain('content_filter')
  })
})
