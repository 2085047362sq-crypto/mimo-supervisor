import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { closedRows, dropAt, looksLikeAnswer, parseAnswer } from '../hooks/feedback'
import { MAX_ITEMS, noteText, parseFindings, watchPrompt } from '../hooks/prompt'
import { summarize } from '../hooks/register'

const SEEN = {
  what: 'You wrote "5 = 5%" before asking which the user meant',
  evidence: 'apply_discount(total, 5) → total * 0.95',
  cost: 'if the user meant 5 off, the whole turn is redone',
  severity: 'you-should-know' as const,
}
const SEEN2 = { what: 'second', evidence: 'e2', cost: 'c2', severity: 'heads-up' as const }
const SEEN3 = { what: 'third', evidence: 'e3', cost: 'c3', severity: 'heads-up' as const }
const usage = { input_tokens: 300, output_tokens: 80, cache_read_input_tokens: 90000, cache_creation_input_tokens: 0 }

// The world beneath the mod: a session with a step loop and a fork that answers
// what `answer` says. The kit has no store beneath a plugin's session.append (it
// reports "no implementation"), so the note itself is tested through noteText;
// here a failed delivery must reach the person as a toast.
//
// `model` is what the session is pointed at and `baseUrl` is where it sends it. The
// two come apart on purpose: this machine runs mimo through a local proxy whose URL
// names no model at all, so the watcher has to read the model id to know what it is.
const world = (on: Parameters<TestBody>[1]) => {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 6, 2, 0) })
  const forks: string[] = []
  const toasts: string[] = []
  const notes: string[] = []
  const statuses: (string | undefined)[] = []
  const opens: string[] = []
  const state = {
    answer: JSON.stringify({ findings: [SEEN] }),
    baseUrl: 'http://127.0.0.1:18080/anthropic' as string | undefined,
    model: 'xiaomi/mimo-v2.6-pro[1m]' as string | undefined,
    // What /model shows, which is what the watcher trusts first: it reflects a model
    // passed as --model at launch, which no environment variable records.
    liveModel: 'xiaomi/mimo-v2.6-pro[1m]' as string | undefined,
    // The project root: what the on/off choice is remembered against, so one project
    // watched and another not do not interfere.
    root: 'C:\\work\\alpha' as string,
    // A fork that never answers. $.model.fork's request takes no timeoutMs, so this
    // is the case only the watcher's own guard can let go of.
    hang: false,
    // A fork that answers only when the test releases it — the late-comer case, where
    // the guard lets go and a newer pass starts before this one's reply arrives.
    late: false,
    // A fork that answers with no usable reply at all — api-error, aborted, or
    // nothing-to-fork. The reason says which.
    noAnswer: undefined as undefined | string,
    // Refuse the note instead of keeping it: the documented way to turn a plugin's own
    // append away is to answer with { deny } in place of next, and nothing is stored.
    refuseNote: false,
    // The reviewer's own model call fails (bad model id, engine refusal, api-error) —
    // the pass must fall back to the main model and say so.
    completeFail: false,
  }
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    // The raw text: a clear passes undefined, and a clear is the only call allowed.
    statuses.push((e as { text?: string }).text)
    return { value: undefined }
  })
  // The kit has no pane; a pane that will not seat is logged and carried on from.
  on('ui.open', (_$, e) => {
    opens.push(String((e as { id?: string }).id ?? ''))
    return { value: { isPlaced: true } } as never
  })
  on('ui.toast', (_$, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('env.get', (_$, e) => ({ value: e.name === 'ANTHROPIC_BASE_URL' ? state.baseUrl : state.model }) as never)
  on('session.model', () => ({ value: state.liveModel }) as never)
  on('session.root', () => ({ value: state.root }) as never)
  const lateReplies: ((v: unknown) => void)[] = []
  // The reviewer now runs on its own model over `$.model.complete`, with the
  // conversation assembled from `$.session.messages()`; the fork is the fallback
  // path. Both feed the same `forks` list (it counts review prompts however they
  // were sent), while `completes`/`forkCalls` keep the paths apart for the tests
  // that pin which one ran.
  const completes: { model: string; prompt: string }[] = []
  const forkCalls: string[] = []
  const reply = () => {
    if (state.hang) return new Promise(() => undefined) as never
    if (state.late) return new Promise((res) => lateReplies.push(res as never)) as never
    if (state.noAnswer !== undefined) return { value: { isAnswered: false, reason: state.noAnswer } } as never
    return { value: { isAnswered: true, text: state.answer, usage } } as never
  }
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    forkCalls.push(e.prompt)
    return reply() as never
  })
  on('model.complete', (_$, e) => {
    const req = e as { model?: string; prompt?: string | { text: string }[] }
    const text = typeof req.prompt === 'string' ? req.prompt : (req.prompt ?? []).map(b => b.text).join('\n')
    completes.push({ model: req.model ?? '', prompt: text })
    forks.push(text)
    if (state.completeFail) return { value: { isAnswered: false, reason: 'api-error', status: 500 } } as never
    return reply() as never
  })
  // The conversation the reviewer reads on the complete path: canned, but with real
  // text and a tool use so the transcript rendering has both shapes to carry.
  on('session.messages', () => ({
    value: [
      { role: 'user', text: '帮我看看折扣该怎么算' },
      { role: 'assistant', text: '我来查一下。', toolUses: [{ name: 'Read', input: { file: 'a.ts' }, result: '文件内容' }] },
    ],
  }) as never)
  // The note is what the model reads at its next step, so what actually landed is
  // worth asserting on. A hook relays the row with next(e); answering with { deny } in
  // its place refuses a plugin's own append and nothing is stored, which is how the
  // delivery can be made to fail on purpose.
  on('session.append', async ($, e, next) => {
    const text = (e as { message?: { content?: { text?: string }[] } }).message?.content?.[0]?.text ?? ''
    if (state.refuseNote) return { deny: 'refused by the test' } as never
    notes.push(text)
    return next(e) as never
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null } as never
  })
  // What the engine draws above the prompt when the band has nothing: an empty box.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as never
  })
  on('session.start', () => ({ cwd: '/' }))
  return {
    clock,
    forks,
    forkCalls,
    completes,
    toasts,
    notes,
    statuses,
    opens,
    state,
    // Let every waiting (late) fork answer now, with whatever `state.answer` holds.
    releaseLate: () => {
      while (lateReplies.length > 0) lateReplies.shift()!({ value: { isAnswered: true, text: state.answer, usage } })
    },
  }
}

