/**
 * Sidebar quota merging: collapse same-named packages into one bar.
 *
 * The upstream reports one entry per purchased package, and an account can hold
 * several entries of the SAME name, so they are grouped into one bar per package
 * name instead of listing near-duplicates. Pure functions: no React, no fetch.
 */

import type { QoderWebCreditAccount } from '../status-paths.ts'

/** Languages the plugin can label a package in (the upstream sends `zh`/`en`). */
export type QuotaTitleLanguage = 'zh' | 'en'

/**
 * The active UI language. Both surfaces label the SAME package and must not pick
 * different words for it, so the client entry mirrors `ctx.locale` into here; a
 * host that never calls the setter leaves `zh`.
 */
let activeLanguage: QuotaTitleLanguage = 'zh'

/** Record the host's active locale; anything but `en` selects the Chinese title. */
export function setActiveLanguage(localeId: string | undefined): void {
  activeLanguage = typeof localeId === 'string' && localeId.toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/** The language currently labelling packages. */
export function currentLanguage(): QuotaTitleLanguage {
  return activeLanguage
}

/**
 * The label one credit account renders with: the active language's title when a
 * title map exists, the other language as backstop, else the upstream
 * `packageName` (never the campaign code the upstream `name` field carries).
 */
export function accountDisplayName(
  account: { packageName: string; packageNameI18n?: { zh?: string | undefined; en?: string | undefined } },
  language: QuotaTitleLanguage = activeLanguage,
): string {
  const titles = account.packageNameI18n
  if (titles === undefined) return account.packageName
  const other: QuotaTitleLanguage = language === 'en' ? 'zh' : 'en'
  return titles[language] ?? titles[other] ?? account.packageName
}

/**
 * Format an upstream expiry instant the way every quota surface prints dates:
 * localized, not the raw ISO string. An unparseable value stays verbatim rather
 * than becoming a made-up date.
 */
export function formatExpiryText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return new Intl.DateTimeFormat(hostLocale(), { dateStyle: 'medium' }).format(new Date(parsed))
}

/** Format an instant with its time of day (the PAT's authorization line needs the clock time). */
export function formatStampText(atMs: number): string {
  return new Intl.DateTimeFormat(hostLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(atMs))
}

/** The BCP-47 tag the active language formats dates with. */
function hostLocale(): string {
  return activeLanguage === 'en' ? 'en-US' : 'zh-CN'
}

/** One merged sidebar row: a package group and its summed figures. */
export interface QuotaGroup {
  /** Package display name, verbatim from the upstream. */
  packageName: string
  /** Localized titles of the first member, so the row can re-label itself. */
  packageNameI18n?: { zh?: string | undefined; en?: string | undefined }
  /** The group's expiry, verbatim, or undefined when no member reported one. */
  packageEndTime: string | undefined
  /** Summed remaining credit across the group's members. */
  remain: number
  /** Summed total across the group's members. */
  size: number
  /** Any member is unlimited — the group renders as unlimited, not as sums. */
  unlimited: boolean
}

/**
 * Group credit accounts by package NAME and sum each group.
 *
 * The key is the name alone: same-named packages whose expiries differ by
 * seconds are still one overview row (the group carries the earliest expiry for
 * the sort/visibility rules; the per-expiry breakdown lives in the dashboard).
 * A missing figure counts as 0 — the merge never invents a denominator — and
 * `unlimited` is sticky across members.
 *
 * @param accounts - the status document's per-package credit entries.
 * @returns one group per distinct package name, in first-seen order.
 */
export function mergeCreditAccounts(accounts: readonly QoderWebCreditAccount[]): QuotaGroup[] {
  const groups = new Map<string, QuotaGroup>()
  for (const account of accounts) {
    const key = account.packageName
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        packageName: account.packageName,
        ...account.packageNameI18n === undefined ? {} : { packageNameI18n: account.packageNameI18n },
        packageEndTime: account.packageEndTime,
        remain: account.remain,
        size: account.size,
        unlimited: account.unlimited === true,
      })
      continue
    }
    // A missing figure counts as 0: the sum may understate, never fabricate.
    existing.remain += account.remain
    existing.size += account.size
    existing.unlimited = existing.unlimited || account.unlimited === true
    // Keep the EARLIEST expiry: the soonest deadline is the meaningful one.
    if (existing.packageEndTime !== undefined && account.packageEndTime !== undefined) {
      const a = Date.parse(existing.packageEndTime)
      const b = Date.parse(account.packageEndTime)
      if (!Number.isNaN(a) && !Number.isNaN(b) && b < a) existing.packageEndTime = account.packageEndTime
    } else {
      existing.packageEndTime = existing.packageEndTime ?? account.packageEndTime
    }
  }
  return [...groups.values()]
}

