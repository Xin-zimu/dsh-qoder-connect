import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderCatalog, type QoderModelInfo } from '../src/catalog.ts'
import { QoderProbeStore } from '../src/probe-store.ts'
import { QoderProbeService } from '../src/probe-service.ts'
import type { QoderCredentialStore } from '../src/auth.ts'
import type { QoderUpstreamClient } from '../src/upstream.ts'

/**
 * Queue, consent, deduplication and account-binding rules of the probe service.
 * The sender is injected, so nothing here touches the network.
 */

/** Undeclared but reasoning-capable: the only shape worth detecting. */
const PROBE_ME: QoderModelInfo = {
  id: 'probe-me',
  name: 'Probe Me',
  contextWindow: 180_000,
  maxTokens: 32_768,
  supportsImages: false,
  reasoning: { supports: true, canDisableThinking: false },
  billing: { free: false },
}

/** Declares its effort set: detection has nothing to add. */
const DECLARED: QoderModelInfo = {
  ...PROBE_ME,
  id: 'declared-model',
  reasoning: { supports: true, supportedEfforts: ['low', 'high'], canDisableThinking: false },
}

/** Not reasoning-capable at all: the Qoder catalog's plain rows. */
const NOT_REASONING: QoderModelInfo = {
  id: 'plain-model',
  name: 'Plain Model',
  contextWindow: 180_000,
  maxTokens: 32_768,
  supportsImages: false,
  billing: { free: false },
}

describe('manual probe consent and deduplication', () => {
  const paths: string[] = []
  afterEach(() => { paths.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })) })
  function setup(consent = false) {
    const path = mkdtempSync(join(tmpdir(), 'qoder-probe-service-'))
    paths.push(path)
    const catalog = new QoderCatalog([PROBE_ME, DECLARED, NOT_REASONING])
    const send = vi.fn(async () => ({ status: 200, streamed: true }))
    const service = new QoderProbeService({
      catalog,
      store: new QoderProbeStore({ path: join(path, 'state.json'), pluginVersion: 'test' }),
      credentials: {
        current: async () => ({ pat: 'pat-a', region: 'china' as const, source: 'card' as const }),
      } as unknown as QoderCredentialStore,
      client: {} as unknown as QoderUpstreamClient,
      consent: () => consent,
      account: () => 'pat:account-a',
      send: () => send,
    })
    return { service, send }
  }
  it('keeps automatic requests gated but permits one confirmed model without changing consent', async () => {
    const { service, send } = setup()
    expect((await service.probe(PROBE_ME.id)).state).toBe('unavailable')
    expect(send).not.toHaveBeenCalled()
    expect((await service.probe(PROBE_ME.id, true)).state).toBe('ok')
    expect(send).toHaveBeenCalledTimes(2)
    // The configuration was never flipped: an automatic request still refuses.
    expect((await service.probe(PROBE_ME.id)).state).toBe('unavailable')
  })
  it('does not spend twice when two conversations submit the same model', async () => {
    const { service, send } = setup()
    const results = await Promise.all([service.probe(PROBE_ME.id, true), service.probe(PROBE_ME.id, true)])
    expect(results.map(result => result.state)).toEqual(['ok', 'ok'])
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('does not make a new account join the previous account\'s pending probe', async () => {
    const path = mkdtempSync(join(tmpdir(), 'qoder-probe-service-'))
    paths.push(path)
    const catalog = new QoderCatalog([PROBE_ME, DECLARED, NOT_REASONING])
    let account = 'pat:account-a'
    let release: (() => void) | undefined
    let calls = 0
    const send = vi.fn(async () => {
      calls += 1
      if (calls === 1) await new Promise<void>(resolve => { release = resolve })
      return { status: 200, streamed: true }
    })
    const service = new QoderProbeService({
      catalog,
      store: new QoderProbeStore({ path: join(path, 'state.json'), pluginVersion: 'test' }),
      credentials: {
        current: async () => ({ pat: 'pat-a', region: 'china' as const, source: 'card' as const }),
      } as unknown as QoderCredentialStore,
      client: {} as unknown as QoderUpstreamClient,
      consent: () => false,
      account: () => account,
      send: () => send,
    })

    const probeA = service.probe(PROBE_ME.id, true)
    await vi.waitFor(() => { expect(calls).toBe(1) })
    account = 'pat:account-b'
    const probeB = service.probe(PROBE_ME.id, true)
    release?.()

    await expect(probeA).resolves.toMatchObject({ state: 'unavailable', reason: 'account changed during detection' })
    await expect(probeB).resolves.toMatchObject({ state: 'ok' })
    expect(send).toHaveBeenCalledTimes(4)
  })
  it('runs a fresh probe on each sequential manual confirmation', async () => {
    const { service, send } = setup()
    await service.probe(PROBE_ME.id, true)
    const result = await service.probe(PROBE_ME.id, true)
    expect(result).toMatchObject({ state: 'ok', requests: 2 })
    expect(send).toHaveBeenCalledTimes(4)
  })
  it('still reuses historical results for authorized automatic requests', async () => {
    const { service, send } = setup(true)
    await service.probe(PROBE_ME.id, true)
    expect(await service.probe(PROBE_ME.id)).toMatchObject({ state: 'ok', requests: 0 })
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('rejects declared and unknown models before sending', async () => {
    const { service, send } = setup()
    expect((await service.probe(DECLARED.id, true)).state).toBe('unavailable')
    expect((await service.probe(NOT_REASONING.id, true)).state).toBe('unavailable')
    expect((await service.probe('not-in-catalog', true)).state).toBe('unavailable')
    expect(send).not.toHaveBeenCalled()
  })
})
