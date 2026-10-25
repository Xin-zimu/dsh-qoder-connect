/**
 * The two Qoder products this one plugin serves.
 *
 * Same upstream in different regions; everything that varies (routes, file and
 * display identity) is one descriptor, so a third variant stays a data change.
 * Each variant holds its own PAT: tokens and files never cross between regions.
 * The browser half reads the same ids and routes from `status-paths.ts`.
 *
 * @module dsh-qoder-connect/variants
 */

import {
  QODER_AUTH_PATH,
  QODER_GLOBAL_AUTH_PATH,
  QODER_GLOBAL_PROBE_PATH,
  QODER_GLOBAL_STATUS_PATH,
  QODER_PROBE_PATH,
  QODER_STATUS_PATH,
} from './status-paths.ts'
import type { QoderVariantId } from './status-paths.ts'
import type { QoderRegion } from './qoder/region.ts'

export type { QoderVariantId }

/** One Qoder product variant. */
export interface QoderVariant {
  /** Provider id registered with DSH, e.g. `qoder-global`. */
  id: QoderVariantId
  /** Model-group heading and card title stem, e.g. `Qoder Global`. */
  displayName: string
  /** Product name as users know it, for diagnostics and error copy. */
  appName: string
  /** Which upstream region this variant's transport talks to. */
  region: QoderRegion
  /** Basename of the plugin-owned credential file under the data dir. */
  ownFilename: string
  /** Basename of the plugin-owned probe-record file under the data dir. */
  probeFilename: string
  /**
   * Basename of the plugin-owned saved-catalog file under the data dir.
   * One per variant: the deployments disagree about rates, windows, and models,
   * so a catalog saved from one must never be served as the other's.
   */
  catalogFilename: string
  /** Same-origin status route consumed by this variant's card. */
  statusPath: string
  /** Same-origin probe-control route consumed by this variant's card. */
  probePath: string
  /** Same-origin PAT route consumed by this variant's card. */
  authPath: string
}

/** China Qoder first: the no-suffix arm keeps the plugin's primary routes. */
export const QODER_VARIANTS: readonly QoderVariant[] = [
  {
    id: 'qoder',
    displayName: 'Qoder',
    appName: 'Qoder',
    region: 'china',
    ownFilename: '.qoder-auth.json',
    probeFilename: '.qoder-probe.json',
    catalogFilename: '.qoder-catalog.json',
    statusPath: QODER_STATUS_PATH,
    probePath: QODER_PROBE_PATH,
    authPath: QODER_AUTH_PATH,
  },
  {
    id: 'qoder-global',
    displayName: 'Qoder Global',
    appName: 'Qoder Global',
    region: 'global',
    ownFilename: '.qoder-global-auth.json',
    probeFilename: '.qoder-global-probe.json',
    catalogFilename: '.qoder-global-catalog.json',
    statusPath: QODER_GLOBAL_STATUS_PATH,
    probePath: QODER_GLOBAL_PROBE_PATH,
    authPath: QODER_GLOBAL_AUTH_PATH,
  },
]

/** The China variant; the plugin's default and compatibility anchor. */
export const CHINA_VARIANT: QoderVariant = QODER_VARIANTS[0]!

/** The international variant. */
export const GLOBAL_VARIANT: QoderVariant = QODER_VARIANTS[1]!

/** Look up a variant by provider id. */
export function variantFor(id: string): QoderVariant | undefined {
  return QODER_VARIANTS.find(variant => variant.id === id)
}
