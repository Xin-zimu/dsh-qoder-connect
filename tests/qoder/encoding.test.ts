import test from 'node:test'
import assert from 'node:assert/strict'
import { qoderEncodeBody } from '../../src/qoder/transport/wire/encoding.ts'

test('qoderEncodeBody encodes ASCII strings deterministically', () => {
  const input = '{"test": "hello world"}'
  const encoded1 = qoderEncodeBody(input)
  const encoded2 = qoderEncodeBody(Buffer.from(input))

  assert.equal(typeof encoded1, 'string')
  assert.equal(encoded1, encoded2)
  assert.ok(encoded1.length > 0)
})

test('qoderEncodeBody handles padding characters correctly', () => {
  const input = 'a' // Base64 is "YQ==", should replace '=' with '$'
  const encoded = qoderEncodeBody(input)
  assert.ok(encoded.includes('$'))
})

test('qoderEncodeBody handles UTF-8 characters correctly', () => {
  const input = '{"message": "你好，世界"}'
  const encoded = qoderEncodeBody(input)
  assert.ok(encoded.length > 0)
})

/**
 * The byte-table form must stay byte-for-byte identical to the character-loop
 * reference: the encoding is wire contract, and a mismatch is rejected upstream.
 */
function referenceEncode(plaintext: string | Buffer): string {
  const stdAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const customAlphabet = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString('base64') : Buffer.from(plaintext).toString('base64')
  const n = std.length
  const a = Math.floor(n / 3)
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a)
  let out = ''
  for (let index = 0; index < n; index++) {
    const character = rearranged[index]
    if (character === undefined) continue
    if (character === '=') out += '$'
    else {
      const position = stdAlphabet.indexOf(character)
      out += position >= 0 ? customAlphabet[position] : character
    }
  }
  return out
}

test('qoderEncodeBody matches the character-loop reference on every length class', () => {
  // Lengths around the 3-way split boundaries: the `Math.floor(n/3)`
  // re-arrangement behaves differently per residue, so one sample proves nothing.
  const cases: string[] = []
  for (let length = 0; length <= 40; length++) cases.push('x'.repeat(length))
  cases.push(
    '{"messages":[{"role":"user","content":"你好，世界 🌍"}]}',
    JSON.stringify({ filler: 'A'.repeat(10_000) }),
    JSON.stringify({ filler: '中'.repeat(5_000) }),
    'a',
    'ab',
    'abc',
    'abcd',
    '',
  )
  for (const input of cases) {
    assert.equal(
      qoderEncodeBody(input),
      referenceEncode(input),
      `mismatch for input of length ${input.length}`,
    )
    assert.equal(
      qoderEncodeBody(Buffer.from(input, 'utf8')),
      referenceEncode(Buffer.from(input, 'utf8')),
      `buffer mismatch for input of length ${input.length}`,
    )
  }
})

test('qoderEncodeBody stays cheap on a large body (main-thread budget)', () => {
  // A 1 MB body is an ordinary large-context request: the table form stays in the
  // millisecond range where the character loop blocked the event loop for ~800 ms.
  const body = JSON.stringify({ filler: '中'.repeat(500_000) })
  const started = performance.now()
  const encoded = qoderEncodeBody(body)
  const elapsed = performance.now() - started
  assert.equal(encoded, referenceEncode(body))
  assert.ok(elapsed < 250, `encoding a ${body.length}-char body took ${Math.round(elapsed)}ms`)
})
