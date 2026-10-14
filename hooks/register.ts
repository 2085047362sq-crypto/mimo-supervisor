import type { Finding, Mode, Snapshot } from '../types'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { registerBand } from './band'
import { addOne, dropOne, keyFor, looksLikeAnswer, parseAnswer, sane, sentences, type FeedbackKind } from './feedback'
import { PANE, registerPane } from './pane'
import { noteText, parseFindings, watchPrompt } from './prompt'

// Claude Code's own "You should know" watches Claude at work, but it is hidden
// whenever ANTHROPIC_BASE_URL points away from Anthropic (observed on 2.1.290: that
// one variable alone), so it never loads on a third-party model. It checks every 6
// steps (the constant read off the 2.1.290 binary); this one starts at 3 instead.
//
// A pass takes 11-14s to come back and a step takes 3-9s, so a finding lands some 2-4
// steps after its pass went out. At 6 that is past the end of most turns and the
// finding reaches only the next one; at 3 it lands while the turn it looked at is
// still running, and — worth more — a wrong reading picked at step 1 is caught at 3
// instead of at 6, with less wrong work built on top of it.
const CHECK_EVERY = 3
// ...but a pass that finds nothing is the common one, and learning that costs a fork
// of the whole transcript. After a few in a row the checks spread out, doubling, up
// to this; the first finding puts them back at CHECK_EVERY.
const CHECK_EVERY_MAX = 24
// Its cards clear after two prompts from the person; so does the band.
const CLEAR_AFTER_PROMPTS = 2
// What the watcher has already said, the newest kept; every later pass skips it.
// The DeepSeek original kept 12 and its author saw the same point come back twice;
// 24 is what that costs, and the memory is small either way.
const RAISED_KEPT = 24
const HISTORY = 50
// $.model.fork's request takes no timeoutMs (only $.model.complete does), so a fork
// that never comes back is let go of by this and by nothing else. See `watch`.
const FORK_GIVE_UP_MS = 120_000
// After this many passes in a row with no readable verdict, say so out loud: a
// reviewer that silently stopped working is worse than none, because you think it
// is still watching.
const DEAD_PASS_ALERT = 3

// The band's two values, drawn by hooks/band.tsx. The scan wants every file that
// writes one to name it in a const of its own; types/index.d.ts holds both to one shape.
const cards = atom({ plugin: 'mimo-supervisor', key: 'cards' } as const, null)
const isHidden = atom({ plugin: 'mimo-supervisor', key: 'isHidden' } as const, false)
const snapshot = atom({ plugin: 'mimo-supervisor', key: 'snapshot' } as const, {
  mode: 'auto',
  watches: false,
  why: 'not looked at yet',
  every: CHECK_EVERY,
  told: 0,
  last: '',
  raised: [],
  quietPasses: 0,
} as Snapshot)

const say = ($: EngineInterface, line: string) => $.ui.log(`mimo-supervisor: ${line}`, { to: 'debug' })

// The last thing the person chose, kept across sessions **per working directory**:
// one project watched and the next not, without the two interfering. `$.store` is the
// host's and outlives both the session and a reload of this module, so a choice typed
// once is there the next time that directory is opened.
//
// `$.session.root()` is the identifier, not `cwd`: root is where the session started
// or where /cd took it, and a shell `cd` during work does not move it — so the setting
// follows the project, not the folder a command happened to run in.
const dirKey = (dir: string) => dir.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')

const modeDir = async ($: EngineInterface) => dirKey(await $.session.root().catch(() => '') ?? '')

const modesOf = async ($: EngineInterface): Promise<Record<string, Mode>> => {
  const all = await $.store.get('modes').catch(() => undefined)
  return all !== null && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, Mode>) : {}
}

const modeOf = async ($: EngineInterface): Promise<Mode> => {
  const all = await modesOf($)
  const v = all[await modeDir($)]
  return v === 'on' || v === 'off' || v === 'auto' ? v : 'off'
}

// What the person has closed about past findings. The pure shape is in hooks/
// feedback.ts; the store calls are written out here because a hook's `$` may not be
// passed through an import. Read once per pass and fed back into the review prompt.
const readKind = async ($: EngineInterface, kind: FeedbackKind) => {
  const all = await $.store.get(kind).catch(() => undefined)
  const base = all !== null && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, unknown>) : {}
  return sane(base[keyFor((await $.session.root().catch(() => '')) ?? '')])
}

