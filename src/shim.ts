/**
 * Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the shim
 * guards the local boundary and hands the raw JSON body to the upstream client,
 * which translates it onto the Qoder transport. Binds 127.0.0.1 only.
 *
 * The loopback bind alone is not a trust boundary (any local process or a
 * DNS-rebinding page can reach 127.0.0.1), so every request must carry a loopback
 * Host header, browser-sent Origins must be loopback, chat POSTs must be
 * application/json, and the Authorization header must carry the shim's per-process
 * shared secret.
 *
 * @module dsh-qoder-connect/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { QoderCredentialStore } from './auth.ts'
import type { QoderCatalog } from './catalog.ts'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { KIND_STATUS, type QoderUpstreamClient } from './upstream.ts'
import { QODER_PURPOSE_HEADER, QODER_SESSION_HEADER, readQoderPurposeHeader, readQoderSessionHeader } from './request-session.ts'

/** Minimal logger surface the plugin context already provides. */
export interface ShimLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** What the plugin needs from a running shim. */
export interface QoderShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the shim resolves the
   * real credential itself via the store.
   */
  token(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface QoderShimOptions {
  store: QoderCredentialStore
  client: Pick<QoderUpstreamClient, 'chatStream'>
  catalog: QoderCatalog
  /** Provider id reported as each model's `owned_by`; one per variant. */
  providerId: string
  logger?: ShimLogger
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  })
  res.end(payload)
}

/**
 * The prefix the shim stamps onto a failure message carrying an upstream retry
 * hint.
 *
 * The hint must cross two text-only boundaries to reach the harness retry policy,
 * so the marker is written in front of the 400-byte excerpt (never inside it,
 * where truncation could cut it off) and read back by {@link retryAfterFromMessage}.
 */
export const RETRY_AFTER_TAG = /\[retry-after=(\d+)s\]/u

/**
 * The upstream's retry hint, in milliseconds, recovered from a shim failure
 * message.
 *
 * The tagged form is the contract this plugin writes itself; the untagged
 * `retryAfterSeconds` form is the fallback for a message composed elsewhere.
 */
export function retryAfterFromMessage(message: string): number | undefined {
  const tagged = RETRY_AFTER_TAG.exec(message)
  if (tagged !== null) {
    const seconds = Number(tagged[1])
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
  }
  const body = /"retryAfterSeconds"\s*:\s*(\d+)/u.exec(message)
  if (body !== null) {
    const seconds = Number(body[1])
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
  }
  return undefined
}

/**
 * Seconds an OpenAI `Retry-After` header carries: the ceiling of the hint, so a
 * client that honors it never returns before the upstream's window closed.
 */
function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000))
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string, retryAfterMs?: number): void {
  const hint = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.floor(retryAfterMs)
    : undefined
  if (hint === undefined) {
    writeJson(res, status, { error: { message, type: kind, code: kind } })
    return
  }
  const seconds = retryAfterSeconds(hint)
  writeJson(
    res,
    status,
    { error: { message: `[retry-after=${seconds}s] ${message}`, type: kind, code: kind } },
    // `Retry-After` is the standard (RFC 9110, whole seconds); `retry-after-ms` is
    // what the OpenAI SDKs read first. The harness adapter reads the tag above,
    // but any other client of this endpoint gets the standard answer.
    { 'Retry-After': String(seconds), 'retry-after-ms': String(hint) },
  )
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Start the loopback endpoint. The upstream credential comes from the store alone;
 * the bearer checked is the per-process shared secret.
 */
export function createQoderShim(options: QoderShimOptions): QoderShim {
  const { store, client, catalog } = options
  const logger = options.logger
  const providerId = options.providerId

  // Per-process shared secret. Lives only in memory; the adapter resolves it as
  // the OpenAI apiKey, which pi-ai sends as `Authorization: Bearer ...`. It is
  // never forwarded upstream — the real credential comes from the store.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check; absent or mismatched bearers are rejected. */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const expected = SHARED_SECRET
    const a = Buffer.from(presented)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server: Server = createServer((req, res) => {
    // `handle` contains its own failures, but the attempt is wrapped once more: an
    // escaped rejection is an unhandled rejection, which Node turns into process
    // termination.
    void handle(req, res).catch((error: unknown) => {
      logger?.warn('dsh-qoder-connect: loopback request failed', error)
      try {
        if (!res.headersSent) writeOpenAIError(res, 500, 'internal', 'loopback request failed')
        else res.end()
      } catch {
        // The socket is already gone; nothing left to report to.
      }
    })
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error(`${providerId} shim has no listening address`)
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Inbound hardening: every request must name the loopback host, and
      // browser-sent origins must be loopback too.
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: providerId,
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
      } else {
        res.end()
      }
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    // Fail before reading a body the upstream can never accept: no stored or
    // environmental token means nothing here can answer.
    try {
      await store.resolve()
    } catch (error: unknown) {
      writeOpenAIError(res, KIND_STATUS.missing_credential, 'not_signed_in', String(error))
      return
    }

    const raw = (await readBody(req)).toString('utf8')

    const controller = new AbortController()
    // The response closing before it ends is the client going away — a stopped
    // turn. Listening on the request instead would fire as soon as its body was
    // read, which is not a cancellation.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort('client closed the response')
    })
    const sessionId = readQoderSessionHeader(req.headers[QODER_SESSION_HEADER])
    const purpose = readQoderPurposeHeader(req.headers[QODER_PURPOSE_HEADER])
    const result = await client.chatStream(raw, controller.signal, sessionId, purpose)

    if (!result.ok) {
      // The message quotes the shim's OUTBOUND status, never the upstream's
      // internal one: the harness's pi-ai error classifier matches 401/403 in the
      // message text, so quoting an upstream 403 here would report a queue answer
      // as a credential failure. The real status travels in the structured
      // `status` field.
      writeOpenAIError(
        res,
        KIND_STATUS[result.kind],
        result.kind,
        `${providerId} upstream ${result.kind} (http ${KIND_STATUS[result.kind]}): ${result.message.slice(0, 400)}`,
        result.retryAfterMs,
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let sawDone = false
    const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      if (chunk.includes('[DONE]')) sawDone = true
    })
    body.on('error', (error: unknown) => {
      logger?.warn('dsh-qoder-connect: upstream stream failed mid-flight', error)
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
    })
    body.pipe(res)
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}
