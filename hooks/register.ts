import type { Finding, Mode, Snapshot } from '../types'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { addOne, closedCount, closedRows, dropAt, keyFor, looksLikeAnswer, parseAnswer, sane, sentences, type FeedbackKind } from './feedback'
import { PANE, registerPane } from './pane'
import { noteText, parseFindings, watchPrompt } from './prompt'

// Claude Code's own "You should know" watches Claude at work, but it is hidden
// whenever ANTHROPIC_BASE_URL points away from Anthropic (observed on 2.1.290: that
// one variable alone), so it never loads on a third-party model. It checks every 6
// steps (the constant read off the 2.1.290 binary); this one starts at 3 instead.
//
// A pass reads the whole transcript again, so it is slow and gets slower as the
// conversation grows: measured over 50 real passes, p50 126s / p90 227s / max 302s
// (the early "11-14s" figure was a short-session sample and is obsolete). A step
// takes 3-9s, so a finding lands tens of steps later, often in a later turn — the
// value is "seen before the next step of work", not "caught live". 3 is still the
// right knob: the interval sets review DENSITY, the pass duration sets the latency,
// and widening the interval only lands findings later. What 3 buys over 6 is that a
// wrong reading picked at step 1 is caught at 3 instead of 6, with less wrong work
// built on top of it.
const CHECK_EVERY = 3
// The largest interval `interval <n>` accepts. (It used to also be the ceiling of an
// adaptive doubling; the widening is gone and this is now just the range of n.)
const CHECK_EVERY_MAX = 24
// The delta gate for CHAINED checks: at least this much new work since the previous
// pass landed, whatever `every` says. Two passes in a row over one wave of work (the
// slow-pass-then-instant-pass rhythm) mostly re-poke what the first one just saw; six
// steps is enough for the transcript to have moved on. The first check of a session
// is exempt — it still fires at exactly the interval the person picked.
const MIN_NEW_STEPS = 6
// Its cards clear after two prompts from the person; the pane draws what is held.
const CLEAR_AFTER_PROMPTS = 2
// What the watcher has already said, the newest kept; every later pass skips it.
// The DeepSeek original kept 12 and its author saw the same point come back twice;
// 24 is what that costs, and the memory is small either way.
const RAISED_KEPT = 24
const HISTORY = 50
// $.model.fork's request takes no timeoutMs (only $.model.complete does), so a fork
// that never comes back is let go of by this and by nothing else. See `watch`.
// 600s, not the old 120s: over 50 real passes, 54% took longer than 120s (p50 126s,
// max 302s) — the old guard let go of healthy passes, and once a newer pass started
// the late one's findings were dropped on the floor. The guard only frees the slot;
// the ownership token decides who lands. Generous costs nothing when a fork is
// healthy and waits quietly when it is not.
const FORK_GIVE_UP_MS = 600_000
// After this many passes in a row with no readable verdict, say so out loud: a
// reviewer that silently stopped working is worse than none, because you think it
// is still watching.
const DEAD_PASS_ALERT = 3

// ===== 审查员的模型 =====
// $.model.fork 不能换模型——它把主线程最后一次请求原样重发(模型随主线程)。所以
// 审查员换模型走的是 $.model.complete + $.session.messages():对话自己拼,模型自选。
// 默认是 mimo-v2.6-flash(Mify ¥1/¥2,pro ¥3/¥6):pro 上一次 pass 分钟级,发现
// 总落到下一回合;flash 快,发现重新落进它正在看的回合。降噪词是在 pro 输出上
// 校准的,换模型后用 tools/measure-themes.mjs 复量。
// id 已确认:就是 Mify 代理 /v1/models 列的裸名 `mimo-v2.6-flash`(`[1m]` 只是上下文窗口
// 标记,不影响路由)。真实审查 pass 就是端到端验证:引擎若拒这个名字,会 toast「已回退
// 主模型」,敲 `reviewer <正确写法>` 一条命令即改。
const REVIEWER_DEFAULT = 'mimo-v2.6-flash'
const REVIEWER_MAIN = 'mimo'

// flash 调用失败(模型 id 不对、引擎拒发、api-error)就回退主模型 fork,并只吼一次:
// 审查员换了模型却静默失败,是最坏的一种坏法。
let fallbackSaid = false

const reviewerOf = async ($: EngineInterface): Promise<string> => {
  const v = await $.store.get('reviewer').catch(() => undefined)
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : REVIEWER_DEFAULT
}