const writeKind = async ($: EngineInterface, kind: FeedbackKind, next: ReturnType<typeof sane>) => {
  const all = await $.store.get(kind).catch(() => undefined)
  const base = all !== null && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, unknown>) : {}
  return $.store
    .set(kind, { ...base, [keyFor((await $.session.root().catch(() => '')) ?? '')]: next })
    .catch(() => undefined)
}

const closeOne = async ($: EngineInterface, kind: FeedbackKind, what: string) =>
  writeKind($, kind, addOne(await readKind($, kind), what, await $.clock.now().catch(() => Date.now())))

const setMode = async ($: EngineInterface, next: Mode) => {
  const all = await modesOf($)
  return $.store.set('modes', { ...all, [await modeDir($)]: next }).catch(() => undefined)
}

// Which model the session is actually pointed at. This is the one thing the port has
// to get right: the DeepSeek original keyed off the endpoint alone, and here the
// endpoint is a local proxy (127.0.0.1:18080) that carries no model name at all —
// it serves whatever ANTHROPIC_*_MODEL says. So the model id, not the host, is what
// tells this apart from a session on some other third-party model.
const modelOf = async ($: EngineInterface): Promise<string | undefined> => {
  // What /model shows: the model the main loop actually resolved, including one
  // passed as --model at launch, which no environment variable records.
  const live = await $.session.model().catch(() => undefined)
  if (typeof live === 'string' && live.trim() !== '') return live.trim()

  // Otherwise the environment, all five at once. Each name is written out, not
  // looped: $.env.get wants a literal so the scan can list every variable a module
  // touches. First one set wins.
  const named = await Promise.all([
    $.env.get('ANTHROPIC_MODEL').catch(() => undefined),
    $.env.get('ANTHROPIC_DEFAULT_OPUS_MODEL').catch(() => undefined),
    $.env.get('ANTHROPIC_DEFAULT_SONNET_MODEL').catch(() => undefined),
    $.env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL').catch(() => undefined),
    $.env.get('ANTHROPIC_CUSTOM_MODEL_OPTION').catch(() => undefined),
  ])
  for (const v of named) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return undefined
}

const isMimo = (id: string | undefined) => id !== undefined && /mimo/i.test(id)

const isAnthropic = (url: string | undefined) => {
  if (url === undefined || url.trim() === '') return true
  const host = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url.trim())?.[1]?.toLowerCase() ?? ''
  return host === 'anthropic.com' || host.endsWith('.anthropic.com')
}

const onAnthropic = async ($: EngineInterface) => isAnthropic(await $.env.get('ANTHROPIC_BASE_URL').catch(() => undefined))

// What the watcher decided, and why, as the status line and the command report it.
type Verdict = { watches: boolean; mode: Mode; why: string }

// Worked out once per prompt rather than on every step. The answer changes only when
// the person runs the command or points the session at another model, and each
// derivation is a store read plus up to seven engine calls; `turn.step` used to pay
// all of that per step. A model switched mid-session with /model is seen at the next
// prompt, which is the next time it could matter.
let verdict: Verdict | undefined

const workOut = async ($: EngineInterface): Promise<Verdict> => {
  const mode = await modeOf($)
  // Read either way, so the answer can say which model is being watched. `forced on`
  // used to stand here and the name was lost — the person could not tell from the pane
  // that they were looking at the wrong model or the wrong proxy.
  const model = await modelOf($)
  const named = model !== undefined ? `model ${model}` : undefined

  if (mode === 'off') return { watches: false, mode, why: 'not started — /mimo-supervisor begins' }
  if (mode === 'on') return { watches: true, mode, why: named ?? 'started for this conversation' }

  // Auto: run for mimo. When no model name is set anywhere, fall back to the DeepSeek
  // rule — anything that is not Anthropic's endpoint is someone else's model and still
  // worth watching — so a session that hides its model is not left unwatched.
  if (named !== undefined) return { watches: isMimo(model), mode, why: named }
  const anthropic = await onAnthropic($)
  return { watches: !anthropic, mode, why: anthropic ? 'Anthropic endpoint' : 'non-Anthropic endpoint' }
}

const verdictOf = async ($: EngineInterface): Promise<Verdict> => {
  if (verdict === undefined) {
    verdict = await workOut($).catch((err: unknown): Verdict => ({ watches: false, mode: 'auto', why: `unreadable (${err})` }))
  }
  return verdict
}

