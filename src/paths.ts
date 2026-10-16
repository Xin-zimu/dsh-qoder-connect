/**
 * The plugin's data directory — the ONE place every file the plugin owns
 * lives.
 *
 * Layout: `<profile>/.dsh-qoder-connect/state/` (the profile discovered
 * the same way the credential store always did). Everything — PAT files,
 * saved catalogs, probe records, the host heartbeat, and the machine-id
 * seed — writes there, so a profile directory never collects loose
 * `.qoder-*` files and the whole plugin's footprint is one folder.
 *
 * Fallbacks, in order: `DSH_QODER_DATA_DIR` env override → the profile the host
 * reports as running → the discovered profile → the Harness home (a checkout
 * running its own tests, or a host loading the plugin from outside any profile).
 *
 * The host-reported profile outranks discovery because it is the running
 * profile rather than an inference about it; see {@link configurePluginPaths}.
 *
 * Split out of `auth.ts` so catalog/probe/heartbeat stores can import the
 * directory without pulling in the credential code (and its upstream
 * dependency) — these modules stay leaf-light on purpose.
 *
 * @module dsh-qoder-connect/paths
 */

import { lstatSync, readFileSync, readdirSync, realpathSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** The per-profile directory the plugin's data folder lives under. */
export const QODER_DATA_DIR_NAME = '.dsh-qoder-connect'

/** The directory inside the data dir where the rebuildable state files live. */
export const QODER_STATE_DIR_NAME = 'state'

/** Environment override for the whole data directory. */
export const QODER_DATA_DIR_ENV = 'DSH_QODER_DATA_DIR'

const PROFILES_DIR_NAME = 'profiles'

/** The npm name of this package, as a profile's manifest declares it. */
const PLUGIN_PACKAGE_NAME = 'dsh-qoder-connect'

/** The subset of a logger this module reports decisions through. */
export interface PathsDiagnostics {
  warn(message: string): void
}

/** Host-reported facts about the running profile; see {@link configurePluginPaths}. */
let hostProfileDir: string | undefined
let diagnostics: PathsDiagnostics | undefined

/**
 * Adopt the host's answer for which profile is running, before any path is
 * resolved.
 *
 * `dsh` provides a `profileContext` service (`{ name, dir, … }`) on the host
 * context of every profile it boots — the CLI launcher and the desktop
 * application both, from the same shared boot code — so `dir` is the directory
 * this process booted in, not a guess about it.
 *
 * Called on every `apply()`, which overwrites both fields: a reload arriving
 * without a profile context clears the previous answer instead of keeping it.
 *
 * @param host - the host's report.
 * @param host.profileDir - `profileContext.dir`, when the host has one.
 * @param host.diagnostics - where an ambiguous discovery fallback is reported.
 */
export function configurePluginPaths(host: {
  profileDir: string | undefined
  diagnostics?: PathsDiagnostics | undefined
}): void {
  const reported = host.profileDir
  // An empty report is no report: joining the empty string as a directory would
  // put the data dir in the process's working directory.
  hostProfileDir = typeof reported === 'string' && reported.trim() !== '' ? reported : undefined
  diagnostics = host.diagnostics
}

function pluginPackageRoot(): string | undefined {
  try {
    // `<root>/lib/paths.js` in a build, `<root>/src/paths.ts` from source.
    return dirname(dirname(fileURLToPath(import.meta.url)))
  } catch {
    // Not loaded from a file URL (a bundled or synthetic module).
    return undefined
  }
}

/**
 * Whether a profile directory declares this plugin.
 *
 * Read from the profile's manifest rather than inferred from this module's own
 * location, because DSH installs a plugin into a profile by *link*: the manifest
 * carries `"dsh-qoder-connect": "link:/path/to/checkout"`, while Node
 * resolves the module to that real path, which lies outside `$DSH_HOME` entirely.
 * Walking up from the module would therefore miss the profile for exactly the
 * install shape a developer uses.
 */
function profileDeclaresPlugin(profileDir: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return typeof manifest.dependencies?.[PLUGIN_PACKAGE_NAME] === 'string'
      || typeof manifest.devDependencies?.[PLUGIN_PACKAGE_NAME] === 'string'
  } catch {
    // Not a profile, or unreadable: it simply is not a candidate.
    return false
  }
}

/**
 * Whether a profile's OWN `node_modules` is a link rather than a directory.
 *
 * This is the shape a residual directory takes when it was left behind by
 * copying another profile's manifest and pointing the whole tree at that
 * profile. A real install links the package (`node_modules/<name>`), not the
 * directory holding it, so this shape never identifies the running copy.
 *
 * An ABSENT `node_modules` is deliberately not this shape: a profile whose
 * packages resolve from the shared `profiles/node_modules` has none of its own,
 * and that profile may still be the one running.
 */
