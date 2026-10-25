import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderCatalog, type QoderModelInfo } from '../src/catalog.ts'
import {
  fingerprintModel,
  newestFirst,
  qoderProbePath,
  QODER_PROBE_FILENAME,
  QoderProbeStore,
} from '../src/probe-store.ts'
import { QoderProbeService } from '../src/probe-service.ts'

/**
 * Offline tests for the probe record and its precedence rules
 * (`docs/reasoning-effort-probe-plan.md` §5): an observation is invalidated by
 * a catalog change, expires, never overrides a declared set, and is never
 * erased by a transient failure.
 */

const CLEANUP: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const path of CLEANUP.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tempStore(now?: () => number): { store: QoderProbeStore; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-probe-'))
  CLEANUP.push(dir)
  const path = join(dir, 'probe.json')
  return { store: new QoderProbeStore({ path, pluginVersion: '9.9.9', ...now === undefined ? {} : { now } }), path, dir }
}

/** A row the upstream left undeclared: reasoning, but no effort set. */
const BASE: QoderModelInfo = {
  id: 'probe-base',
  name: 'Probe Base',
  contextWindow: 180_000,
  maxTokens: 32_768,
  supportsImages: true,
  reasoning: { supports: true, canDisableThinking: false },
  billing: { free: false },
}

/** A row that declares its effort set: observation must never override it. */
const DECLARED: QoderModelInfo = {
  ...BASE,
  id: 'declared-model',
  reasoning: { supports: true, supportedEfforts: ['low', 'high'], canDisableThinking: false },
}

/**
 * The account these observations are attributed to. In the Qoder shape the
 * identity is a one-way hash of the PAT (`pat:` + hex), not a uid/domain pair;
 * the store treats it as an opaque string.
 */
const ACCOUNT = 'pat:0123456789abcdef'

describe('qoderProbePath', () => {
  it('places the record file in the plugin state directory, one default name per reader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qoder-probe-path-'))
    CLEANUP.push(dir)
    vi.stubEnv('DSH_QODER_DATA_DIR', dir)
    expect(qoderProbePath()).toBe(join(dir, 'state', QODER_PROBE_FILENAME))
    expect(qoderProbePath('.qoder-global-probe.json')).toBe(join(dir, 'state', '.qoder-global-probe.json'))
  })
})

describe('fingerprintModel', () => {
  it('is stable for the same row and changes when the reasoning object changes', () => {
    const before = fingerprintModel(BASE)
    expect(fingerprintModel(BASE)).toBe(before)

    const changed: QoderModelInfo = {
      ...BASE,
      reasoning: { ...BASE.reasoning!, defaultEffort: 'low' },
    }
    expect(fingerprintModel(changed)).not.toBe(before)
  })

  it('ignores display-only fields so a rename does not discard an observation', () => {
    const renamed: QoderModelInfo = { ...BASE, name: 'Probe Base (renamed)' }
    expect(fingerprintModel(renamed)).toBe(fingerprintModel(BASE))
  })

  it('changes when a probed dependency of the row changes', () => {
    // `supportsImages` rides on the request shape, so a flip must re-probe;
    // an id change is a different model entirely.
    const vision: QoderModelInfo = { ...BASE, supportsImages: false }
    expect(fingerprintModel(vision)).not.toBe(fingerprintModel(BASE))
    expect(fingerprintModel({ ...BASE, id: 'other' })).not.toBe(fingerprintModel(BASE))
  })
})