// What is being held above nothing but the pane now (the band was cut — the pane
// carried everything it showed). The scan wants every file that writes one of these
// to name it in a const of its own; types/index.d.ts holds them to one shape.
const cards = atom({ plugin: 'mimo-supervisor', key: 'cards' } as const, null)
const snapshot = atom({ plugin: 'mimo-supervisor', key: 'snapshot' } as const, {
  mode: 'off',
  watches: false,
  why: 'not looked at yet',
  every: CHECK_EVERY,
  told: 0,
  last: '',
  raised: [],
  quietPasses: 0,
  reviewer: '',
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
  // A legacy 'auto' from the model-gated build maps to on: it meant "watch on this
  // machine", and this machine is the one it was turned up on.
  return v === 'on' || v === 'auto' ? 'on' : 'off'
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
  const named = model !== undefined ? `主会话 ${model}` : undefined

  // Only on/off in this build (the model-gated `auto` is gone). The model is still
  // named in the reply — that is how the person sees they are looking at the model
  // they meant and not some other one behind the same proxy.
  return mode === 'on'
    ? { watches: true, mode, why: named ?? '本对话已开始监视' }
    : { watches: false, mode, why: '未启动 —— 敲 /mimo-supervisor 开始' }
}

const verdictOf = async ($: EngineInterface): Promise<Verdict> => {
  if (verdict === undefined) {
    verdict = await workOut($).catch((err: unknown): Verdict => ({ watches: false, mode: 'off', why: `读不出来(${err})` }))
  }
  return verdict
}

const forget = () => {
  verdict = undefined
}

let raised: Finding[] = []
// Steps of NEW WORK since the last pass LANDED: cleared at settle (not at trigger), so
// steps that happen while a pass is out do not immediately demand another one.
let steps = 0
// Whether a pass has run this session — the delta floor below applies to chained
// checks only; the first check honours `every` exactly as the person set it.
let seenPass = false
// The pass that owns `isWatching`; a pass lets go only while it still owns it, so an
// older one coming back late cannot stop a newer one already under way.
let watchRun = 0
let isWatching = false
let promptsSinceCards = 0
// This session's count, for the status line; a hot reload starts it over.
let told = 0
let last = ''
// Consecutive passes that found nothing. Informational only — the pane shows it;
// nothing widens on it in this build.
let quietPasses = 0
// Consecutive passes that came back with nothing readable at all. A few in a row
// means the reviewer is not working, and silence is how that fails.
let deadPasses = 0

// The base interval, settable: a pass takes 11-14s to come back, so one started at
// step 6 of a turn that ends at step 7 reaches nobody in that turn. A shorter base
// starts it earlier and lands findings inside the turn it is looking at — at the price
// of more forks over the same work.
//
// A number the person picked is used as it stands — and there is no adaptive widening
// in this build at all. "Every 3 steps" means every 3 steps, empty passes included:
// the widening was an opt-in fork-saver that was never used and has been cut with the
// `interval auto` command that reached it.
let fixedEvery = CHECK_EVERY
const checkEvery = () => fixedEvery

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
    reviewer: await reviewerOf($),
  }
  await update($, snapshot, () => next).catch(() => undefined)
}