// The plugin sits dormant until asked. This is what asks: the bare command is the
// switch, and it holds for the conversation it was typed in.
const start = ($: Parameters<TestBody>[0], mode = '') => $.command.run({ command: 'mimo-supervisor', args: mode } as never)

const steps = async ($: Parameters<TestBody>[0], n: number, agentId?: string) => {
  for (let i = 0; i < n; i++) {
    const s = $.turn.step({ turnId: 't1', index: i, model: 'xiaomi/mimo-v2.6-pro[1m]', messageCount: 3, ...(agentId === undefined ? {} : { agentId }) } as never)
    for await (const _ of s) void _
  }
}

// The pane is the only surface now (the band above the prompt was cut — the pane
// carried everything it showed, and the person said so).
const mountPane = ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'mimo-supervisor', surface, component: 'Pane', requestId: 'mimo-supervisor', props: { viewport: { rows: 24, columns: 80 } } } as never)

test('parses fenced, empty and malformed replies, and never keeps more than it promised', async () => {
  expect(parseFindings('```json\n' + JSON.stringify({ findings: [SEEN] }) + '\n```')?.length).toBe(1)
  expect(parseFindings('{"findings": []}')).toEqual([])
  expect(parseFindings('{"findings": [{"what": "no evidence", "evidence": ""}]}')).toEqual([])
  expect(parseFindings('{"verdict": "ok"}')).toBeNull()
  expect(parseFindings('not json')).toBeNull()
  // The prompt says at most 2; the parser used to keep 3, so a loud pass could
  // land one more than it told anyone about.
  expect(parseFindings(JSON.stringify({ findings: [SEEN, SEEN2, SEEN3] }))?.length).toBe(MAX_ITEMS)
  expect(MAX_ITEMS).toBe(2)
})

// Severity is honoured as written. Only an explicit loud marker is loud; a quiet marker
// and a missing field both stay quiet. This is deliberate: the prompt reserves the loud
// kind and asks for a severity every time, and the old "anything not `heads-up` is loud"
// default is exactly how severity inflation crept back in through the parser.
test('an explicit quiet marker is quiet; a missing severity is still loud, never buried', async () => {
  // One finding at a time: parseFindings caps at MAX_ITEMS and sorts, which would drop
  // later items and hide what is being asserted here.
  const sev = (severity?: string) =>
    parseFindings(JSON.stringify({ findings: [severity === undefined ? { what: 'w', evidence: 'e', cost: 'c' } : { what: 'w', evidence: 'e', cost: 'c', severity }] }))?.[0]?.severity
  expect(sev('heads-up')).toBe('heads-up')
  expect(sev('low')).toBe('heads-up') // an explicit quiet marker is honoured as quiet
  expect(sev('you-should-know')).toBe('you-should-know')
  expect(sev('urgent')).toBe('you-should-know')
  expect(sev(undefined)).toBe('you-should-know') // silence stays loud — never bury a real problem
  expect(noteText([SEEN])).toContain('[you-should-know]')
})

// The two seats go to the two that matter most, not to whichever the reviewer wrote
// first. Without this, two things that could wait crowd out the one worth stopping
// for — the exact outcome the two severities exist to prevent.
test('a loud item keeps its seat when quiet ones come first', async () => {
  const quiet = JSON.stringify({ what: 'a', evidence: 'e', cost: 'c', severity: 'heads-up' })
  const loud = JSON.stringify({ what: 'b', evidence: 'e', cost: 'c', severity: 'you-should-know' })
  const parsed = parseFindings(`{"findings": [${quiet}, ${quiet}, ${loud}]}`)
  expect(parsed?.length).toBe(2)
  expect(parsed?.[0].what).toBe('b') // the loud one is kept, and first
  expect(parsed?.[0].severity).toBe('you-should-know')
})

test('the note the model reads is labelled as not from the user, and says what to do', async () => {
  const note = noteText([SEEN])
  expect(note).toContain('[mimo-supervisor]')
  expect(note).toContain('(not the user)')
  expect(note).toContain(SEEN.what)
  expect(note).toContain('tell the user in one line')
  expect(note).toContain('not an instruction from the user')
})

