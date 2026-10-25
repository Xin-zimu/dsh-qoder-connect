/**
 * Shared live flags for the quota cards, mirrored from the settings document.
 *
 * The settings scope lives in one place (the quota-settings card binds it) but
 * three surfaces read the derived values, so they meet here: plain mutable module
 * state plus a revision counter that React subscribes to through
 * useSyncExternalStore — no prop-drilling through slot injections.
 *
 * Status documents are shared too: every surface ACQUIRES the variant it shows,
 * ONE ticker reads each live variant, and a sequence guard keeps whichever read
 * started last.
 */

import type { QoderVariantId, QoderWebStatus } from '../status-paths.ts'
import { QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH } from '../status-paths.ts'
import { isQoderWebStatus } from './status-document.ts'

/** Whether each variant has a usable PAT, as far as the last status poll knows. */
export interface QuotaSignInState {
  cn: boolean
  global: boolean
}

let pollIntervalMs = 300_000
const toggles = { cn: false, global: false }
let togglesSnapshot: QuotaSignInState = { cn: false, global: false }
const signIn: QuotaSignInState = { cn: false, global: false }
let signInSnapshot: QuotaSignInState = { cn: false, global: false }
let revision = 0
const listeners = new Set<() => void>()

function bump(): void {
  revision += 1
  for (const listener of listeners) listener()
}

/** Update the shared poll interval (from the settings document). */
export function setQuotaPollMs(ms: number): void {
  if (Number.isFinite(ms) && ms >= 60_000 && pollIntervalMs !== ms) {
    pollIntervalMs = ms
    bump()
  }
}

/** Read the configured poll interval. */
export function quotaPollMs(): number {
  return pollIntervalMs
}

/** Update both sidebar toggles (from the settings document). */
export function setQuotaToggles(cn: boolean, global: boolean): void {
  if (toggles.cn !== cn || toggles.global !== global) {
    toggles.cn = cn
    toggles.global = global
    togglesSnapshot = { ...toggles }
    bump()
  }
}

/** Read the current toggles. */
export function quotaToggles(): QuotaSignInState {
  return togglesSnapshot
}

/** Record a variant's sign-in state from any successful status poll. */
export function noteQuotaSignIn(variantId: string, signedIn: boolean): void {
  if (variantId === 'qoder' && signIn.cn !== signedIn) {
    signIn.cn = signedIn
    signInSnapshot = { ...signIn }
    bump()
  } else if (variantId === 'qoder-global' && signIn.global !== signedIn) {
    signIn.global = signedIn
    signInSnapshot = { ...signIn }
    bump()
  }
}

/** Read the cached sign-in state. */
export function quotaSignInState(): QuotaSignInState {
  return signInSnapshot
}

/**
 * Note that the label language changed and wake every subscribed surface: a
 * package title is re-read at render, so without a bump the old language lingers.
 */
export function noteQuotaLanguage(): void {
  bump()
}

/** Subscribe to any flag change; returns the disposer. */
export function onQuotaSettingsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The current revision — the useSyncExternalStore snapshot value. */
export function quotaSettingsRevision(): number {
  return revision
}

/** Which variant a status route belongs to, from the route path. */
export function variantOfStatusPath(statusPath: string): QoderVariantId {
  return statusPath.includes('/global/') ? 'qoder-global' : 'qoder'
}

/* ---- shared status documents ---- */

/**
 * The last status document per variant, shared by EVERY quota surface, so one
 * refresh updates the sidebar card and the dashboard together instead of each
 * showing its own read.
 *
 * Documents are kept by identity (never mutated), so reference comparisons in
 * useSyncExternalStore selectors stay stable.
 */
const statusDocuments: { cn: QoderWebStatus | undefined; global: QoderWebStatus | undefined } = { cn: undefined, global: undefined }

/**
 * Store one variant's document and sign-in fact — the raw publish, with no
 * sequence bookkeeping. Direct callers go through {@link noteQuotaStatus};
 * read results go through {@link publishRead}.
 */