const forget = () => {
  verdict = undefined
}

let raised: Finding[] = []
let steps = 0
// The pass that owns `isWatching`; a pass lets go only while it still owns it, so an
// older one coming back late cannot stop a newer one already under way.
let watchRun = 0
let isWatching = false
let promptsSinceCards = 0
// This session's count, for the status line; a hot reload starts it over.
let told = 0
let last = ''
// Consecutive passes that found nothing, which is what widens the interval.
let quietPasses = 0
// Consecutive passes that came back with nothing readable at all. A few in a row
// means the reviewer is not working, and silence is how that fails.
let deadPasses = 0

// The base interval, settable: a pass takes 11-14s to come back, so one started at
// step 6 of a turn that ends at step 7 reaches nobody in that turn. A shorter base
// starts it earlier and lands findings inside the turn it is looking at — at the price
// of more forks over the same work.
//
// A number the person picked is used as it stands. Someone who says "every 3 steps"
// means every 3 steps: an adaptive widening to 24 behind their back is not what they
// asked for, and the widening is there to save forks, which is not everyone's concern.
// The default is fixed too, at CHECK_EVERY; `interval auto` is the only way to get the
// widening, and it says so when you ask for it.
let fixedEvery: number | undefined = CHECK_EVERY
const checkEvery = () => (fixedEvery ?? Math.min(CHECK_EVERY * 2 ** quietPasses, CHECK_EVERY_MAX))

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// What the pane draws is kept here. This is an atom write and draws nothing itself.
// The status line used to hold this and did draw — and a `$.ui.status` text reaches
// the terminal with a warning glyph in front of it that the plugin cannot ask to leave
// off, so the state went to a pane the plugin draws as its own tree instead.
const refresh = async ($: EngineInterface) => {
  const v = await verdictOf($)
  const next: Snapshot = {
    mode: v.mode,
    watches: v.watches,
    why: v.why,
    every: checkEvery(),
    told,
    last,
    raised,
    quietPasses,
  }
  await update($, snapshot, () => next).catch(() => undefined)
}

// A reload runs `register` and `session.start` again and the module's own variables
// start over; `$.state` is the host's and stays. So the session's memory is read back
// from it — otherwise a reload would make the watcher raise the same points twice and
// forget how far the checks had already stretched out. `steps` is the one thing left
// out: losing it only means the first pass after a reload comes a few steps later.
const load = async ($: EngineInterface) => {
  // One-time carry-over: a version that stored a single global mode is moved under
  // this directory, so the choice already made does not vanish with the upgrade.
  const legacy = await $.store.get('mode').catch(() => undefined)
  if (legacy === 'on' || legacy === 'off' || legacy === 'auto') {
    const all = await modesOf($)
    const at = await modeDir($)
    if (all[at] === undefined) await $.store.set('modes', { ...all, [at]: legacy }).catch(() => undefined)
    await $.store.delete('mode').catch(() => undefined)
  }

  const s = await read($, snapshot).catch(() => null)
  if (s !== null) {
    told = s.told
    last = s.last
    quietPasses = s.quietPasses
    raised = Array.isArray(s.raised) ? s.raised : []
  }
  // $.store outlives the session, so the interval the person picked comes from there.
  // Absent means the default — fixed at CHECK_EVERY. 'auto' is what `interval auto`
  // stores, and it is the only spelling that gets the widening back.
  const every = await $.store.get('every').catch(() => undefined)
  fixedEvery =
    typeof every === 'number' && every >= 1 && every <= CHECK_EVERY_MAX ? every : every === 'auto' ? undefined : CHECK_EVERY
}

// One pass over the work so far, as it settled. The cost is wall-clock: on this
// gateway the usage fields come back as zeros, so tokens cannot be totalled up — and
// a fork whose cache_read_input_tokens is near zero paid for the whole transcript
// prefix anyway, which is the expensive case, not the cheap one.
type Pass = {
  at: number
  ms: number
  findings: Finding[] | null
  usage: unknown
  readable: boolean
}

const remember = async ($: EngineInterface, entry: Pass) => {
  const old = await $.store.get('history').catch(() => [])
  const list = Array.isArray(old) ? old : []
  await $.store.set('history', [...list, entry].slice(-HISTORY)).catch(() => undefined)
}

