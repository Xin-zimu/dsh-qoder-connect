import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildAuthHeaders, computeSigPath } from '../../src/qoder/transport/wire/cosy.ts'
import { getQoderChatUrl } from '../../src/qoder/transport/endpoints.ts'
import { getMachineId } from '../../src/qoder/transport/machine-id.ts'

test('computeSigPath strips the /algo prefix', () => {
  assert.equal(computeSigPath('https://api3.qoder.sh/algo/api/v2/service'), '/api/v2/service')
})

/**
 * The OS header must follow the official client's `<arch>_<platform>` formula, with
 * arm64 spelled `aarch64` and x64 spelled `x86_64`.
 *
 * Asserted through the header this module actually emits rather than through a
 * helper: an earlier fork fix exported `qoderMachineOsFor` to prove darwin was not
 * mislabelled as linux, but upstream then derived the value from `process.platform`
 * outright, which fixes the same defect without a function to call. Testing the
 * emitted header keeps the guarantee while surviving that refactor — and it is the
 * value upstream sees, which is what the risk-control concern was about.
 */
test('the Cosy-Machineos header names this host’s real platform, not a linux default', () => {
  const headers = buildAuthHeaders(Buffer.from('x'), getQoderChatUrl(), {
    userID: 'user-123',
    authToken: 'jt-token',
    name: 'User',
    email: 'user@example.com',
    machineID: 'machine-123',
  })
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch
  assert.equal(headers['Cosy-Machineos'], `${arch}_${process.platform}`)
  // The specific regression: a darwin host must never be reported as linux. This
  // branch only runs on macOS, so it documents rather than exercises the case on
  // other runners; the formula above is what covers them.
  if (process.platform === 'darwin') {
    assert.ok(headers['Cosy-Machineos']!.endsWith('_darwin'))
  }
})

test('getMachineId accepts an isolated storage location', () => {
  const path = join(tmpdir(), `qoder-machine-${crypto.randomUUID()}`, 'machine_id')
  const machineId = getMachineId([path])
  assert.ok(machineId.length > 0)
  assert.equal(getMachineId([path]), machineId)
})

test('buildAuthHeaders creates the required bounded COSY headers', () => {
  const body = Buffer.from('encoded-body')
  const headers = buildAuthHeaders(body, getQoderChatUrl(), {
    userID: 'user-123',
    authToken: 'jt-token',
    name: 'User',
    email: 'user@example.com',
    machineID: 'machine-123',
  })
  assert.ok(headers.Authorization!.startsWith('Bearer COSY.'))
  assert.equal(headers['Cosy-User'], 'user-123')
  assert.equal(headers['Cosy-Bodylength'], String(body.length))
  assert.equal(headers['Cosy-Sigpath'], '/api/v2/service/pro/sse/agent_chat_generation')
})