// A reload runs `register` and `session.start` again and the module's own variables
// start over; `$.state` is the host's and stays. So the session's memory is read back
// from it — otherwise a reload would make the watcher raise the same points twice and
// forget how far the checks had already stretched out. `steps` and `seenPass` are left
// out: losing them only means the first pass after a reload comes a few steps later and
// honours `every` exactly, which is the benign direction.
const load = async ($: EngineInterface) => {
  // One-time carry-over: a version that stored a single global mode is moved under
  // this directory, so the choice already made does not vanish with the upgrade.
  const legacy = await $.store.get('mode').catch(() => undefined)
  if (legacy === 'on' || legacy === 'off' || legacy === 'auto') {
    const all = await modesOf($)
    const at = await modeDir($)
    // 'auto' is the old model-gated build; it maps to on (see modeOf).
    if (all[at] === undefined) await $.store.set('modes', { ...all, [at]: legacy === 'auto' ? 'on' : legacy }).catch(() => undefined)
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
  // Absent (or the legacy 'auto' from the adaptive build, which is gone) means the
  // default — fixed at CHECK_EVERY.
  const every = await $.store.get('every').catch(() => undefined)
  fixedEvery = typeof every === 'number' && every >= 1 && every <= CHECK_EVERY_MAX ? every : CHECK_EVERY
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
  /** Which path ran the review and, on fallback, why: `complete(mimo-v2.6-flash)` or `fork(回退:…)`。 */
  via?: string
  /** A newer pass owned the state when this one came back: recorded, not delivered. */
  stale?: boolean
}

// Counters that never roll off. `history` is a sliding window and 50 entries is about
// one busy day — just past the range the "is this reviewer earning its keep" question
// lives in. Backfilled from the window the first time, so upgrading here does not start
// the totals from zero.
type Agg = {
  passes: number
  findings: number
  loud: number
  quiet: number
  empty: number
  unreadable: number
  stale: number
  msTotal: number
}

const AGG_KEYS: (keyof Agg)[] = ['passes', 'findings', 'loud', 'quiet', 'empty', 'unreadable', 'stale', 'msTotal']

const isAgg = (v: unknown): v is Agg =>
  typeof v === 'object' && v !== null && AGG_KEYS.every(k => typeof (v as Record<string, unknown>)[k] === 'number')

const ZERO_AGG: Agg = { passes: 0, findings: 0, loud: 0, quiet: 0, empty: 0, unreadable: 0, stale: 0, msTotal: 0 }

const aggOf = (a: Agg, p: Pass): Agg => {
  // Same cut as the window line: a stale pass was never delivered, so its findings are
  // not "findings raised" — they go in `stale` alone and never inflate loud/quiet.
  const found = p.stale ? null : Array.isArray(p.findings) ? p.findings : null
  return {
    passes: a.passes + (p.stale ? 0 : 1),
    findings: a.findings + (found?.length ?? 0),
    loud: a.loud + (found?.filter(f => f.severity === 'you-should-know').length ?? 0),
    quiet: a.quiet + (found?.filter(f => f.severity === 'heads-up').length ?? 0),
    empty: a.empty + (!p.stale && Array.isArray(p.findings) && p.findings.length === 0 ? 1 : 0),
    unreadable: a.unreadable + (!p.stale && !p.readable ? 1 : 0),
    stale: a.stale + (p.stale ? 1 : 0),
    // Wall-clock of delivered passes only — the same cut as `passes` above, so the
    // avg (msTotal / passes) is not pulled around by passes that were never delivered.
    msTotal: a.msTotal + (p.stale ? 0 : p.ms || 0),
  }
}

const remember = async ($: EngineInterface, entry: Pass) => {
  const old = await $.store.get('history').catch(() => [])
  const list: Pass[] = Array.isArray(old) ? (old as Pass[]) : []
  await $.store.set('history', [...list, entry].slice(-HISTORY)).catch(() => undefined)
  // The aggregate rides along: absent means "first entry since the upgrade", and the
  // window still visible is backfilled into it so the totals do not restart at zero.
  const held = await $.store.get('agg').catch(() => undefined)
  await $.store.set('agg', aggOf(isAgg(held) ? held : list.reduce(aggOf, ZERO_AGG), entry)).catch(() => undefined)
}

// Nearest-rank percentile: p90 of three samples is the largest, not the middle one.
const pct = (sorted: readonly number[], p: number) =>
  sorted.length === 0 ? 0 : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]