test('every 3 steps of the main loop a side pass looks at the work, and the band shows what it found', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)

  await steps($, 2)
  await steps($, 4, 'sub-1') // a subagent's steps are its own
  await w.clock.advance(10)
  expect(w.forks.length).toBe(0)

  await steps($, 1)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)
  expect(w.forks[0]).toContain('The user reads the final answers')
  // What reached the model is the reviewer's note, carrying the item and its evidence.
  expect(w.notes.length).toBe(1)
  expect(w.notes[0]).toContain('[mimo-supervisor]')
  expect(w.notes[0]).toContain('5 = 5%')
  expect(w.toasts.length).toBe(0)

  // The person sees the item in the pane — on both surfaces (the band above the
  // prompt was cut; the pane carried everything it showed).
  for (const surface of ['terminal', 'desktop'] as const) {
    const drawn = await mountPane($, surface)
    expect(await drawn.find({ text: /^正在提醒 1 条/ })).toBeDefined()
    expect(await drawn.find({ text: /5 = 5%/ })).toBeDefined()
    // And the pane is deliberately bare: no buttons to press. Answering happens by
    // typing (`learn 1` and friends), and the held items age out after two prompts.
    expect(await drawn.find({ key: 'hide' })).toBeUndefined()
  }
})

// (The band used to have a Hide button and a `show` command to undo it. Both are cut:
// the band clears itself after two of the person's prompts or on the next finding —
// 'the band clears after two prompts from the person' pins that.)

// Nothing at all goes through $.ui.status. The host draws a status text with a warning
// glyph in front of it and offers no way to ask for one without, and that glyph is what
// read as an error; the watcher's state is drawn in a pane instead. If a status call
// creeps back in, the glyph comes back with it.
test('nothing is drawn through the status line', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  await $.prompt.submit({ text: 'more work', wait: false, origin: { kind: 'composer' } } as never)
  await steps($, 6)
  await w.clock.advance(10)
  await $.command.run({ command: 'mimo-supervisor', args: 'log' } as never)
  await $.command.run({ command: 'mimo-supervisor', args: 'on' } as never)

  // A clear may go through — it is what drops the row an older build left on screen —
  // but nothing may carry text: that is the call the host marks with a warning glyph.
  expect(w.statuses.length).toBeGreaterThan(0)
  expect(w.statuses.every(t => t === undefined)).toBe(true)
})

// The pane is where the state went, and it carries what the band leaves out: the
// evidence and cost behind each item.
test('the pane draws the watcher state and the evidence behind each item', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  const pane = await $.ui.mount({
    plugin: 'mimo-supervisor',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'mimo-supervisor',
    props: { viewport: { rows: 24, columns: 80 } },
  } as never)
  expect(await pane.find({ text: /监视中/ })).toBeDefined()
  expect(await pane.find({ text: /mimo-v2\.6-pro/ })).toBeDefined()
  // The reviewer's own model is shown apart from the session's — they are two models.
  expect(await pane.find({ text: /审查员 mimo-v2\.6-flash/ })).toBeDefined()
  expect(await pane.find({ text: /报出 1 条/ })).toBeDefined()
  expect(await pane.find({ text: /5 = 5%/ })).toBeDefined()
  expect(await pane.find({ text: /证据:/ })).toBeDefined()
})

// The one path the kit used to make unreachable: a note refused on its way to the model
// still has to reach the person, since the band is drawn whatever happens to the note.
test('a note that is refused still reaches the person', async ($, on) => {
  const w = world(on)
  w.state.refuseNote = true
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 6)
  await w.clock.advance(10)

  expect(w.forks.length).toBe(1)
  expect(w.notes.length).toBe(0) // nothing was stored
  expect(await (await mountPane($)).find({ text: /^正在提醒 1 条/ })).toBeDefined()
  expect(w.toasts.at(-1)).toContain('没能送到模型')
})

// A shorter interval starts the review earlier in a turn, so it stands a better chance
// of coming back while that turn is still running and reaching it.
test('the interval the person sets counts, and the chain floor sits on top of it', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  const set = await $.command.run({ command: 'mimo-supervisor', args: 'interval 5' } as never)
  expect(set.text).toContain('每 5 步')
  expect(set.text).toContain('至少要 6') // the floor is disclosed in the reply, not silent

  await steps($, 5) // the first check: exactly at the interval the person picked
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  // A chained check needs MIN_NEW_STEPS of new work since the last one LANDED. Here
  // the floor (6) is larger than the interval (5), so five steps do not reach — that
  // is the disclosed wrinkle, not a quiet widening of the interval itself.
  await steps($, 5)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)
  await steps($, 1)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
})

test('an interval outside 1..24 is refused', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'interval 0' } as never)).text).toContain('请选 1 到 24')
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'interval 99' } as never)).text).toContain('请选 1 到 24')
})

// A number the person picks is used as it stands, and empty passes never move it.
// There is no adaptive widening in this build at all (the `interval auto` command and
// the doubling behind it were cut): "every 3 steps" means the first check at exactly 3
// and the chained ones at the chain floor (6 of new work, disclosed in the reply and
// the README) — same cadence whether the passes find things or nothing.
test('empty passes do not move the interval', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await $.command.run({ command: 'mimo-supervisor', args: 'interval 3' } as never)
  w.state.answer = '{"findings": []}'

  for (let round = 0; round < 5; round++) {
    await steps($, round === 0 ? 3 : 6) // first at exactly 3; chained at the floor
    await w.clock.advance(10)
    expect(w.forks.length).toBe(round + 1) // same cadence every round, no stretching
  }
})

