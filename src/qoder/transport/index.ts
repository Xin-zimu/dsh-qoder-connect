/** The only external seam for communication with Qoder. */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { QoderAccountInfo } from '../account.ts'
import type { QoderCatalogModel } from '../catalog.ts'
import type { QoderRegion } from '../region.ts'
import type { QoderCheckInResult } from './checkin.ts'
import type { QoderQueueWait } from './chat.ts'
import { DefaultQoderTransport, defaultStreamIdleTimeoutMs } from './default-transport.ts'
import { defaultResponseHeaderTimeoutMs } from './request.ts'
import type { QoderLogger } from './logging.ts'

export { defaultResponseHeaderTimeoutMs, defaultStreamIdleTimeoutMs }
export type { QoderCheckInResult }

export interface QoderTransport {
  stream(options: GenerateOptions, model?: QoderCatalogModel): AsyncIterable<StreamChunk>
  discoverModels(signal?: AbortSignal): Promise<readonly QoderCatalogModel[]>
  readAccount(options?: { force?: boolean | undefined; signal?: AbortSignal | undefined }): Promise<QoderAccountInfo>
  checkIn(signal?: AbortSignal): Promise<QoderCheckInResult>
}

export interface QoderTransportOptions {
  region: QoderRegion
  resolvePat: () => Promise<string>
  fetch?: typeof fetch
  logger?: QoderLogger
  streamIdleTimeoutMs?: number
  responseHeaderTimeoutMs?: number
  metadataTimeoutMs?: number
  resolveMachineId?: () => string
  attachments?: Pick<AttachmentStore, 'imageLimits' | 'readImageRequest'>
  /** Deadline for one center image publication attempt. */
  imageUploadTimeoutMs?: number
  /** Lifetime of a remembered center image URL. */
  imageUrlCacheTtlMs?: number
  /** Whether prior assistant reasoning content is preserved across turns. */
  preserveThinking?: boolean
  /**
   * Called once per successful re-auth refresh, after a fresh job token was
   * exchanged and accepted following a 401 rejection.
   */
  onJobTokenRefreshed?: (info: { region: QoderRegion; at: number }) => void
  /**
   * Called once per unresolved self-heal failure (refreshed token rejected too),
   * and at most once per outage, reset when a later chat is accepted.
   */
  onJobTokenRefreshFailed?: (info: { region: QoderRegion; at: number; status?: number }) => void
  /** Called once per queue poll round, so the conversation can show progress. */
  onQueueWait?: (info: QoderQueueWait) => void
  /** Create an observer owned by one stream, including its internal replays. */
  createQueueWaitHandler?: (options: GenerateOptions) => (info: QoderQueueWait) => void
  /** Budget for one chat call's queue wait; read per call so settings apply live. */
  queueWaitBudgetMs?: () => number
  /** One-line diagnostic sink (chat vs queue decisions). */
  onDiag?: (message: string) => void
  /** Whether to poll out a queue answer; false hands the failure to the host with its hint. */
  queueWait?: () => boolean
}

export function createQoderTransport(options: QoderTransportOptions): QoderTransport {
  return new DefaultQoderTransport(options)
}
