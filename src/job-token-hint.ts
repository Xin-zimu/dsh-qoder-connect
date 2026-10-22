/**
 * The conversation hint row for a self-healed job token.
 *
 * The visible channel is the session: appending the log-only event pair
 * `command/run` + `command/done` prints one row into the conversation without
 * opening a turn, calling the model, or registering a command. Attribution is
 * best effort (`lastRunningAgent`): with two agents running concurrently the row
 * can land in the other one's conversation, which is display imprecision only.
 * The recorded name is the ASCII `qoder`; without a client renderer it becomes
 * the row title.
 *
 * @module dsh-qoder-connect/job-token-hint
 */

import type { Context } from '@deepseek-ai/cordis'

/** The name recorded on the hint row (and therefore its displayed title). */
export const JOB_TOKEN_HINT_NAME = 'qoder'

/** The session slice this module appends to. */
interface HintSession {
  append(type: string, data: unknown): unknown
}

/** The agent slice this module needs: identity plus its session. */
interface HintAgent {
  readonly id: unknown
  readonly session?: HintSession
}

/** Refresh time per agent id, so a later read can name when it happened. */
const lastRefreshAt = new Map<string, number>()

/** The most recent agent observed entering a running turn. */
let lastRunningAgent: HintAgent | undefined

/** Monotonic suffix keeping appended ids unique within this process. */
let hintSeq = 0

/**
 * Start tracking which agent is running.
 *
 * `agent/status` is a plain `emit` event, so a listener returning nothing cannot
 * disturb the emitting path. The self-heal fires inside that agent's request, so
 * the most recently running agent is the conversation to print into.
 */
export function installJobTokenHint(ctx: Context): void {
  ctx.on('agent/status' as never, ((payload: { agent?: HintAgent, status?: string }) => {
    if (payload.status === 'running' && payload.agent !== undefined) {
      lastRunningAgent = payload.agent
    }
  }) as never)
}

/**
 * Print the refresh row into the conversation whose request triggered it.
 *
 * Best effort by design: a missing agent, an absent session, or a projection
 * that rejects the append must never affect the chat that just recovered.
 *
 * @param at - When the job token was rotated.
 * @param text - The row's summary line.
 */
export function emitJobTokenHint(at: number, text: string): void {
  const agent = lastRunningAgent
  if (agent?.session === undefined) return
  lastRefreshAt.set(String(agent.id), at)
  appendHintRow(agent, 'success', text)
}

/**
 * Print the failed-heal row into the conversation whose request triggered it;
 * the mirror of {@link emitJobTokenHint}.
 *
 * Without it the user saw only the authorization failure and could not tell that
 * recovery had already been attempted and lost. Rate limited by the transport
 * (once per unresolved outage), so this module stays a pure printer.
 *
 * @param at - When the failed heal was recorded.
 * @param text - The row's summary line.
 */
export function emitJobTokenRefreshFailedHint(at: number, text: string): void {
  const agent = lastRunningAgent
  if (agent?.session === undefined) return
  appendHintRow(agent, 'error', text)
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
export function emitNoticeRow(
  session: { append(type: string, data: unknown): unknown },
  kind: 'success' | 'error',
  text: string,
): void {
  appendHintRow({ id: 'notice', session }, kind, text)
}

/** Append one log-only command pair carrying `text` as its outcome. */
function appendHintRow(agent: HintAgent, kind: 'success' | 'error', text: string): void {
  const session = agent.session
  if (session === undefined) return
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
export function openQueueHint(session: { append(type: string, data: unknown): unknown }, text: string): string | undefined {
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
export function updateQueueHint(session: { append(type: string, data: unknown): unknown }, commandId: string, text: string): void {
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

/** The refresh time recorded for one agent, if this process rotated its token. */
export function jobTokenRefreshAt(agentId: unknown): number | undefined {
  return lastRefreshAt.get(String(agentId))
}