function storeStatus(variantId: string, status: QoderWebStatus): void {
  if (variantId === 'qoder' && statusDocuments.cn !== status) {
    statusDocuments.cn = status
    statusFetchedAt.cn = Date.now()
    bump()
  } else if (variantId === 'qoder-global' && statusDocuments.global !== status) {
    statusDocuments.global = status
    statusFetchedAt.global = Date.now()
    bump()
  }
  // Also record the sign-in fact the toggles gate on.
  noteQuotaSignIn(variantId, status.status === 'signed-in')
}

/**
 * Publish one variant's document as an AUTHORITATIVE fact: the host answered a
 * write, or a surface synthesized the outcome (clearing a PAT). It supersedes
 * every read that started before it.
 */
export function noteQuotaStatus(variantId: string, status: QoderWebStatus): void {
  storeStatus(variantId, status)
  if (variantId === 'qoder' || variantId === 'qoder-global') {
    publishedSeq[variantId] = readSeq[variantId]
  }
}

/** Read one variant's latest status document. */
export function quotaStatus(variantId: QoderVariantId): QoderWebStatus | undefined {
  return variantId === 'qoder' ? statusDocuments.cn : statusDocuments.global
}

/** When each variant's document was last fetched (per publish, not per read). */
const statusFetchedAt: { cn: number | undefined; global: number | undefined } = { cn: undefined, global: undefined }

/** Read the time a variant's current document was fetched, if any. */
export function quotaStatusFetchedAt(variantId: QoderVariantId): number | undefined {
  return variantId === 'qoder' ? statusFetchedAt.cn : statusFetchedAt.global
}

/**
 * Whether ONE variant's shared document is fresh enough to skip a fetch: a
 * click/mount/tick within the configured interval reuses the cached document,
 * and only a variant with NO result yet forces the upstream call. The interval
 * is a cache lifetime, not a metronome.
 *
 * @param variantId - which variant's freshness to test.
 * @param maxAgeMs - the configured poll interval (cache lifetime).
 */
export function quotaStatusIsFresh(variantId: QoderVariantId, maxAgeMs: number): boolean {
  const fetchedAt = variantId === 'qoder' ? statusFetchedAt.cn : statusFetchedAt.global
  const document = variantId === 'qoder' ? statusDocuments.cn : statusDocuments.global
  // No document yet = never a result = always stale, whatever the clock says.
  if (fetchedAt === undefined || document === undefined) return false
  return Date.now() - fetchedAt < maxAgeMs
}

/* ---- shared status polling ---- */

/**
 * One read's outcome as every surface reports it: `invalid` is a 200 whose body
 * is not a status document; `transport` carries the raw reason, which each
 * surface renders through its own copy. `status` is the HTTP status when the
 * server answered at all — a 404 means this route does not exist, which is how
 * a surface recognizes that the plugin never registered its host half.
 */
export type QuotaReadFailure =
  | { kind: 'transport'; message: string; status?: number }
  | { kind: 'invalid' }

/** The last read failure per variant, cleared by the next successful read. */
const readFailures: Record<QoderVariantId, QuotaReadFailure | undefined> = {
  qoder: undefined,
  'qoder-global': undefined,
}

/** Read one variant's last read failure, if the last read failed. */
export function quotaReadFailure(variantId: QoderVariantId): QuotaReadFailure | undefined {
  return variantId === 'qoder' ? readFailures.qoder : readFailures['qoder-global']
}

/**
 * Cadence an expanded card reads at — one request per variant per minute,
 * whatever the number of cards showing it.
 */
const CARD_POLL_MS = 60_000

/** The status route each variant polls (mirrors the host's locked route table). */
const STATUS_ROUTES: Record<QoderVariantId, string> = {
  qoder: QODER_STATUS_PATH,
  'qoder-global': QODER_GLOBAL_STATUS_PATH,
}

