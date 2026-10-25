/**
 * Repair the two malformations models produce when they complete tool-call arguments.
 *
 * Arguments arrive as one JSON string assembled from stream deltas. Two defects are common
 * enough to be worth recovering from, because either one otherwise failed the whole turn and
 * the tool call was never dispatched:
 *
 * - quoted prose pasted into a string value without escaping (`"…少了"两个世界"的实感。"`)
 * - a response cut before its closing brackets
 *
 * Recovery is deliberately narrow: only text that is not already valid JSON is touched, and
 * a repair is returned only when the result parses as an object. Anything else still fails
 * the call with the provider's own error rather than dispatching invented arguments.
 *
 * @module dsh-qoder-connect/tool-arguments
 */

/** A repair that produced valid arguments, with what it had to change. */
export interface ToolArgumentRepair {
  arguments: Record<string, unknown>
  /** What was repaired, in the order applied; empty when the text was already valid JSON. */
  repairs: Array<'unescaped quotes' | 'truncated JSON'>
}

const whitespace = new Set([' ', '\t', '\n', '\r', '\u00a0'])

/**
 * Characters that can only follow a completed JSON string. An unescaped quote inside a
 * literal is a real closing quote only when one of these comes next; otherwise it is prose
 * the model pasted without escaping, and the literal continues past it.
 */
const followsString = new Set([',', ':', '}', ']'])

/** @returns the index of the first non-whitespace character at or after `from`. */
function skipWhitespace(text: string, from: number): number {
  let index = from
  while (index < text.length && whitespace.has(text[index] as string)) index += 1
  return index
}

/** @returns the argument object a strict parse yields, or `undefined` when the text is not one. */
function strictObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Escape the unescaped quotes that the model pasted into a string value.
 *
 * The text is read with JSON's own string rules: inside a literal a backslash keeps the next
 * character, so escaped quotes never end it. A quote is only believed to close the literal
 * when a JSON delimiter follows it; every other quote inside a literal is prose and gains a
 * backslash. Well-written documents satisfy that test at exactly their closing quotes, so
 * valid JSON is returned unchanged.
 * @param text - the argument text.
 * @returns the text with prose quotes escaped.
 */
function escapeProseQuotes(text: string): string {
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (!inString) {
      if (char === '"') inString = true
      out += char
      continue
    }
    if (char === '\\') {
      out += text.slice(index, index + 2)
      index += 1
      continue
    }
    if (char === '"' && !followsString.has(text[skipWhitespace(text, index + 1)] as string)) {
      out += '\\"'
      continue
    }
    if (char === '"') inString = false
    out += char
  }
  return out
}

/**
 * Complete a response that was cut before its closing brackets.
 *
 * Only missing characters are added: an unfinished literal is closed at its last character,
 * then every container still open is closed in reverse order. A trailing member the model
 * never finished (a dangling comma, a partial key, or a key with no value) is dropped first,
 * because it holds nothing that can be used; everything already complete is kept.
 * @param text - the quote-repaired argument text.
 * @returns the completed text, or `undefined` when the nesting cannot be restored.
 */
function closeTruncation(text: string): string | undefined {
  let body = text.trimEnd()
  for (;;) {
    const trimmed = body
      .replace(/,\s*"[^"]*"\s*:\s*[^,{}[\]]*$/, '')
      .replace(/,\s*"[^"]*$/, '')
      .replace(/,\s*$/, '')
    if (trimmed === body) break
    body = trimmed
  }

  const stack: string[] = []
  let inString = false
  let inEscape = false
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (inString) {
      if (inEscape) inEscape = false
      else if (char === '\\') inEscape = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') {
      if (stack.at(-1) !== char) return undefined
      stack.pop()
    }
  }
  // A cut in the middle of an escape sequence drops that sequence: the backslash alone would
  // otherwise escape the closing quote added below.
  const opened = inEscape ? body.slice(0, -1) : body
  return `${opened}${inString ? '"' : ''}${stack.reverse().join('')}`
}

/**
 * Parse completed tool-call arguments, repairing the malformations models produce.
 *
 * Strict JSON returns unchanged and reports no repair. Otherwise prose quotes pasted into
 * string values are escaped, and text that still does not parse is completed as a truncated
 * response. Both repairs are attempts: the caller keeps its own error when neither yields an
 * object.
 * @param text - the raw JSON argument string assembled from the provider stream.
 * @returns the arguments and the repairs applied.
 * @throws SyntaxError when no repair yields a JSON object.
 */
export function repairToolCallArguments(text: string): ToolArgumentRepair {
  const strict = strictObject(text)
  if (strict !== undefined) return { arguments: strict, repairs: [] }

  const quoted = escapeProseQuotes(text)
  if (quoted !== text) {
    const escaped = strictObject(quoted)
    if (escaped !== undefined) return { arguments: escaped, repairs: ['unescaped quotes'] }
  }

  const closed = closeTruncation(quoted)
  if (closed !== undefined) {
    const truncated = strictObject(closed)
    // Closing a response that holds no completed member would dispatch arguments the model
    // never wrote, so that stays an error.
    if (truncated !== undefined && Object.keys(truncated).length > 0) {
      return {
        arguments: truncated,
        repairs: quoted === text ? ['truncated JSON'] : ['unescaped quotes', 'truncated JSON'],
      }
    }
  }
  throw new SyntaxError('tool-call arguments are not valid JSON and could not be repaired')
}
