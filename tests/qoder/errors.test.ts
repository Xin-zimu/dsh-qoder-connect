import test from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { QoderLlmError, isQoderAuthRejection, qoderHttpError, qoderQueueSignal, retryAfterMs } from '../../src/qoder/errors.ts'

test('QoderLlmError is a structured DSH LlmError', () => {
  const error = new QoderLlmError('unavailable', 'SERVER', { status: 503 })
  assert.ok(error instanceof LlmError)
  assert.deepEqual(error.failure, { message: 'unavailable', code: 'SERVER', status: 503 })
})

test('qoderHttpError maps HTTP status classes to DSH error codes', () => {
  const cases = [
    [400, 'INVALID_REQUEST'],
    [401, 'AUTH'],
    [403, 'AUTH'],
    [408, 'TIMEOUT'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
    [503, 'SERVER'],
  ] as const
  for (const [status, code] of cases) {
    const error = qoderHttpError(`HTTP ${status}`, new Response(null, { status }))
    assert.equal(error.code, code)
    assert.equal(error.failure.status, status)
  }
})

test('retryAfterMs accepts delay-seconds and future HTTP dates', () => {
  const now = Date.parse('2026-09-03T00:00:00Z')
  assert.equal(retryAfterMs('3', now), 3000)
  assert.equal(retryAfterMs('Wed, 03 Sep 2026 00:00:05 GMT', now), 5000)
  assert.equal(retryAfterMs('0', now), undefined)
  assert.equal(retryAfterMs('invalid', now), undefined)
  assert.equal(retryAfterMs('Wed, 02 Sep 2026 00:00:00 GMT', now), undefined)
})

test('qoderHttpError preserves an upstream request id', () => {
  const error = qoderHttpError('unavailable', {
    status: 503,
    headers: new Headers({ 'x-request-id': 'request-42' }),
  })
  assert.equal(error.failure.requestId, 'request-42')
})

test('qoderQueueSignal detects the upstream queue answer', () => {
  // The upstream's queue answer, double-encoded: outer code "403", inner "10605".
  const queueBody = JSON.stringify({
    code: '403',
    message: JSON.stringify({
      code: '10605',
      message: JSON.stringify({
        isQueued: true,
        modelKey: 'qfmodel',
        queueCount: 8887,
        queueType: 'p3',
        retryAfterSeconds: 30,
        serviceAvailable: true,
        waitTime: 274,
      }),
    }),
  })
  assert.deepEqual(qoderQueueSignal(queueBody), { retryAfterMs: 30_000, queueType: 'p3' })
  assert.deepEqual(qoderQueueSignal('{"isQueued":true}'), {})
  assert.deepEqual(qoderQueueSignal('{"serviceAvailable":false}'), {})
  assert.equal(qoderQueueSignal('{"code":"403","message":"invalid job token"}'), undefined)
  assert.equal(qoderQueueSignal(''), undefined)
  assert.equal(qoderQueueSignal(undefined), undefined)
})

test('qoderHttpError reads a queued 401/403 as RATE_LIMIT, not AUTH', () => {
  // A queued 401/403 must code RATE_LIMIT: AUTH fired job-token exchanges that
  // cannot jump a queue and muted the host's rate-limit retry.
  const queueBody = JSON.stringify({
    code: '10605',
    message: JSON.stringify({
      isQueued: true,
      modelKey: 'qfmodel',
      queueCount: 8887,
      queueType: 'p3',
      retryAfterSeconds: 30,
      serviceAvailable: true,
      waitTime: 274,
    }),
  })
  const error = qoderHttpError(
    `Qoder service returned upstream error status 403: ${queueBody}`,
    { status: 403 },
    queueBody,
  )
  assert.equal(error.code, 'RATE_LIMIT')
  assert.equal(error.failure.status, 403)
  assert.equal(error.failure.providerRetryAfterMs, 30_000)
  // The digits must go: dsh-llm-pi-ai matches 401/403 in text ahead of its
  // rate-limit test, so a queued message quoting one reads as a dead credential.
  assert.doesNotMatch(error.message, /\b(?:401|403)\b/u)
  assert.match(error.message, /throttled/u)
  // The diagnostic facts survive: 10605 and the queue markers stay readable.
  assert.match(error.message, /10605/u)
  assert.match(error.message, /retryAfterSeconds/u)

  // No retryAfterSeconds: still a throttle, and the backoff follows the host's policy.
  const noRetryAfter = qoderHttpError('queued', { status: 401 }, '{"isQueued":true}')
  assert.equal(noRetryAfter.code, 'RATE_LIMIT')
  assert.equal(noRetryAfter.failure.providerRetryAfterMs, undefined)
  assert.doesNotMatch(noRetryAfter.message, /\b(?:401|403)\b/u)

  // A queue answer with no retry-after header falls back to the header.
  const headerFallback = qoderHttpError('queued', {
    status: 403,
    headers: new Headers({ 'retry-after': '7' }),
  }, '{"queueCount":42}')
  assert.equal(headerFallback.code, 'RATE_LIMIT')
  assert.equal(headerFallback.failure.providerRetryAfterMs, 7000)

  // A plain 403 with no queue markers stays AUTH, body-less routing included.
  const plain = qoderHttpError('forbidden', { status: 403 }, '{"message":"quota exhausted"}')
  assert.equal(plain.code, 'AUTH')
  const bodyless = qoderHttpError('HTTP 403', new Response(null, { status: 403 }))
  assert.equal(bodyless.code, 'AUTH')
})

test('isQoderAuthRejection refuses a queued 401/403 even though the status matches', () => {
  // The status arm alone still saw AUTH, so the heal ran: a queued 401/403 must be refused.
  const queued = qoderHttpError('queued', { status: 403 }, '{"code":"10605","retryAfterSeconds":30}')
  assert.equal(queued.code, 'RATE_LIMIT')
  assert.equal(isQoderAuthRejection(queued), false)
  assert.equal(isQoderAuthRejection(qoderHttpError('forbidden', { status: 403 })), true)
  assert.equal(isQoderAuthRejection(qoderHttpError('forbidden', { status: 401 })), true)
  assert.equal(isQoderAuthRejection(new Error('boom')), false)

  // A quota 401/403 keeps the status while saying the token is fine: the heal
  // would spend an exchange on a window it cannot change and report a failed refresh.
  for (const code of ['110', '113', '118']) {
    const body = JSON.stringify({ code, message: 'limit reached' })
    const quota = qoderHttpError(`HTTP 403: ${body}`, { status: 403 }, body)
    assert.equal(quota.code, 'QUOTA')
    assert.equal(isQoderAuthRejection(quota), false, `code ${code} must not trigger a re-auth`)
  }
  const accountQuota = new QoderLlmError('spent', 'ACCOUNT_QUOTA', { status: 403 })
  assert.equal(isQoderAuthRejection(accountQuota), false)
})

test('qoderHttpError reads a documented request code as a request failure, not AUTH', () => {
  // A documented request code (content refusal, over-long input) is a request
  // failure: pi-ai has no code for either, and AUTH would be a lie.
  const refusal = JSON.stringify({ code: '406', message: 'Request blocked because of sensitive content' })
  const error = qoderHttpError(
    `Qoder service returned upstream error status 403: ${refusal}`,
    { status: 403 },
    refusal,
  )
  assert.equal(error.code, 'INVALID_REQUEST')
  // The upstream's real status survives for diagnostics.
  assert.equal(error.failure.status, 403)
  // Without this the digits re-arm pi-ai's first test and read as a dead credential.
  assert.doesNotMatch(error.message, /\b(?:401|403)\b/u)
  assert.match(error.message, /406/u)
  assert.match(error.message, /sensitive content/u)

  for (const code of ['416', '430', '80411', '80412']) {
    const body = JSON.stringify({ code, message: 'rejected' })
    assert.equal(
      qoderHttpError(`HTTP 403: ${body}`, { status: 403 }, body).code,
      'INVALID_REQUEST',
      `code ${code} must not be read as an authorization failure`,
    )
  }

  // An undocumented 401/403 still routes by status; 105 stays AUTH.
  assert.equal(qoderHttpError('forbidden', { status: 403 }, '{"message":"blocked"}').code, 'AUTH')
  const expired = JSON.stringify({ code: '105', message: 'Login or access token expired' })
  assert.equal(qoderHttpError(`HTTP 401: ${expired}`, { status: 401 }, expired).code, 'AUTH')
})

test('qoderHttpError reads a documented quota code as QUOTA, not AUTH', () => {
  // An exhausted daily billing counter answers HTTP 403 with code 110: QUOTA,
  // never AUTH — no fresh token fixes it, and the counter resets by itself.
  const body = JSON.stringify({ code: '110', message: 'Billing daily count exceeded' })
  const error = qoderHttpError(
    `Qoder service returned upstream error status 403: ${body}`,
    { status: 403 },
    body,
  )
  assert.equal(error.code, 'QUOTA')
  // The upstream's real status survives for diagnostics.
  assert.equal(error.failure.status, 403)
  // No retry hint: a daily counter is not a "try again in N seconds" window, and
  // the host never retries QUOTA anyway.
  assert.equal(error.failure.providerRetryAfterMs, undefined)
  // The digits must go: pi-ai matches 401/403 ahead of its quota test.
  assert.doesNotMatch(error.message, /\b(?:401|403)\b/u)
  // The cause stays readable: the documented code and the upstream's own words.
  assert.match(error.message, /110/u)
  assert.match(error.message, /Billing daily count exceeded/u)

  // The whole documented quota family routes the same way, not just 110.
  for (const code of ['113', '114', '115', '116', '117', '118', '119', '122']) {
    const familyBody = JSON.stringify({ code, message: 'limit reached' })
    assert.equal(
      qoderHttpError(`HTTP 403: ${familyBody}`, { status: 403 }, familyBody).code,
      'QUOTA',
      `code ${code} must route to QUOTA`,
    )
  }

  // A `code` field that merely mirrors the status is not a documented code, so
  // prose mentioning "quota" stays AUTH.
  const prose = qoderHttpError('forbidden', { status: 403 }, '{"code":403,"message":"quota exhausted"}')
  assert.equal(prose.code, 'AUTH')
})