function profileNodeModulesIsLinked(profileDir: string): boolean {
  try {
    // On Windows a junction reports as a symbolic link here, which is the
    // intended detection.
    return lstatSync(join(profileDir, 'node_modules')).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Whether a profile's installed copy of this plugin resolves to this package.
 *
 * This is what separates two profiles that both declare the plugin — a `web` and
 * a `desktop` profile can each list it — so the data directory follows the
 * profile whose copy is actually running rather than the first one found.
 *
 * A whole-tree link is rejected first (see {@link profileNodeModulesIsLinked}):
 * the realpath comparison cannot tell that shape apart from a real installation,
 * so a residual directory would claim this package just as convincingly as the
 * live copy.
 */
function profileLinksToThisPackage(profileDir: string): boolean {
  const own = pluginPackageRoot()
  if (own === undefined) return false
  if (profileNodeModulesIsLinked(profileDir)) return false
  try {
    return realpathSync(join(profileDir, 'node_modules', PLUGIN_PACKAGE_NAME)) === realpathSync(own)
  } catch {
    // No installed copy, or an unreadable link.
    return false
  }
}

/**
 * The profile directory this plugin belongs to, or undefined when none can be
 * determined.
 *
 * A single declaring profile is accepted without the link test, so a profile
 * whose packages resolve from the shared `profiles/node_modules` — which has no
 * copy of its own to compare — still resolves. A whole-tree link is refused even
 * then: that shape is a residual directory whatever else is true, and there is
 * nothing else it could be.
 *
 * With several declaring profiles only those whose copy resolves here are
 * eligible. Exactly one eligible candidate is an answer; two or more is a tie
 * broken by `readdirSync` order, which Node leaves undefined — so both that and
 * "nothing eligible" are reported, because either way the data directory is
 * about to leave the profile the user expects and nothing else would say so.
 */
function discoverProfileDir(): string | undefined {
  const profilesRoot = join(resolveDshHome(), PROFILES_DIR_NAME)
  let entries: Dirent[]
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true })
  } catch {
    // No profiles directory at all: nothing to discover.
    return undefined
  }
  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(profilesRoot, entry.name)
    if (profileDeclaresPlugin(dir)) candidates.push(dir)
  }
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) {
    // The length check above is what makes this defined.
    const only = candidates[0]!
    if (profileNodeModulesIsLinked(only)) {
      diagnostics?.warn(
        `qoder: the only profile declaring this plugin, ${only}, links its entire node_modules elsewhere and so `
        + `cannot be the running copy; the data directory falls back to the Harness home.`,
      )
      return undefined
    }
    return only
  }
  const eligible = candidates.filter(candidate => profileLinksToThisPackage(candidate))
  if (eligible.length === 0) {
    diagnostics?.warn(
      `qoder: ${candidates.length} profiles declare this plugin, none holds the running copy, and the host `
      + `reported no running profile; the data directory falls back to the Harness home. `
      + `Candidates: ${candidates.join(', ')}`,
    )
    return undefined
  }
  if (eligible.length > 1) {
    diagnostics?.warn(
      `qoder: ${eligible.length} profiles hold a copy resolving to this package and the host reported no running `
      + `profile; the data directory follows ${eligible[0]} on nothing but directory order. `
      + `Candidates: ${eligible.join(', ')}`,
    )
  }
  return eligible[0]
}

/**
 * The plugin's data directory: `<profile>/.dsh-qoder-connect`.
 *
 * Falls back to profile discovery, then to the Harness home when no profile can
 * be determined — a checkout running its own tests, or a host that loads the
 * plugin from outside a profile — so the plugin always has somewhere to write,
 * and `DSH_QODER_DATA_DIR` overrides either way.
 */
export function qoderPluginDataDir(): string {
  const override = process.env[QODER_DATA_DIR_ENV]
  if (override !== undefined && override.trim() !== '') return override
  const base = hostProfileDir ?? discoverProfileDir() ?? resolveDshHome()
  return join(base, QODER_DATA_DIR_NAME)
}

/**
 * The directory the rebuildable state files live in:
 * `<data dir>/state/` (saved catalogs, probe records, the host heartbeat).
 */
export function qoderStateDir(): string {
  return join(qoderPluginDataDir(), QODER_STATE_DIR_NAME)
}

/**
 * The plugin-owned seed for the Qoder transport's machine id.
 *
 * The transport's `getMachineId(paths)` helper reads a list of trusted
 * locations and writes its created UUID into the last one; this is the
 * DSH-side location the host wires into that chain, so the identifier stays
 * inside the plugin's own folder instead of scattering files near `$HOME`.
 */
export function qoderMachineIdPath(): string {
  return join(qoderStateDir(), '.qoder-machine-id')
}