describe('QoderProbeStore', () => {
  it('round-trips a record through disk', () => {
    const { store, path } = tempStore()
    const fingerprint = fingerprintModel(BASE)
    store.set(BASE.id, store.record(fingerprint, 'validating', ['low', 'high'], ACCOUNT))

    const reopened = new QoderProbeStore({ path, pluginVersion: '9.9.9' })
    const record = reopened.get(BASE.id, fingerprint, ACCOUNT)
    expect(record?.validation).toBe('validating')
    expect(record?.efforts).toEqual(['low', 'high'])
    expect(record?.pluginVersion).toBe('9.9.9')
  })

  it('refuses a record whose fingerprint no longer matches', () => {
    const { store } = tempStore()
    store.set(BASE.id, store.record(fingerprintModel(BASE), 'validating', ['low'], ACCOUNT))
    expect(store.get(BASE.id, fingerprintModel(BASE), ACCOUNT)).toBeDefined()
    expect(store.get(BASE.id, 'a-different-fingerprint', ACCOUNT)).toBeUndefined()
  })

  it('refuses a record made under another account', () => {
    const { store } = tempStore()
    store.set(BASE.id, store.record(fingerprintModel(BASE), 'validating', ['low'], ACCOUNT))
    expect(store.get(BASE.id, fingerprintModel(BASE), 'pat:fedcba9876543210')).toBeUndefined()
  })

  it('expires a record past the TTL', () => {
    let now = 1_000_000
    const { store } = tempStore(() => now)
    const fingerprint = fingerprintModel(BASE)
    store.set(BASE.id, store.record(fingerprint, 'validating', ['low'], ACCOUNT))
    expect(store.get(BASE.id, fingerprint, ACCOUNT)).toBeDefined()

    now += 15 * 24 * 60 * 60 * 1000
    expect(store.get(BASE.id, fingerprint, ACCOUNT)).toBeUndefined()
  })

  it('never stores efforts for a non-validating observation', () => {
    const { store } = tempStore()
    const record = store.record(fingerprintModel(BASE), 'non-validating', ['low', 'high'], ACCOUNT)
    expect(record.efforts).toEqual([])
  })

  it('does not let an unknown result erase a decisive one', () => {
    const { store } = tempStore()
    const fingerprint = fingerprintModel(BASE)
    store.set(BASE.id, store.record(fingerprint, 'validating', ['low'], ACCOUNT))
    store.set(BASE.id, store.record(fingerprint, 'unknown', [], ACCOUNT))

    const kept = store.get(BASE.id, fingerprint, ACCOUNT)
    expect(kept?.validation).toBe('validating')
    expect(kept?.efforts).toEqual(['low'])
  })

  it('does let a decisive result replace a previous unknown', () => {
    const { store } = tempStore()
    const fingerprint = fingerprintModel(BASE)
    store.set(BASE.id, store.record(fingerprint, 'unknown', [], ACCOUNT))
    store.set(BASE.id, store.record(fingerprint, 'validating', ['high'], ACCOUNT))
    expect(store.get(BASE.id, fingerprint, ACCOUNT)?.efforts).toEqual(['high'])
  })

  it('reads a corrupt or foreign-version file as empty rather than throwing', () => {
    const { store, path } = tempStore()
    store.set(BASE.id, store.record(fingerprintModel(BASE), 'validating', ['low'], ACCOUNT))
    expect(store.all()).toHaveProperty(BASE.id)

    // A format version this reader does not know must not be half-understood.
    const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    document['version'] = 999
    writeFileSync(path, JSON.stringify(document))
    expect(new QoderProbeStore({ path, pluginVersion: '9.9.9' }).all()).toEqual({})

    // Garbage on disk reads as empty too, rather than taking the plugin down.
    writeFileSync(path, '{ not json')
    expect(new QoderProbeStore({ path, pluginVersion: '9.9.9' }).all()).toEqual({})
  })

  it('clears every record on request', () => {
    const { store } = tempStore()
    store.set(BASE.id, store.record(fingerprintModel(BASE), 'validating', ['low'], ACCOUNT))
    store.clear()
    expect(store.all()).toEqual({})
  })

  it('clears one account without touching another saved account', () => {
    const { store } = tempStore()
    store.set(BASE.id, store.record(fingerprintModel(BASE), 'validating', ['low'], 'acct-a'))
    store.set(DECLARED.id, store.record(fingerprintModel(DECLARED), 'validating', ['low'], 'acct-b'))
    store.clearFor('acct-a')
    expect(store.get(BASE.id, fingerprintModel(BASE), 'acct-a')).toBeUndefined()
    // The other saved account's observation survives: removing one PAT must
    // not erase the data of the accounts the user still has.
    expect(store.get(DECLARED.id, fingerprintModel(DECLARED), 'acct-b')).toBeDefined()
  })
})

