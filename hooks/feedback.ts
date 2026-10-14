// What the person told the plugin about its own findings. Three lists, three
// different instructions to the reviewer — without this the plugin reports the same
// things forever, whether or not any of them were any use.
//
//   appreciated — "I want more of this." The reviewer is told to keep raising this
//                 kind of thing, and to put it first.
//   dismissed   — "Not for me." A real problem somewhere, just not here: stop offering.
//   learned     — "I already know." The fact is settled: never raise it again.
//
// All three live per working directory and are fed back into the review prompt.
//
// Only the pure shape lives here. The `$.store` calls themselves have to be written
// out at each site: a hook's `$` may be passed to a function declared in its own file,
// never to one reached through an import, so sharing those through this module is
// refused by the engine.

export type FeedbackEntry = {
  /** The item's sentence, which is what the person was shown. */
  what: string
  /** When they said so, epoch ms. */
  at: number
}

export type FeedbackKind = 'appreciated' | 'dismissed' | 'learned'

export const KINDS: readonly FeedbackKind[] = ['appreciated', 'dismissed', 'learned']

export const MAX_KEPT = 50

/** The project root identifies the setting. Case and slash direction do not matter. */
export const keyFor = (dir: string) => dir.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')

/** Only well-formed entries survive a read; a store written by an older version can hold anything. */
export const sane = (list: unknown): FeedbackEntry[] =>
  Array.isArray(list) ? list.filter((f): f is FeedbackEntry => typeof f === 'object' && f !== null && typeof f.what === 'string') : []

/** Adding the same sentence twice keeps the earlier stamp. */
export const addOne = (list: readonly FeedbackEntry[], what: string, at: number): FeedbackEntry[] =>
  list.some((f) => f.what === what) ? [...list] : [...list, { what, at }].slice(-MAX_KEPT)

/** Returns what was taken off, or undefined when the index names nothing. */
export const dropOne = (list: readonly FeedbackEntry[], index: number): [FeedbackEntry[] | undefined, FeedbackEntry | undefined] =>
  index < 0 || index >= list.length ? [undefined, undefined] : [list.filter((_, j) => j !== index), list[index]]

/** The sentences, which is all the reviewer's prompt needs. */
export const sentences = (list: readonly FeedbackEntry[]) => list.map((f) => f.what)

/**
 * What a typed line means, if anything. The person answers the band in whatever way
 * comes to hand — "learn 1", "learn: 5 = 5%", "dismiss 2", "more like 1" — so this
 * reads the line instead of asking them to press anything. Silence is not read here
 * at all: not answering is the common case and is recorded elsewhere as such.
 *
 * Only the kinds this plugin can act on are recognised. "You should know" carries
 * more — explain a card, chat about it, ask for simpler words — none of which have
 * anything to act on here, so a line about one of those reads as no answer rather
 * than as a guess.
 */
export type Answer =
  | { kind: 'learned'; targets: readonly string[] }
  | { kind: 'dismissed'; targets: readonly string[] }
  | { kind: 'appreciated'; targets: readonly string[] }

// Only words the plugin can be sure about, and only in the shape that means the
// plugin. "知道了", "got it", "close", "useful" are things people say to the model
// all day — swallowing those would drop a normal reply and, worse, silence every
// item on the band. And `learn` must be followed by a number, a colon or a quote:
// "learn from this file" is a work request, not an answer to the band.
// `[\s:,-]*` then one of: end of line, a digit (the band's number), or a quote (a
// borrowed line). That is what makes `learn 1` an answer and `learn from this file`
// a request.
// The verb alone. Whether the rest of the line points at anything is `targetsOf`'s
// call, and it is strict on purpose: free text is refused, because matching it is
// exactly how ordinary sentences ("learn how the cache works") got eaten.
const CLOSING = /^(\s*(?:learn|known)\b[\s:,-]*)(.*)$/i
const DISMISSING = /^(\s*(?:dismiss|not mine|not relevant)\b[\s:,-]*)(.*)$/i
const LIKING = /^(\s*(?:more like|more of)\b[\s:,-]*)(.*)$/i

/**
 * What the rest of the line points at, and nothing else counts. Two shapes are
 * accepted and both name a place rather than a topic:
 *
 *   `learn 1` / `learn 1,2`  — the band's numbering, 1-based as drawn
 *   `learn "…"` / `learn 「…」` — a quote of the item's own words
 *
 * Free text is refused outright. `learn how the cache works` reads as a request and
 * goes to the model untouched, which is what keeps ordinary sentences safe; use a
 * number to answer the band.
 */
const targetsOf = (raw: string, items: readonly { what: string }[]): string[] => {
  const body = raw.trim().replace(/[.!?。！？]+$/, '')
  if (body === '') return []
  if (/^(all|both|everything|所有|全部)$/i.test(body)) return items.map((f) => f.what)

  // A place: the band's numbering.
  if (/^\d+([\s,，、]+\d+)*$/.test(body)) {
    return body
      .split(/[\s,，、]+/)
      .map((n) => items[Number(n) - 1]?.what)
      .filter((x): x is string => typeof x === 'string')
  }

  // A place: a quoted line from the item itself.
  const quoted = /^["'“”「」](.+)["'“”「」]$/.exec(body)
  if (quoted) {
    const words = quoted[1].trim()
    return items.filter((f) => f.what.includes(words)).map((f) => f.what)
  }

  return []
}

/**
 * A line that is aimed at the band even when there is nothing on it. `learn 1`
 * typed after the band has already cleared is still not a work request, and letting
 * it through would cost a turn and record something the plugin cannot act on.
 */
/**
 * The shape of a line meant for the band with nothing to place it on: a bare
 * `learn`, or `learn 2` when the band has already cleared. Used only to catch and
 * answer such a line rather than send it on — it says nothing about whether the
 * words can be placed, which is `parseAnswer`'s job. A line that names something
 * real (`learn from this file`) does not match here and reaches the model.
 */
export const looksLikeAnswer = (text: string): boolean => {
  const line = text.trim()
  const verb = /^\s*(learn|known|dismiss|not mine|not relevant|more like|more of)\b[\s:,-]*/i.exec(line)
  if (!verb) return false
  const rest = line.slice(verb[0].length).trim().replace(/[.!?。！？]+$/, '')
  // The same two shapes targetsOf accepts: nothing at all (which asks), a place
  // (`1`, `1,2`), or a quote. Anything else is a request and reaches the model.
  return rest === '' || /^\d+([\s,，、]+\d+)*$/.test(rest) || /^["'“”「」].+["'“”「」]$/.test(rest)
}

export const parseAnswer = (text: string, items: readonly { what: string }[]): Answer | null => {
  const line = text.trim()
  // Dismiss and "more like" are checked before closing: "more like 1" must not read
  // as "learn", and "not relevant" must not read as either.
  for (const [re, kind] of [
    [DISMISSING, 'dismissed'],
    [LIKING, 'appreciated'],
    [CLOSING, 'learned'],
  ] as [RegExp, Answer['kind']][]) {
    const hit = re.exec(line)
    if (!hit) continue
    const targets = targetsOf(hit[2], items)
    return targets.length === 0 ? null : { kind, targets }
  }
  return null
}
