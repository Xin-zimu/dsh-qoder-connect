import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { qoderMachineIdPath } from '../../paths.ts'

/**
 * The machine id Qoder's own CLI keeps at `$HOME/.qoder/.auth/machine_id`, read
 * only: the transport reuses it and never writes into that tree.
 */
function officialMachineIdPath(): string {
  return join(homedir(), '.qoder', '.auth', 'machine_id')
}

/**
 * Read chain when the caller nominates none: the official CLI's id first, this
 * plugin's seed last — the only location a new id is ever saved to.
 */
function defaultMachineIdPaths(): string[] {
  return [officialMachineIdPath(), qoderMachineIdPath()]
}

/**
 * Read Qoder's machine id, or create this plugin's seed at the chain's end.
 * `paths` is the read chain; its last entry doubles as the create point, and an
 * empty array keeps the id process-local.
 */
export function getMachineId(paths: readonly string[] = defaultMachineIdPaths()): string {
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      const value = readFileSync(path, 'utf8').trim()
      if (value) return value
    } catch {
      // Try the next trusted location.
    }
  }

  const machineId = crypto.randomUUID()
  const savePath = paths.at(-1)
  if (savePath === undefined) return machineId
  try {
    mkdirSync(dirname(savePath), { recursive: true })
    writeFileSync(savePath, machineId, { encoding: 'utf8', flag: 'wx' })
  } catch {
    // Another process may have won creation; prefer its stable value.
    try {
      const existing = readFileSync(savePath, 'utf8').trim()
      if (existing) return existing
    } catch {
      // An ephemeral id is still sufficient for this process.
    }
  }
  return machineId
}