/**
 * Who needs a variant live. A `card` holder (an expanded settings card) reads
 * every minute; a `surface` holder (an enabled sidebar card, an open quota panel)
 * reads at the settings interval. A variant is read at the TIGHTEST cadence its
 * holders ask for, so overlapping holders cost one request, not two.
 */
const demand: Record<QoderVariantId, { cards: number; surfaces: number }> = {
  qoder: { cards: 0, surfaces: 0 },
  'qoder-global': { cards: 0, surfaces: 0 },
}

/** The single ticker every holder shares; undefined while nothing is live. */
let ticker: number | undefined

/**
 * Read-start sequences per variant, and the sequence of the last PUBLISHED read.
 * A read publishes only when no later-started read has published yet, so a stale
 * answer can never roll the screen back.
 */
const readSeq: Record<QoderVariantId, number> = { qoder: 0, 'qoder-global': 0 }
const publishedSeq: Record<QoderVariantId, number> = { qoder: 0, 'qoder-global': 0 }

/** Whether the page is visible; a hidden page reads nothing and catches up on return. */
function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true
}

/** Publish one read's outcome under the sequence guard (see `readSeq`). */
function publishRead(variantId: QoderVariantId, seq: number, outcome: { doc: QoderWebStatus } | { failure: QuotaReadFailure }): void {
  if (seq <= publishedSeq[variantId]) return
  if ('doc' in outcome) {
    storeStatus(variantId, outcome.doc)
    publishReadFailure(variantId, undefined)
  } else {
    publishReadFailure(variantId, outcome.failure)
  }
  publishedSeq[variantId] = seq
}

/** Publish (or clear) one variant's read failure; identity-stable between changes. */
function publishReadFailure(variantId: QoderVariantId, failure: QuotaReadFailure | undefined): void {
  const previous = readFailures[variantId]
  if (previous === failure) return
  if (previous !== undefined && failure !== undefined && previous.kind === failure.kind
    && (previous.kind !== 'transport'
      || failure.kind !== 'transport'
      || (previous.message === failure.message && previous.status === failure.status))) return
  readFailures[variantId] = failure
  bump()
}

/** A 200 whose body is not a status document — reported as `invalid`, not as a transport failure. */
class InvalidStatusDocumentError extends Error {}

/** A non-2xx answer; carries the status so surfaces can tell "missing route" from "server down". */
class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpStatusError'
  }
}

/**
 * Fetch one variant's status document and publish it (or its failure) for every
 * surface. The request is never shared: a tick reads each live variant once, and
 * an explicit read must be able to postdate a write.
 *
 * @returns the published document, or undefined when the read failed.
 */
async function readVariant(variantId: QoderVariantId): Promise<QoderWebStatus | undefined> {
  const seq = ++readSeq[variantId]
  try {
    const response = await fetch(STATUS_ROUTES[variantId], {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    })
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) throw new HttpStatusError(response.status)
    if (!isQoderWebStatus(body)) throw new InvalidStatusDocumentError()
    publishRead(variantId, seq, { doc: body })
    return body
  } catch (error: unknown) {
    publishRead(variantId, seq, {
      failure: error instanceof InvalidStatusDocumentError
        ? { kind: 'invalid' }
        : error instanceof HttpStatusError
          ? { kind: 'transport', message: error.message, status: error.status }
          : { kind: 'transport', message: error instanceof Error ? error.message : 'request failed' },
    })
    return undefined
  }
}

/** Whether a variant is due for its next read: held at all, past its cadence, and not parked signed-out. */
function dueForRead(variantId: QoderVariantId): boolean {
  const holders = demand[variantId]
  if (holders.cards === 0 && holders.surfaces === 0) return false
  // A signed-out variant held only by cards parks: nothing changes without a
  // PAT, so their poll stops. A surface holder keeps its interval regardless.
  if (holders.cards > 0 && holders.surfaces === 0 && quotaStatus(variantId)?.status === 'signed-out') return false
  if (holders.cards > 0) return true
  return !quotaStatusIsFresh(variantId, Math.max(CARD_POLL_MS, pollIntervalMs))
}

