import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { QODER_CARD_VARIANTS } from '../src/client/QoderPluginCard.tsx'

/**
 * The §7 gate: register two cards from one plugin, and if the slot cannot hold
 * both, find the actual limit rather than duplicating the plugin.
 * `settings.plugin.item` is a keyed slot, so coexistence is a property of the real
 * registry — these drive the actual `SlotCore`. Register calls are typed loosely on
 * purpose: the registry's behaviour is what is under test.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Minimal component stand-in; the registry only stores the reference. */
const Component = (): null => null

const register = (core: SlotCore, options: Record<string, unknown>): unknown =>
  (core.register as any)(options, Component)

/**
 * Declare `settings.plugin.item` the way DSH does: a parent entry contributes a
 * `children` table, and the child spec is owned by the registering entry.
 */
function declarePluginItem(core: SlotCore): void {
  register(core, {
    name: 'root',
    children: {
      'settings.plugin.item': {
        kind: 'keyed',
        keyProps: { qoder: {}, 'qoder-global': {} },
      },
    },
  })
}

const entries = (core: SlotCore): any[] => (core.entries as any)('settings.plugin.item')

describe('settings.plugin.item holds both cards', () => {
  it('accepts two registrations with distinct keys from one owner', () => {
    const core = new SlotCore()
    declarePluginItem(core)
    expect(() => {
      for (const [index, variant] of QODER_CARD_VARIANTS.entries()) {
        register(core, { name: 'settings.plugin.item', key: variant.id, priority: 30 - index })
      }
    }).not.toThrow()
    // Both entries are live, which is exactly what the two cards need.
    expect(entries(core)).toHaveLength(2)
  })

  it('projects one cell per key, so both cards render', () => {
    const core = new SlotCore()
    declarePluginItem(core)
    for (const [index, variant] of QODER_CARD_VARIANTS.entries()) {
      register(core, { name: 'settings.plugin.item', key: variant.id, priority: 30 - index })
    }
    // The projection returns the winning ENTRY per key, so the key is read off
    // `options` — one cell each, which is what the settings page renders.
    const cells = (core.entriesOfSlot as any)('settings.plugin.item') as { options: { key?: string } }[]
    expect(cells).toHaveLength(2)
    expect(cells.map(cell => cell.options.key).sort()).toEqual(['qoder', 'qoder-global'])
  })

  it('rejects a duplicate key at the same priority, which is why priorities differ', () => {
    // The registry throws only on the SAME key at the same priority; the plugin
    // still staggers them so the CN card leads in the settings list.
    const core = new SlotCore()
    declarePluginItem(core)
    register(core, { name: 'settings.plugin.item', key: 'qoder', priority: 30 })
    expect(() => register(core, { name: 'settings.plugin.item', key: 'qoder', priority: 30 }))
      .toThrow(/already has an entry for key/)
  })

  it('allows distinct keys at the same priority, so staggering is presentation only', () => {
    const core = new SlotCore()
    declarePluginItem(core)
    // If this ever threw, the two cards would depend on artificial priority
    // differences to coexist — worth knowing explicitly.
    expect(() => {
      register(core, { name: 'settings.plugin.item', key: 'qoder', priority: 30 })
      register(core, { name: 'settings.plugin.item', key: 'qoder-global', priority: 30 })
    }).not.toThrow()
    expect(entries(core)).toHaveLength(2)
  })

  it('requires an explicit key, which is why each card passes one', () => {
    const core = new SlotCore()
    declarePluginItem(core)
    // This is the rc.7 breakage the client entry's try/catch exists for.
    expect(() => register(core, { name: 'settings.plugin.item' }))
      .toThrow(/requires options.key/)
  })

  it('rejects registering into an undeclared slot', () => {
    const core = new SlotCore()
    expect(() => register(core, { name: 'settings.plugin.item', key: 'qoder' }))
      .toThrow(/not declared/)
  })
})

/**
 * The plugin manager's bundle-configuration seat: a keyed child slot with NO
 * `keyProps` table, so any string is a valid entry key and the bundle's npm
 * package name is what a registration passes.
 */
function declareBundleConfig(core: SlotCore): void {
  register(core, {
    name: 'root',
    children: {
      'plugins.bundle.config': {
        kind: 'keyed',
        scope: 'root',
      },
    },
  })
}

const bundleConfigEntries = (core: SlotCore): any[] => (core.entries as any)('plugins.bundle.config')

describe('plugins.bundle.config holds the bundle configuration', () => {
  it('accepts the package-name key this plugin registers', () => {
    const core = new SlotCore()
    declareBundleConfig(core)
    expect(() => register(core, { name: 'plugins.bundle.config', key: 'dsh-qoder-connect' }))
      .not.toThrow()
    expect(bundleConfigEntries(core)).toHaveLength(1)
  })

  it('projects one cell per key, so the page renders the entry it was opened for', () => {
    const core = new SlotCore()
    declareBundleConfig(core)
    register(core, { name: 'plugins.bundle.config', key: 'dsh-qoder-connect' })
    const cells = (core.entriesOfSlot as any)('plugins.bundle.config') as { options: { key?: string } }[]
    expect(cells).toHaveLength(1)
    expect(cells[0]?.options.key).toBe('dsh-qoder-connect')
  })

  it('rejects a second registration for the same key, which is why the inject disposer owns re-registration', () => {
    // HMR re-applies the same instance and the inject effect disposes the first
    // registration; a second register without the disposer throws naming the occupant.
    const core = new SlotCore()
    declareBundleConfig(core)
    register(core, { name: 'plugins.bundle.config', key: 'dsh-qoder-connect' })
    expect(() => register(core, { name: 'plugins.bundle.config', key: 'dsh-qoder-connect' }))
      .toThrow(/already has an entry for key/)
  })

  it('requires an explicit key, which is why the registration passes the package name', () => {
    const core = new SlotCore()
    declareBundleConfig(core)
    expect(() => register(core, { name: 'plugins.bundle.config' }))
      .toThrow(/requires options.key/)
  })
})
