/**
 * Host-side copy for session rows.
 *
 * The client bundle has its own dictionaries; the host process has no UI locale
 * to read, so it resolves one from the OS and keeps both wordings here.
 */

export type HostLocale = 'zh' | 'en'

/** Best-effort locale for host-generated session rows. */
export function hostLocale(): HostLocale {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

/** Inputs for one queue-wait row. */
export interface QueueCopyInput {
  display: string
  attempt: number
  waitSeconds?: number
}

/**
 * The wait wording: the estimate is the upstream's own answer, not this client's
 * promise, so the row must never read as "about to be granted". A zero estimate
 * means "no capacity", not "instant".
 */
function zhWait(waitSeconds: number | undefined): string {
  if (waitSeconds === undefined) return ''
  if (waitSeconds <= 0) return '，等待上游释放容量'
  return `，上游返回预计等待 ${waitSeconds} 秒`
}

/** The wait wording: a zero estimate means "no capacity", not "instant". */
function enWait(waitSeconds: number | undefined): string {
  if (waitSeconds === undefined) return ''
  if (waitSeconds <= 0) return ', waiting for capacity'
  return `, upstream estimate ~${waitSeconds}s`
}

const zhQueue = {
  hint: ({ display, attempt, waitSeconds }: QueueCopyInput): string =>
    `${display} · 模型排队中（第 ${attempt} 次轮询${zhWait(waitSeconds)}）`,
  reason: ({ display, waitSeconds }: QueueCopyInput): string =>
    `${display} 模型排队中${zhWait(waitSeconds)}`,
}

const enQueue = {
  hint: ({ display, attempt, waitSeconds }: QueueCopyInput): string =>
    `${display} · queued (poll ${attempt}${enWait(waitSeconds)})`,
  reason: ({ display, waitSeconds }: QueueCopyInput): string =>
    `${display} model queued${enWait(waitSeconds)}`,
}

/** The wording for one locale. */
export function queueCopy(locale: HostLocale = hostLocale()): { hint: (input: QueueCopyInput) => string, reason: (input: QueueCopyInput) => string } {
  return locale === 'zh' ? zhQueue : enQueue
}
