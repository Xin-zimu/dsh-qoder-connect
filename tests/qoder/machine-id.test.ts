import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getMachineId } from '../../src/qoder/transport/machine-id.ts'

/**
 * The machine id belongs in the resolved harness home, never in
 * `~/.dsh/qoder/machine_id`. Every assertion runs against throwaway
 * `$HOME`/`$DSH_HOME` directories, so a stray home write shows up as a file there.
 */

let fakeHome: string
let fakeDshHome: string
let savedEnv: NodeJS.ProcessEnv

// No profiles/ directory, so discovery falls back to the harness home itself —
// which is where the seed belongs outside a profile.
function seedPath(): string {
  return join(fakeDshHome, '.dsh-qoder-connect', 'state', '.qoder-machine-id')
}

before(() => {
  savedEnv = { ...process.env }
  fakeHome = mkdtempSync(join(tmpdir(), 'qoder-machine-id-home-'))
  fakeDshHome = mkdtempSync(join(tmpdir(), 'qoder-machine-id-dsh-'))
  // os.homedir() reads USERPROFILE on Windows and HOME on POSIX; set both so
  // the test pins the same behavior on every platform.
  process.env.USERPROFILE = fakeHome
  process.env.HOME = fakeHome
  process.env.DSH_HOME = fakeDshHome
})

after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    process.env[key] = value
  }
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(fakeDshHome, { recursive: true, force: true })
})

test('getMachineId() prefers the official Qoder CLI file and creates nothing', () => {
  const officialDir = join(fakeHome, '.qoder', '.auth')
  mkdirSync(officialDir, { recursive: true })
  writeFileSync(join(officialDir, 'machine_id'), 'official-machine-id\n')
  try {
    assert.equal(getMachineId(), 'official-machine-id')
    assert.equal(existsSync(seedPath()), false)
  } finally {
    rmSync(join(fakeHome, '.qoder'), { recursive: true, force: true })
  }
})

test('getMachineId() creates the seed inside the harness home, never under $HOME', () => {
  const machineId = getMachineId()
  assert.match(machineId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(readFileSync(seedPath(), 'utf8').trim(), machineId)
  assert.equal(existsSync(join(fakeHome, '.dsh')), false)
  assert.equal(getMachineId(), machineId)
})

test('getMachineId([]) nominates no save location and stays process-local', () => {
  const machineId = getMachineId([])
  assert.ok(machineId.length > 0)
  assert.notEqual(getMachineId([]), machineId)
  assert.equal(readFileSync(seedPath(), 'utf8').trim().length > 0, true)
})

test('getMachineId([chain]) still honors an explicit create point', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'qoder-machine-id-explicit-')), 'machine_id')
  try {
    const machineId = getMachineId([path])
    assert.ok(machineId.length > 0)
    assert.equal(getMachineId([path]), machineId)
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
})