// What the passes have actually been worth, read back from history. The usage fields
// come back zero on this gateway, so cost is only visible as wall-clock and counts —
// these, and not a guess, are what tell the person whether the reviewer earns its keep.
export const summarize = (list: readonly Pass[]): string => {
  if (list.length === 0) return 'No passes yet.'
  const withFind = list.filter(p => Array.isArray(p.findings) && p.findings.length > 0)
  const items = withFind.reduce((a, p) => a + (p.findings?.length ?? 0), 0)
  const stop = withFind.reduce((a, p) => a + (p.findings ?? []).filter(f => f.severity === 'you-should-know').length, 0)
  const empty = list.filter(p => Array.isArray(p.findings) && p.findings.length === 0).length
  const unreadable = list.filter(p => !p.readable).length
  const avg = list.length === 0 ? 0 : Math.round(list.reduce((a, p) => a + (p.ms || 0), 0) / list.length / 1000)
  return `last ${list.length} passes: ${items} finding(s) — ${stop} worth stopping for, ${empty} found nothing, ${unreadable} unreadable, avg ${avg}s each`
}

// One pass over the work so far. It runs beside the turn, never in its way: the
// items reach the model as a note it reads at its next step, and the band above the
// prompt shows the person the same items.
const watch = async ($: EngineInterface) => {
  const run = ++watchRun
  let guard: { cancel: () => void } | undefined
  try {
    // Without this, a fork that never comes back holds isWatching true and stops
    // every later pass for the rest of the session, with nothing said about it.
    // Neither this nor the finally below redraws the status: a pass settles after the
    // turn has ended, where there is no status row to draw into and the line is kept
    // in the transcript instead — which is what the host marks with a warning glyph.
    // The status is raised from session.start, prompt.submit and command.run instead,
    // each of them inside a turn.
    guard = $.clock.after(FORK_GIVE_UP_MS, () => {
      if (run !== watchRun) return
      say($, `fork gave no answer in ${FORK_GIVE_UP_MS}ms; moving on`)
      isWatching = false
    })

    const startedAt = await $.clock.now()
    const learned = await readKind($, 'learned')
    const dismissed = await readKind($, 'dismissed')
    const appreciated = await readKind($, 'appreciated')

    // `raised` keeps everything, including what they appreciate. The two lists say
    // different things and neither cancels the other: "already raised" stops the same
    // sentence coming back, while "useful to them" asks for *new* problems of that kind.
    // Dropping a praised sentence from `raised` would have it re-reported every pass —
    // the opposite of what pressing "more like this" is meant to do.
    const reply = await $.model.fork({
      prompt: watchPrompt(raised, {
        learned: sentences(learned),
        dismissed: sentences(dismissed),
        appreciated: sentences(appreciated),
      }),
    })
    const at = await $.clock.now()
    // The guard let go and a newer pass may already own the state: this one is over.
    if (run !== watchRun) return

    if (!reply.isAnswered) {
      say($, `no verdict (${reply.reason})`)
      // 没回答也算一次"没给出结论"——api-error、aborted 这类恰恰是最可能真坏掉
      // 的路，漏掉就等于最需要提醒时闭嘴。但 `nothing-to-fork` 不算：那是"还
      // 没东西可 fork"（新会话、/clear 之后），不是审查坏了，数进去会弹假警报。
      if (reply.reason !== 'nothing-to-fork')
      {
        deadPasses += 1
        if (deadPasses >= DEAD_PASS_ALERT)
        {
          say($, `no usable verdict ${deadPasses} times in a row`)
          $.ui.toast(`mimo-supervisor：审查连续 ${deadPasses} 次没结果（${reply.reason}），可能没在工作。`)
          deadPasses = 0
        }
      }
      return
    }
    const findings = parseFindings(reply.text)
    // 审查是旁路：它坏了不会报错，只是再也不提醒。所以连续几次没有结论
    // 就直说一声，别让人以为它还看着。
    if (findings === null) deadPasses += 1
    else deadPasses = 0
    await remember($, { at, ms: at - startedAt, findings, usage: reply.usage, readable: findings !== null })
    say($, `WATCH ${JSON.stringify(findings)} in ${at - startedAt}ms`)

    if (findings === null)
    {
      if (deadPasses >= DEAD_PASS_ALERT)
      {
        say($, `no readable verdict ${deadPasses} times in a row`)
        $.ui.toast('mimo-supervisor：连续几次审查没给出结论，可能没在工作。用 /mimo-supervisor log 看。')
        deadPasses = 0   // 只提醒一次，别一直吵
      }
      return // said nothing readable: the interval is left alone
    }
    if (findings.length === 0) {
      // Topped out where the doubling stops mattering: CHECK_EVERY * 2^3 is already
      // CHECK_EVERY_MAX, so a fourth quiet pass would not push the interval any further.
      quietPasses = Math.min(quietPasses + 1, 3)
      return
    }
    quietPasses = 0

    raised = [...raised, ...findings].slice(-RAISED_KEPT)
    told += findings.length
    last = `${findings.length} at ${hhmm(at)}`
    promptsSinceCards = 0
    await update($, cards, () => ({ at, items: findings }))
    await update($, isHidden, () => false)
    // Refused or failed, the items are still in the band: say so, so the person can pass
    // them on. A refused append RESOLVES to { deny } rather than rejecting, so the
    // result is read and the rejection path is caught as well: either way the person
    // hears about it.
    const note = await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: noteText(findings) }] } })
      .catch((err: unknown) => ({ deny: String(err) }))
    if (note.deny !== undefined) {
      say($, `note not delivered (${note.deny})`)
      $.ui.toast('mimo-supervisor: a note did not reach the model; see the band above the prompt')
    }
  } catch (err) {
    say($, `watch failed: ${err}`)
  } finally {
    guard?.cancel()
    if (run === watchRun) {
      isWatching = false
      // Safe to do here, unlike the old status line: this writes an atom and draws
      // nothing, so a pass settling after the turn has ended leaves no mark.
      await refresh($)
    }
  }
}

