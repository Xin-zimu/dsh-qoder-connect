import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { QODER_CONNECT_VERSION } from '../src/version.ts'

/**
 * Guard the single-source-of-truth version contract: the build-time define
 * (`__DSH_QODER_VERSION__`) injects package.json's version into src/version.ts, and
 * dropping it makes version.ts fall back to '0.0.0-dev' — which this test refuses.
 */
describe('package version sync', () => {
  it('QODER_CONNECT_VERSION matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(QODER_CONNECT_VERSION).toBe(pkg.version)
  })

  it('never leaks a build-define fallback marker', () => {
    expect(QODER_CONNECT_VERSION).not.toBe('0.0.0-dev')
  })

  /**
   * The define reads package.json at BUILD time, so bumping the version after a
   * build ships artifacts reporting the old one. The literal may land in `index.js`
   * or a shared chunk beside it, so every emitted `.js` is scanned rather than one
   * guessed filename; skipped on a fresh clone before the first build.
   */
  it('built lib/ artifacts carry the current version when present', () => {
    const libDir = new URL('../lib/', import.meta.url)
    if (!existsSync(libDir)) return
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const bundles = readdirSync(libDir).filter(name => name.endsWith('.js'))
    expect(bundles.length, 'no built bundles in lib/ — run the build before this test').toBeGreaterThan(0)
    const declaring = bundles.filter(bundle =>
      readFileSync(new URL(`../lib/${bundle}`, import.meta.url), 'utf8')
        .includes(`QODER_CONNECT_VERSION = "${pkg.version}"`),
    )
    expect(
      declaring,
      `no built bundle declares QODER_CONNECT_VERSION as "${pkg.version}" — rebuild before committing or publishing`,
    ).not.toHaveLength(0)
  })
})
