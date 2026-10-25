/** Scheduling and catch-up orchestration for daily 10:00 (UTC+8) check-in. */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { QoderCheckInResult } from './qoder/transport/checkin.ts'
import { qoderPluginDataDir } from './paths.ts'
import { formatUtc8Date, utc8WallClock } from './utc8.ts'

export interface VariantCheckInTarget {
  variantId: string
  /**
   * Claim today's benefit for this variant.
   *
   * The variant's transport owns credential resolution, so this takes no token; a
   * missing credential surfaces as an `error` result rather than a throw, so one
   * signed-out variant cannot stop the sweep for the other.
   */
  checkIn: (signal?: AbortSignal) => Promise<QoderCheckInResult>
  /**
   * The moment this variant checks in, as minutes past midnight in UTC+8.
   *
   * A getter, not a value: the user can retime it on the card and the scheduler
   * must see the new value on its next pass without being rebuilt.
   */
  minuteOfDay: () => number
  onClaimed?: () => void
}

export interface CheckInLogItem {
  id: string
  date: string
  timestamp: number
  status: 'claimed' | 'already-claimed' | 'before-window' | 'no-campaign' | 'error'
  amount?: number | undefined
  campaignKey?: string | undefined
  message?: string | undefined
}

export interface CheckInRecord {
  lastDate: string
  lastAt: number
  status: 'claimed' | 'already-claimed' | 'before-window' | 'no-campaign' | 'error'
  amount?: number | undefined
  message?: string | undefined
  logs?: CheckInLogItem[] | undefined
}

export interface CheckInStatusStore {
  read(variantId: string): CheckInRecord | undefined
  write(variantId: string, record: CheckInRecord): void
  clearLogs(variantId: string): void
}

export class JsonFileCheckInStore implements CheckInStatusStore {
  private readonly filePath: string

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(qoderPluginDataDir(), 'checkin-status.json')
  }

  private readAll(): Record<string, CheckInRecord> {
    try {
      if (!existsSync(this.filePath)) return {}
      const raw = readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw) as Record<string, CheckInRecord>
    } catch {
      return {}
    }
  }

  read(variantId: string): CheckInRecord | undefined {
    return this.readAll()[variantId]
  }

  clearLogs(variantId: string): void {
    try {
      const all = this.readAll()
      if (all[variantId]) {
        all[variantId] = {
          ...all[variantId],
          logs: [],
        }
        mkdirSync(dirname(this.filePath), { recursive: true })
        writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf-8')
      }
    } catch {
      // Best-effort persistence
    }
  }

  write(variantId: string, record: CheckInRecord): void {
    try {
      const all = this.readAll()
      const existing = all[variantId]
      const existingLogs = existing?.logs ?? []
      const newLog: CheckInLogItem = {
        id: `${record.lastDate}-${record.lastAt}`,
        date: record.lastDate,
        timestamp: record.lastAt,
        status: record.status,
        ...record.amount === undefined ? {} : { amount: record.amount },
        ...record.message === undefined ? {} : { message: record.message },
      }
      const updatedLogs = [newLog, ...existingLogs.filter(l => l.id !== newLog.id)].slice(0, 30)
      all[variantId] = {
        ...record,
        logs: updatedLogs,
      }
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(all, null, 2), 'utf-8')
    } catch {
      // Best-effort persistence
    }
  }
}

/**
 * The moment a variant checks in, as minutes past midnight in UTC+8.
 *
 * 600 is 10:00, which is when the upstream resets the daily campaign; it is
 * also the default a variant falls back to when its setting is absent or
 * malformed, so a bad stored value can never leave the day unscheduled.
 */
export const DEFAULT_CHECK_IN_MINUTE = 600

/**
 * The earliest moment a variant may be scheduled for: the window's opening.
 *
 * An earlier moment would read the *previous* window's status and settle a day
 * that was never claimed. The settings schema refuses such a value; this is the
 * floor a stored one is lifted to, so an old or hand-edited config still lands on
 * something honourable.
 */
export const EARLIEST_CHECK_IN_MINUTE = DEFAULT_CHECK_IN_MINUTE

/** Clamp any stored/typed value onto a minute the plugin can actually honour. */
export function normalizeCheckInMinute(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CHECK_IN_MINUTE
  const whole = Math.trunc(value)
  if (whole < 0 || whole > 1439) return DEFAULT_CHECK_IN_MINUTE
  return Math.max(EARLIEST_CHECK_IN_MINUTE, whole)
}

/**
 * Calculates milliseconds until the next occurrence of `minuteOfDay` (UTC+8).
 *
 * Five seconds past the configured minute are used so the request lands after
 * the upstream has flipped the day over rather than on the boundary itself.
 */
export function msUntilNextCheckIn(minuteOfDay: number, nowMs: number = Date.now()): number {
  const minute = normalizeCheckInMinute(minuteOfDay)
  // Calculate current UTC+8 wall clock
  const utc8Time = utc8WallClock(nowMs)
  const targetUtc8 = new Date(utc8Time.getTime())
  targetUtc8.setHours(Math.floor(minute / 60), minute % 60, 5, 0)

  let diff = targetUtc8.getTime() - utc8Time.getTime()
  if (diff <= 0) {
    // Today's moment has passed, schedule for tomorrow
    targetUtc8.setDate(targetUtc8.getDate() + 1)
    diff = targetUtc8.getTime() - utc8Time.getTime()
  }
  return diff
}

/**
 * Whether today's configured check-in moment (UTC+8) has already passed.
 */
