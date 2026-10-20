/** Shape check for the status document, shared by the card and the composer control. */

import type { QoderWebStatus } from '../status-paths.ts'

/**
 * Whether a parsed status response really is a status document.
 *
 * A 200 is no promise about the body: it may be empty, `null`, a non-JSON page,
 * or an array. Only the discriminator is checked, plus `error`'s `message`.
 */
export function isQoderWebStatus(value: unknown): value is QoderWebStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const wrapped = value as Record<string, unknown>
  const status = wrapped['status']
  if (status === 'signed-out' || status === 'signed-in') return true
  return status === 'error' && typeof wrapped['message'] === 'string'
}