// A reload re-runs `register` and `session.start` and the module's own variables start
// over; `$.state` is the host's and stays. The pane draws from state, so what it shows
// is what a pass wrote there for the next load to find. (`load()` itself cannot be
// exercised here: the kit cannot unload the module, so its variables never start over
// mid-test. The write half is what can go wrong silently, and that is what is pinned.)
test('a pass leaves the session memory in state for the next load', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1) // raised SEEN, so nothing is quiet yet

  w.state.answer = '{"findings": []}'
  await steps($, 6) // chained: the floor is 6
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2) // the second pass found nothing

  const pane = await $.ui.mount({
    plugin: 'mimo-supervisor',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'mimo-supervisor',
    props: { viewport: { rows: 24, columns: 80 } },
  } as never)
  // `1 remembered` is `raised` reaching state; `1 quiet pass` is `quietPasses` getting
  // there. `every 3` is the fixed interval — the widening only happens under
  // `interval auto`, so a quiet pass does not move this number by default.
  expect(await pane.find({ text: /去重记忆 1 条/ })).toBeDefined()
  expect(await pane.find({ text: /连续空审查 1 次/ })).toBeDefined()
  expect(await pane.find({ text: /每 3 步新工作检查一次/ })).toBeDefined()
})

// A note can be refused on its way to the model: the kit takes { deny } in place of
// next and stores nothing, which is what the test above exercises.

test('one pass at a time, and what it already said is not said again', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)

  await steps($, 6) // a pass is started…
  await steps($, 12) // …and while it is out, no second one is
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  w.state.answer = '{"findings": []}'
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
  expect(w.forks[1]).toContain('<already-raised>')
  expect(w.forks[1]).toContain('5 = 5%')
  // Only the sentence is re-sent. The evidence and cost of an old item are not: the
  // block rides the fork's prompt, appended to the whole transcript, so carrying
  // them would be paid again on every later pass. Without this, swapping raisedLines
  // back for asLines keeps every other test green and quietly re-inflates the prompt.
  expect(w.forks[1]).not.toContain(SEEN.evidence)
  expect(w.forks[1]).not.toContain(SEEN.cost)
})

test('the held items age out after two prompts from the person', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 6)
  await w.clock.advance(10)

  const prompt = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  // One mount, re-read after each change: the pane is a single surface instance.
  const pane = await mountPane($)
  await prompt('first')
  expect(await pane.find({ text: /^正在提醒 1 条/ })).toBeDefined()
  await prompt('second')
  expect(await pane.find({ text: /^正在提醒/ })).toBeUndefined()
})

test('an unreadable or empty verdict shows nothing', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  w.state.answer = 'I think it is fine'
  await steps($, 6)
  await w.clock.advance(10)
  w.state.answer = '{"findings": []}'
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
  expect(await (await mountPane($)).find({ text: /^正在提醒/ })).toBeUndefined()
  expect(w.toasts.length).toBe(0)
})

test('turning it off clears the held items and stops the passes', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 6)
  await w.clock.advance(10)
  const pane = await mountPane($)
  expect(await pane.find({ text: /^正在提醒 1 条/ })).toBeDefined()

  await $.command.run({ command: 'mimo-supervisor', args: 'off' } as never)
  expect(await pane.find({ text: /^正在提醒/ })).toBeUndefined()
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)
})

// (The model-gated `auto` mode is gone — it ran only for mimo and its command was cut
// with it. What survives of the model detection is the naming: the reply tells the
// person which model is being watched, and /model wins over the environment.)

// The model /model shows is the truth; the environment is only what it was set from.
// `--model` at launch changes the first and not the second, so the first has to win —
// and the reply must name it, so the person can see they are looking at the model
// they meant and not another one behind the same proxy.
test('the reply names the model /model shows, not what the environment claims', async ($, on) => {
  const w = world(on)
  w.state.model = 'env-claims-this-model'
  w.state.liveModel = 'xiaomi/mimo-v2.6-pro[1m]'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const first = await start($)
  expect(first.text).toContain('xiaomi/mimo-v2.6-pro[1m]')
  expect(first.text).not.toContain('env-claims-this-model')

  // With /model silent, the environment is the fallback and gets named instead.
  w.state.liveModel = undefined
  await $.command.run({ command: 'mimo-supervisor', args: 'off' } as never)
  const second = await start($)
  expect(second.text).toContain('env-claims-this-model')

  // And with nothing named anywhere — no /model, no environment — the reply says so
  // rather than inventing a name.
  w.state.model = undefined
  await $.command.run({ command: 'mimo-supervisor', args: 'off' } as never)
  const third = await start($)
  expect(third.text).toContain('本对话已开始监视')
})

// (The endpoint fallback of the old `auto` mode is gone with it: the watch/no-watch
// decision no longer looks at ANTHROPIC_BASE_URL at all. The verdict is still worked
// out once per prompt rather than once per step.)

// (Two widening tests were here — 'a run of passes that find nothing spreads the
// checks out' and 'a pass with something to say puts the checks back to the base
// interval'. The widening is gone in this build; 'empty passes do not move the
// interval' pins the replacement behaviour.)

