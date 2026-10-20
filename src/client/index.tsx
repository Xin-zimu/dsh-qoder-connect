/** Browser half: Qoder account status, quota cards, and plugin settings. */

import { useEffect } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// The settings domain base owns the `settings.section` slot contract. Imported
// for its TYPES only, which keeps this bundle free of a runtime dependency on
// the settings package.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { QoderProbeControl } from './QoderProbeControl.tsx'
import { QODER_CARD_VARIANTS, QoderPluginCard } from './QoderPluginCard.tsx'
import type { QoderPluginCardInjected } from './QoderPluginCard.tsx'
import { QuotaSettingsCard } from './QuotaSettingsCard.tsx'
import type { QuotaSection, QuotaSettingsCardInjected, QuotaSettingsScope } from './QuotaSettingsCard.tsx'
import { OwnQuotaSettingsScope } from './http-settings-scope.ts'
import { QuotaDashboard, SidebarQuotaCard } from './SidebarQuotaCard.tsx'
import type { QuotaDashboardInjected, QuotaDashboardState, QuotaDashboardProps, SidebarQuotaCardInjected, SidebarQuotaCardProps } from './SidebarQuotaCard.tsx'
import { injectQuotaCss } from './quota-styles.ts'
import './quota-slots.ts'
import './plugin-manager-slots.ts'
import { setQuotaPollMs, setQuotaToggles, quotaSignInState, quotaPollMs, quotaStatusIsFresh, acquireLiveSurface, refreshQuotaStatus, variantOfStatusPath, noteQuotaLanguage } from './quota-settings-store.ts'
import { setActiveLanguage } from './quota-merge.ts'
import { en, zh } from './locales.ts'
import type { QoderSettingsKey } from './locales.ts'
import { QODER_GLOBAL_STATUS_PATH, QODER_STATUS_PATH } from '../status-paths.ts'
import type { QoderWebStatus } from '../status-paths.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Qoder plugin card copy. */
    'settings.qoder': QoderSettingsKey
    /** Shared quota-settings and sidebar-card copy. */
    'panel.qoder-quota': QoderSettingsKey
  }
  interface SlotMap {
    /**
     * One card inside the shared 《插件设置》 block. The three connect plugins
     * declare this child slot under the shared container and register their own
     * entry into it. Options: `id` (the plugin's package name, unique), `order`.
     */
    'plugin-settings.item': { kind: 'list'; scope: 'root' }
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-qoder-connect-client'
/**
 * Client services this bundle requires BEFORE it activates: `slots` comes from
 * `@deepseek-ai/dsh-client-ui-renderer`, `locale` from
 * `@deepseek-ai/dsh-client-locale`, all named in `dsh.client.inject`.
 */
// `modelDirectories` reads the active session through `remote.session`.
// Declaring that dependency here is required by the Desktop renderer: without it
// Cordis rejects `directoryFor()` before this bundle can register.
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/** The status routes per variant id (mirrors the host's locked route table). */
const VARIANT_STATUS: Record<string, string> = {
  qoder: QODER_STATUS_PATH,
  'qoder-global': QODER_GLOBAL_STATUS_PATH,
}

/**
 * The shared 《插件设置》 block's slot and entry ids. The three connect plugins must
 * agree on these exactly: a child slot name may be declared once and a list entry
 * id registered once, so the ids are fixed constants rather than per-plugin names.
 */
const SHARED_SECTION_SLOT = 'settings.section'
const SHARED_SECTION_ID = 'plugin-settings'
const SHARED_SECTION_ORDER = 900
const SHARED_ITEM_SLOT = 'plugin-settings.item'
/** This plugin's entry id inside the shared block: its package name (unique). */
const SHARED_ITEM_ID = 'dsh-qoder-connect'
/** The shared block's title, fixed by the contract so all three plugins agree. */
const SHARED_SECTION_LABEL = '插件设置'

/**
 * The plugin manager's bundle-configuration seat and this bundle's key in it. The
 * key must spell this package's name exactly: the page's configuration ledger reads
 * it to decide whether the configuration section shows at all.
 */
const PLUGIN_MANAGER_SLOT = 'plugins.bundle.config'
const PLUGIN_MANAGER_KEY = 'dsh-qoder-connect'

/**
 * The shared 《插件设置》 section: it renders nothing but its child slot, which
 * mirrors the removed Plugins tab's list layout (`gap: 10`, no markers).
 *
 * @param props - the section's slot props (owner share plus `renderSlot`).
 * @returns the ordered card list.
 */
function PluginSettingsSection(
  props: PropsRuntime<'settings.section'> & PropsRenderSlots<typeof SHARED_ITEM_SLOT>,
): React.ReactNode {
  return (
    <ul style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 0, listStyle: 'none' }}>
      {props.renderSlot(SHARED_ITEM_SLOT, {})}
    </ul>
  )
}

