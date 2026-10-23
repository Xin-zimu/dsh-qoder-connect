/** One queue hint lifecycle, owned by one model request and its host session. */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { queueCopy } from './copy.ts'
import { openQueueHint, updateQueueHint, type HintSession } from './job-token-hint.ts'
import type { QoderQueueWait } from './qoder/transport/chat.ts'

export type QueueHintSession = HintSession

/**
 * Capture the request's destination and keep its row private to this observer.
 * No registry survives the request, so cancellation and failures leave no state
 * that another request can inherit. Replays within this request reuse its row.
 */
export function createQueueHint(options: {
  sessionId: string | undefined
  purpose?: GenerateOptions['purpose']
  displayName: string
  resolveSession: (id: string) => QueueHintSession | undefined
  onDiag?: (message: string) => void
}): (info: QoderQueueWait) => void {
  const { sessionId, purpose, displayName, resolveSession, onDiag } = options
  let row: { session: QueueHintSession, commandId: string } | undefined
  return info => {
    // A grant may be followed by another queue rejection of the same request.
    if (info.cleared === true) return
    if (purpose === 'session-title') {
      onDiag?.(`hint skipped: purpose=session-title session=${sessionId ?? 'none'} attempt=${info.attempt}`)
      return
    }
    const session = row?.session ?? (sessionId === undefined ? undefined : resolveSession(sessionId))
    if (session === undefined) {
      onDiag?.(`hint skipped: no session (sessionId=${sessionId ?? 'none'})`)
      return
    }
    const text = queueCopy().hint({
      display: displayName,
      attempt: info.attempt,
      ...info.waitTimeMs === undefined ? {} : { waitSeconds: Math.ceil(info.waitTimeMs / 1000) },
    })
    if (row === undefined) {
      const commandId = openQueueHint(session, text)
      if (commandId !== undefined) row = { session, commandId }
      onDiag?.(`hint open session=${sessionId} attempt=${info.attempt} id=${commandId ?? 'none'}`)
      return
    }
    updateQueueHint(row.session, row.commandId, text)
    onDiag?.(`hint update session=${sessionId} attempt=${info.attempt} id=${row.commandId}`)
  }
}
