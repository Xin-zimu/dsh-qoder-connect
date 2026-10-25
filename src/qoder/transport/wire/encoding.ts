/**
 * Qoder WAF body encoding: rearranges standard Base64 chunks and translates
 * characters through a custom alphabet. A byte table replaces the slower
 * per-character loop; the output is byte-for-byte identical.
 *
 * @module dsh-provider-qoder/qoder/transport/wire/encoding
 */

const qoderCustomAlphabet = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
const qoderStdAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Byte translation table: every byte maps to itself unless it is a Base64
 * alphabet character (→ the custom alphabet) or the `=` pad (→ `$`).
 */
const encodeTable: Uint8Array = (() => {
  const table = new Uint8Array(256)
  for (let index = 0; index < 256; index++) table[index] = index
  for (let index = 0; index < qoderStdAlphabet.length; index++) {
    table[qoderStdAlphabet.charCodeAt(index)] = qoderCustomAlphabet.charCodeAt(index)
  }
  table['='.charCodeAt(0)] = '$'.charCodeAt(0)
  return table
})()

export function qoderEncodeBody(plaintext: string | Buffer): string {
  const std = Buffer.isBuffer(plaintext) ? plaintext.toString('base64') : Buffer.from(plaintext).toString('base64')
  const n = std.length
  const a = Math.floor(n / 3)
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a)
  // Base64 output is ASCII, so a latin1 view is exact and the table applies byte-wise.
  const source = Buffer.from(rearranged, 'latin1')
  const target = Buffer.allocUnsafe(n)
  for (let index = 0; index < n; index++) {
    // Both indexes are in range by construction; the fallbacks satisfy noUncheckedIndexedAccess.
    target[index] = encodeTable[source[index] ?? 0] ?? 0
  }
  return target.toString('latin1')
}
