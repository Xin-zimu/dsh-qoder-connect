/**
 * Conversation rows printed into one named session.
 *
 * A row is the log-only `command/run` + `command/done` pair: one line, no turn,
 * no model call. The destination is never guessed — a request that cannot name
 * its session prints nothing, the same rule the queue hint follows.
 *
 * @module dsh-qoder-connect/job-token-hint
 */

/** The name recorded on the hint row (and therefore its displayed title). */
export const JOB_TOKEN_HINT_NAME = 'qoder'

/** The session slice this module appends to. */
export interface HintSession {
  append(type: string, data: unknown): unknown
}

/** Monotonic suffix keeping appended ids unique within this process. */
let hintSeq = 0

/**
 * Print the refresh row into the session whose request triggered it.
 *
 * @param text - The row's summary line.
 * @param session - The session to append into; never inferred.
 */
export function emitJobTokenHint(text: string, session: HintSession): void {
  appendHintRow(session, 'success', text)
}

/**
 * Print the failed-heal row into the same session; the mirror of
 * {@link emitJobTokenHint}. Rate limited by the transport, so this stays a printer.
 *
 * @param text - The row's summary line.
 * @param session - The session to append into; never inferred.
 */
export function emitJobTokenRefreshFailedHint(text: string, session: HintSession): void {
  appendHintRow(session, 'error', text)
}

/**
 * Dispatch a heal row to the one session that may receive it.
 *
 * Fails closed: no `sessionId`, or one that no longer resolves, prints nothing.
 */
export function dispatchJobTokenNotice(options: {
  text: string
  kind: 'success' | 'error'
  sessionId?: string | undefined
  resolveSession: (id: string) => HintSession | undefined
}): void {
  const { text, kind, sessionId, resolveSession } = options
  if (sessionId === undefined) return
  const session = resolveSession(sessionId)
  if (session === undefined) return
  if (kind === 'success') emitJobTokenHint(text, session)
  else emitJobTokenRefreshFailedHint(text, session)
}

/**
 * Append one one-off notice row into a specific session.
 *
 * A notice reports something the user needs to see but that neither fails the turn
 * nor belongs to a row lifecycle: today that is the upstream filtering a reply. It
 * reuses the `qoder` row name, so it reads exactly like the heal rows.
 *
 * @param session - the session to append into.
 * @param kind - how the row renders; `error` marks an incomplete answer.
 * @param text - the row's summary line.
 */
export function emitNoticeRow(session: HintSession, kind: 'success' | 'error', text: string): void {
  appendHintRow(session, kind, text)
}

/** Append one log-only command pair carrying `text` as its outcome. */
function appendHintRow(session: HintSession, kind: 'success' | 'error', text: string): void {
  const commandId = `cmd-qoder-hint-${Date.now().toString(36)}-${++hintSeq}`
  try {
    // The official pairing: `command/run` opens the row, `command/done` carries
    // its summary. Both are log-only, so no turn is opened. `error` renders the
    // row as a failure, which is what an exhausted heal is.
    session.append('command/run', {
      commandId,
      name: JOB_TOKEN_HINT_NAME,
      source: { kind: 'user' },
    })
    session.append('command/done', {
      commandId,
      kind,
      text,
    })
  } catch {
    // The row reports a heal that already happened (or already failed); failing
    // to print it is diagnostics-grade and must never surface as a chat failure.
  }
}

/**
 * Open a queue-wait row and return its id.
 *
 * The row title is the ASCII name; the display name belongs in `text`, since the
 * card renders `{name} · {text}` and would otherwise repeat it.
 */
export function openQueueHint(session: HintSession, text: string): string | undefined {
  const commandId = `cmd-qoder-queue-${Date.now().toString(36)}-${++hintSeq}`
  try {
    session.append('command/run', {
      commandId,
      name: JOB_TOKEN_HINT_NAME,
      source: { kind: 'user' },
    })
    session.append('command/done', {
      commandId,
      kind: 'success',
      text,
    })
    return commandId
  } catch {
    return undefined
  }
}

/**
 * Rewrite an open queue-wait row.
 *
 * The chat view folds a `command/done` into the row its `commandId` opened and
 * keeps the original seq, so the row stays in place and only its text changes.
 */
export function updateQueueHint(session: HintSession, commandId: string, text: string): void {
  try {
    session.append('command/done', {
      commandId,
      kind: 'success',
      text,
    })
  } catch {
    // Diagnostics-grade, like every other row here.
  }
}
