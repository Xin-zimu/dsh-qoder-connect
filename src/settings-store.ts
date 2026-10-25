/**
 * Plugin-owned settings store — the single source of truth for this plugin's user
 * configuration on every host line.
 *
 * A profile patch write reconciles the whole loader tree and hot-reloads the
 * plugin's fiber on every write, so the plugin's settings live beside its other
 * files in `<plugin data dir>/settings.json`: a write is a small atomic file write
 * with an in-memory apply, no reload. The path comes from `qoderPluginDataDir()`,
 * the plugin's one discovery implementation.
 *
 * Migration (one time): an absent file is seeded from the entry config's fields,
 * then only this plugin's fields are deleted from the entry config.
 *
 * @module dsh-qoder-connect/settings-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { qoderPluginDataDir } from './paths.ts'

/** Settings file name inside the plugin data directory. */
const SETTINGS_FILE_NAME = 'settings.json'
/** This plugin's data directory (shared with the credential and caches). */
export function dataDir(): string {
  return qoderPluginDataDir()
}

/** Absolute path of the settings file. */
export function settingsFilePath(): string {
  return join(dataDir(), SETTINGS_FILE_NAME)
}

/** Read + parse the settings file; `undefined` when absent or unreadable. */
function readFile(): Record<string, unknown> | undefined {
  const path = settingsFilePath()
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    // A corrupt file is not a reason to take the host down: the caller falls
    // back to the entry config, whose values still serve as a live fallback.
    return undefined
  }
}

/** Write the settings file atomically (tmp + rename), creating the directory. */
export function writeSettings(values: Record<string, unknown>): void {
  const path = settingsFilePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/**
 * Reserved bookkeeping key: how many writes the settings card has made through
 * this store. It separates "the file holds the startup seed" from "the file holds
 * the user's live edits". Field readers address their fields by name and never
 * collide with it.
 */
const WRITE_MARK = '__writes'

/**
 * One store instance: the plugin's own settings file, with the entry config as
 * the fallback layer the caller overlays it on.
 */
export class SettingsStore {
  /** The user layer exactly as stored (presence marks an override). */
  readonly user: Record<string, unknown>

  constructor() {
    this.user = readFile() ?? {}
  }

  /** Whether the store file exists. */
  exists(): boolean {
    return existsSync(settingsFilePath())
  }

  /**
   * Whether the settings card has ever written through this store.
   *
   * Until it has, the entry config stays the fallback layer; once the card writes,
   * the file is authoritative — a runtime edit must never be regressed by a stale
   * profile row.
   */
  get edited(): boolean {
    return typeof this.user[WRITE_MARK] === 'number' && this.user[WRITE_MARK] > 0
  }

  /**
   * Apply one patch in memory and persist it.
   * @param patch - field → value; a `null` value clears the field.
   * @param fromCard - true when the settings card made this write; marks the
   *   file as holding live user edits from then on.
   * @returns the new user layer.
   */
  patch(patch: Record<string, unknown>, fromCard = false): Record<string, unknown> {
    const next = { ...this.user }
    for (const [field, value] of Object.entries(patch)) {
      if (value === null) delete next[field]
      else next[field] = value
    }
    if (fromCard) next[WRITE_MARK] = (typeof next[WRITE_MARK] === 'number' ? next[WRITE_MARK] : 0) + 1
    writeSettings(next)
    // Keep the in-memory view in step with the file without swapping the
    // reference the host captured: mutate in place.
    for (const key of Object.keys(this.user)) delete this.user[key]
    Object.assign(this.user, next)
    return this.user
  }

  /** The current user layer. */
  values(): Record<string, unknown> {
    return this.user
  }
}
