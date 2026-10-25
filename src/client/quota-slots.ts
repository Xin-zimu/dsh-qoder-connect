/**
 * SlotMap merge for the quota panel's two seats, re-declared here because the
 * owning packages are not dependencies of this bundle. Import it for its side
 * effect in any file that registers into either seat.
 *
 * Must stay structurally identical to upstream's: a conflicting duplicate
 * member from a peer package would fail compilation.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** The layout's center-column panel registry; the footer card selects a key from it. */
    'main': { kind: 'keyed'; scope: 'root' }
    /** Sidebar foot action list, rendered above the Settings seat. */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
  }
}

/** Owner share of a sidebar footer action: only the column display state. */
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}
