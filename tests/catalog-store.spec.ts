import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { qoderCredentialIdentity } from '../src/auth.ts'
import type { QoderModelInfo } from '../src/catalog.ts'
import { QoderCatalogStore, qoderCatalogPath } from '../src/catalog-store.ts'

/**
 * The saved catalog: the middle rung of the degradation order (§4) — live fetch →
 * this account's last successful fetch → the built-in roster. The tests that
 * matter prove it can never make things worse: a corrupt file reads as empty, a
 * foreign account's catalog is never served, and no secret is written. The account
 * key is `qoderCredentialIdentity({pat})` — `pat:` plus the first 16 hex of SHA-256.
 */

const CLEANUP: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const path of CLEANUP.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tempStore(): { store: QoderCatalogStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qoder-catalog-'))
  CLEANUP.push(dir)
  const path = join(dir, 'catalog.json')
  return { store: new QoderCatalogStore({ path }), path }
}

/** The two accounts, derived from real PATs the way the plugin does. */
const PAT_A = 'pt-alpha-0000000000000000000000aa'
const PAT_B = 'pt-bravo-1111111111111111111111bb'
const ACCOUNT_A = qoderCredentialIdentity({ pat: PAT_A })
const ACCOUNT_B = qoderCredentialIdentity({ pat: PAT_B })

function model(id: string): QoderModelInfo {
  return {
    id,
    name: id,
    contextWindow: 1000,
    maxTokens: 100,
    supportsImages: true,
    billing: { credits: 'x1.00', free: false },
  }
}

describe('QoderCatalogStore', () => {
  it('keys accounts by the hashed PAT identity, not the token', () => {
    expect(ACCOUNT_A).toMatch(/^pat:[0-9a-f]{16}$/)
    expect(ACCOUNT_A).not.toContain(PAT_A)
  })

  it('round-trips a catalog per account', () => {
    const { store, path } = tempStore()
    store.set(ACCOUNT_A, { source: 'qoder', fetchedAtMs: 111, models: [model('a')] })

    const reopened = new QoderCatalogStore({ path })
    const saved = reopened.get(ACCOUNT_A)
    expect(saved?.models.map(entry => entry.id)).toEqual(['a'])
    expect(saved?.source).toBe('qoder')
    expect(saved?.fetchedAtMs).toBe(111)
  })

  it('keeps accounts apart, so one account never serves another catalog', () => {
    const { store } = tempStore()
    store.set(ACCOUNT_A, { source: 's', fetchedAtMs: 1, models: [model('for-a')] })
    store.set(ACCOUNT_B, { source: 's', fetchedAtMs: 2, models: [model('for-b')] })
    expect(store.get(ACCOUNT_A)?.models.map(m => m.id)).toEqual(['for-a'])
    expect(store.get(ACCOUNT_B)?.models.map(m => m.id)).toEqual(['for-b'])
    expect(store.get(qoderCredentialIdentity({ pat: 'pt-other' }))).toBeUndefined()
  })

  it('replaces an account catalog rather than accumulating models', () => {
    const { store } = tempStore()
    store.set(ACCOUNT_A, { source: 's', fetchedAtMs: 1, models: [model('old')] })
    store.set(ACCOUNT_A, { source: 's', fetchedAtMs: 2, models: [model('new')] })
    expect(store.get(ACCOUNT_A)?.models.map(m => m.id)).toEqual(['new'])
  })

  it('forgets one account on request', () => {
    const { store } = tempStore()
    store.set(ACCOUNT_A, { source: 's', fetchedAtMs: 1, models: [model('a')] })
    store.delete(ACCOUNT_A)
    expect(store.get(ACCOUNT_A)).toBeUndefined()
    // Deleting an absent account is a no-op, not a crash.
    expect(() => store.delete(qoderCredentialIdentity({ pat: 'pt-none' }))).not.toThrow()
  })

  it('reads a corrupt or foreign-version file as empty instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qoder-catalog-bad-'))
    CLEANUP.push(dir)
    const cases = [
      'not json at all',
      '[]',
      JSON.stringify({ version: 99, entries: { [ACCOUNT_A]: { account: ACCOUNT_A, source: 's', fetchedAtMs: 1, models: [model('a')] } } }),
      JSON.stringify({ version: 1, entries: { [ACCOUNT_A]: { account: ACCOUNT_A, source: 's', fetchedAtMs: 1, models: [] } } }),
      JSON.stringify({ version: 1, entries: { [ACCOUNT_A]: { account: '', source: 's', fetchedAtMs: 1, models: [model('a')] } } }),
      JSON.stringify({ version: 1, entries: { [ACCOUNT_A]: { account: ACCOUNT_A, source: 's', fetchedAtMs: 1, models: [{ id: 'x' }] } } }),
    ]
    for (const [index, body] of cases.entries()) {
      const path = join(dir, `case-${index}.json`)
      writeFileSync(path, body)
      const store = new QoderCatalogStore({ path })
      expect(store.get(ACCOUNT_A), `case ${index} must read as empty`).toBeUndefined()
    }
  })

  it('writes no token material', () => {
    const { store, path } = tempStore()
    store.set(ACCOUNT_A, { source: 'qoder', fetchedAtMs: 1, models: [model('a')] })
    const text = readFileSync(path, 'utf8')
    // The file holds model metadata and the hashed account key only. The PAT
    // itself — and any WorkBuddy-era token vocabulary — must never reach it.
    expect(text).not.toContain(PAT_A)
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]+\./)
    expect(text).not.toMatch(/refreshToken|accessToken/i)
    expect(text).toContain(ACCOUNT_A)
  })

  it('survives an unwritable path without throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qoder-catalog-ro-'))
    CLEANUP.push(dir)
    // A NUL byte fails every filesystem call on this path, on any platform.
    const store = new QoderCatalogStore({ path: join(dir, 'bad\u0000catalog.json') })
    // Saving is best-effort: the models are already served, and a failed write must not crash.
    expect(() => store.set(ACCOUNT_A, { source: 's', fetchedAtMs: 1, models: [model('a')] })).not.toThrow()
    expect(() => store.get(ACCOUNT_A)).not.toThrow()
  })

  it('defaults its file into the plugin state directory, one per variant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qoder-catalog-path-'))
    CLEANUP.push(dir)
    vi.stubEnv('DSH_QODER_DATA_DIR', dir)
    expect(qoderCatalogPath('.qoder-catalog.json')).toBe(join(dir, 'state', '.qoder-catalog.json'))
    expect(qoderCatalogPath('.qoder-global-catalog.json')).toBe(join(dir, 'state', '.qoder-global-catalog.json'))
    expect(new QoderCatalogStore().filePath()).toBe(join(dir, 'state', '.qoder-catalog.json'))
  })
})