// $.model.fork's request takes no timeoutMs, so a fork that never comes back is let
// go of by nothing but the watcher's own guard. Without it the gate stays shut and
// every later pass is skipped for the rest of the session, silently.
// The whole point of the thing: installed and its command always there, but a
// conversation that never asks is never watched — no pass, no cost, no note. Typing
// the bare command is the switch, and it holds for that conversation alone.
test('nothing runs until the person asks for it', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(0) // dormant
  expect(w.notes.length).toBe(0)

  const asked = await start($)
  expect(asked.text).toContain('已开始监视')
  // Which model, not just "on": the person has to be able to see they are looking at
  // the one they meant, not a different model behind the same proxy.
  expect(asked.text).toContain('mimo-v2.6-pro')

  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)
})

test('off stops it again', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  const opened = w.opens.length
  await start($, 'off')
  // Stopping it must not pop a pane at the person: a dormant session shows nothing.
  expect(w.opens.length).toBe(opened)

  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1) // still just the one
})

// The choice is remembered, so someone who has turned it on once does not type the
// command again in every conversation that follows. Each conversation's first prompt
// is what re-reads it — the verdict is cached until then, exactly as it is in a real
// session where a new conversation starts with no cached verdict at all.
test('the choice carries into the next conversation', async ($, on) => {
  const w = world(on)
  const prompt = () => $.prompt.submit({ text: 'work', wait: false, origin: { kind: 'composer' } } as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await prompt()
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  // A second conversation on the same store: no command typed, and it is already on.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await prompt()
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)

  // `off` carries just as well.
  await start($, 'off')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await prompt()
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
})

// The choice is remembered per working directory, so one project can be watched and
// the next not without the two interfering. The project root is the identifier, and it
// is compared case- and separator-insensitively — `C:\Work\ALPHA` and `c:/work/alpha/`
// are the same project. Each new conversation starts with no cached verdict, so a
// prompt stands in for that here.
test('each working directory keeps its own choice', async ($, on) => {
  const w = world(on)
  const prompt = () => $.prompt.submit({ text: 'work', wait: false, origin: { kind: 'composer' } } as never)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($) // alpha on
  await prompt()
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  // A different project that never asked for anything.
  w.state.root = 'C:\\work\\beta'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await prompt()
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1) // beta dormant

  await start($, 'off') // beta off, which must not reach alpha

  // Back to alpha, spelled differently — same project, still on.
  w.state.root = 'c:/work/ALPHA/'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await prompt()
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
})

// "I know about this one — stop telling me." What the person closes is not the same as
// what has been raised: raised means the reviewer may still repeat it if it got worse,
// while closed is done and must not come back in any wording.
// The two severities are drawn apart — `!` and bold against `~` and dimmed — so a real
// problem is not lost among three that could wait. If this is ever dropped, the field
// is parsed and then drawn exactly the same, which is the same as not having it.
test('the two severities are drawn apart in the pane', async ($, on) => {
  const w = world(on)
  w.state.answer = JSON.stringify({ findings: [{ ...SEEN, severity: 'you-should-know' }, { ...SEEN2, severity: 'heads-up' }] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  const pane = await $.ui.mount({
    plugin: 'mimo-supervisor',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'mimo-supervisor',
    props: { viewport: { rows: 24, columns: 80 } },
  } as never)
  expect(await pane.find({ text: /^! 1\. / })).toBeDefined()
  expect(await pane.find({ text: /^~ 2\. / })).toBeDefined()
})

// The feedback loop end to end: a line typed at the band reaches the store, is taken
// out of the prompt, and changes what the next pass is told. A capture that only
// cleared the screen would look identical here — this is what catches that.
test('saying something about a finding changes what the reviewer is told', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  const said = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  // "Not for me" — said in the next thing they type. The plugin reads it, takes it
  // out of the prompt (a drop, so no turn is spent on it), and the item leaves the band.
  const pane = await mountPane($)
  expect(await pane.find({ text: /5 = 5%/ })).toBeDefined()
  const dismissed = await said('dismiss 1')
  // Dropped rather than forwarded: the line was for the plugin, and the drop reason
  // is what the person sees in place of the prompt they typed.
  expect((dismissed as { drop?: string }).drop ?? '').toContain('不相关')
  expect(await pane.find({ text: /5 = 5%/ })).toBeUndefined()

  w.state.answer = '{"findings": []}'
  await steps($, 6) // chained: the floor is 6
  await w.clock.advance(10)
  const afterDismiss = w.forks.at(-1) ?? ''
  expect(afterDismiss).toContain('<not-relevant>')
  expect(afterDismiss).toContain('5 = 5%')

  // "I want more of this" reaches the prompt too — and, unlike the raised list, it is
  // a reason to bring things up rather than leave them alone.
  w.state.answer = JSON.stringify({ findings: [{ ...SEEN2, what: 'a kind of thing' }] })
  await steps($, 6)
  await w.clock.advance(10)
  await said('more like 1')

  w.state.answer = '{"findings": []}'
  await steps($, 6)
  await w.clock.advance(10)
  const afterAppreciate = w.forks.at(-1) ?? ''
  expect(afterAppreciate).toContain('<useful-to-them>')
  expect(afterAppreciate).toContain('a kind of thing')
  // Both lists hold the praised sentence, and they say different things: "already
  // raised" stops that *sentence* coming back, "useful to them" asks for *new* problems
  // of that kind. Dropping it from the first would have the same item re-reported every
  // pass — the opposite of what "more like this" is for.
  const quiet = /<already-raised>([\s\S]*?)<\/already-raised>/.exec(afterAppreciate)?.[1] ?? ''
  expect(quiet).toContain('5 = 5%')
  expect(quiet).toContain('a kind of thing')
})

// A place is what points at an item: the band's own numbering, 1-based as drawn.
// Matching free text is deliberately not supported — it is how ordinary sentences
// like "learn how the cache works" got eaten. The number is checked as a whole line
// so `learn 1` means the first item and not whichever item contains a "1".
test('a number points at its place', async () => {
  const items = [{ what: 'item 1 of 2' }, { what: 'item 2 of 2' }, { what: 'a third' }]
  expect(parseAnswer('learn 1', items)?.targets).toEqual(['item 1 of 2'])
  expect(parseAnswer('learn 2,3', items)?.targets).toEqual(['item 2 of 2', 'a third'])
  expect(parseAnswer('learn 1', items)?.targets).toEqual(['item 1 of 2'])
  // A number that is not there names nothing, and nothing is closed.
  expect(parseAnswer('learn 9', items)).toBeNull()
})

// A line aimed at the band is never a work request, even when there is nothing on
// the band to answer. Letting it through turns `learn 1` into a prompt the model
// answers — which is how a test run once had it write a lesson into memory instead.
test('a feedback line with nothing on screen is dropped, not sent to the model', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)

  const empty = await $.prompt.submit({ text: 'learn 1', wait: false, origin: { kind: 'composer' } } as never)
  expect((empty as { drop?: string }).drop ?? '').toContain('没有条目')
  // And an ordinary prompt still goes through untouched.
  const normal = await $.prompt.submit({ text: 'now read the config', wait: false, origin: { kind: 'composer' } } as never)
  expect((normal as { drop?: string }).drop ?? '').toBe('')
})

