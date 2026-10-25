/**
 * Plugin-owned settings scope over the Host's settings face.
 *
 * The host half serves this plugin's configuration from its own settings file
 * over a loopback route (writing through the host's config editor would
 * recompose the whole loader tree on every toggle); this module is the browser
 * half, implementing the same {@link QuotaSettingsScope} surface the card was
 * written against.
 */

import type { QuotaSection, QuotaSettingsScope, QuotaSettingsSnapshot } from './QuotaSettingsCard.tsx'

/** Base path of the host half's settings face. */
const ROUTE_BASE = '/plugins/dsh-qoder-connect'

/** The document the host's GET and POST answer with. */
interface SettingsFaceDocument {
  /** Write authorizer, minted per host plugin lifetime. */
  key: string
  /** Effective values: the settings file over the composition entry. */
  value: Partial<QuotaSection>
  /** The schema defaults the host serves. */
  base: Partial<QuotaSection>
  /** The user layer exactly as stored (presence marks an override). */
  user: Partial<QuotaSection>
}

/**
 * Fetch one settings face document.
 * @param init - the request init (method, headers, body).
 * @returns the parsed document.
 * @throws when the transport or the host refuses the request.
 */
async function request(init: RequestInit): Promise<SettingsFaceDocument> {
  const response = await fetch(`${ROUTE_BASE}/settings`, {
    credentials: 'same-origin',
    ...init,
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const error = typeof value === 'object' && value !== null && 'error' in value
      ? String((value as Record<string, unknown>)['error'])
      : `HTTP ${response.status}`
    throw new Error(error)
  }
  if (typeof value !== 'object' || value === null || !('value' in value)) {
    throw new Error('qoder: settings face answered an invalid document')
  }
  return value as SettingsFaceDocument
}

/**
 * The scope the card was written against, backed by this plugin's own file.
 *
 * A write optimistically adopts the value it just sent, then confirms with the
 * host's answer (which re-reads the file it wrote), so the card never renders a
 * value the host does not hold.
 */
export class OwnQuotaSettingsScope implements QuotaSettingsScope<QuotaSection> {
  private document: SettingsFaceDocument | undefined
  private readonly listeners = new Set<() => void>()
  private snapshot: QuotaSettingsSnapshot<QuotaSection> = { status: 'loading', value: undefined, writable: true }
  private writeChain: Promise<unknown> = Promise.resolve()
  private lastWriteFailed = false

  /**
   * Load the current document. Call once before the card binds; repeated calls
   * are harmless and re-read the host.
   * @returns the effective values.
   */
  async load(): Promise<QuotaSection | undefined> {
    try {
      this.document = await request({ headers: { accept: 'application/json' } })
    } catch {
      // An unreachable face is not a broken card: it keeps loading and the
      // toggles stay inert, exactly like an unserved namespace.
      return undefined
    }
    this.publish()
    return this.document.value
  }

  /** @returns the stable snapshot the card reads (ready once loaded). */
  getSnapshot(): QuotaSettingsSnapshot<QuotaSection> {
    return this.snapshot
  }

  /** @param listener - invoked after every snapshot change. @returns the disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Write one field.
   * @param field - field name inside the settings document.
   * @param value - the JSON-shaped value to store.
   * @returns whether the host accepted the write.
   */
  async set(field: string, value: unknown): Promise<boolean> {
    return this.patch({ [field]: value })
  }

  /**
   * Clear one field: the value falls back to the schema default.
   * @param field - field name inside the settings document.
   * @returns whether the host accepted the clear.
   */
  async unset(field: string): Promise<boolean> {
    return this.patch({ [field]: null })
  }

  /** Send one patch and adopt the host's answer, serialized via writeChain. */
  private async patch(patch: Record<string, unknown>): Promise<boolean> {
    const key = this.document?.key
    if (key === undefined) return false
    const task = async (): Promise<boolean> => {
      try {
        this.document = await request({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Qoder-Settings-Key': key,
          },
          body: JSON.stringify(patch),
        })
        this.lastWriteFailed = false
        this.publish()
        return true
      } catch {
        this.lastWriteFailed = true
        this.publish()
        return false
      }
    }
    const resultPromise = this.writeChain.then(task, task)
    this.writeChain = resultPromise.catch(() => {})
    return resultPromise
  }

  /** Rebuild the cached snapshot and notify the subscribers. */
  private publish(): void {
    this.snapshot = {
      status: this.document === undefined ? 'loading' : 'ready',
      value: this.document?.value,
      writable: !this.lastWriteFailed,
    }
    for (const listener of this.listeners) listener()
  }
}