export function isPastCheckInTime(minuteOfDay: number, nowMs: number = Date.now()): boolean {
  const minute = normalizeCheckInMinute(minuteOfDay)
  const utc8 = utc8WallClock(nowMs)
  return utc8.getHours() * 60 + utc8.getMinutes() >= minute
}

export interface CheckInSchedulerOptions {
  targets: VariantCheckInTarget[]
  isEnabled: (variantId: string) => boolean
  store?: CheckInStatusStore | undefined
  onResult?: ((result: QoderCheckInResult) => void) | undefined
  now?: (() => number) | undefined
}

export class CheckInScheduler {
  private readonly targets: VariantCheckInTarget[]
  private readonly isEnabled: (variantId: string) => boolean
  private readonly store: CheckInStatusStore
  private readonly onResult: ((result: QoderCheckInResult) => void) | undefined
  private readonly now: () => number
  /**
   * One timer per enabled variant, keyed by variant id.
   *
   * Per-variant because the two products may check in at different moments.
   */
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /**
   * Variants with a sweep in progress, so concurrent callers cannot double-claim.
   */
  private readonly inFlight = new Set<string>()
  /** When each variant's timer is next due, epoch ms, for the card to show. */
  private readonly nextRuns = new Map<string, number>()
  private disposed = false

  constructor(options: CheckInSchedulerOptions) {
    this.targets = options.targets
    this.isEnabled = options.isEnabled
    this.store = options.store ?? new JsonFileCheckInStore()
    this.onResult = options.onResult
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (this.disposed) return
    // Immediate catch-up evaluation on startup
    void this.sweepAll(true)
    this.rearm()
  }

  /**
   * Re-run the startup catch-up once the toggles are actually readable.
   *
   * `start()` runs before the settings section hands over its stored values, so
   * the first sweep may skip the day. The sweep is idempotent, so a day already
   * handled costs nothing.
   */
  catchUp(): void {
    if (this.disposed) return
    void this.sweepAll(true)
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /**
   * Re-place every variant's timer.
   *
   * Called after each fire and whenever configuration lands, so a retimed card
   * takes effect without a restart. A timer is placed for every target, including
   * disabled variants: `start()` runs before the stored toggles are readable, and
   * gating placement on `isEnabled` left the variant with no timer and nothing to
   * re-arm it. Whether work is due is decided in the sweep; the timer only decides
   * when to look.
   */
  rearm(): void {
    if (this.disposed) return
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.nextRuns.clear()
    const nowMs = this.now()
    for (const target of this.targets) {
      const delay = msUntilNextCheckIn(target.minuteOfDay(), nowMs)
      // Published so the card can say when the next automatic run is due: a day
      // already claimed goes quiet by design, and silence looks like a broken
      // scheduler.
      this.nextRuns.set(target.variantId, nowMs + delay)
      const timer = setTimeout(() => {
        this.timers.delete(target.variantId)
        void this.sweepAll(false, target.variantId).finally(() => { this.rearm() })
      }, delay)
      timer.unref?.()
      this.timers.set(target.variantId, timer)
    }
  }

  /** When this variant's timer is next due, epoch ms; absent before first arm. */
  nextRunAt(variantId: string): number | undefined {
    return this.nextRuns.get(variantId)
  }

  async sweepAll(isCatchUp: boolean, only?: string): Promise<void> {
    if (this.disposed) return
    const nowMs = this.now()
    const today = formatUtc8Date(nowMs)

    for (const target of this.targets) {
      if (only !== undefined && target.variantId !== only) continue
      if (!this.isEnabled(target.variantId)) continue
      // One variant is never swept twice at once: `start()` and the settings
      // section's first catch-up can both be in the air during assembly.
      if (this.inFlight.has(target.variantId)) continue
      this.inFlight.add(target.variantId)
      try {
        await this.sweepOne(target, isCatchUp, nowMs, today)
      } finally {
        this.inFlight.delete(target.variantId)
      }
    }
  }

  private async sweepOne(
    target: VariantCheckInTarget,
    isCatchUp: boolean,
    nowMs: number,
    today: string,
  ): Promise<void> {
    const record = this.store.read(target.variantId)
    // Only an actually claimed day is settled. "no campaign", "before window" and
    // errors must stay retryable, otherwise one early failure burns the whole day.
    const settledToday = record?.lastDate === today
      && (record.status === 'claimed' || record.status === 'already-claimed')
    if (settledToday) {
      // A scheduled run that finds the day already handled still leaves a row:
      // total silence is indistinguishable from a timer that never fired.
      if (!isCatchUp) {
        this.store.write(target.variantId, {
          lastDate: today,
          lastAt: nowMs,
          status: 'already-claimed',
          ...record.amount === undefined ? {} : { amount: record.amount },
          message: 'Scheduled check-in ran; today was already claimed',
        })
      }
      return
    }
    // A catch-up run only makes sense once this variant's configured moment
    // has passed; before it, the variant's own timer still owns today.
    if (isCatchUp && !isPastCheckInTime(target.minuteOfDay(), nowMs)) return

    let result: QoderCheckInResult
    try {
      result = await target.checkIn()
    } catch {
      // A transport-level throw (no credential at all, a rejection) is not a
      // settled day: leave the record alone so a later sweep can retry.
      return
    }
    try {
      if (result.status !== 'error') {
        this.store.write(target.variantId, {
          lastDate: result.date,
          lastAt: result.timestamp,
          status: result.status,
          amount: result.amount,
          message: result.message,
        })
        if (result.status === 'claimed') {
          target.onClaimed?.()
        }
      }
      this.onResult?.(result)
    } catch {
      // Ignored to protect loop
    }
  }
}