// Things people say to the model all day must not be swallowed. "知道了" and "got
// it" are normal replies, "close the panel" is a normal request — and a bare `learn`
// must not silence every item on screen at once.
test('ordinary replies are never eaten', async () => {
  const items = [{ what: 'a' }, { what: 'b' }]
  // Said to the model all day: a normal reply or a normal request. None is
  // swallowed. A line only means the band when it names a place — a number or a
  // quoted one — so free text stays a request however the sentence starts.
  for (const line of [
    '知道了',
    '明白了',
    'got it',
    'close the panel',
    'useful, thanks',
    'learn how the cache works',
    'learn from this file',
    'dismiss the idea of caching',
    'more like this please keep going',
  ]) {
    expect(parseAnswer(line, items)).toBeNull()
    expect(looksLikeAnswer(line)).toBe(false)
  }
  // The shapes that do mean the plugin: a place, or nothing at all (which asks).
  expect(parseAnswer('learn 1', items)?.targets).toEqual(['a'])
  expect(parseAnswer('dismiss 2', items)?.targets).toEqual(['b'])
  expect(parseAnswer('more like 1', items)?.targets).toEqual(['a'])
  expect(parseAnswer('learn', items)).toBeNull()
  expect(looksLikeAnswer('learn')).toBe(true)
})

test('learn 1 closes what is on screen and it never comes back', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1) // raised SEEN

  // "I know this one" — typed in the next message, taken out by the plugin (a drop).
  const closed = await $.prompt.submit({ text: 'learn 1', wait: false, origin: { kind: 'composer' } } as never)
  expect((closed as { drop?: string }).drop ?? '').toContain('已关闭')
  // The closed list lives in `log` now — that is where the person looks for it.
  const log = (await $.command.run({ command: 'mimo-supervisor', args: 'log' } as never)) as { text: string }
  expect(log.text).toContain(SEEN.what)

  // The next pass is told, in stronger terms than "already raised", to leave it alone.
  w.state.answer = '{"findings": []}'
  await steps($, 6) // chained: the floor is 6
  await w.clock.advance(10)
  const last = w.forks.at(-1) ?? ''
  expect(last).toContain('<known>')
  expect(last).toContain(SEEN.what)
  expect(last).toContain('Never raise anything in the list below')
})

// The one undo: `undo <n>` reopens a closed item from whichever of the three lists it
// sits in, and the sentence is also lifted out of "already raised" — otherwise the
// reviewer would keep skipping it and the reopen would be a promise it never keeps.
test('undo reopens a closed item, whatever kind it was', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1) // one item on screen

  // Close it as "not for me"; the closed list is in `log`, tagged by kind.
  await $.prompt.submit({ text: 'dismiss 1', wait: false, origin: { kind: 'composer' } } as never)
  const closed = (await $.command.run({ command: 'mimo-supervisor', args: 'log' } as never)) as { text: string }
  expect(closed.text).toContain('[不相关]')
  expect(closed.text).toContain(SEEN.what)

  // Undo it — one numbering across the lists.
  const back = await $.command.run({ command: 'mimo-supervisor', args: 'undo 1' } as never)
  expect(back.text).toContain('已放出')
  expect(back.text).toContain(SEEN.what)
  const log = (await $.command.run({ command: 'mimo-supervisor', args: 'log' } as never)) as { text: string }
  expect(log.text).not.toContain('[不相关]')

  // And the reviewer may raise it again: the reopen lifted it out of `raised` too.
  w.state.answer = JSON.stringify({ findings: [SEEN] })
  await steps($, 6) // chained: the floor is 6
  await w.clock.advance(10)
  expect(w.forks.at(-1) ?? '').not.toContain('<already-raised>')
})

