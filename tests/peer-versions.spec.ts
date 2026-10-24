import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { peerExpectations, peerVersionFailure, satisfiesRange } from '../src/index.ts'

/**
 * The load-time peer check exists because a profile installed with
 * `autoInstallPeers: false` keeps whatever copy of `dsh-llm` / `pi-ai` it first
 * resolved, and the plugin imports that copy regardless of what peer ranges
 * declare. These tests pin the two halves: the range comparison itself, and the
 * resolution walk that reads the manifest Node will actually load.
 */

describe('peer range comparison', () => {
  const cases: ReadonlyArray<readonly [string, string, boolean, string]> = [
    // The floor this plugin declares, and the host versions in the wild.
    ['0.2.1-rc.2', '>=0.2.1-rc.1', true, 'current host build passes'],
    ['0.2.1-rc.1', '>=0.2.1-rc.1', true, 'exact floor passes'],
    ['0.2.1', '>=0.2.1-rc.1', true, 'release above the rc floor passes'],
    ['0.3.0', '>=0.2.1-rc.1', true, 'newer minor passes'],
    ['0.2.0', '>=0.2.1-rc.1', false, 'older minor fails'],
    ['0.1.6-alpha.2', '>=0.2.1-rc.1', false, 'stale profile copy fails'],
    // pi-ai's caret floor.
    ['1.3.0', '^1.1.0', true, 'current pi-ai passes'],
    ['1.1.0', '^1.1.0', true, 'exact caret floor passes'],
    ['1.4.0', '^1.1.0', true, 'caret admits the next minor'],
    ['1.0.9', '^1.1.0', false, 'caret rejects a lower minor'],
    ['2.0.0', '^1.1.0', false, 'caret rejects the next major'],
    ['2.0.0-rc.1', '^1.1.0', false, 'a preview of the next major is still out of range'],
    ['0.3.0-rc.1', '^0.2.1', false, 'a preview of the next minor is still out of range'],
    ['1.5.0-rc.1', '^1.1.0', true, 'a preview inside an admitted minor passes'],
    ['1.1.0-rc.1', '^1.1.0', true, 'an rc of the caret floor passes'],
    ['0.82.1', '^1.1.0', false, 'stale pi-ai 0.82.x fails'],
    ['0.85.1', '^1.1.0', false, 'stale pi-ai 0.85.x fails'],
    // Pre-release ordering.
    ['0.2.1-alpha', '>=0.2.1-beta', false, 'alpha sorts below beta'],
    ['0.2.1-beta.2', '>=0.2.1-alpha.1', true, 'beta sorts above alpha'],
    ['0.2.1-rc.1', '>=0.2.1-rc.2', false, 'rc.1 sorts below rc.2'],
    ['0.2.1-rc.10', '>=0.2.1-rc.9', true, 'numeric pre-release id compares numerically'],
    ['0.2.1', '>=0.2.1-rc.1', true, 'release sorts above its own rc'],
    // Deliberate leniency: an rc of the floor base counts as the floor.
    ['0.2.1-rc.2', '>=0.2.1', true, 'rc of the bound base passes a bare floor'],
    ['0.2.1-rc.2', '^0.2.1', true, 'rc of the bound base passes caret'],
    // 0.x caret locks the first non-zero field.
    ['0.0.5', '^0.0.1', false, '^0.0.1 admits only 0.0.1'],
    ['0.0.5', '^0.0.5', true, 'exact 0.0.x floor passes'],
    ['0.0.6', '^0.0.5', false, '^0.0.5 admits only 0.0.5'],
    ['0.2.9', '^0.2.1', true, '^0.2.1 admits the rest of 0.2.x'],
    ['0.3.0', '^0.2.1', false, '^0.2.1 stops at 0.3.0'],
    ['1.9.9', '^1.2.3', true, '^1.2.3 admits the rest of 1.x'],
    // Unknowable forms pass: a declaration we cannot parse must never block a load.
    ['latest', '^1.1.0', true, 'non-semver tag passes'],
    ['canary', '>=0.0.0', true, 'non-semver tag passes'],
    ['1.0', '>=1.0.0', true, 'two-part version is not semver, passes'],
    ['0.2.1+build.5', '>=0.2.1-rc.1', true, 'build metadata is ignored'],
    ['1.0.0', '', true, 'empty range passes'],
    ['1.0.0', 'invalid', true, 'unparseable range passes'],
    ['1.0.0', '~1.0.0', true, 'tilde admits its own patch'],
    ['1.0.4', '~1.0.0', true, 'tilde admits a later patch'],
    ['1.0.9', '~1.0.0', true, 'tilde stays inside the minor'],
    ['1.1.0', '~1.0.0', false, 'tilde stops at the next minor'],
    ['0.2.9', '~0.2.1', true, 'tilde on a 0.x line admits later patches'],
    ['0.3.0', '~0.2.1', false, 'tilde on a 0.x line stops at the next minor'],
    ['1.0.0', '1.x', true, 'unimplemented range form passes'],
  ]

  for (const [version, range, expected, note] of cases) {
    it(`${version} vs ${range} -> ${expected} (${note})`, () => {
      expect(satisfiesRange(version, range)).toBe(expected)
    })
  }
})

