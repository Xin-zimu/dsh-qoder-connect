import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QoderCredentialStore, QODER_PAT_ENV_CN, QODER_PAT_ENV_GLOBAL } from '../src/auth.ts'
import { QoderCatalog, FALLBACK_QODER_MODELS, type QoderModelInfo } from '../src/catalog.ts'
import { QODER_DATA_DIR_ENV } from '../src/paths.ts'
import { qoderProbeHandler } from '../src/probe-route.ts'
import { qoderStatusHandler } from '../src/web-status.ts'
import { CHINA_VARIANT, GLOBAL_VARIANT, type QoderVariant } from '../src/variants.ts'
import type { QoderUpstreamClient } from '../src/upstream.ts'

/**
 * Both variants' routes mounted side by side on one server, the way the plugin
 * mounts them: real handlers, real path constants, real loopback guards, so a
 * route parameterized onto the wrong variant fails here. No network —
 * `fetchCredits` is a stub, so no credit is spent and no real PAT is read.
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
  vi.unstubAllEnvs()
})

function patDocument(variant: QoderVariant, pat: string): string {
  return JSON.stringify({ version: 2, pat, region: variant.region, savedAt: 1_792_128_236_868 })
}

/** Raw request with full header control (fetch forbids overriding Host). */
function requestOnce(options: {
  port: number
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    outgoing.on('error', reject)
    if (options.body !== undefined) outgoing.write(options.body)
    outgoing.end()
  })
}

interface Mounted {
  port: number
  close: () => Promise<void>
}

/** Mount one variant's status and probe routes, as `apply()` does. */
async function mount(variant: QoderVariant, options: {
  catalog: QoderCatalog
  probeKey?: string
  authKey?: string
  /** Supply a refresh handler, as `apply()` does for a real variant. */
  refresh?: boolean
}): Promise<Mounted> {
  // The store derives its credential path from the data dir at construction,
  // so the env stub below must already be in place.
  const store = new QoderCredentialStore({ variant })
  const client: Pick<QoderUpstreamClient, 'fetchCredits'> = {
    fetchCredits: async () => ({ total: variant.id === 'qoder-global' ? 350 : 4663, accounts: [] }),
  }
  const handler = qoderStatusHandler({
    store,
    client,
    models: () => options.catalog.current(),
    catalog: () => ({ source: 'fallback' }),
    probe: () => ({ consent: true, running: false, candidates: [], results: [] }),
    ...options.probeKey === undefined ? {} : { probeKey: options.probeKey },
    ...options.authKey === undefined ? {} : { authKey: options.authKey },
  })
  const probes = new Map<string, number>()
  const probeHandler = qoderProbeHandler({
    probe: async modelId => { probes.set(modelId, (probes.get(modelId) ?? 0) + 1); return { state: 'ok' } },
    clear: () => { probes.clear() },
    ...options.refresh === true
      ? { refresh: async () => ({ state: 'refreshed', reason: `${options.catalog.current().length} models` }) }
      : {},
  }, options.probeKey ?? '')
  // One server per variant, both routes on it, matching the plugin's layout.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (path === variant.statusPath) void handler(req, res)
    else if (path === variant.probePath) void probeHandler(req, res)
    else { res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"no such route"}') }
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const mounted: Mounted = {
    port,
    close: () => new Promise<void>(resolve => { server.close(() => { resolve() }) }),
  }
  CLEANUP.push(mounted.close)
  return mounted
}

/**
 * A temporary plugin data directory, stubbed as `DSH_QODER_DATA_DIR`: each
 * variant's store reads exactly one file, `<dataDir>/<ownFilename>`, so a case
 * that writes none is signed out and no real token can be read.
 */
async function tempDataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qoder-routes-'))
  CLEANUP.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv(QODER_DATA_DIR_ENV, root)
  vi.stubEnv(QODER_PAT_ENV_CN, '')
  vi.stubEnv(QODER_PAT_ENV_GLOBAL, '')
  return root
}

/** Serve one variant a saved PAT it owns. */
async function grantPat(variant: QoderVariant, pat: string, root?: string): Promise<void> {
  const dir = root ?? await tempDataRoot()
  await writeFile(join(dir, variant.ownFilename), patDocument(variant, pat))
}

function model(id: string): QoderModelInfo {
  return { id, name: id.toUpperCase(), contextWindow: 100_000, maxTokens: 1024, supportsImages: false, billing: { free: false } }
}