// What the passes have actually been worth. The usage fields come back zero on this
// gateway, so cost is only visible as wall-clock and counts — these, and not a guess,
// are what tell the person whether the reviewer earns its keep. avg alone is pulled
// around by the slowest pass, so p50/p90 stand next to it; `all-time` is the aggregate
// that outlives the 50-entry window.
export const summarize = (list: readonly Pass[], agg?: Agg): string => {
  const settled = list.filter(p => !p.stale)
  const stale = list.filter(p => p.stale).length
  const slow = list.filter(p => (p.ms || 0) > FORK_GIVE_UP_MS).length
  const window =
    list.length === 0
      ? '还没有审查记录。'
      : (() => {
          const withFind = settled.filter(p => Array.isArray(p.findings) && p.findings.length > 0)
          const items = withFind.reduce((a, p) => a + (p.findings?.length ?? 0), 0)
          const stop = withFind.reduce((a, p) => a + (p.findings ?? []).filter(f => f.severity === 'you-should-know').length, 0)
          const empty = settled.filter(p => Array.isArray(p.findings) && p.findings.length === 0).length
          const unreadable = settled.filter(p => !p.readable).length
          // 只数已投递的,与聚合同口径 —— 被作废的 pass 花了时间但没投递,
          // 它计入「被作废」,不进耗时统计。
          const times = settled.map(p => p.ms || 0).sort((a, b) => a - b)
          const avg = times.length === 0 ? 0 : Math.round(times.reduce((a, b) => a + b, 0) / times.length / 1000)
          return `最近 ${list.length} 次审查:发现 ${items} 条(其中 ${stop} 条该尽快处理)· ${empty} 次空手 · ${unreadable} 次读不出结论 · ${stale} 次被作废 · 平均 ${avg} 秒 · p50 ${Math.round(pct(times, 0.5) / 1000)} 秒 · p90 ${Math.round(pct(times, 0.9) / 1000)} 秒${slow > 0 ? ` · ${slow} 次超过看门狗` : ''}`
        })()
  if (agg === undefined || agg.passes + agg.stale === 0) return window
  const avg = agg.passes === 0 ? 0 : Math.round(agg.msTotal / agg.passes / 1000)
  return `${window}\n累计:审查 ${agg.passes} 次(作废 ${agg.stale} 次),发现 ${agg.findings} 条 —— ${agg.loud} 条该尽快处理 / ${agg.quiet} 条可稍后,${agg.empty} 次空手,平均 ${avg} 秒`
}

// ===== 自拼对话(flash 路径用)=====
type Msg = { role?: string; text?: string; toolUses?: unknown[]; toolResults?: unknown[] }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const renderTranscript = (msgs: readonly Msg[]): string => {
  const one = (m: Msg): string => {
    const parts = [`[${m.role ?? 'message'}]`]
    if (typeof m.text === 'string' && m.text.trim() !== '') parts.push(clip(m.text, 6000))
    for (const u of Array.isArray(m.toolUses) ? m.toolUses : []) {
      const t = u as { name?: string; input?: unknown; result?: unknown; text?: string }
      parts.push(`(调用 ${t.name ?? 'tool'} ${clip(JSON.stringify(t.input ?? {}), 400)})`)
      if (t.result !== undefined) parts.push(`(结果 ${clip(JSON.stringify(t.result), 1200)})`)
    }
    for (const r of Array.isArray(m.toolResults) ? m.toolResults : [])
      parts.push(`(结果 ${clip(typeof r === 'string' ? r : JSON.stringify(r), 1200)})`)
    return parts.join('\n')
  }
  const rows = msgs.map(one)
  // 单条已截过;总量还超就从中间抽条——头是用户的原始请求(读法之争都在),
  // 尾是最近的工作(该听什么都在),都留。
  const MAX = 300_000
  let total = rows.reduce((a, r) => a + r.length, 0)
  let dropped = 0
  while (rows.length > 2 && total > MAX) {
    const at = Math.floor(rows.length / 2)
    total -= rows[at].length
    rows.splice(at, 1)
    dropped++
  }
  return dropped > 0 ? [...rows.slice(0, rows.length / 2), `[中间省略 ${dropped} 条消息]`, ...rows.slice(rows.length / 2)].join('\n\n') : rows.join('\n\n')
}

// 一次审查请求:默认 flash(complete 自拼对话),`reviewer mimo` 回到 fork(主模型,
// 缓存前缀)。flash 侧的失败一律回退 fork——审查员换了模型却静默坏掉是最坏的坏法。
// 同一个模型的几种 id 形态:引擎的白名单和代理的路由可能各认一种写法
// (裸名 / xiaomi/ 前缀 / [1m] 后缀)。首个跑通的胜出,并回写 store——
// 以后直接用它,不再每次试。
const idVariants = (m: string): string[] => {
  const out = [m]
  if (!m.includes('/')) out.push(`xiaomi/${m}`)
  if (!m.includes('[')) {
    out.push(`${m}[1m]`)
    if (!m.includes('/')) out.push(`xiaomi/${m}[1m]`)
  }
  return [...new Set(out)]
}

