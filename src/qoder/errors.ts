/**
 * DSH-compatible LLM error representation.
 *
 * @module dsh-provider-qoder/qoder/errors
 */

import { LlmError, ProviderRequestId, type LlmErrorOptions } from '@deepseek-ai/dsh-llm'
import { qoderResultCode } from './codes.ts'

export class QoderLlmError extends LlmError {
  constructor(message: string, code: string = 'UNKNOWN_ERROR', options?: LlmErrorOptions) {
    super(message, code, options)
  }
}

/** Queue/limit markers Qoder puts in a rejection body. */
const QUEUE_BODY_MARKERS: readonly RegExp[] = [
  /"code"\s*:\s*"?10605"?/u,
  /"isQueued"\s*:\s*true/u,
  /"queueCount"/u,
  /"serviceAvailable"\s*:\s*false/u,
] as const

/** What a queue-shaped rejection body reports about the pending entry. */
export interface QoderQueueSignal {
  /** Milliseconds the upstream asked us to wait before asking again. */
  retryAfterMs?: number
  /** Queue class the entry belongs to, used as a poll filter. */
  queueType?: string
}

/**
 * Returns the queue signal when a rejection body is Qoder's queue answer rather
 * than an authorization failure, otherwise `undefined`.
 */
export function qoderQueueSignal(body: string | undefined): QoderQueueSignal | undefined {
  if (body === undefined || body === '') return undefined
  // Bodies are often JSON nested inside the SSE envelope, so every inner quote
  // arrives escaped (`\"retryAfterSeconds\":30`); no marker depends on backslashes.
  const text = body.replace(/\\/gu, '')
  if (!QUEUE_BODY_MARKERS.some(marker => marker.test(text))) return undefined
  const match = /"retryAfterSeconds"\s*:\s*(\d+)/u.exec(text)
  const queueType = /"queueType"\s*:\s*"([^"]+)"/u.exec(text)
  return {
    ...match === null ? {} : { retryAfterMs: Number(match[1]) * 1000 },
    ...queueType === null ? {} : { queueType: queueType[1] },
  }
}

/**
 * Replaces status digits with a neutral word so a throttle or quota answer is
 * not read as a dead credential (`401`/`403` in text outrank structured codes).
 *
 * @param message - the message to neutralize.
 * @param replacement - the neutral word substituted for the digits.
 */
function deauthorizeDigits(message: string, replacement = 'throttled'): string {
  return message.replace(/\b(?:401|403)\b/gu, replacement)
}

/** Maps an HTTP response and optional body to a `QoderLlmError`, preferring body signals over status. */
export function qoderHttpError(
  message: string,
  response: { status: number; headers?: Pick<Headers, 'get'> },
  body?: string,
): QoderLlmError {
  const { status } = response
  const headerRetryAfterMs = retryAfterMs(response.headers?.get('retry-after') ?? null)
  const requestId = qoderRequestId(response.headers)
  // A 401/403/429 carrying queue markers is a throttle; fall back to the message,
  // which embeds the body on the SSE envelope path.
  const queue = status === 401 || status === 403 || status === 429
    ? qoderQueueSignal(body ?? message)
    : undefined
  if (queue !== undefined) {
    const retryAfterMs = queue.retryAfterMs ?? headerRetryAfterMs
    // The digits must not survive: the downstream pi-ai classifier matches them in
    // message text before any code. Status and queue facts stay on the failure.
    return new QoderLlmError(deauthorizeDigits(message), 'RATE_LIMIT', {
      status,
      ...retryAfterMs === undefined ? {} : { providerRetryAfterMs: retryAfterMs },
      ...requestId === undefined ? {} : { requestId },
    })
  }
  // A documented quota code is the only sign of an exhausted daily counter behind
  // a 403. Only documented codes count, so a mirrored `code` keeps routing by status.
  const documented = qoderResultCode(body ?? message)
  if (documented?.family === 'quota') {
    // No `providerRetryAfterMs`: a spent daily window is not a retry-after hint.
    return new QoderLlmError(deauthorizeDigits(message, 'limited'), 'QUOTA', {
      status,
      ...requestId === undefined ? {} : { requestId },
    })
  }
  // Qoder can name a request/policy code (406/416/430/80411/80412) while answering
  // 401/403; that is a request failure, not a dead credential.
  if (documented?.family === 'request' && (status === 401 || status === 403)) {
    return new QoderLlmError(deauthorizeDigits(message, 'rejected'), 'INVALID_REQUEST', {
      status,
      ...requestId === undefined ? {} : { requestId },
    })
  }
  const code = status === 401 || status === 403
    ? 'AUTH'
    : status === 408
      ? 'TIMEOUT'
      : status === 429
        ? 'RATE_LIMIT'
        : status >= 500 && status <= 599
          ? 'SERVER'
          : status >= 400 && status <= 499
            ? 'INVALID_REQUEST'
            : 'PROVIDER_ERROR'
  return new QoderLlmError(message, code, {
    status,
    ...headerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: headerRetryAfterMs },
    ...requestId === undefined ? {} : { requestId },
  })
}

/** Reads a request id from the upstream headers, or `undefined` when absent. */
export function qoderRequestId(headers?: Pick<Headers, 'get'>): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers?.get('x-request-id')
    ?? headers?.get('request-id')
    ?? headers?.get('x-amzn-requestid')
  const normalized = value?.trim()
  return normalized ? ProviderRequestId(normalized) : undefined
}

/**
 * Codes that keep an upstream 401/403 status without being credential
 * rejections: the queue answer and a spent usage window, neither fixable by a
 * fresh job token, so healing them would waste the exchange and the retry.
 */
const NON_AUTH_STATUS_CODES: readonly string[] = ['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA']

/**
 * Whether this failure is an upstream authorization rejection worth one re-auth
 * retry. A code in {@link NON_AUTH_STATUS_CODES} is never a candidate, even
 * when its status is 401/403.
 */
export function isQoderAuthRejection(error: unknown): error is LlmError {
  if (!(error instanceof LlmError)) return false
  if (NON_AUTH_STATUS_CODES.includes(error.code)) return false
  return error.code === 'AUTH' || error.failure.status === 401 || error.failure.status === 403
}

/** Seconds or an HTTP date to a positive delay in ms; `undefined` when unusable. */
export function retryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  const normalized = value?.trim()
  if (!normalized) return undefined
  if (/^\d+$/u.test(normalized)) {
    const delayMs = Number(normalized) * 1000
    return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : undefined
  }
  const retryAt = Date.parse(normalized)
  if (Number.isNaN(retryAt)) return undefined
  const delayMs = retryAt - nowMs
  return delayMs > 0 ? delayMs : undefined
}