/** Clamp helper shared by the card's percent math. */
export function clampPercent(remain: number, size: number): number | undefined {
  if (!(size > 0)) return undefined
  const percent = (remain / size) * 100
  if (!Number.isFinite(percent)) return undefined
  return Math.min(100, Math.max(0, percent))
}

/**
 * The percent format every surface prints a RATIO with: at most two decimals,
 * with a whole value left whole ("100", never "100.00"). Both cards show the
 * same package, so they must print the same number.
 *
 * Two decimals rather than a fixed two: the sidebar's 38px percent column fits
 * "99.61%" (36px) but not "100.00%" (42px).
 *
 * @param percent - an already-clamped percentage value.
 * @returns the percent as text, without the trailing sign.
 */
export function formatPercentText(percent: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(percent)
}

/**
 * The same ratio read the other way round: the cycle's USED percentage as a bare
 * number string ("3"), ready for the `quotaPackageUsed` copy.
 *
 * Whole percent on purpose — the suffix rides inside the package label, where two
 * decimals would ellipsize it. Derived from remain/size rather than the upstream's
 * `used`, which normalizes to a literal 0 when absent.
 *
 * @param remain - the package's remaining credit.
 * @param size - the package's granted total; a non-positive size has no ratio.
 * @returns the used percentage as a bare number string, or undefined when there is no ratio to state.
 */
export function usedPercentText(remain: number, size: number): string | undefined {
  const percent = clampPercent(remain, size)
  return percent === undefined ? undefined : String(Math.round(100 - percent))
}

/** Parse an upstream expiry string ("YYYY-MM-DD HH:mm:ss") into a timestamp; undefined when unparseable. */
function parseExpiry(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Whether a group is spent (remain 0) and NOT unlimited. */
function isSpent(group: QuotaGroup): boolean {
  return !group.unlimited && group.remain <= 0
}

/** Whether a spent group's expiry date has already passed (undated → false: no proof of expiry). */
function isExpired(group: QuotaGroup, now: number): boolean {
  if (!isSpent(group)) return false
  const expiry = parseExpiry(group.packageEndTime)
  return expiry !== undefined && expiry < now
}

/**
 * SIDEBAR overview rule:
 *
 * - A group with credit LEFT (remain > 0, or unlimited) renders.
 * - A SPENT group renders ONLY when EVERY group is spent and it is not expired.
 * - An EXPIRED group renders NOWHERE.
 *
 * Applied AFTER the merge so the sums are settled before the test.
 * "Now" is injectable for tests.
 *
 * @param groups - merged groups, in first-seen order.
 * @param now - current timestamp (defaults to Date.now()).
 * @returns the groups to display, in first-seen order.
 */
export function visibleQuotaGroups(groups: readonly QuotaGroup[], now: number = Date.now()): QuotaGroup[] {
  const hasCredit = groups.some(group => group.unlimited || group.remain > 0)
  return groups.filter(group => {
    if (group.unlimited || group.remain > 0) return true
    // Spent: visible only when the WHOLE account is spent and this group has
    // not lapsed.
    return !hasCredit && !isExpired(group, now)
  })
}

/**
 * PANEL detail-table ordering: every row renders, but spent-yet-active rows sink
 * to the BOTTOM and expired rows are dropped. Rows keep their first-seen order
 * within each band.
 *
 * @param rows - per-package rows, unmerged, in first-seen order.
 * @param now - current timestamp (defaults to Date.now()).
 */
export function sortPackageRows<T extends { remain: number; unlimited?: true; packageEndTime?: string }>(rows: readonly T[], now: number = Date.now()): T[] {
  const live: T[] = []
  const spent: T[] = []
  for (const row of rows) {
    const unlimited = row.unlimited === true
    const expiry = parseExpiry(row.packageEndTime)
    const expired = !unlimited && row.remain <= 0 && expiry !== undefined && expiry < now
    if (expired) continue
    if (unlimited || row.remain > 0) live.push(row)
    else spent.push(row)
  }
  return [...live, ...spent]
}