/**
 * Register card copy, the shared quota-settings card, the two variant cards, the
 * sidebar quota cards, and the same unified card on this bundle's page.
 *
 * The body is wrapped so a DSH slot-API breaking change degrades to a
 * `console.error` instead of raising the "Failed to load plugins" banner; the
 * host provider keeps serving models regardless.
 *
 * NOTE: the try/catch boundary here is mirrored in `tests/client-fallback.spec.ts`
 * — change the guarded body or the `console.error` message and update that spec too.
 */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.qoder'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-qoder-connect: settings copy')
    const t = ctx.locale.bind(namespace) as QoderPluginCardInjected['t']

    // Which language a package title renders in is decided in the merge layer, so
    // the sidebar card and the dashboard cannot label one package two ways. The
    // bump re-renders subscribed cards on a mid-session language switch.
    const applyLanguage = (localeId: string): void => {
      setActiveLanguage(localeId)
      noteQuotaLanguage()
    }
    applyLanguage(ctx.locale.getLocale().active)
    ctx.effect(() => {
      const dispose = ctx.on('locale/change', snapshot => {
        applyLanguage(snapshot.active)
      })
      return () => {
        dispose()
      }
    }, 'dsh-qoder-connect: package title language')

    // 1. Shared quota-settings card. Card ORDER is priority-ascending, so this card
    // gets the lowest priority of the three: 统一设置 (50) → CN (60) → Global (70).
    //
    // The band starts at 50 deliberately: the sibling connect plugin registers the
    // same three seats at 10/20/30 and ties break by registration order, so
    // overlapping values would interleave the two plugins' cards.
    const quotaSettingsInjected: QuotaSettingsCardInjected = {
      t,
      // Read live at render: the sign-in state changes without a remount.
      signedIn: () => quotaSignInState(),
    }
    /**
     * The bound quota settings face, filled in as soon as a host configuration
     * service becomes available (see the two `ctx.inject` callbacks below).
     *
     * It binds as a SERVICE ARRIVES rather than when the settings card's inject
     * factory first runs: the factory only executes while the settings page
     * renders, so a fresh page load would read no toggles and render no sidebar
     * card. The face's subscription mirrors every accepted snapshot into the
     * shared store; with no configuration service the sidebar cards stay hidden.
     */
    let quotaScope: QuotaSettingsScope<QuotaSection> | undefined
    const adoptQuotaScope = (scope: QuotaSettingsScope<QuotaSection>): void => {
      quotaScope = scope
      const applySnapshot = (): void => {
        const value = scope.getSnapshot().value
        setQuotaToggles(value?.sidebarQuotaCN === true, value?.sidebarQuotaGlobal === true)
        if (typeof value?.quotaPollMs === 'number') setQuotaPollMs(value.quotaPollMs)
      }
      applySnapshot()
      scope.subscribe(applySnapshot)
    }

    // Unified Qoder plugin configuration card: merges sidebar quota settings, the
    // China variant, and the Global variant into one card titled "Qoder". The shared
    // block dispatches list entries by ascending order; this plugin takes 30.
    /**
     * The unified card's inject face, shared by its two surfaces: the shared
     * 《插件设置》 block and this bundle's own page in the Plugins panel. One face
     * keeps both cards reading the same scope and sign-in fact.
     */
    const unifiedCardInject = (defaultOpen = false): QoderPluginCardInjected => ({
      t,
      // Read live at render: the sign-in state changes without a remount.
      signedIn: () => quotaSignInState(),
      scope: quotaScope,
      unified: true,
      defaultOpen,
    })

    const registerUnifiedCard = (): (() => void) =>
      ctx.slots.inject(SHARED_ITEM_SLOT, () => ctx.slots.register({ name: SHARED_ITEM_SLOT, id: SHARED_ITEM_ID, order: 30, inject: unifiedCardInject }, QoderPluginCard))

    /**
     * Attach this plugin's card to the shared 《插件设置》 block, building the block
     * first if nobody has.
     *
     * Backoff protocol (identical in all three connect plugins: a `list` slot takes
     * many entries but only ONE registration per id, and a child slot name may be
     * declared once):
     *   1. wait for the host to declare `settings.section`;
     *   2. if an entry with the shared id is already there, only attach;
     *   3. otherwise register the container — and if a sibling won the race and the
     *      registration throws, fall back to attaching to theirs.
     */
    const joinSharedSettingsBlock = (): void => {
      ctx.slots.inject(SHARED_SECTION_SLOT, () => {
        let disposeContainer: (() => void) | undefined
        const claimed = ctx.slots.entries(SHARED_SECTION_SLOT)
          .some(entry => entry.options?.id === SHARED_SECTION_ID)
        if (!claimed) {
          try {
            disposeContainer = ctx.slots.register({
              name: SHARED_SECTION_SLOT,
              id: SHARED_SECTION_ID,
              order: SHARED_SECTION_ORDER,
              label: () => SHARED_SECTION_LABEL,
              children: { [SHARED_ITEM_SLOT]: { kind: 'list', scope: 'root' } },
            }, PluginSettingsSection)
          } catch (error: unknown) {
            // A sibling registered the container between the probe and this
            // call: their declaration is the live one, so attach to it.
            console.error('[dsh-qoder-connect] shared plugin-settings block lost the race; attaching to the winner:', error)
          }
        }
        const disposeItem = registerUnifiedCard()
        return () => {
          disposeItem()
          disposeContainer?.()
        }
      })
    }

    /**
     * Contribute the same unified card to this bundle's page in the Plugins panel.
     *
     * `ctx.slots.inject` defers the factory until the Host's plugin manager declares
     * the seat, so a deployment without a plugin manager never throws — the shared
     * 《插件设置》 block then stays the single surface.
     */
    const joinPluginManagerBlock = (): void => {
      try {
        ctx.slots.inject(PLUGIN_MANAGER_SLOT, () => ctx.slots.register({
          name: PLUGIN_MANAGER_SLOT,
          key: PLUGIN_MANAGER_KEY,
          // The bundle's page in the Plugins panel has room for the whole
          // configuration, so the card opens expanded there.
          inject: () => unifiedCardInject(true),
        }, QoderPluginCard))
      } catch (error: unknown) {
        console.error('[dsh-qoder-connect] could not join the plugin manager page:', error)
      }
    }

    /**
     * 插件自有配置（`<profile>/.dsh-qoder-connect/settings.json`）：读写在宿主半的
     * settings face 上完成，不经过 settingsScope / configForms（后者每次写入都会
     * 整树 reconcile + fiber 热重载）。卡片注册无条件进行，迟到也不会漏掉 UI。
     */
    const ownQuotaScope = new OwnQuotaSettingsScope()
    void ownQuotaScope.load()
    adoptQuotaScope(ownQuotaScope as unknown as QuotaSettingsScope<QuotaSection>)
    joinSharedSettingsBlock()
    joinPluginManagerBlock()

    // Sidebar quota cards + the dashboard they open: the layout's keyed `main` slot
    // holds the shared dashboard and each footer card selects it on click. The
    // `layout` service is read REFLECTIVELY (ui-layout is not a dependency), and the
    // footer registration is gated on the seam so a profile without `selectPanel`
    // never renders a dead button.
    const QUOTA_PANEL_ID = 'qoder-quota-panel'
    const CONVERSATION_PANEL_ID = 'conversation'
    interface LayoutSelectionSeam {
      selectPanel: (id: string | null) => void
    }

    // ---- dashboard state (module-closure, read by both the face and open()) ----
    let dashboardLoading = false
    let dashboardRequestedPath: string = QODER_STATUS_PATH
    /** Whether the dashboard is the CURRENT center panel (its mount owns this). */
    let quotaPanelOpen = false
    const dashboardListeners = new Set<() => void>()
    /**
     * The observable source the dashboard reads through the inject face's `hooks`
     * compartment: the renderer caches an inject face ONCE and spreads it, so a face
     * getter is frozen — only hooks read the CURRENT snapshot on every render.
     *
     * STABILITY CONTRACT: useSyncExternalStore requires getSnapshot() to return the
     * SAME reference between changes; a fresh object per call re-renders forever and
     * React kills the entry (error #185). So the snapshot is a CACHED object,
     * replaced wholesale by publish().
     */
    let dashboardSnap: QuotaDashboardState = {
      loading: false,
      activePath: QODER_STATUS_PATH,
    }
    const rebuildSnapshot = (): void => {
      const next: QuotaDashboardState = {
        loading: dashboardLoading,
        activePath: dashboardRequestedPath,
      }
      // Publish only on an actual change: identity-stable otherwise.
      if (JSON.stringify(next) !== JSON.stringify(dashboardSnap)) {
        dashboardSnap = next
        for (const listener of dashboardListeners) listener()
      }
    }
    const dashboardSource = {
      getSnapshot: (): QuotaDashboardState => dashboardSnap,
      subscribe: (listener: () => void): (() => void) => {
        dashboardListeners.add(listener)
        return () => {
          dashboardListeners.delete(listener)
        }
      },
    }
    const notifyDashboard = (): void => {
      rebuildSnapshot()
    }

    /**
     * Refresh ONE variant's document (the one the panel is showing), not both.
     *
     * Freshness rule: when the shared document for THIS variant is newer than the
     * configured interval the fetch is SKIPPED (a click shows cached numbers); a
     * variant with no result yet always fetches. `force` bypasses the check for the
     * user's own Refresh click.
     *
     * The read is the SHARED one, so this panel, the sidebar cards and the settings
     * cards converge on the same document — the panel keeps no timer of its own.
     */
    const refreshDashboard = async (options: { force?: boolean } = {}): Promise<void> => {
      if (dashboardLoading) return
      const variantId = variantOfStatusPath(dashboardRequestedPath)
      if (options.force !== true && quotaStatusIsFresh(variantId, quotaPollMs())) return
      dashboardLoading = true
      rebuildSnapshot()
      try {
        await refreshQuotaStatus(variantId)
      } finally {
        dashboardLoading = false
        rebuildSnapshot()
      }
    }

    /**
     * The panel's hold on its shown variant: the shared ticker reads it at the
     * settings interval while the panel stands, and an expanded settings card beside
     * it tightens the read to once a minute. A variant switch moves the hold.
     */
    let dashboardHold: (() => void) | undefined
    const holdDashboardVariant = (path: string): void => {
      dashboardHold?.()
      dashboardHold = acquireLiveSurface(variantOfStatusPath(path))
    }
    const releaseDashboardVariant = (): void => {
      dashboardHold?.()
      dashboardHold = undefined
    }

    // Mount/unmount wrapper. A FUNCTION DECLARATION, not a `const`: the
    // slots.inject factory can run synchronously and hit the temporal dead zone,
    // which silently dropped the dashboard cell. The child renders as JSX so its
    // hooks stay in their own component instance.
    function QuotaDashboardWithLifecycle(props: QuotaDashboardProps): React.ReactNode {
      useEffect(() => {
        quotaPanelOpen = true
        // The panel holds its shown variant live and reads it at once (the
        // freshness rule may serve the cached document).
        holdDashboardVariant(dashboardRequestedPath)
        void refreshDashboard()
        return () => {
          quotaPanelOpen = false
          releaseDashboardVariant()
        }
      }, [])
      return <QuotaDashboard {...props} />
    }

    const panelFace = (): QuotaDashboardInjected => ({
      hooks: {
        // Renderer converts this to the `useQuotaDashboard` selector hook; its
        // snapshots MUST be reference-stable (useSyncExternalStore compares identity).
        quotaDashboard: dashboardSource,
      },
      t,
      statusPaths: [QODER_STATUS_PATH, QODER_GLOBAL_STATUS_PATH],
      refresh: () => {
        // An explicit user action: bypass the freshness rule, re-read the SHOWN variant.
        void refreshDashboard({ force: true })
      },
      // The user switched tabs: point the dashboard at it, move the hold, and fetch it
      // when the shared store holds nothing (its sidebar card may be off).
      onVariantPicked: (path: string) => {
        dashboardRequestedPath = path
        holdDashboardVariant(path)
        notifyDashboard()
        void refreshDashboard()
      },
      close: () => {
        const layout = ctx.get('layout') as LayoutSelectionSeam | undefined
        if (typeof layout?.selectPanel !== 'function') return
        try {
          layout.selectPanel(null)
        } catch {
          try {
            layout.selectPanel(CONVERSATION_PANEL_ID)
          } catch (error: unknown) {
            console.error('[dsh-qoder-connect] could not close the quota panel:', error)
          }
        }
      },
    })

    ctx.effect(() => injectQuotaCss(), 'dsh-qoder-connect: quota styles')

    // No gate needed: registering for a declaration that never arrives is a no-op.
    try {
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: QUOTA_PANEL_ID, locale: 'panel.qoder-quota', inject: panelFace as never },
        QuotaDashboardWithLifecycle as never,
      ))
    } catch (error: unknown) {
      console.error('[dsh-qoder-connect] could not register the quota dashboard:', error)
    }

    ctx.inject(['layout'], layoutCtx => {
      const layout = layoutCtx.get('layout') as LayoutSelectionSeam | undefined
      if (typeof layout?.selectPanel !== 'function') return
      try {
        for (const variant of QODER_CARD_VARIANTS) {
          const statusPath = VARIANT_STATUS[variant.id]
          if (statusPath === undefined) continue
          const injected: SidebarQuotaCardInjected = {
            t,
            statusPath,
            // Toggle semantics: clicking the card of the variant ALREADY showing
            // closes the panel; clicking the other variant's card switches to it.
            open: () => {
              const current = layoutCtx.get('layout') as LayoutSelectionSeam | undefined
              if (typeof current?.selectPanel !== 'function') return
              if (quotaPanelOpen && dashboardRequestedPath === statusPath) {
                current.selectPanel(null)
                return
              }
              dashboardRequestedPath = statusPath
              // A mounted panel will not re-render from selectPanel alone, so push the
              // tab change through the revision the dashboard subscribes to, and fetch
              // the newly shown variant (no other surface polls it when its card is off).
              notifyDashboard()
              void refreshDashboard()
              current.selectPanel(QUOTA_PANEL_ID)
            },
          }
          layoutCtx.slots.inject('sidebar.footer.action', () => layoutCtx.slots.register({
            name: 'sidebar.footer.action',
            id: variant.id === 'qoder' ? 'qoder-quota' : 'qoder-global-quota',
            order: variant.id === 'qoder' ? 20 : 21,
            locale: 'panel.qoder-quota',
            inject: (): SidebarQuotaCardProps | SidebarQuotaCardInjected => injected,
          } as never, SidebarQuotaCard))
        }
      } catch (error: unknown) {
        console.error('[dsh-qoder-connect] could not register the sidebar footer card:', error)
      }
    })

    ctx.inject(['modelDirectories'], scope => {
      scope.slots.inject('conversation.input.right', () => scope.slots.register({
        name: 'conversation.input.right',
        id: 'qoder-probe',
        order: 10,
        inject: sessionId => ({
          directory: scope.modelDirectories.directoryFor(
            sessionId as Parameters<typeof scope.modelDirectories.directoryFor>[0],
          ).store,
          t,
        }),
      }, QoderProbeControl))
    })
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models, users
    // see no banner, and the cause lands in the browser console.
    console.error('[dsh-qoder-connect] client card failed to load (host provider unaffected):', error)
  }
}