describe('QoderProbeService precedence', () => {
  /** Minimal service with a caller-supplied consent answer. */
  function service(options: { consent: boolean; stored?: boolean }): QoderProbeService {
    const { store } = tempStore()
    const catalog = new QoderCatalog([BASE, DECLARED])
    if (options.stored === true) {
      store.set(BASE.id, store.record(fingerprintModel(BASE), 'validating', ['low', 'high'], ACCOUNT))
    }
    return new QoderProbeService({
      store,
      catalog,
      credentials: { current: async () => undefined } as never,
      client: {} as never,
      consent: () => options.consent,
      account: () => ACCOUNT,
    })
  }

  it('never answers from an observation when the upstream declares a set', () => {
    const probe = service({ consent: true, stored: true })
    // The declared row is declared-set-only even though an observation exists
    // for the same store; the undeclared sibling below proves the store has it.
    expect(probe.recordFor(DECLARED.id)).toBeUndefined()
  })

  it('returns the stored observation for an undeclared model', () => {
    const probe = service({ consent: true, stored: true })
    expect(probe.recordFor(BASE.id)?.efforts).toEqual(['low', 'high'])
  })

  it('refuses to probe without consent', async () => {
    const probe = service({ consent: false })
    const status = await probe.probe(BASE.id)
    expect(status.state).toBe('unavailable')
    expect(status.state === 'unavailable' && status.reason).toContain('not authorized')
  })
})

describe('newestFirst', () => {
  it('puts the most recent observation first', () => {
    // The store appends, so a just-run detection would land below every earlier one.
    const ordered = newestFirst([
      { probedAt: 100, id: 'oldest' },
      { probedAt: 300, id: 'newest' },
      { probedAt: 200, id: 'middle' },
    ])
    expect(ordered.map(entry => entry.id)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('does not mutate its input', () => {
    const input = [{ probedAt: 1 }, { probedAt: 2 }]
    newestFirst(input)
    expect(input.map(entry => entry.probedAt)).toEqual([1, 2])
  })
})

describe('recordFor: the single judgement the card and adapter share', () => {
  /** Both the card and the adapter now go through `recordFor`; these pin what it refuses. */
  function serviceFor(store: QoderProbeStore): QoderProbeService {
    return new QoderProbeService({
      store,
      catalog: new QoderCatalog([BASE, DECLARED]),
      credentials: { current: async () => undefined } as never,
      client: {} as never,
      consent: () => true,
      account: () => ACCOUNT,
    })
  }

  it('refuses a record whose catalog row changed', () => {
    const { store } = tempStore()
    const service = serviceFor(store)
    // Recorded against a fingerprint that no longer describes the row.
    store.set(BASE.id, store.record('stale-fingerprint', 'validating', ['low'], ACCOUNT))
    expect(service.recordFor(BASE.id)).toBeUndefined()
  })

  it('refuses an expired record even though the store still holds it', () => {
    let now = 1_000_000
    const dir = mkdtempSync(join(tmpdir(), 'qoder-probe-'))
    CLEANUP.push(dir)
    const store = new QoderProbeStore({ path: join(dir, 'state.json'), pluginVersion: '9.9.9', now: () => now })
    const service = serviceFor(store)
    store.set(BASE.id, store.record(fingerprintModel(BASE), 'validating', ['low'], ACCOUNT))
    expect(service.recordFor(BASE.id)?.efforts).toEqual(['low'])

    now += 15 * 24 * 60 * 60 * 1000
    // Past the TTL the card must stop reporting it, exactly as the adapter does.
    expect(service.recordFor(BASE.id)).toBeUndefined()
  })

  it('refuses a record for a model the catalog no longer lists', () => {
    const { store } = tempStore()
    const service = serviceFor(store)
    // A row recorded for an id the upstream has since dropped.
    store.set('retired-model', store.record('whatever', 'validating', ['low'], ACCOUNT))
    expect(service.recordFor('retired-model')).toBeUndefined()
  })

  it('refuses every record while signed out', () => {
    const { store } = tempStore()
    store.set(BASE.id, store.record(fingerprintModel(BASE), 'validating', ['low'], ACCOUNT))
    const service = new QoderProbeService({
      store,
      catalog: new QoderCatalog([BASE, DECLARED]),
      credentials: { current: async () => undefined } as never,
      client: {} as never,
      consent: () => true,
      account: () => undefined,
    })
    // A previous account's observation must not answer for nobody.
    expect(service.recordFor(BASE.id)).toBeUndefined()
  })
})