// Closed items are numbered oldest-closed-first, so what `undo 2` points at today is
// still what it points at after more things are closed. A list-order concatenation
// would silently shift every later number the moment one more item landed.
test('closed items are numbered oldest first, so undo numbers do not shift', async () => {
  const lists = {
    learned: [{ what: 'old-learn', at: 100 }],
    dismissed: [{ what: 'new-dismiss', at: 300 }, { what: 'mid-dismiss', at: 200 }],
    appreciated: [],
  }
  expect(closedRows(lists).map(r => r.entry.what)).toEqual(['old-learn', 'mid-dismiss', 'new-dismiss'])
  // A newly closed item lands at the tail — the earlier numbers stay put.
  const grown = { ...lists, appreciated: [{ what: 'newest', at: 400 }] }
  expect(closedRows(grown).map(r => r.entry.what)).toEqual(['old-learn', 'mid-dismiss', 'new-dismiss', 'newest'])
  expect(dropAt(grown, 1)?.entry.what).toBe('mid-dismiss')
  expect(dropAt(grown, 1)?.kind).toBe('dismissed')
})

// 审查是旁路：它坏了不会报错，只是再也不提醒。连续几次没有结论就得说一声，
// 否则你以为它还在看着。
test('a reviewer that stops making sense says so', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)

  // 首查 3 步；此后每次链式检查要 6 步新工作（chain floor）。
  w.state.answer = 'not json at all'
  await steps($, 3)
  await w.clock.advance(10)
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.toasts.length).toBe(0)   // 一两次不值得吵

  await steps($, 6)
  await w.clock.advance(10)
  expect(w.toasts.at(-1) ?? '').toContain('没给出结论')

  // 一旦又给出结论，计数清零，不重复提醒。
  w.state.answer = '{"findings": []}'
  await steps($, 6)
  await w.clock.advance(10)
  w.state.answer = 'still not json'
  await steps($, 6)
  await w.clock.advance(10)
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.toasts.filter(t => t.includes('没给出结论')).length).toBe(1)
})

// 这条提醒是为「审查真坏掉」加的，那正是 fork 不回答的样子——api-error、
// aborted。但 nothing-to-fork 不算坏：那是还没东西可 fork（新会话、/clear），
// 数进去会弹假警报，让人学会忽略这个提醒。
test('a fork that keeps failing is reported, one with nothing to fork is not', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)

  w.state.noAnswer = 'api-error'
  for (let i = 0; i < 3; i++) { await steps($, i === 0 ? 3 : 6); await w.clock.advance(10) } // 首查 3,链条 6
  expect(w.toasts.at(-1) ?? '').toContain('没结果')

  // 清零后，nothing-to-fork 不该累积成警报。
  w.state.noAnswer = 'nothing-to-fork'
  for (let i = 0; i < 6; i++) { await steps($, 6); await w.clock.advance(10) }
  expect(w.toasts.filter(t => t.includes('没结果')).length).toBe(1)
})

test('a fork that never comes back gives up and lets the next one run', async ($, on) => {
  const w = world(on)
  w.state.hang = true
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  await steps($, 12) // while it hangs, no second one is started
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  await w.clock.advance(600_000) // the guard lets go (600s: real passes run minutes, see docs §7.4)
  w.state.hang = false
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
})

// A pass that comes back late is recorded as superseded, not silently lost. Its
// findings are not delivered — a late note would collide with the newer pass's — but
// the pass and what it saw are kept, so the numbers do not lie about how much was
// reviewed and how much was dropped. This is how the old 120s guard used to eat
// results invisibly: history only ever held passes that happened to still be newest.
test('a pass that comes back late is recorded as superseded, not silently lost', async ($, on) => {
  const w = world(on)
  w.state.late = true
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3)
  await w.clock.advance(10) // the first pass forks and waits (late)
  expect(w.forks.length).toBe(1)

  await w.clock.advance(600_000) // its guard lets go; the slot is free again
  w.state.late = false
  await steps($, 3) // six new steps since the first pass went out → a second pass runs
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)

  w.releaseLate() // the first reply finally arrives — a newer pass owns the state
  await w.clock.advance(10)

  // Not delivered twice: only the newer pass's note reached the model.
  expect(w.notes.length).toBe(1)
  // But recorded: the log counts it as superseded and the aggregate keeps it forever.
  const log = (await $.command.run({ command: 'mimo-supervisor', args: 'log' } as never)) as { text: string }
  expect(log.text).toContain('1 次被作废')
  expect(log.text).toContain('累计')
  // The bare command is the switch, and its reply carries the stats — that is the
  // command people actually type. (Not `on`: there is no `on` spelling in this build.)
  const status = (await $.command.run({ command: 'mimo-supervisor', args: '' } as never)) as { text: string }
  expect(status.text).toContain('累计:审查 1 次(作废 1 次)')
})