export const register: Register = on => {
  registerBand(on)
  registerPane(on)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({
        name: 'mimo-supervisor',
        description: 'Start watching this conversation and tell the model what it notices. Bare command starts it; off stops it again.',
        argumentHint: '[off|on|auto|show|log|learn|dismiss|appreciate|learned|dismissed|appreciated|unlearn|undismiss|unappreciate|interval <n>|interval auto]',
      })
      .catch(err => say($, `command not registered: ${err}`))
    // Nothing opens while the session is dormant: the plugin is installed and its
    // command is there, but asking for it is what starts the watching and the pane.
    // Unasked, a pane seats from 144 columns and waits below that; one opened behind
    // the person's own command seats at any width.
    if ((await verdictOf($)).watches) {
      void $.ui.open({ id: PANE, title: 'mimo-supervisor' }).catch(err => say($, `pane not opened: ${err}`))
    }
    // Clear, not draw: a status line set before this version stays on screen until
    // something clears it, and this module never draws one again. session.start fires
    // again on a reload, which is how a leftover from the old build goes away.
    $.ui.status(undefined)
    await load($)
    await refresh($)
    return result
  })

  // The person's prompts age the band, as they age "You should know" cards — and are
  // the one moment a changed model or setting has to be looked at again.
  on('prompt.submit', async ($, e, next) => {
    // A line aimed at the band is not a line aimed at the model: `learn 1`,
    // `dismiss 2`, `more like 1`, or a quote of the item itself. It is read here and
    // taken out of the prompt, so the person can answer the band in passing without
    // derailing whatever they were doing. Silence is not read here at all — not
    // answering is the common case and is recorded as such elsewhere.
    try {
      const shown = await read($, cards).catch(() => null)
      const items = shown?.items ?? []
      const answer = items.length > 0 ? parseAnswer(e.text, items) : null

      // A line aimed at the band is never a work request. Two ways it can fail to
      // name anything: the band has already cleared (or this is a fresh session), or
      // it names nothing at all. Either way it is caught and answered, not sent on —
      // forwarding `learn 1` would cost a turn and close the wrong thing.
      if (answer === null && looksLikeAnswer(e.text)) {
        say($, 'answer that named nothing')
        return {
          drop:
            items.length === 0
              ? 'mimo-supervisor: nothing on screen to answer — a pass has to find something first.'
              : `mimo-supervisor: which one? Say \`learn 1\` or \`learn "…"\` with the line in quotes. ${items.length} on screen.`,
        }
      }

      if (answer !== null) {
        for (const what of answer.targets) await closeOne($, answer.kind, what)
        await update($, cards, (c) =>
          c === null ? null : { ...c, items: c.items.filter((f) => !answer.targets.includes(f.what)) },
        )
        await refresh($)
        say($, `answered ${answer.kind}: ${answer.targets.length} item(s)`)
        // Dropped, not forwarded: the line was aimed at the plugin, and sending it on
        // would cost a whole turn for the model to answer "sure". `drop` shows this
        // text back to the person instead — the acknowledgement and the prompt are
        // the same message.
        return {
          drop:
            answer.kind === 'learned'
              ? `mimo-supervisor: closed ${answer.targets.length} item(s) — they will not come up again.`
              : answer.kind === 'dismissed'
                ? `mimo-supervisor: ${answer.targets.length} item(s) marked not relevant.`
                : `mimo-supervisor: noted — more like that will be raised.`,
        }
      }
    } catch (err) {
      say($, `answer: ${err}`)
    }

    // Raised before the prompt goes in, while the status row is live. A pass settles
    // after the turn has ended; drawing there has no row to land in and the line is
    // kept in the transcript instead, which the host marks.
    try {
      forget()
      // The pane is only auto-drawn at 144 columns and above. Opening it behind the
      // person's own prompt counts as being asked, which seats it at any width, so a
      // narrow terminal still gets it. Only once the watching is on — a dormant
      // session shows nothing.
      if ((await verdictOf($)).watches) void $.ui.open({ id: PANE, title: 'mimo-supervisor' }).catch(() => undefined)
      await refresh($)
    } catch (err) {
      say($, `prompt.submit: ${err}`)
    }

    const result = await next(e)
    // Gating, so nothing in here may throw into the person's own prompt.
    try {
      if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
        promptsSinceCards += 1
        if (promptsSinceCards >= CLEAR_AFTER_PROMPTS) await update($, cards, () => null)
      }
    } catch (err) {
      say($, `prompt.submit: ${err}`)
    }
    return result
  })

  // The watcher counts the main loop's finished steps; a subagent's are its own.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId !== undefined || result.stopReason === null) return result
    steps += 1
    const every = checkEvery()
    if (steps >= every && !isWatching && (await verdictOf($)).watches) {
      steps = 0
      isWatching = true
      // Off the step's own dispatch, which closes when the step ends: work that
      // must outlive it runs from a timer (started straight from the hook, the
      // pass stalled after the fork).
      $.clock.after(0, () => {
        void watch($)
      })
    }
    return result
  })

  on('command.run', { command: 'mimo-supervisor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'log') {
      const list = await $.store.get('history').catch(() => [])
      const arr = Array.isArray(list) ? (list as Pass[]) : []
      return { text: arr.length > 0 ? `${summarize(arr)}\n\nlast ${Math.min(arr.length, 10)}:\n${JSON.stringify(arr.slice(-10), null, 1)}` : 'No checks yet.' }
    }

    // "I know about this one — stop telling me." Everything currently held above the
    // prompt is closed: the reviewer is told never to raise it again in any wording,
    // which is stronger than "already raised", where it may still repeat if worse.
    // Three signals, three effects on what the reviewer is told to do. Each takes
    // whatever is currently held above the prompt — that is what the person is looking
    // at when they type it.
    const KINDS = {
      learn: { kind: 'learned', add: 'learn', verb: 'Closed', after: 'They will not come up again in this project.', empty: 'Nothing held to learn. It runs after a pass finds something.', emptyList: 'Nothing closed yet. /mimo-supervisor learn closes what is on screen.', list: 'learned', undo: 'unlearn' },
      dismiss: { kind: 'dismissed', add: 'dismiss', verb: 'Marked', after: 'They will not come up again in this project.', empty: 'Nothing held to dismiss. It runs after a pass finds something.', emptyList: 'Nothing marked not relevant yet. /mimo-supervisor dismiss marks what is on screen.', list: 'dismissed', undo: 'undismiss' },
      appreciate: { kind: 'appreciated', add: 'appreciate', verb: 'Noted', after: 'This kind of thing is worth a turn to you, so the reviewer will raise it when it qualifies.', empty: 'Nothing held to appreciate. It runs after a pass finds something.', emptyList: 'Nothing appreciated yet. /mimo-supervisor appreciate notes what is on screen.', list: 'appreciated', undo: 'unappreciate' },
    } as const

    for (const [name, spec] of Object.entries(KINDS)) {
      if (arg !== name) continue
      const shown = await read($, cards).catch(() => null)
      const now = shown === null ? [] : shown.items.map(f => f.what).filter(x => x !== '')
      if (now.length === 0) return { text: spec.empty }
      for (const what of now) await closeOne($, spec.kind, what)
      return { text: `${spec.verb} ${now.length} item(s). ${spec.after}\n${now.map((x, i) => `${i + 1}. ${x}`).join('\n')}` }
    }

    for (const spec of Object.values(KINDS)) {
      if (arg === spec.list) {
        const list = sentences(await readKind($, spec.kind))
        return {
          text:
            list.length === 0
              ? spec.emptyList
              : list.map((x, i) => `${i + 1}. ${x}`).join('\n') + `\n\n/mimo-supervisor ${spec.undo} <n> takes one off.`,
        }
      }
      const undo = new RegExp(`^${spec.undo}\\s+(\\d+)$`)
      const hit = undo.exec(arg)
      if (hit) {
        const held = await readKind($, spec.kind)
        const [next, gone] = dropOne(held, Number(hit[1]) - 1)
        if (next === undefined || gone === undefined)
          return { text: `No item ${hit[1]}. ${held.length} in this list.` }
        await writeKind($, spec.kind, next)
        return { text: `Reopened: ${gone.what}\nIt can be raised again.` }
      }
    }
    // Hide puts the band away with nothing to bring it back but the next finding, so
    // this is how the person asks for the one already there. The items are still held
    // until two of their prompts age them out; only the drawing was turned off.
    if (arg === 'show') {
      const shown = await read($, cards).catch(() => null)
      if (shown === null || shown.items.length === 0)
        return { text: 'Nothing is being held above the prompt. /mimo-supervisor log lists what past passes found.' }
      await update($, isHidden, () => false)
      // Asking to see something is asking to see the pane too.
      await $.ui.open({ id: PANE, title: 'mimo-supervisor' }).catch(() => undefined)
      return { text: `Showing ${shown.items.length} item(s) above the prompt again.` }
    }

    // The interval. Lower it and the review starts earlier in a turn, so it is more
    // likely to come back while that turn is still running and reach it; raise it and
    // fewer forks are spent over the same work.
    if (arg === 'interval auto') {
      fixedEvery = undefined
      quietPasses = 0
      await $.store.set('every', 'auto').catch(() => undefined)
      await refresh($)
      return { text: `Adaptive: every ${CHECK_EVERY} steps, further apart while passes keep finding nothing. /mimo-supervisor interval <n> fixes it again.` }
    }
    const interval = /^interval\s+(\d+)$/.exec(arg)
    if (interval) {
      const n = Number(interval[1])
      if (n < 1 || n > CHECK_EVERY_MAX) return { text: `Pick 1 to ${CHECK_EVERY_MAX}.` }
      fixedEvery = n
      quietPasses = 0
      await $.store.set('every', n).catch(() => undefined)
      await refresh($)
      return { text: `Checking every ${n} step(s), exactly — no widening. /mimo-supervisor interval auto puts the widening back.` }
    }

    // The bare command is the switch: this is what turns the watching on, the way a
    // statusline sits installed until you set it up. It holds for this conversation
    // only.
    if (arg === '' || arg === 'on' || arg === 'off' || arg === 'auto') {
      const chosen: Mode = arg === '' ? 'on' : (arg as Mode)
      await setMode($, chosen)
      forget()
      quietPasses = 0
      if (!(await verdictOf($)).watches) await update($, cards, () => null)
      await refresh($)
      const v = await verdictOf($)
      // Only once the watching is actually on. Typing `off` stops it and must not pop
      // a pane at the person — a dormant session shows nothing at all.
      if (v.watches) await $.ui.open({ id: PANE, title: 'mimo-supervisor' }).catch(err => say($, `pane not opened: ${err}`))
      return {
        text:
          arg === ''
            ? `Watching this conversation. ${v.why}. Use /mimo-supervisor off to stop.`
            : `mimo-supervisor is ${chosen}${chosen === 'auto' ? ` (${v.why})` : ''}, for this conversation.`,
      }
    }

    const v = await verdictOf($)
    const hist = await $.store.get('history').catch(() => [])
    const stats = summarize(Array.isArray(hist) ? (hist as Pass[]) : [])
    return {
      text: `mimo-supervisor is ${v.mode} (${v.why})${v.watches ? `, every ${checkEvery()} steps` : ''}. ${stats}. /mimo-supervisor starts it, /mimo-supervisor off stops it. On what is on screen: learn (I know), dismiss (not for me), appreciate (I want more of this). Also: [on|auto|show|log|learned|dismissed|appreciated|interval <n>|interval auto]`,
    }
  })
}