describe('checked peers come from the manifest', () => {
  it('uses the ranges this package declares, not a copy of them', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { peerDependencies: Record<string, string> }
    const expectations = peerExpectations()
    expect(expectations.length).toBeGreaterThan(0)
    for (const { spec, range } of expectations) {
      expect(range).toBe(manifest.peerDependencies[spec])
    }
  })
})

describe('peer version resolution', () => {
  const dirs: string[] = []

  /** A throwaway node_modules tree holding one package at one version. */
  function fixture(tree: Record<string, string | null>): string {
    const root = mkdtempSync(join(tmpdir(), 'qoder-peer-'))
    dirs.push(root)
    writeFileSync(join(root, 'package.json'), '{"name":"fixture"}')
    for (const [spec, version] of Object.entries(tree)) {
      const dir = join(root, 'node_modules', ...spec.split('/'))
      mkdirSync(dir, { recursive: true })
      // A null version writes a manifest JSON cannot parse.
      writeFileSync(
        join(dir, 'package.json'),
        version === null ? '{ not json' : JSON.stringify({ name: spec, version }),
      )
    }
    return root
  }

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  const expectations = [{ spec: '@scope/pkg', range: '>=0.2.1-rc.1' }]

  it('passes when the resolved copy meets the floor', () => {
    const root = fixture({ '@scope/pkg': '0.2.1-rc.2' })
    expect(peerVersionFailure(createRequireFrom(root), expectations)).toBeUndefined()
  })

  it('names the spec, the range and the resolved version on a stale copy', () => {
    const root = fixture({ '@scope/pkg': '0.1.6-alpha.2' })
    expect(peerVersionFailure(createRequireFrom(root), expectations)).toMatch(
      /@scope\/pkg@>=0\.2\.1-rc\.1.*0\.1\.6-alpha\.2/s,
    )
  })

  it('reports a missing package instead of a version verdict', () => {
    const root = fixture({})
    expect(peerVersionFailure(createRequireFrom(root), expectations)).toMatch(/is not resolvable/)
  })

  it('skips an unreadable manifest rather than failing on the parse error', () => {
    const root = fixture({ '@scope/pkg': null })
    expect(peerVersionFailure(createRequireFrom(root), expectations)).toMatch(/is not resolvable/)
  })

  it('keeps looking past a candidate manifest that states no version', () => {
    const outer = mkdtempSync(join(tmpdir(), 'qoder-peer-'))
    dirs.push(outer)
    const inner = join(outer, 'proj')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(inner, 'package.json'), '{"name":"proj"}')
    // Nearer candidate parses but states no version; the search must not stop here.
    mkdirSync(join(inner, 'node_modules', '@scope', 'pkg'), { recursive: true })
    writeFileSync(
      join(inner, 'node_modules', '@scope', 'pkg', 'package.json'),
      JSON.stringify({ name: '@scope/pkg' }),
    )
    // Farther candidate is the stale copy that decides the verdict.
    mkdirSync(join(outer, 'node_modules', '@scope', 'pkg'), { recursive: true })
    writeFileSync(
      join(outer, 'node_modules', '@scope', 'pkg', 'package.json'),
      JSON.stringify({ name: '@scope/pkg', version: '0.1.6-alpha.2' }),
    )
    expect(peerVersionFailure(createRequireFrom(inner), expectations)).toMatch(/0\.1\.6-alpha\.2/)
  })

  it('reports a range it cannot interpret instead of enforcing nothing quietly', () => {
    const root = fixture({ '@scope/pkg': '0.1.0' })
    const warnings: string[] = []
    const failure = peerVersionFailure(
      createRequireFrom(root),
      [{ spec: '@scope/pkg', range: '*' }],
      message => warnings.push(message),
    )
    expect(failure).toBeUndefined()
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toMatch(/cannot interpret the range "\*"/)
  })
})

/** A resolver anchored at a fixture root, so lookups start inside it. */
function createRequireFrom(root: string): NodeJS.Require {
  return createRequire(join(root, 'package.json'))
}
