/**
 * Qoder credential storage — a list of Personal Access Tokens per variant, one of
 * which is active.
 *
 * Every credential is a PAT the human pasted into the variant's card (or saved by
 * the CLI, or exported into the environment). There is no device flow, no refresh,
 * and no expiry: a PAT is valid until revoked, so this store only reads, writes,
 * and deletes a small JSON document.
 *
 * Only the *credential* is per-account. Every setting the cards expose lives in
 * the plugin's own settings file and is shared by every saved PAT, so switching
 * accounts only changes which token signs the next request.
 *
 * One file per variant inside the plugin's data directory, with schema
 * `{version: 3, activeId, credentials: [{id, pat, region, savedAt, label?}]}`.
 * `id` is a one-way hash prefix of the token, so re-pasting a token updates its own
 * entry and the id can be shown without leaking the secret. A version-2 document
 * is read as a one-entry list and rewritten as v3 on the next mutation; a
 * WorkBuddy-era document (`accessToken`, no `pat`) is reported, never migrated.
 *
 * @module dsh-qoder-connect/auth
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { qoderPluginDataDir, QODER_DATA_DIR_ENV, QODER_DATA_DIR_NAME } from './paths.ts'
import type { QoderRegion } from './qoder/region.ts'
import type { QoderCredentialSource, QoderPatProfile, QoderPatSummary } from './status-paths.ts'
import type { QoderVariant } from './variants.ts'

// Re-exported for compatibility: existing callers import these from here.
export { qoderPluginDataDir, QODER_DATA_DIR_ENV, QODER_DATA_DIR_NAME }

/** The on-disk document version this writer produces. */
const AUTH_SCHEMA_VERSION = 3

/** Environment fallback for the global arm when no file exists. */
export const QODER_PAT_ENV_GLOBAL = 'QODER_PERSONAL_ACCESS_TOKEN'

/** Environment fallback for the China arm when no file exists. */
export const QODER_PAT_ENV_CN = 'QODER_CN_PERSONAL_ACCESS_TOKEN'

/** Basename of the China variant's credential file inside the data directory. */
export const QODER_AUTH_FILENAME = '.qoder-auth.json'

/** Minimal logger surface the plugin context already provides. */
export interface AuthLogger {
  warn?(...args: unknown[]): void
}

/** One saved credential, as the file stores it. */
export interface QoderCredentialEntry {
  /** Stable local id (a one-way hash prefix of the token). */
  id: string
  pat: string
  region: QoderRegion
  /** When the stored token was saved, epoch milliseconds. */
  savedAtMs?: number
  /** Optional display label; never sent upstream. */
  label?: string
}

/** Runtime credential, timestamps in epoch milliseconds. */
export interface QoderCredential {
  /** Local id of the saved entry; absent for an environment token. */
  id?: string
  pat: string
  region: QoderRegion
  /** When the stored token was saved; absent for environment-sourced tokens. */
  savedAtMs?: number
  /** Display label, when the saved entry carries one. */
  label?: string
  source: QoderCredentialSource
}

/** Read-only sign-in summary for status, the PAT route, and doctor output. */
export interface QoderAuthStatus {
  state: 'configured' | 'missing'
  /** Redacted summary of the token in effect, when there is one. */
  pat?: QoderPatSummary
  /** Which upstream region the token is used against. */
  region?: QoderRegion
  /** Why no credential is usable, when diagnosable (a stale legacy file). */
  reason?: string
  /** Absolute path of the credential file this store owns. */
  filePath: string
  /** Every saved token for this variant, newest first, redacted. */
  profiles?: readonly QoderPatProfile[]
  /** The entry id in effect, when a saved entry is active. */
  activeId?: string
}

/** Constructor options. */
export interface QoderStoreOptions {
  variant: QoderVariant
  /** Explicit plugin-owned credential path, defaulting under the data dir. */
  ownPath?: string
  /** Logger for the legacy-file warning; optional so tests stay quiet. */
  logger?: AuthLogger
}

/** One parsed credential document, normalized to the list shape. */
interface StoredDocument {
  entries: QoderCredentialEntry[]
  activeId: string | undefined
}

/** Last four characters of a token, for display. */
export function patTail(pat: string): string | undefined {
  const trimmed = pat.trim()
  return trimmed.length >= 4 ? trimmed.slice(-4) : undefined
}

/**
 * Stable local id for one token.
 *
 * A one-way hash prefix rather than a suffix: surfaces showing the id leak nothing
 * usable, while two saves of the same token still resolve to the same entry.
 */
