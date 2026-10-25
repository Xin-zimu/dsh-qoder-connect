/**
 * The one UTC+8 day calculation the check-in logic is allowed to use.
 * The benefit window (10:00–09:59 next morning) is not a calendar date, so
 * transport and scheduler must name the day through this module only.
 *
 * @module dsh-qoder-connect/utc8
 */

/** Beijing time's offset from UTC, in minutes. */
export const UTC8_OFFSET_MINUTES = 480

/**
 * The UTC+8 wall clock of an instant, as a Date whose *local* fields hold it.
 * Read it with the local getters (`getHours`, `getFullYear`, …), not the UTC ones.
 */
export function utc8WallClock(atMs: number): Date {
  const d = new Date(atMs)
  return new Date(d.getTime() + (d.getTimezoneOffset() + UTC8_OFFSET_MINUTES) * 60_000)
}

/**
 * Format an epoch-ms instant as its UTC+8 calendar date, `YYYY-MM-DD`.
 */
export function formatUtc8Date(atMs: number): string {
  const utc8 = utc8WallClock(atMs)
  const y = utc8.getFullYear()
  const m = String(utc8.getMonth() + 1).padStart(2, '0')
  const day = String(utc8.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
