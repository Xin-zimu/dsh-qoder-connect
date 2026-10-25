/**
 * Host-side heartbeat: a small JSON file written into the plugin's data directory
 * once the `qoder` providers are registered. The status CLI reads it to report
 * whether the host bundle is alive, independent of the browser card (the browser
 * bundle cannot write files, and the host is the load-bearing half).
 *
 * @module dsh-qoder-connect/host-heartbeat
 */

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
  /** Host process PID. Liveness is a bare existence probe: a reused PID reads as alive. */
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
export async function clearHostHeartbeat(expectedPid: number = process.pid): Promise<void> {
  try {
    const current = await readHostHeartbeat()
    if (current !== undefined && current.pid !== expectedPid) return
    await rm(qoderHostHeartbeatPath(), { force: true })
  } catch {
    // Best-effort cleanup; a leftover file reads as alive only while its PID is still in use.
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
 * Whether the heartbeat's PID is still alive.
 *
 * Uses Node's native `process.kill(pid, 0)` cross-platform signal probe:
 * - Returns true on success or EPERM (process exists and is alive);
 * - Returns false on ESRCH (process does not exist in the operating system);
 * - Rejects non-positive or non-integer PIDs to prevent matching process groups.
 *
 * Known limitation: after a host crash, if the OS recycles and reassigns the same PID
 * to another process before cleanup, it reads as alive until that PID exits. This trade-off
 * is accepted because wmic was removed in Windows 11 24H2+, PowerShell child processes are
 * fragile under restrictive sandboxes, and the status check serves only as an informational
 * hint in the doctor CLI rather than a critical operational invariant.
 */
export function isHeartbeatProcessAlive(heartbeat: QoderHostHeartbeat): boolean {
  if (!Number.isInteger(heartbeat.pid) || heartbeat.pid <= 0) return false
  try {
    process.kill(heartbeat.pid, 0)
    return true
  } catch (error: unknown) {
    return (error as { code?: string })?.code === 'EPERM'
  }
}