/** One tick: read every variant that is due, once, whatever the number of holders. */
function tickQuotaPoll(): void {
  if (pageHidden()) return
  for (const variantId of ['qoder', 'qoder-global'] as const) {
    if (dueForRead(variantId)) void readVariant(variantId)
  }
}

function startTicker(): void {
  if (ticker !== undefined) return
  ticker = window.setInterval(tickQuotaPoll, CARD_POLL_MS)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', tickQuotaPoll)
}

function stopTicker(): void {
  if (ticker === undefined) return
  window.clearInterval(ticker)
  ticker = undefined
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', tickQuotaPoll)
}

/** Record one holder of `kind` and start the shared ticker when it is the first. */
function addHolder(variantId: QoderVariantId, kind: 'cards' | 'surfaces'): void {
  const holders = demand[variantId]
  holders[kind] += 1
  if (holders.cards + holders.surfaces === 1) startTicker()
}

/** Drop one holder and stop the shared ticker when nothing is live any more. */
function removeHolder(variantId: QoderVariantId, kind: 'cards' | 'surfaces'): void {
  const holders = demand[variantId]
  holders[kind] = Math.max(0, holders[kind] - 1)
  if (demand.qoder.cards + demand.qoder.surfaces === 0
    && demand['qoder-global'].cards + demand['qoder-global'].surfaces === 0) stopTicker()
}

/** Sync the holder count with the ticker, reading at once when the document is due. */
function acquire(variantId: QoderVariantId, kind: 'cards' | 'surfaces'): () => void {
  // The due check is cadence-based, not holder-based: the first holder reads
  // at once unless another holder's document is still within its cadence —
  // re-opening a card beside a live one shows the numbers already on screen
  // instead of re-billing the route.
  const cadence = kind === 'cards' ? CARD_POLL_MS : Math.max(CARD_POLL_MS, pollIntervalMs)
  const readNow = !quotaStatusIsFresh(variantId, cadence)
  addHolder(variantId, kind)
  if (readNow) void readVariant(variantId)
  return () => { removeHolder(variantId, kind) }
}

/**
 * Acquire one variant as an EXPANDED CARD shows it: reads every minute while
 * any card holds it, stops on a signed-out document (nothing changes without
 * a PAT). The release disposer belongs to the card's effect lifetime.
 */
export function acquireLiveCard(variantId: QoderVariantId): () => void {
  return acquire(variantId, 'cards')
}

/**
 * Acquire one variant as a CADENCE-BOUND SURFACE shows it (an enabled sidebar
 * card, an open quota panel): reads at the settings interval, whatever the
 * sign-in state. The release disposer belongs to the surface's lifetime.
 */
export function acquireLiveSurface(variantId: QoderVariantId): () => void {
  return acquire(variantId, 'surfaces')
}

/**
 * Force one shared read now. The explicit path — a manual refresh, or the
 * re-read that follows a write — always starts its own request, so its answer
 * can postdate the write that preceded it.
 *
 * @returns whether the read produced a document.
 */
export function refreshQuotaStatus(variantId: QoderVariantId): Promise<boolean> {
  return readVariant(variantId).then(doc => doc !== undefined)
}

/**
 * Test support: drop every piece of shared read state, leaving toggles, sign-in
 * facts and the poll interval alone. Without it a card under test would inherit
 * the previous test's document. Production code never calls this.
 */
export function resetQuotaStatusForTesting(): void {
  statusDocuments.cn = undefined
  statusDocuments.global = undefined
  statusFetchedAt.cn = undefined
  statusFetchedAt.global = undefined
  readFailures.qoder = undefined
  readFailures['qoder-global'] = undefined
  readSeq.qoder = 0
  readSeq['qoder-global'] = 0
  publishedSeq.qoder = 0
  publishedSeq['qoder-global'] = 0
  demand.qoder.cards = 0
  demand.qoder.surfaces = 0
  demand['qoder-global'].cards = 0
  demand['qoder-global'].surfaces = 0
  stopTicker()
}
