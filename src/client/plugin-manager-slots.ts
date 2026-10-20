/**
 * SlotMap merge for the plugin manager's bundle-configuration seat, re-declared
 * here because the plugin-manager package is a Host built-in this bundle does
 * not depend on. The owner shapes below mirror upstream's `PluginConfigViewProps`
 * / `ConfigPageForm` verbatim.
 *
 * Must stay structurally identical to upstream's: a conflicting duplicate member
 * from a peer package would fail compilation.
 */

import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Host-owned configuration values and write actions for one page's entry. */
export interface ConfigPageForm {
  /** Accepted Host values; refreshed by the page owner. */
  readonly state: ConfigFormSnapshot<Record<string, unknown>>
  /** Submit all field edits together with the revision the editor read. */
  readonly mutate: ConfigForm<Record<string, unknown>>['mutate']
}

/** The view the plugin manager asks a configuration entry for. */
export interface PluginConfigViewProps {
  /** `summary` renders the one-liner alone; `page` renders the form with its save control. */
  readonly view: 'summary' | 'page'
  /** Host-owned configuration values and write actions for this page's entry. */
  readonly form?: ConfigPageForm | undefined
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * A bundle's own configuration, keyed by its package name and rendered
     * between the page's description and its rows (`view: 'page'` only).
     */
    'plugins.bundle.config': {
      kind: 'keyed'
      scope: 'root'
      owner: PluginConfigViewProps
    }
  }
}