const runReview = async ($: EngineInterface, prompt: string): Promise<{ reply: Awaited<ReturnType<EngineInterface['model']['fork']>> | Awaited<ReturnType<EngineInterface['model']['complete']>>; via: string }> => {
  const model = await reviewerOf($)
  if (model === REVIEWER_MAIN) return { reply: await $.model.fork({ prompt }), via: 'fork(主模型)' }

  const transcript = await $.session.messages().then(m => (Array.isArray(m) ? renderTranscript(m as Msg[]) : Promise.reject(new Error('transcript 被拒')))).catch((err: unknown) => {
    say($, `transcript 读取失败(${err})`)
    return null
  })
  const errors: string[] = []
  if (transcript !== null) {
    for (const id of idVariants(model)) {
      try {
        const reply = await $.model.complete({
          model: id,
          // 对话在前且标缓存:它随会话只增不改头,共享前缀命中;审查指令在后,
          // 每次随已提清单变化,不标缓存。
          prompt: [{ text: transcript, cache: true }, { text: prompt }],
        })
        if (reply.isAnswered || reply.reason !== 'api-error') {
          if (id !== model) await $.store.set('reviewer', id).catch(() => undefined) // 记住跑通的形态
          return { reply, via: `complete(${id})` }
        }
        errors.push(`${id}: api-error ${(reply as { status?: number }).status ?? ''}`.trim())
      } catch (err) {
        errors.push(`${id}: ${err}`)
      }
    }
  } else {
    errors.push('transcript 被拒')
  }
  // 全败:回退主模型 fork。失败原因进 history(via),log 里看得见——
  // 回退提示只弹一次,不能只靠它。
  const why = errors.join(' | ')
  say($, `reviewer ${model} 全部形态失败(${why}),回退主模型`)
  if (!fallbackSaid) {
    fallbackSaid = true
    $.ui.toast(`mimo-supervisor:审查员 ${model} 调用失败(${why}),已回退主模型。/mimo-supervisor reviewer 可改。`)
  }
  return { reply: await $.model.fork({ prompt }), via: `fork(回退:${why})` }
}

// One pass over the work so far. It runs beside the turn, never in its way: the
// items reach the model as a note it reads at its next step, and the pane shows the
// person the same items.
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
    const prompt = watchPrompt(raised, {
      learned: sentences(learned),
      dismissed: sentences(dismissed),
      appreciated: sentences(appreciated),
    })
    const { reply, via } = await runReview($, prompt)
    const at = await $.clock.now()
    // The guard let go and a newer pass already owns the state: this one's findings are
    // NOT delivered — a late note would collide with the newer pass's — but the pass is
    // recorded, stale flag and all. Dropping it silently is how the numbers lied before:
    // history only ever held passes that happened to still be newest.
    if (run !== watchRun) {
      const late = reply.isAnswered ? parseFindings(reply.text) : null
      await remember($, { at, ms: at - startedAt, findings: late, usage: reply.usage, readable: late !== null, stale: true, via }).catch(() => undefined)
      say($, `stale pass recorded (${at - startedAt}ms); a newer one owned the state`)
      return
    }

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
    await remember($, { at, ms: at - startedAt, findings, usage: reply.usage, readable: findings !== null, via })
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
      // Informational only (the pane shows it); nothing widens on it in this build.
      quietPasses += 1
      return
    }
    quietPasses = 0

    raised = [...raised, ...findings].slice(-RAISED_KEPT)
    told += findings.length
    last = hhmm(at) // 面板行是「最近一次 15:59」,只放时间才读得顺
    promptsSinceCards = 0
    await update($, cards, () => ({ at, items: findings }))
    // Refused or failed, the items are still held in the pane: say so, so the person can pass
    // them on. A refused append RESOLVES to { deny } rather than rejecting, so the
    // result is read and the rejection path is caught as well: either way the person
    // hears about it.
    const note = await $.session
      .append({ message: { type: 'user', content: [{ type: 'text', text: noteText(findings) }] } })
      .catch((err: unknown) => ({ deny: String(err) }))
    if (note.deny !== undefined) {
      say($, `note not delivered (${note.deny})`)
      $.ui.toast('mimo-supervisor:提醒没能送到模型;内容还在提示框上方那栏。')
    }
  } catch (err) {
    say($, `watch failed: ${err}`)
  } finally {
    guard?.cancel()
    if (run === watchRun) {
      isWatching = false
      // The counter measures work since the last review LANDED, and it lands here — so
      // it is cleared here. Steps that ran while this pass was out are covered by the
      // review that just landed (or were the wave it was already poking at); counting
      // them again is what used to chain back-to-back passes over one wave of work.
      steps = 0
      // Safe to do here, unlike the old status line: this writes an atom and draws
      // nothing, so a pass settling after the turn has ended leaves no mark.
      await refresh($)
    }
  }
}

