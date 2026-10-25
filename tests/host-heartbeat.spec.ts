import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  qoderHostHeartbeatPath,
  QODER_HOST_HEARTBEAT_FILENAME,
  readHostHeartbeat,
  writeHostHeartbeat,
  type QoderHostHeartbeat,
} from '../src/host-heartbeat.ts'
import { QODER_DATA_DIR_ENV } from '../src/paths.ts'
import { QODER_CONNECT_VERSION } from '../src/version.ts'

/**
 * The host heartbeat lives in the state subdirectory
 * (`<DSH_QODER_DATA_DIR>/state/.qoder-host-heartbeat.json`): `writeHostHeartbeat`
 * is best-effort and creates nothing itself. The data dir is stubbed, so nothing
 * ever touches a real profile.
 */

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** A temporary data dir with the state subdirectory the runtime creates. */
async function tempStateRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'qoder-heartbeat-'))
  vi.stubEnv(QODER_DATA_DIR_ENV, root)
  await mkdir(join(root, 'state'), { recursive: true })
  return root
}

describe('host heartbeat', () => {
  it('writes, reads, and clears a heartbeat under the state directory', async () => {
    const dir = await tempStateRoot()

    // Before write: absent.
    expect(await readHostHeartbeat()).toBeUndefined()

    await writeHostHeartbeat()

    // After write: present and well-formed.
    const heartbeat = await readHostHeartbeat()
    expect(heartbeat).toBeDefined()
    expect(heartbeat!.package).toBe('dsh-qoder-connect')
    expect(heartbeat!.version).toBe(1)
    expect(heartbeat!.pid).toBe(process.pid)
    expect(typeof heartbeat!.registeredAt).toBe('number')
    expect(heartbeat!.pluginVersion).toBe(QODER_CONNECT_VERSION)

    // The file lives at the expected path: the data dir's `state/` subfolder.
    expect(qoderHostHeartbeatPath()).toBe(join(dir, 'state', QODER_HOST_HEARTBEAT_FILENAME))

    // Live PID is detectable.
    expect(isHeartbeatProcessAlive(heartbeat!)).toBe(true)

    // A fake PID that cannot exist is detected as dead.
    const fakeHeartbeat = { ...heartbeat!, pid: 999_999 }
    expect(isHeartbeatProcessAlive(fakeHeartbeat)).toBe(false)

    // Clear removes the file.
    await clearHostHeartbeat()
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('writes the documented v1 document verbatim', async () => {
    const dir = await tempStateRoot()
    const before = Date.now()
    await writeHostHeartbeat()
    const raw = JSON.parse(
      await import('node:fs/promises').then(fs => fs.readFile(join(dir, 'state', QODER_HOST_HEARTBEAT_FILENAME), 'utf8')),
    ) as Record<string, unknown>
    expect(raw).toMatchObject({
      version: 1,
      package: 'dsh-qoder-connect',
      pluginVersion: QODER_CONNECT_VERSION,
      pid: process.pid,
    })
    expect(typeof raw.registeredAt).toBe('number')
    expect(raw.registeredAt as number).toBeGreaterThanOrEqual(before)
  })

  it('a write with the state directory missing creates it and lands the file', async () => {
    // `writeHostHeartbeat` never throws and owns creating state/, so a host that
    // registers before the stores touch the dir still leaves a readable file.
    root = await mkdtemp(join(tmpdir(), 'qoder-heartbeat-nodir-'))
    vi.stubEnv(QODER_DATA_DIR_ENV, root)
    await expect(writeHostHeartbeat()).resolves.toBeUndefined()
    const heartbeat = await readHostHeartbeat()
    expect(heartbeat).toBeDefined()
    expect(heartbeat?.package).toBe('dsh-qoder-connect')
  })

  it('probes PID liveness with process.kill and rejects invalid PIDs', async () => {
    const genuine: QoderHostHeartbeat = {
      version: 1,
      package: 'dsh-qoder-connect',
      pluginVersion: '0.0.0-test',
      registeredAt: Date.now(),
      pid: process.pid,
    }
    expect(isHeartbeatProcessAlive(genuine)).toBe(true)

    // A fake PID that does not exist in the OS is detected as dead
    const fakeHeartbeat: QoderHostHeartbeat = { ...genuine, pid: 2_147_483_647 }
    expect(isHeartbeatProcessAlive(fakeHeartbeat)).toBe(false)

    // Invalid PIDs (0, negative, non-integer) are rejected before probing
    expect(isHeartbeatProcessAlive({ ...genuine, pid: 0 })).toBe(false)
    expect(isHeartbeatProcessAlive({ ...genuine, pid: -1 })).toBe(false)
    expect(isHeartbeatProcessAlive({ ...genuine, pid: 1.5 })).toBe(false)

    // EPERM is treated as alive (process exists but unprivileged)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })
    expect(isHeartbeatProcessAlive(genuine)).toBe(true)

    // ESRCH is treated as dead (process does not exist)
    kill.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    expect(isHeartbeatProcessAlive(genuine)).toBe(false)

    // Unknown error code is treated as dead
    kill.mockImplementation(() => {
      throw Object.assign(new Error('unknown'), { code: 'ENOSYS' })
    })
    expect(isHeartbeatProcessAlive(genuine)).toBe(false)

    kill.mockRestore()
  })

  it('treats a malformed heartbeat file as absent', async () => {
    const dir = await tempStateRoot()
    const { writeFile: write } = await import('node:fs/promises')
    await write(join(dir, 'state', QODER_HOST_HEARTBEAT_FILENAME), '{ not json', 'utf8')
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('rejects a heartbeat with the wrong format version', async () => {
    const dir = await tempStateRoot()
    await writeFile(
      join(dir, 'state', QODER_HOST_HEARTBEAT_FILENAME),
      JSON.stringify({ version: 99, package: 'dsh-qoder-connect', registeredAt: Date.now(), pid: process.pid }),
      'utf8',
    )
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('rejects a WorkBuddy-era heartbeat (wrong package name)', async () => {
    // The old plugin's file — same directory, same format version — must read
    // as absent rather than be adopted by the Qoder reader.
    const dir = await tempStateRoot()
    await writeFile(
      join(dir, 'state', QODER_HOST_HEARTBEAT_FILENAME),
      JSON.stringify({ version: 1, package: 'dsh-workbuddy-connect', registeredAt: Date.now(), pid: process.pid }),
      'utf8',
    )
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('reads a missing pluginVersion as the honest "unknown"', async () => {
    const dir = await tempStateRoot()
    await writeFile(
      join(dir, 'state', QODER_HOST_HEARTBEAT_FILENAME),
      JSON.stringify({ version: 1, package: 'dsh-qoder-connect', registeredAt: 5, pid: process.pid }),
      'utf8',
    )
    const heartbeat = await readHostHeartbeat()
    expect(heartbeat).toEqual({
      version: 1,
      package: 'dsh-qoder-connect',
      pluginVersion: 'unknown',
      registeredAt: 5,
      pid: process.pid,
    })
  })
})