export function qoderCredentialId(pat: string): string {
  return createHash('sha256').update(pat).digest('hex').slice(0, 12)
}

/**
 * Stable identity key for a credential, used by probe records and saved catalogs.
 *
 * Wider than the local id: these keys address stored data, not UI, and 16 hex
 * characters keep two tokens from sharing a bucket.
 */
export function qoderCredentialIdentity(credential: Pick<QoderCredential, 'pat'>): string {
  return `pat:${createHash('sha256').update(credential.pat).digest('hex').slice(0, 16)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRegion(value: unknown): value is QoderRegion {
  return value === 'global' || value === 'china'
}

/** Trim a label and cap it at a length a card row can render. */
function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, 48)
}

/** Parse one stored entry, dropping anything this store cannot use. */
function normalizeEntry(value: unknown): QoderCredentialEntry | undefined {
  if (!isRecord(value)) return undefined
  const pat = typeof value['pat'] === 'string' ? value['pat'].trim() : ''
  if (pat === '') return undefined
  const region = value['region']
  if (!isRegion(region)) return undefined
  const rawId = typeof value['id'] === 'string' ? value['id'].trim() : ''
  const label = normalizeLabel(value['label'])
  const savedAt = typeof value['savedAt'] === 'number' && Number.isFinite(value['savedAt'])
    ? value['savedAt']
    : undefined
  return {
    id: rawId === '' ? qoderCredentialId(pat) : rawId,
    pat,
    region,
    ...savedAt === undefined ? {} : { savedAtMs: savedAt },
    ...label === undefined ? {} : { label },
  }
}

export class QoderCredentialStore {
  private readonly variant: QoderVariant
  private readonly ownPath: string
  private readonly logger: AuthLogger | undefined
  /** The legacy-file warning is emitted once per process, not per read. */
  private legacyWarned = false

  constructor(options: QoderStoreOptions) {
    this.variant = options.variant
    this.ownPath = options.ownPath ?? join(qoderPluginDataDir(), options.variant.ownFilename)
    this.logger = options.logger
  }

  /** Absolute path of this variant's credential file, for display and tests. */
  ownAuthPath(): string {
    return this.ownPath
  }

  /**
   * The credential currently in effect, or `undefined` when there is none.
   *
   * Resolution order: the active saved entry (or the first when the pointer is
   * stale), then the arm's environment variable (only when no saved entry
   * exists). No refresh and no expiry check.
   */
  async current(): Promise<QoderCredential | undefined> {
    const stored = await this.readOwn()
    if (stored !== undefined && stored.entries.length > 0) {
      const entry = stored.entries.find(candidate => candidate.id === stored.activeId) ?? stored.entries[0]!
      return {
        id: entry.id,
        pat: entry.pat,
        region: entry.region,
        ...entry.savedAtMs === undefined ? {} : { savedAtMs: entry.savedAtMs },
        ...entry.label === undefined ? {} : { label: entry.label },
        // A file this store wrote came from the card or the CLI; `source` is not
        // persisted because "card vs cli" only records who typed the command.
        source: 'card',
      }
    }
    return this.fromEnvironment()
  }

  /**
   * The credential, or a thrown `MISSING_CREDENTIAL` error.
   *
   * Serving callers use this so an absent token surfaces as the classified failure
   * the transport itself raises.
   */
  async resolve(): Promise<QoderCredential> {
    const credential = await this.current()
    if (credential === undefined || credential.pat.trim() === '') {
      throw new Error('qoder: MISSING_CREDENTIAL — no Personal Access Token is configured. Add one in the Qoder settings card.')
    }
    return credential
  }

  /** The token in effect as a bare string, rejecting when there is none. */
  async patPromise(): Promise<string> {
    return (await this.resolve()).pat
  }

  /** Every saved entry (tokens included; host-side callers only). */
  async entries(): Promise<readonly QoderCredentialEntry[]> {
    return (await this.readOwn())?.entries ?? []
  }

  /**
   * Add a token and make it active.
   *
   * Re-saving an existing token updates that entry instead of appending a
   * duplicate — the id is derived from the token. The caller must have validated
   * the token against the region first.
   *
   * @param pat - the token to store.
   * @param label - optional display label for the select row.
   * @returns the stored entry.
   */
  async add(pat: string, label?: string): Promise<QoderCredentialEntry> {
    const trimmed = pat.trim()
    if (trimmed === '') throw new Error('qoder: cannot save an empty Personal Access Token')
    const stored = await this.readOwn()
    const entries = stored?.entries ?? []
    const id = qoderCredentialId(trimmed)
    const index = entries.findIndex(entry => entry.id === id)
    const existing = index === -1 ? undefined : entries[index]
    const nextLabel = normalizeLabel(label) ?? existing?.label
    const next: QoderCredentialEntry = {
      id,
      pat: trimmed,
      region: this.variant.region,
      savedAtMs: Date.now(),
      ...nextLabel === undefined ? {} : { label: nextLabel },
    }
    if (index === -1) entries.push(next)
    else entries[index] = next
    await this.writeDocument(entries, id)
    return next
  }

  /**
   * Make one saved entry active.
   *
   * @param id - the entry id.
   * @returns the activated entry, or `undefined` when no entry has that id.
   */
  async activate(id: string): Promise<QoderCredentialEntry | undefined> {
    const stored = await this.readOwn()
    if (stored === undefined) return undefined
    const entry = stored.entries.find(candidate => candidate.id === id)
    if (entry === undefined) return undefined
    await this.writeDocument(stored.entries, id)
    return entry
  }

  /**
   * Remove one saved entry.
   *
   * The active pointer moves to the first remaining entry; removing the last entry
   * deletes the file, exactly like {@link clear}.
   *
   * @param id - the entry id.
   * @returns the removed entry, or `undefined` when no entry has that id.
   */
  async remove(id: string): Promise<QoderCredentialEntry | undefined> {
    const stored = await this.readOwn()
    if (stored === undefined) return undefined
    const index = stored.entries.findIndex(entry => entry.id === id)
    if (index === -1) return undefined
    const [removed] = stored.entries.splice(index, 1)
    const activeId = stored.activeId === id ? stored.entries[0]?.id : stored.activeId
    await this.writeDocument(stored.entries, activeId)
    return removed
  }

  /**
   * Persist a token for this variant and make it active; {@link add} behind the
   * runtime-credential shape older call sites expect.
   */
  async save(pat: string, source: QoderCredentialSource = 'card'): Promise<QoderCredential> {
    const entry = await this.add(pat)
    return {
      id: entry.id,
      pat: entry.pat,
      region: entry.region,
      ...entry.savedAtMs === undefined ? {} : { savedAtMs: entry.savedAtMs },
      source,
    }
  }

  /** Remove every stored credential. A missing file is not an error. */
  async clear(): Promise<void> {
    try {
      await rm(this.ownPath, { force: true })
    } catch {
      // Best effort: a file that cannot be removed will fail validation later
      // and surface through `status()` the same way.
    }
  }

  /** Alias kept for call-site readability (`logout` is just clearing). */
  async logout(): Promise<void> {
    await this.clear()
  }

  /** Redacted summary for the card, the PAT route, and doctor output. */
  async status(): Promise<QoderAuthStatus> {
    const base: { filePath: string; region?: QoderRegion } = {
      filePath: this.ownPath,
      region: this.variant.region,
    }
    const stored = await this.readOwn()
    const entries = stored?.entries ?? []
    if (entries.length > 0) {
      const active = entries.find(entry => entry.id === stored?.activeId) ?? entries[0]!
      const tail = patTail(active.pat)
      const profiles: QoderPatProfile[] = [...entries]
        .sort(newestFirst)
        .map(entry => {
          const entryTail = patTail(entry.pat)
          return {
            id: entry.id,
            ...entry.label === undefined ? {} : { label: entry.label },
            ...entryTail === undefined ? {} : { patTail: entryTail },
            ...entry.savedAtMs === undefined ? {} : { savedAtMs: entry.savedAtMs },
          }
        })
      return {
        state: 'configured',
        ...base,
        pat: {
          id: active.id,
          ...active.label === undefined ? {} : { label: active.label },
          source: 'card',
          ...active.savedAtMs === undefined ? {} : { savedAtMs: active.savedAtMs },
          ...tail === undefined ? {} : { patTail: tail },
        },
        activeId: active.id,
        profiles,
      }
    }
    const credential = await this.fromEnvironment()
    if (credential === undefined) {
      return {
        state: 'missing',
        ...base,
        ...this.pendingLegacyReason === undefined ? {} : { reason: this.pendingLegacyReason },
      }
    }
    const tail = patTail(credential.pat)
    return {
      state: 'configured',
      ...base,
      pat: {
        source: credential.source,
        ...tail === undefined ? {} : { patTail: tail },
      },
    }
  }

  /** Set when a read found a stale WorkBuddy-era file; consumed once. */
  private pendingLegacyReason: string | undefined

  private async fromEnvironment(): Promise<QoderCredential | undefined> {
    const name = this.variant.region === 'china' ? QODER_PAT_ENV_CN : QODER_PAT_ENV_GLOBAL
    const value = process.env[name]?.trim()
    if (value === undefined || value === '') return undefined
    return { pat: value, region: this.variant.region, source: 'env' }
  }

  private async readOwn(): Promise<StoredDocument | undefined> {
    let text: string
    try {
      text = await readFile(this.ownPath, 'utf8')
    } catch {
      // An absent file means "not signed in". Any other read failure is treated
      // the same way: the only recovery either way is to save the token again.
      this.pendingLegacyReason = undefined
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.pendingLegacyReason = undefined
      return undefined
    }
    if (!isRecord(parsed)) {
      this.pendingLegacyReason = undefined
      return undefined
    }
    // A WorkBuddy-era document is not a credential this plugin can use in any
    // form. Treat it as invalid — never a fake migration — and say so.
    if (typeof parsed['accessToken'] === 'string' && parsed['pat'] === undefined && parsed['credentials'] === undefined) {
      this.pendingLegacyReason = 'stale WorkBuddy credential file; save a Qoder Personal Access Token instead'
      if (!this.legacyWarned) {
        this.legacyWarned = true
        this.logger?.warn?.(
          `qoder: ${this.variant.displayName}: ${this.ownPath} holds a WorkBuddy-era credential;`
          + ' it is ignored. Save a Qoder Personal Access Token to replace it.',
        )
      }
      return undefined
    }
    this.pendingLegacyReason = undefined
    // v3: a list. Unknown rows are dropped one by one rather than invalidating
    // the whole file, so one hand-edited typo cannot sign the user out of the
    // other entries.
    if (Array.isArray(parsed['credentials'])) {
      const byId = new Map<string, QoderCredentialEntry>()
      for (const raw of parsed['credentials']) {
        const entry = normalizeEntry(raw)
        if (entry !== undefined) byId.set(entry.id, entry)
      }
      const entries = [...byId.values()]
      const requested = typeof parsed['activeId'] === 'string' ? parsed['activeId'] : undefined
      return {
        entries,
        activeId: requested !== undefined && entries.some(entry => entry.id === requested)
          ? requested
          : entries[0]?.id,
      }
    }
    // v2: one token. Read it as a one-entry list; the next mutation writes v3.
    const pat = typeof parsed['pat'] === 'string' ? parsed['pat'].trim() : ''
    if (pat === '') return undefined
    const region = isRegion(parsed['region']) ? parsed['region'] : this.variant.region
    const savedAt = typeof parsed['savedAt'] === 'number' && Number.isFinite(parsed['savedAt'])
      ? parsed['savedAt']
      : undefined
    const entry: QoderCredentialEntry = {
      id: qoderCredentialId(pat),
      pat,
      region,
      ...savedAt === undefined ? {} : { savedAtMs: savedAt },
    }
    return { entries: [entry], activeId: entry.id }
  }

  private async writeDocument(entries: readonly QoderCredentialEntry[], activeId: string | undefined): Promise<void> {
    // No entries means "signed out", which is the absence of the file: an
    // empty document would shadow the environment fallback and make `status`
    // claim a configured-but-empty sign-in.
    if (entries.length === 0) {
      await this.clear()
      return
    }
    const document = {
      version: AUTH_SCHEMA_VERSION,
      activeId: activeId !== undefined && entries.some(entry => entry.id === activeId)
        ? activeId
        : entries[0]!.id,
      credentials: entries.map(entry => ({
        id: entry.id,
        pat: entry.pat,
        region: entry.region,
        savedAt: entry.savedAtMs ?? Date.now(),
        ...entry.label === undefined ? {} : { label: entry.label },
      })),
    }
    const directory = dirname(this.ownPath)
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
    } catch {
      // An existing or uncreatable directory surfaces on the write below.
    }
    await writeFileAtomic(this.ownPath, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
    this.pendingLegacyReason = undefined
  }
}

/** Newest first, with a stable tie-break so the select order never jitters. */
function newestFirst(a: QoderCredentialEntry, b: QoderCredentialEntry): number {
  return (b.savedAtMs ?? 0) - (a.savedAtMs ?? 0) || a.id.localeCompare(b.id)
}

/**
 * The plugin-owned credential path for one variant's default filename.
 * Kept as a free function for the CLI, which builds no store per display line.
 */
export function qoderOwnAuthPath(variant: QoderVariant): string {
  return join(qoderPluginDataDir(), variant.ownFilename)
}