// The delta gate: a chained check needs MIN_NEW_STEPS of new work since the last one
// LANDED, so a slow pass followed by an instant one does not produce two passes poking
// at one wave of work. The first check of a conversation honours `every` exactly.
test('a chained check waits for new work since the last one landed', async ($, on) => {
  const w = world(on)
  w.state.answer = JSON.stringify({ findings: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3) // first check: exactly at the interval
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  await steps($, 5) // five new steps — one short of the chained floor
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  await steps($, 1) // the sixth lands the chained check
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
})

// The reviewer runs on its own model (flash) over $.model.complete, with the
// conversation assembled from $.session.messages() — a fork cannot change models,
// it re-sends the main thread's request. The transcript goes first and is cache-
// marked (it only grows, so the shared prefix still hits); the review instructions
// come last and vary with the already-raised list.
test('the reviewer runs on its own model over the assembled conversation', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3)
  await w.clock.advance(10)

  expect(w.completes.length).toBe(1)
  // Not pinned to an exact id: the flash id shape is confirmed with the person's
  // /model line. What matters here: the reviewer's own model, and the same one the
  // `reviewer` command reports.
  expect(w.completes[0].model).toContain('flash')
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'reviewer' } as never)).text).toContain(w.completes[0].model)
  // The conversation, and the review instructions after it.
  expect(w.completes[0].prompt).toContain('帮我看看折扣该怎么算')
  expect(w.completes[0].prompt).toContain('(调用 Read')
  expect(w.completes[0].prompt).toContain('The user reads the final answers')
  // Nothing went through the fork — the main model was not asked at all.
  expect(w.forkCalls.length).toBe(0)
  expect(w.notes.length).toBe(1)
})

// A reviewer model that fails (wrong id, engine refusal, api-error) falls back to the
// main model for that pass and says so once — a reviewer that switched models and
// died quietly is the worst kind of broken.
test('a reviewer model that fails falls back to the main model and says so', async ($, on) => {
  const w = world(on)
  w.state.completeFail = true
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3)
  await w.clock.advance(10)

  // One pass: one failed attempt on the reviewer's model, one fallback on the fork
  // (both review calls, so `forks` sees two entries — the paths are counted apart).
  expect(w.completes.length).toBeGreaterThan(0) // tried the id variants
  expect(w.forkCalls.length).toBe(1)
  expect(w.notes.length).toBe(1) // and its findings still landed
  expect(w.toasts.at(-1) ?? '').toContain('已回退主模型')

  // Said once, not every pass.
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.toasts.filter(t => t.includes('已回退主模型')).length).toBe(1)
})

// `reviewer mimo` puts the fork back — the escape hatch when the second model's
// output turns out noisier (the restraint prompt was tuned on the main model).
test('reviewer mimo goes back to the fork path', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'reviewer' } as never)).text).toContain('flash')

  await $.command.run({ command: 'mimo-supervisor', args: 'reviewer mimo' } as never)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forkCalls.length).toBe(1)
  expect(w.completes.length).toBe(0)
})

test('a reviewer id is taken verbatim, case included', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  // Model ids are case-sensitive: the command must not lowercase what it is given.
  const set = (await $.command.run({ command: 'mimo-supervisor', args: 'reviewer Mimo-Flash[2M]' } as never)) as { text: string }
  expect(set.text).toContain('Mimo-Flash[2M]')
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.completes[0].model).toBe('Mimo-Flash[2M]')
})

test('the review prompt matches already-raised by lesson, not by wording', async () => {
  const raised = [{ what: 'measure before you assert', evidence: 'e', cost: 'c', severity: 'you-should-know' as const }]
  const p = watchPrompt(raised)
  // The whole point: a reworded repeat of a lesson is still already raised.
  expect(p).toContain('Match by LESSON, not by wording')
  expect(p).toContain('measure before you assert')
})

test('the review prompt restrains severity and stops re-reporting a process lesson', async () => {
  const p = watchPrompt()
  // Only a wrong user result is worth stopping for; a process nitpick is heads-up at most.
  expect(p).toContain('Reserve `you-should-know`')
  // A process lesson earns one mention for the conversation, then it is noise.
  expect(p).toContain('mention for the whole conversation')
  // When recent passes each found something, prefer empty.
  expect(p).toContain('raise the bar')
})

test('the command reports what the passes were worth, not a guess', () => {
  expect(summarize([])).toBe('还没有审查记录。')
  const line = summarize([
    { at: 0, ms: 10000, findings: [{ what: 'a', evidence: 'e', cost: 'c', severity: 'you-should-know' as const }], usage: null, readable: true },
    { at: 0, ms: 20000, findings: [], usage: null, readable: true },
    { at: 0, ms: 30000, findings: [{ what: 'b', evidence: 'e', cost: 'c', severity: 'heads-up' as const }], usage: null, readable: true },
  ])
  expect(line).toContain('最近 3 次审查')
  expect(line).toContain('发现 2 条')
  expect(line).toContain('1 条该尽快处理')
  expect(line).toContain('1 次空手')
  expect(line).toContain('平均 20 秒')
  // avg alone is pulled around by the slowest pass — p50/p90 stand next to it.
  expect(line).toContain('p50 20 秒')
  expect(line).toContain('p90 30 秒')
  // A superseded pass is counted as superseded; its findings were never delivered,
  // so they are not "raised" — neither in the window line nor in the aggregate.
  const withStale = summarize([
    { at: 0, ms: 10000, findings: [SEEN], usage: null, readable: true, stale: true },
    { at: 0, ms: 20000, findings: [SEEN], usage: null, readable: true },
  ])
  expect(withStale).toContain('最近 2 次审查:发现 1 条')
  expect(withStale).toContain('1 次被作废')
  // The aggregate outlives the 50-entry window: passes, superseded, and the loud/quiet split.
  const all = summarize([], { passes: 40, findings: 55, loud: 40, quiet: 15, empty: 3, unreadable: 1, stale: 2, msTotal: 40 * 126_000 })
  expect(all).toContain('累计:审查 40 次(作废 2 次)')
  expect(all).toContain('发现 55 条 —— 40 条该尽快处理 / 15 条可稍后')
  expect(all).toContain('平均 126 秒')
})