describe('per-variant route mount', () => {
  it('serves each variant its own identity, credits, and models', async () => {
    // One data directory holding both variants' own credential files: the
    // China variant writes `.qoder-auth.json`, the international one
    // `.qoder-global-auth.json`, and neither may read the other's.
    const root = await tempDataRoot()
    await grantPat(CHINA_VARIANT, 'pt-cn-abcd', root)
    await grantPat(GLOBAL_VARIANT, 'pt-gl-efgh', root)

    const cnCatalog = new QoderCatalog([model('cn-only-a'), model('cn-only-b')])
    const aiCatalog = new QoderCatalog([model('global-only-a')])
    const cn = await mount(CHINA_VARIANT, { catalog: cnCatalog, probeKey: 'key-cn', authKey: 'auth-cn' })
    const ai = await mount(GLOBAL_VARIANT, { catalog: aiCatalog, probeKey: 'key-ai', authKey: 'auth-ai' })

    const cnBody = JSON.parse((await requestOnce({
      port: cn.port, method: 'GET', path: CHINA_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${cn.port}`, accept: 'application/json' },
    })).body) as Record<string, unknown>
    const aiBody = JSON.parse((await requestOnce({
      port: ai.port, method: 'GET', path: GLOBAL_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${ai.port}`, accept: 'application/json' },
    })).body) as Record<string, unknown>

    expect(cnBody['status']).toBe('signed-in')
    expect(aiBody['status']).toBe('signed-in')
    // Each arm speaks its own region and displays its own token's tail.
    expect(cnBody['region']).toBe('china')
    expect(aiBody['region']).toBe('global')
    expect((cnBody['pat'] as Record<string, unknown>)['patTail']).toBe('abcd')
    expect((aiBody['pat'] as Record<string, unknown>)['patTail']).toBe('efgh')
    // The control keys never cross arms either.
    expect(cnBody['authKey']).toBe('auth-cn')
    expect(aiBody['authKey']).toBe('auth-ai')
    // Separate balances: the whole reason the cards are separate.
    expect(cnBody['credits']).toMatchObject({ total: 4663 })
    expect(aiBody['credits']).toMatchObject({ total: 350 })

    // Disjoint rosters, each served through its own catalog.
    const cnModels = (cnBody['models'] as { id: string }[]).map(m => m.id)
    const aiModels = (aiBody['models'] as { id: string }[]).map(m => m.id)
    expect(cnModels).toEqual(['cn-only-a', 'cn-only-b'])
    expect(aiModels).toEqual(['global-only-a'])
    expect(cnModels).not.toContain('global-only-a')
    expect(aiModels).not.toContain('cn-only-a')
  })

  it('answers 404 on the other variant\'s path, so the routes stay distinct', async () => {
    await tempDataRoot()
    const cn = await mount(CHINA_VARIANT, { catalog: new QoderCatalog(FALLBACK_QODER_MODELS) })
    // The global path is not mounted on this server; a shared path constant
    // would make this succeed and cross the two cards' state.
    const response = await requestOnce({
      port: cn.port, method: 'GET', path: GLOBAL_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${cn.port}` },
    })
    expect(response.status).toBe(404)
  })

  it('hides every model when the catalog is gated off', async () => {
    const catalog = new QoderCatalog(FALLBACK_QODER_MODELS)
    await grantPat(GLOBAL_VARIANT, 'pt-gated-wxyz')
    const server = await mount(GLOBAL_VARIANT, { catalog })
    catalog.setVisible(false)
    const signed = JSON.parse((await requestOnce({
      port: server.port, method: 'GET', path: GLOBAL_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${server.port}` },
    })).body) as Record<string, unknown>
    // Nothing to pick: the group is hidden even though the card still answers.
    expect(signed['status']).toBe('signed-in')
    expect(signed['models']).toBeUndefined()
  })

  it('keeps the loopback guards on both variants\' routes', async () => {
    const catalog = new QoderCatalog(FALLBACK_QODER_MODELS)
    await grantPat(GLOBAL_VARIANT, 'pt-guard-wxyz')
    const server = await mount(GLOBAL_VARIANT, { catalog, probeKey: 'key-ai' })

    // A DNS-rebinding page addresses the request to its own domain.
    const rebound = await requestOnce({
      port: server.port, method: 'GET', path: GLOBAL_VARIANT.statusPath,
      headers: { host: 'evil.example.com' },
    })
    expect(rebound.status).toBe(403)

    // A cross-origin browser Origin is refused too.
    const crossOrigin = await requestOnce({
      port: server.port, method: 'GET', path: GLOBAL_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${server.port}`, origin: 'https://evil.example.com' },
    })
    expect(crossOrigin.status).toBe(403)

    // And the probe route needs the in-process key, on the global path as well.
    const noKey = await requestOnce({
      port: server.port, method: 'POST', path: GLOBAL_VARIANT.probePath,
      headers: { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'probe', model: 'cmodel' }),
    })
    expect(noKey.status).toBe(403)

    const wrongKey = await requestOnce({
      port: server.port, method: 'POST', path: GLOBAL_VARIANT.probePath,
      headers: {
        host: `127.0.0.1:${server.port}`,
        'content-type': 'application/json',
        'x-qoder-probe-key': 'key-cn',
      },
      body: JSON.stringify({ action: 'probe', model: 'cmodel' }),
    })
    // The CN card's key must not authorize the global route.
    expect(wrongKey.status).toBe(403)

    const ok = await requestOnce({
      port: server.port, method: 'POST', path: GLOBAL_VARIANT.probePath,
      headers: {
        host: `127.0.0.1:${server.port}`,
        'content-type': 'application/json',
        'x-qoder-probe-key': 'key-ai',
      },
      body: JSON.stringify({ action: 'probe', model: 'cmodel' }),
    })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body)).toMatchObject({ state: 'ok' })
  })

  it('never serves a stale WorkBuddy-era credential as a sign-in', async () => {
    // A WorkBuddy-era document sitting in the *international* variant's own
    // credential file: copying one product's file over the other's produces
    // exactly this. The Qoder store must refuse it, not fake-migrate it.
    const root = await tempDataRoot()
    await writeFile(join(root, GLOBAL_VARIANT.ownFilename), JSON.stringify({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 1_792_128_236,
      domain: 'www.codebuddy.cn',
    }))
    const server = await mount(GLOBAL_VARIANT, { catalog: new QoderCatalog(FALLBACK_QODER_MODELS), authKey: 'auth-ai' })
    const body = JSON.parse((await requestOnce({
      port: server.port, method: 'GET', path: GLOBAL_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${server.port}` },
    })).body) as Record<string, unknown>
    // Signed out with an explanation and a reachable fix, rather than signed
    // in off a document this plugin cannot honor.
    expect(body['status']).toBe('signed-out')
    expect(String(body['reason'])).toMatch(/stale WorkBuddy credential file/)
    expect(String(body['reason'])).toMatch(/Personal Access Token/)
    // The signed-out arm carries no token material and no model list, but the
    // PAT key rides along so the card can offer the action that resolves it.
    expect(body['pat']).toBeUndefined()
    expect(body['models']).toBeUndefined()
    expect(body['authKey']).toBe('auth-ai')
  })

  it('reports where the served model list came from', async () => {
    const catalog = new QoderCatalog(FALLBACK_QODER_MODELS)
    await grantPat(GLOBAL_VARIANT, 'pt-prov-wxyz')
    const server = await mount(GLOBAL_VARIANT, { catalog })
    const body = JSON.parse((await requestOnce({
      port: server.port, method: 'GET', path: GLOBAL_VARIANT.statusPath,
      headers: { host: `127.0.0.1:${server.port}` },
    })).body) as Record<string, unknown>
    // Pin that the saved token really signed the card in: `catalog` is
    // omitted entirely on the signed-out branch, so a broken fixture would
    // make the provenance assertion below fail for the wrong reason.
    expect(body['status']).toBe('signed-in')
    // Without provenance a stale list is indistinguishable from a fresh one.
    expect(body['catalog']).toMatchObject({ source: 'fallback' })
  })

  it('gates the refresh action behind the same in-process key as probing', async () => {
    await tempDataRoot()
    await grantPat(GLOBAL_VARIANT, 'pt-refresh-wxyz')
    const catalog = new QoderCatalog(FALLBACK_QODER_MODELS)
    const server = await mount(GLOBAL_VARIANT, { catalog, probeKey: 'key-ai', refresh: true })
    const post = (headers: Record<string, string>) => requestOnce({
      port: server.port, method: 'POST', path: GLOBAL_VARIANT.probePath,
      headers: { host: `127.0.0.1:${server.port}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ action: 'refresh' }),
    })
    // A refresh spends an upstream request, so it is a write: unauthenticated
    // callers are refused exactly like an unauthenticated probe.
    expect((await post({})).status).toBe(403)
    const ok = await post({ 'x-qoder-probe-key': 'key-ai' })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body)).toMatchObject({ state: 'refreshed' })
  })

  it('answers 404 for refresh when the mount supplies no handler', async () => {
    // A route without a refresh handler must say so rather than silently
    // reporting success.
    await tempDataRoot()
    await grantPat(GLOBAL_VARIANT, 'pt-noref-wxyz')
    const server = await mount(GLOBAL_VARIANT, {
      catalog: new QoderCatalog(FALLBACK_QODER_MODELS),
      probeKey: 'key-ai',
    })
    const response = await requestOnce({
      port: server.port, method: 'POST', path: GLOBAL_VARIANT.probePath,
      headers: {
        host: `127.0.0.1:${server.port}`,
        'content-type': 'application/json',
        'x-qoder-probe-key': 'key-ai',
      },
      body: JSON.stringify({ action: 'refresh' }),
    })
    expect(response.status).toBe(404)
  })
})
