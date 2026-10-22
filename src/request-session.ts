/** Request attribution carried only across the authenticated loopback shim. */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

export const QODER_SESSION_HEADER = 'x-dsh-qoder-session-id'
export const QODER_PURPOSE_HEADER = 'x-dsh-qoder-request-purpose'

// PiAiAdapter forwards sessionId but omits purpose from its provider options.
// Keep purpose in this call's async context until its HTTP headers are built.
const requestPurpose = new AsyncLocalStorage<GenerateOptions['purpose']>()

/** Bind each iterator operation, including lazy dispatch and cancellation. */
export async function* withQoderRequestPurpose<T>(
  purpose: GenerateOptions['purpose'],
  stream: AsyncIterable<T>,
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]()
  let exhausted = false
  try {
    for (;;) {
      const next = await requestPurpose.run(purpose, () => iterator.next())
      if (next.done) {
        exhausted = true
        return
      }
      yield next.value
    }
  } finally {
    if (!exhausted) await requestPurpose.run(purpose, () => iterator.return?.())
  }
}

/** Copy request headers without retaining another call's attribution. */
export function qoderSessionHeaders(
  sessionId: string | undefined,
  headers?: Readonly<Record<string, string | null>>,
): Record<string, string | null> {
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) =>
      name.toLowerCase() !== QODER_SESSION_HEADER && name.toLowerCase() !== QODER_PURPOSE_HEADER)),
    [QODER_SESSION_HEADER]: sessionId === undefined ? null : encodeURIComponent(sessionId),
    [QODER_PURPOSE_HEADER]: requestPurpose.getStore() ?? null,
  }
}

/** Missing or malformed attribution never falls back to another conversation. */
export function readQoderSessionHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const sessionId = decodeURIComponent(value)
    return sessionId.length === 0 ? undefined : sessionId
  } catch {
    return undefined
  }
}

/** Only host-declared auxiliary purposes may influence the hint's visibility. */
export function readQoderPurposeHeader(value: string | string[] | undefined): GenerateOptions['purpose'] {
  return value === 'session-title' || value === 'compaction' ? value : undefined
}
