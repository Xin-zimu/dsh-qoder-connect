import { describe, expect, it } from 'vitest'
import {
  PROBE_EFFORT_CANDIDATES,
  PROBE_MAX_TOKENS,
  PROBE_PROMPT,
  probeModel,
  randomSentinel,
  type ProbeAttempt,
  type ProbeSender,
} from '../src/probe.ts'

/**
 * Offline tests for the probe protocol (§4). The point is the *gating*, not the
 * sweep: a model answering 200 to a value that cannot exist yields no per-level
 * result, and anything non-decisive degrades to `unknown`, never to a negative
 * capability claim.
 */

const ACCEPTED: ProbeAttempt = { status: 200, streamed: true }
// The Qoder transport raises this code locally against the discovery catalog
// when a model does not advertise the effort (`src/qoder/transport/wire/serialize.ts`).
const REJECTED: ProbeAttempt = { status: 400, streamed: false, errorCode: 'UNSUPPORTED_REASONING_EFFORT' }

/** A sender that answers from a table keyed by effort, with `undefined` = baseline. */
function tableSender(table: Map<string | undefined, ProbeAttempt>): ProbeSender {
  return async effort => table.get(effort) ?? REJECTED
}

/** Count how many requests a sender saw, to assert the sweep stops early. */
function counting(inner: ProbeSender): { send: ProbeSender; count: () => number } {
  let count = 0
  return {
    count: () => count,
    send: async (effort, signal) => {
      count += 1
      return inner(effort, signal)
    },
  }
}

const SENTINEL = 'probe_sentinel_test'

describe('probe constants', () => {
  it('sweeps the canonical Qoder effort vocabulary in a fixed order', () => {
    expect(PROBE_EFFORT_CANDIDATES).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('sends the fixed minimal request shape', () => {
    // The answer is never read, so the request stays one token wide.
    expect(PROBE_PROMPT).toBe('ping')
    expect(PROBE_MAX_TOKENS).toBe(1)
  })
})

describe('probeModel', () => {
  it('verifies the levels a validating model accepts', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
      ['medium', REJECTED],
      ['high', ACCEPTED],
      ['xhigh', REJECTED],
      ['max', ACCEPTED],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('validating')
    expect(outcome.efforts).toEqual(['low', 'high', 'max'])
    // Baseline + sentinel + one per candidate.
    expect(outcome.requests).toBe(2 + PROBE_EFFORT_CANDIDATES.length)
  })

  it('marks a model that accepts the sentinel as non-validating and stops early', async () => {
    // Everything answers 200, including a value that cannot exist. Any
    // per-level answer would be a false positive.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, ACCEPTED],
    ])
    const sent = counting(tableSender(table))
    const outcome = await probeModel({ send: sent.send, sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('non-validating')
    expect(outcome.efforts).toEqual([])
    // Baseline + sentinel only: no candidate was ever tried.
    expect(outcome.requests).toBe(2)
    expect(sent.count()).toBe(2)
  })

  it('reports unknown when the baseline fails', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, { status: 401, streamed: false, errorCode: 'AUTH' }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.efforts).toEqual([])
    // The sentinel was never sent: a broken baseline explains nothing otherwise.
    expect(outcome.requests).toBe(1)
  })

  it('reports unknown when the sentinel fails non-attributably', async () => {
    // A 429 is not a statement about the effort value, so it must not be read
    // as "validating" and must not be read as a capability answer either.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, { status: 429, streamed: false, errorCode: 'RATE_LIMIT' }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.requests).toBe(2)
  })

  it('does not treat a bare 400 as an effort rejection', async () => {
    // Same status, no attributable code: the plan requires degrading to unknown
    // rather than guessing that the effort caused it.
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, { status: 400, streamed: false, errorCode: 'INVALID_REQUEST' }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('unknown')
  })

  it('does not count a 200 without a stream as acceptance', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, { status: 200, streamed: false }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('unknown')
  })

  it('abandons a mid-sweep failure rather than reporting a partial set', async () => {
    const table = new Map<string | undefined, ProbeAttempt>([
      [undefined, ACCEPTED],
      [SENTINEL, REJECTED],
      ['low', ACCEPTED],
      ['medium', { status: 502, streamed: false }],
    ])
    const outcome = await probeModel({ send: tableSender(table), sentinel: () => SENTINEL })
    expect(outcome.validation).toBe('unknown')
    // The accepted `low` must not leak out as a finding.
    expect(outcome.efforts).toEqual([])
  })

  it('never probes `off` or `minimal`', () => {
    expect(PROBE_EFFORT_CANDIDATES).not.toContain('off')
    expect(PROBE_EFFORT_CANDIDATES).not.toContain('minimal')
  })

  it('survives a throwing sender by reporting unknown', async () => {
    const outcome = await probeModel({
      send: async () => { throw new Error('socket hang up') },
      sentinel: () => SENTINEL,
    })
    expect(outcome.validation).toBe('unknown')
  })
})

describe('randomSentinel', () => {
  it('is not a canonical effort spelling and varies per call', () => {
    const first = randomSentinel()
    const second = randomSentinel()
    expect(first).not.toBe(second)
    expect(first.startsWith('probe_sentinel_')).toBe(true)
    for (const effort of PROBE_EFFORT_CANDIDATES) expect(first).not.toBe(effort)
    expect(first).not.toBe('off')
  })
})
