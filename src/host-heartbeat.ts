/**
 * Host-side heartbeat: a small JSON file written into the plugin's data directory
 * once the `qoder` providers are registered. The status CLI reads it to report
 * whether the host bundle is alive, independent of the browser card (the browser
 * bundle cannot write files, and the host is the load-bearing half).
 *
 * @module dsh-qoder-connect/host-heartbeat
 */

import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { qoderStateDir } from './paths.ts'
import { QODER_CONNECT_VERSION } from './version.ts'

/** Basename of the host heartbeat file inside the plugin's state directory. */
export const QODER_HOST_HEARTBEAT_FILENAME = '.qoder-host-heartbeat.json'

/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1

/** On-disk shape of the heartbeat. */
export interface QoderHostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION
  package: 'dsh-qoder-connect'
  pluginVersion: string
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number
}

/** Absolute path of the host heartbeat file. */
export function qoderHostHeartbeatPath(): string {
  return join(qoderStateDir(), QODER_HOST_HEARTBEAT_FILENAME)
}

/**
 * Write (or overwrite) the heartbeat after the host registered the provider.
 * A failed write is non-fatal: the CLI then reports "heartbeat missing".
 */
export async function writeHostHeartbeat(): Promise<void> {
  const document: QoderHostHeartbeat = {
    version: HEARTBEAT_FORMAT_VERSION,
    package: 'dsh-qoder-connect',
    pluginVersion: QODER_CONNECT_VERSION,
    registeredAt: Date.now(),
    pid: process.pid,
  }
  try {
    // The state/ directory is normally created by the catalog/probe stores;
    // ensure it here so the heartbeat never disappears when written first.
    await mkdir(qoderStateDir(), { recursive: true })
    await writeFile(qoderHostHeartbeatPath(), JSON.stringify(document), 'utf8')
  } catch {
    // Non-fatal: the CLI status will show "heartbeat missing".
  }
}

/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
export async function clearHostHeartbeat(): Promise<void> {
  try {
    await rm(qoderHostHeartbeatPath(), { force: true })
  } catch {
    // Best-effort cleanup; a stale heartbeat is harmless (PID mismatch is detected by the reader).
  }
}

/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
export async function readHostHeartbeat(): Promise<QoderHostHeartbeat | undefined> {
  let raw: string
  try {
    raw = await readFile(qoderHostHeartbeatPath(), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as Partial<QoderHostHeartbeat>
    if (
      parsed.version === HEARTBEAT_FORMAT_VERSION
      && parsed.package === 'dsh-qoder-connect'
      && typeof parsed.registeredAt === 'number'
      && typeof parsed.pid === 'number'
    ) {
      return {
        version: HEARTBEAT_FORMAT_VERSION,
        package: 'dsh-qoder-connect',
        pluginVersion: typeof parsed.pluginVersion === 'string' ? parsed.pluginVersion : 'unknown',
        registeredAt: parsed.registeredAt,
        pid: parsed.pid,
      }
    }
  } catch {
    // Malformed JSON; treat as absent.
  }
  return undefined
}

/**
 * Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
 * when it cannot be determined.
 *
 * macOS/Linux use `ps -o lstart=` parsed against the local clock; Windows uses
 * WMI `CreationDate` in UTC. Failures return `undefined` so callers fall back to
 * plain PID liveness instead of mis-reporting a live host as dead.
 */
export function processStartTimeMs(pid: number): number | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'wmic',
        ['process', 'where', `processid=${pid}`, 'get', 'CreationDate'],
        { encoding: 'utf8', windowsHide: true },
      )
      const m = out.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/)
      if (m === null) return undefined
      const [, y, mo, d, h, mi, s] = m
      const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
      return Number.isFinite(ms) ? ms : undefined
    }
    const out = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
    ).trim()
    if (out === '') return undefined
    const ms = Date.parse(out)
    return Number.isFinite(ms) ? ms : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the heartbeat's PID is still alive *and* still the same process that
 * registered it: signal 0 tests existence, and the holder's start time must be at
 * or before `registeredAt`. PID-only detection is not enough — the OS may recycle
 * the PID after a crash, producing a false "Host running". When the start time is
 * unreadable the check degrades to plain PID liveness.
 */
export function isHeartbeatProcessAlive(heartbeat: QoderHostHeartbeat): boolean {
  try {
    process.kill(heartbeat.pid, 0)
  } catch {
    return false
  }
  const startAtMs = processStartTimeMs(heartbeat.pid)
  if (startAtMs === undefined) return true // platform cannot read start time; PID alive is the best signal
  return startAtMs <= heartbeat.registeredAt
}