export const register: Register = on => {
  registerPane(on)

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command
      .register({
        name: 'mimo-supervisor',
        description: '开始监视这个对话:审查员每几步看一眼工作,把注意到的事告诉模型和你。裸命令开始,off 停止。',
        argumentHint: '[off|log|interval <n>|undo <n>|reviewer [flash|mimo|<id>]]',
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
    // A new conversation is a fresh stream of work: its first check honours `every`
    // exactly, the delta floor only chaining the checks after it. (A reload mid-session
    // lands here too and loses the count — the benign direction, see `load`.)
    steps = 0
    seenPass = false
    await refresh($)
    return result
  })

  // The person's prompts age the held items, as they age "You should know" cards — and are
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
              ? 'mimo-supervisor:面板上现在没有条目可回应 —— 要等审查先发现东西。'
              : `mimo-supervisor:指哪条?用 \`learn 1\` 或 \`learn "…"\`(引号引用原话)。面板上有 ${items.length} 条。`,
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
              ? `mimo-supervisor:已关闭 ${answer.targets.length} 条 —— 不会再提。`
              : answer.kind === 'dismissed'
                ? `mimo-supervisor:${answer.targets.length} 条标为不相关,不再提。`
                : `mimo-supervisor:收到 —— 同类的会多提醒。`,
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
    // The delta gate: a chained check also needs MIN_NEW_STEPS of new work since the
    // last pass LANDED (the counter clears at settle, not at trigger). Without it, a
    // slow pass followed by an instant one means two passes poking at one wave of work
    // — back-to-back findings about the same cleanup. The first pass of a session is
    // untouched and still fires at `every`.
    const need = seenPass ? Math.max(every, MIN_NEW_STEPS) : every
    if (steps >= need && !isWatching && (await verdictOf($)).watches) {
      seenPass = true
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
    const raw = e.args.trim()
    const arg = raw.toLowerCase()

    if (arg === 'log') {
      const list = await $.store.get('history').catch(() => [])
      const arr = Array.isArray(list) ? (list as Pass[]) : []
      const agg = await $.store.get('agg').catch(() => undefined)
      const parts: string[] = []
      if (arr.length > 0)
        parts.push(`${summarize(arr, isAgg(agg) ? agg : undefined)}\n\nlast ${Math.min(arr.length, 10)}:\n${JSON.stringify(arr.slice(-10), null, 1)}`)
      // The three closed lists, one numbering across them — that numbering is what
      // `undo <n>` points at. The lists are the only memory of "stop offering this",
      // so they live where the person looks for what the watcher has been doing.
      const closed = { learned: await readKind($, 'learned'), dismissed: await readKind($, 'dismissed'), appreciated: await readKind($, 'appreciated') }
      const total = closedCount(closed)
      if (total > 0) {
        // 与 `dropAt` 同一排序(旧的在前)——两边不能不一致,否则 `undo <n>`
        // 放出的不是 log 上显示的那条。
        const TAG: Record<string, string> = { learned: '不再提', dismissed: '不相关', appreciated: '想多来' }
        const rows = closedRows(closed).map((r, i) => `${i + 1}. [${TAG[r.kind]}] ${r.entry.what}`)
        parts.push(`已关掉的(旧的在前 —— undo <n> 放出):\n${rows.join('\n')}`)
      }
      return { text: parts.length > 0 ? parts.join('\n\n') : '还没有审查记录。' }
    }

    // The one undo: `undo <n>` reopens a closed item, whichever of the three lists it
    // sits in (the numbering is the one `log` prints). Closing itself happens the
    // natural way — `learn 1` / `dismiss 1` / `more like 1` in the next thing typed.
    const undo = /^undo\s+(\d+)$/.exec(arg)
    if (undo) {
      const held = {
        learned: await readKind($, 'learned'),
        dismissed: await readKind($, 'dismissed'),
        appreciated: await readKind($, 'appreciated'),
      }
      const hit = dropAt(held, Number(undo[1]) - 1)
      if (hit === undefined) return { text: `没有第 ${undo[1]} 条(已关 ${closedCount(held)} 条,log 可看)。` }
      await writeKind($, hit.kind, hit.next)
      // 同一句还要从 `raised` 里摘掉:<already-raised> 会继续压着它,
      // 不摘的话「它会被再次提醒」就是审查员不会兑现的空话。
      raised = raised.filter(f => f.what !== hit.entry.what)
      await refresh($)
      return { text: `已放出:${hit.entry.what}\n它会被再次提醒。` }
    }

    // 审查员用哪个模型。默认 flash(complete 自拼对话);`reviewer mimo` 回到
    // fork(主模型+缓存前缀);也可以直接给完整 id 换别的。
    // id 大小写敏感,这条从 raw 解析、id 原样取用,不走 arg 的小写化。
    const reviewer = /^reviewer(?:\s+(.+))?$/i.exec(raw)
    if (reviewer) {
      const want = (reviewer[1] ?? '').trim()
      if (want === '') {
        const now = await reviewerOf($)
        return {
          text: `审查员模型:${now}${now === REVIEWER_MAIN ? '(fork,用主模型和缓存前缀)' : '(complete 自拼对话)'}。切换:/mimo-supervisor reviewer flash|mimo|<模型id>`,
        }
      }
      const low = want.toLowerCase()
      const to = low === REVIEWER_MAIN ? REVIEWER_MAIN : low === 'flash' ? REVIEWER_DEFAULT : want
      await $.store.set('reviewer', to).catch(() => undefined)
      fallbackSaid = false
      return { text: `审查员模型已切到:${to}${to === REVIEWER_MAIN ? '(fork,主模型)' : ''}。` }
    }

    // The interval. Lower it and the review starts earlier in a turn; raise it and
    // fewer forks are spent over the same work. The number is used as it stands —
    // there is no adaptive widening in this build (the person said fixed and meant it).
    const interval = /^interval\s+(\d+)$/.exec(arg)
    if (interval) {
      const n = Number(interval[1])
      if (n < 1 || n > CHECK_EVERY_MAX) return { text: `请选 1 到 ${CHECK_EVERY_MAX}。` }
      fixedEvery = n
      await $.store.set('every', n).catch(() => undefined)
      await refresh($)
      return { text: `每 ${n} 步新工作检查一次(从上次检查落地算起)。连续两次检查之间至少要 ${MIN_NEW_STEPS} 步新工作,免得背靠背戳同一波活。` }
    }

    // The bare command is the switch: this is what turns the watching on, the way a
    // statusline sits installed until you set it up. It holds for this conversation
    // only.
    if (arg === '' || arg === 'off') {
      // The bare command is `on`; there is no `on`/`auto` spelling to keep straight.
      const chosen: Mode = arg === '' ? 'on' : 'off'
      await setMode($, chosen)
      forget()
      quietPasses = 0
      if (!(await verdictOf($)).watches) await update($, cards, () => null)
      await refresh($)
      const v = await verdictOf($)
      // Only once the watching is actually on. Typing `off` stops it and must not pop
      // a pane at the person — a dormant session shows nothing at all.
      if (v.watches) await $.ui.open({ id: PANE, title: 'mimo-supervisor' }).catch(err => say($, `pane not opened: ${err}`))
      // What the passes have been worth rides the reply the person actually types:
      // the switch is this command's main surface, and cost-invisible (usage is zeros
      // on this gateway) is the failure mode that lets a reviewer coast unnoticed.
      const hist = await $.store.get('history').catch(() => [])
      const agg = await $.store.get('agg').catch(() => undefined)
      const stats = summarize(Array.isArray(hist) ? (hist as Pass[]) : [], isAgg(agg) ? agg : undefined)
      // The stats are two lines (window + all-time); they stand on their own below the
      // sentence rather than being spliced into its middle.
      return {
        text:
          arg === ''
            ? `已开始监视这个对话。${v.why}。停用:/mimo-supervisor off。\n${stats}`
            : `已停止 —— 这个对话不再审查。\n${stats}`,
      }
    }

    const v = await verdictOf($)
    const hist = await $.store.get('history').catch(() => [])
    const agg = await $.store.get('agg').catch(() => undefined)
    const stats = summarize(Array.isArray(hist) ? (hist as Pass[]) : [], isAgg(agg) ? agg : undefined)
    return {
      text: `mimo-supervisor:${v.watches ? '监视中' : '已停止'}(${v.why})${v.watches ? `,每 ${checkEvery()} 步新工作检查一次` : ''}。命令:/mimo-supervisor 开始 · off 停止 · log 看记录和已关清单 · interval <n> 设间隔 · undo <n> 放出一条 · reviewer 看/换审查员模型。在消息里回应面板:learn 1 知道了 · dismiss 1 不相关 · more like 1 多来点 · learn all 全部关掉。\n${stats}`,
    }
  })
}
