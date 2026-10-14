import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { looksLikeAnswer, parseAnswer } from '../hooks/feedback'
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
const band = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} }

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
    // A fork that answers with no usable reply at all — api-error, aborted, or
    // nothing-to-fork. The reason says which.
    noAnswer: undefined as undefined | string,
    // Refuse the note instead of keeping it: the documented way to turn a plugin's own
    // append away is to answer with { deny } in place of next, and nothing is stored.
    refuseNote: false,
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
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    if (state.hang) return new Promise(() => undefined) as never
    if (state.noAnswer !== undefined) return { value: { isAnswered: false, reason: state.noAnswer } } as never
    return { value: { isAnswered: true, text: state.answer, usage } } as never
  })
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
  return { clock, forks, toasts, notes, statuses, opens, state }
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

const mountBand = ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'mimo-supervisor', surface, component: 'AbovePrompt', props: band } as never)

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

  // The person sees the item above the prompt, on any surface, and can put it away.
  for (const surface of ['terminal', 'desktop'] as const) {
    const drawn = await mountBand($, surface)
    expect(await drawn.find({ text: /noted 1/ })).toBeDefined()
    expect(await drawn.find({ text: /5 = 5%/ })).toBeDefined()
  }
  const drawn = await mountBand($)
  await drawn.press({ key: 'hide' } as never)
  expect(await drawn.find({ key: 'hide' })).toBeUndefined()
})

// Hide only turns the drawing off; the items are still held, and until this there was
// no way back but waiting for the next finding to un-hide it by itself.
test('show brings the band back after Hide, and says so when there is nothing held', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 6)
  await w.clock.advance(10)
  expect(await (await mountBand($)).find({ text: /noted 1/ })).toBeDefined()

  await (await mountBand($)).press({ key: 'hide' } as never)
  expect(await (await mountBand($)).find({ text: /noted/ })).toBeUndefined()

  const back = await $.command.run({ command: 'mimo-supervisor', args: 'show' } as never)
  expect(back.text).toContain('again')
  expect(await (await mountBand($)).find({ text: /noted 1/ })).toBeDefined()

  // With nothing held there is nothing to bring back, and the person is told where to look.
  await (await mountBand($)).press({ key: 'hide' } as never)
  await $.prompt.submit({ text: 'one', wait: false, origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: 'two', wait: false, origin: { kind: 'composer' } } as never)
  const empty = await $.command.run({ command: 'mimo-supervisor', args: 'show' } as never)
  expect(empty.text).toContain('Nothing is being held')
  expect(empty.text).toContain('/mimo-supervisor log')
})

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
  expect(await pane.find({ text: /watching/ })).toBeDefined()
  expect(await pane.find({ text: /mimo-v2\.6-pro/ })).toBeDefined()
  expect(await pane.find({ text: /1 noted/ })).toBeDefined()
  expect(await pane.find({ text: /5 = 5%/ })).toBeDefined()
  expect(await pane.find({ text: /evidence:/ })).toBeDefined()
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
  expect(await (await mountBand($)).find({ text: /noted 1/ })).toBeDefined()
  expect(w.toasts.at(-1)).toContain('did not reach the model')
})

// A shorter interval starts the review earlier in a turn, so it stands a better chance
// of coming back while that turn is still running and reaching it.
test('the interval the person sets is the one the steps count against', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  const set = await $.command.run({ command: 'mimo-supervisor', args: 'interval 5' } as never)
  expect(set.text).toContain('every 5')

  await steps($, 5)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)
})

test('an interval outside 1..24 is refused', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'interval 0' } as never)).text).toContain('Pick 1 to 24')
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'interval 99' } as never)).text).toContain('Pick 1 to 24')
})

// A number the person picks is used as it stands. The widening is there to save forks,
// which is not everyone's concern, and it must not quietly overrule what they asked
// for — "every 3 steps" has to mean every 3 steps even while passes keep finding nothing.
test('a fixed interval does not widen while passes find nothing', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await $.command.run({ command: 'mimo-supervisor', args: 'interval 3' } as never)
  w.state.answer = '{"findings": []}'

  for (let round = 0; round < 3; round++) {
    await steps($, 3)
    await w.clock.advance(10)
  }
  expect(w.forks.length).toBe(3) // still every 3, never stretched to 6 or 12

  // Back to adaptive and the widening returns: three empty passes in a row take it
  // from 3 to 6, and the next three steps no longer reach.
  await $.command.run({ command: 'mimo-supervisor', args: 'interval auto' } as never)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(4) // quietPasses reset to 0, so still due at 3
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(4) // one quiet pass behind it: now due at 6
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
  await steps($, 3)
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
  expect(await pane.find({ text: /1 remembered/ })).toBeDefined()
  expect(await pane.find({ text: /1 quiet pass/ })).toBeDefined()
  expect(await pane.find({ text: /every 3 steps/ })).toBeDefined()
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

test('the band clears after two prompts from the person', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 6)
  await w.clock.advance(10)

  const prompt = (text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
  await prompt('first')
  expect(await (await mountBand($)).find({ text: /noted 1/ })).toBeDefined()
  await prompt('second')
  expect(await (await mountBand($)).find({ text: /noted/ })).toBeUndefined()
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
  expect(await (await mountBand($)).find({ text: /noted/ })).toBeUndefined()
  expect(w.toasts.length).toBe(0)
})

test('turning it off clears the band and stops the passes', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 6)
  await w.clock.advance(10)
  expect(await (await mountBand($)).find({ text: /noted 1/ })).toBeDefined()

  await $.command.run({ command: 'mimo-supervisor', args: 'off' } as never)
  expect(await (await mountBand($)).find({ text: /noted/ })).toBeUndefined()
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)
})

// The port's one real behavioural change: auto follows the model id, not the host.
// A local proxy at 127.0.0.1 says nothing about which model is behind it, and this
// plugin is for mimo — so it must not fire just because the endpoint is third-party.
test('auto follows the model id, whatever endpoint carries it', async ($, on) => {
  const w = world(on)
  w.state.liveModel = 'xiaomi/mimo-v2.6-pro[1m]'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($, 'auto')
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  // Same local proxy, a different model behind it: this is not what it is for.
  w.state.liveModel = 'xiaomi/some-other-model'
  await $.command.run({ command: 'mimo-supervisor', args: 'auto' } as never)
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  // Forced on, it runs for any model; auto goes back to watching only mimo.
  await $.command.run({ command: 'mimo-supervisor', args: 'on' } as never)
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
  await $.command.run({ command: 'mimo-supervisor', args: 'auto' } as never)
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
})

// The model /model shows is the truth; the environment is only what it was set from.
// `--model` at launch changes the first and not the second, so the first has to win.
test('the resolved model beats what the environment claims', async ($, on) => {
  const w = world(on)
  w.state.model = 'xiaomi/mimo-v2.6-pro[1m]'
  w.state.liveModel = 'xiaomi/some-other-model'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($, 'auto')
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(0)

  w.state.liveModel = 'xiaomi/mimo-v2.6-pro[1m]'
  await $.command.run({ command: 'mimo-supervisor', args: 'auto' } as never)
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)
})

// The verdict is worked out once per prompt, not once per step. Changing what the
// world says mid-session is not a thing that happens — the person changes it, and the
// command is how they say so — so each change here is followed by one.
const reeval = ($: Parameters<TestBody>[0]) => $.command.run({ command: 'mimo-supervisor', args: 'auto' } as never)

test('with no model named anywhere, auto falls back to the endpoint', async ($, on) => {
  const w = world(on)
  w.state.model = undefined
  w.state.liveModel = undefined
  w.state.baseUrl = undefined // unset means Anthropic's own
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($, 'auto')
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(0)

  w.state.baseUrl = 'https://api.anthropic.com'
  await reeval($)
  await steps($, 12)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(0)

  // A host that only starts with anthropic.com is someone else's.
  w.state.baseUrl = 'https://anthropic.com.example.net/v1'
  await reeval($)
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)
})

// A pass that finds nothing is the common one, and learning that costs a fork of the
// whole transcript. So the checks spread out while they keep coming back empty.
test('a run of passes that find nothing spreads the checks out', async ($, on) => {
  const w = world(on)
  w.state.answer = '{"findings": []}'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  // The widening is opt-in: the default interval is fixed, and only `interval auto`
  // lets a stretch of empty passes push the checks further apart.
  await $.command.run({ command: 'mimo-supervisor', args: 'interval auto' } as never)

  await steps($, 3) // due at 3
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  await steps($, 3) // one quiet pass behind it: now due at 6, so this is not enough
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
})

test('a pass with something to say puts the checks back to the base interval', async ($, on) => {
  const w = world(on)
  w.state.answer = '{"findings": []}'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await $.command.run({ command: 'mimo-supervisor', args: 'interval auto' } as never)
  await steps($, 3) // due at 3; one quiet pass -> 6
  await w.clock.advance(10)
  await steps($, 6) // due at 6; two quiet passes -> 12
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)

  w.state.answer = JSON.stringify({ findings: [SEEN] })
  await steps($, 12) // due at 12, and this one has something to say
  await w.clock.advance(10)
  expect(w.forks.length).toBe(3)

  await steps($, 3) // back to the base interval
  await w.clock.advance(10)
  expect(w.forks.length).toBe(4)
})

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
  expect(asked.text).toContain('Watching this conversation')
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
test('the two severities are drawn apart in the band and the pane', async ($, on) => {
  const w = world(on)
  w.state.answer = JSON.stringify({ findings: [{ ...SEEN, severity: 'you-should-know' }, { ...SEEN2, severity: 'heads-up' }] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1)

  const band = await mountBand($)
  expect(await band.find({ text: /^! 1\. / })).toBeDefined() // the loud one
  expect(await band.find({ text: /^~ 2\. / })).toBeDefined() // the quiet one

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
  expect(await (await mountBand($)).find({ text: /5 = 5%/ })).toBeDefined()
  const dismissed = await said('dismiss 1')
  // Dropped rather than forwarded: the line was for the plugin, and the drop reason
  // is what the person sees in place of the prompt they typed.
  expect((dismissed as { drop?: string }).drop ?? '').toContain('not relevant')
  expect(await (await mountBand($)).find({ text: /5 = 5%/ })).toBeUndefined()

  w.state.answer = '{"findings": []}'
  await steps($, 3)
  await w.clock.advance(10)
  const afterDismiss = w.forks.at(-1) ?? ''
  expect(afterDismiss).toContain('<not-relevant>')
  expect(afterDismiss).toContain('5 = 5%')

  // "I want more of this" reaches the prompt too — and, unlike the raised list, it is
  // a reason to bring things up rather than leave them alone.
  w.state.answer = JSON.stringify({ findings: [{ ...SEEN2, what: 'a kind of thing' }] })
  await steps($, 3)
  await w.clock.advance(10)
  await said('more like 1')

  w.state.answer = '{"findings": []}'
  await steps($, 3)
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
  expect((empty as { drop?: string }).drop ?? '').toContain('nothing on screen')
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

test('learn closes what is on screen and it never comes back', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1) // raised SEEN

  const closed = await $.command.run({ command: 'mimo-supervisor', args: 'learn' } as never)
  expect(closed.text).toContain('Closed 1')
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'learned' } as never)).text).toContain(SEEN.what)

  // The next pass is told, in stronger terms than "already raised", to leave it alone.
  w.state.answer = '{"findings": []}'
  await steps($, 3)
  await w.clock.advance(10)
  const last = w.forks.at(-1) ?? ''
  expect(last).toContain('<known>')
  expect(last).toContain(SEEN.what)
  expect(last).toContain('Never raise anything in the list below')
})

// The other two signals work the same way from the command line — `learn` is not
// the only one with a command, and an untested command is one nobody has ever run.
test('dismiss and appreciate work from the command line too', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(1) // one item on screen

  const dismissed = await $.command.run({ command: 'mimo-supervisor', args: 'dismiss' } as never)
  expect(dismissed.text).toContain('Marked 1')
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'dismissed' } as never)).text).toContain(SEEN.what)

  w.state.answer = JSON.stringify({ findings: [{ ...SEEN2, what: 'a kind of thing' }] })
  await steps($, 3)
  await w.clock.advance(10)
  const appreciated = await $.command.run({ command: 'mimo-supervisor', args: 'appreciate' } as never)
  expect(appreciated.text).toContain('Noted')
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'appreciated' } as never)).text).toContain('a kind of thing')

  // And both undo.
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'undismiss 1' } as never)).text).toContain('Reopened')
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'unappreciate 1' } as never)).text).toContain('Reopened')
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'dismissed' } as never)).text).toContain('Nothing marked')
})

test('unlearn reopens one so it can be raised again', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)
  await steps($, 3)
  await w.clock.advance(10)
  await $.command.run({ command: 'mimo-supervisor', args: 'learn' } as never)

  const back = await $.command.run({ command: 'mimo-supervisor', args: 'unlearn 1' } as never)
  expect(back.text).toContain('Reopened')
  expect((await $.command.run({ command: 'mimo-supervisor', args: 'learned' } as never)).text).toContain('Nothing closed')
})

// 审查是旁路：它坏了不会报错，只是再也不提醒。连续几次没有结论就得说一声，
// 否则你以为它还在看着。
test('a reviewer that stops making sense says so', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($)

  w.state.answer = 'not json at all'
  await steps($, 3)
  await w.clock.advance(10)
  await steps($, 3)
  await w.clock.advance(10)
  expect(w.toasts.length).toBe(0)   // 一两次不值得吵

  await steps($, 3)
  await w.clock.advance(10)
  expect(w.toasts.at(-1) ?? '').toContain('没给出结论')

  // 一旦又给出结论，计数清零，不重复提醒。
  w.state.answer = '{"findings": []}'
  await steps($, 3)
  await w.clock.advance(10)
  w.state.answer = 'still not json'
  await steps($, 3)
  await w.clock.advance(10)
  await steps($, 3)
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
  for (let i = 0; i < 3; i++) { await steps($, 3); await w.clock.advance(10) }
  expect(w.toasts.at(-1) ?? '').toContain('没结果')

  // 清零后，nothing-to-fork 不该累积成警报。
  w.state.noAnswer = 'nothing-to-fork'
  for (let i = 0; i < 6; i++) { await steps($, 3); await w.clock.advance(10) }
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

  await w.clock.advance(120_000) // the guard lets go
  w.state.hang = false
  await steps($, 6)
  await w.clock.advance(10)
  expect(w.forks.length).toBe(2)
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
  expect(summarize([])).toBe('No passes yet.')
  const line = summarize([
    { at: 0, ms: 10000, findings: [{ what: 'a', evidence: 'e', cost: 'c', severity: 'you-should-know' as const }], usage: null, readable: true },
    { at: 0, ms: 20000, findings: [], usage: null, readable: true },
    { at: 0, ms: 30000, findings: [{ what: 'b', evidence: 'e', cost: 'c', severity: 'heads-up' as const }], usage: null, readable: true },
  ])
  expect(line).toContain('last 3 passes')
  expect(line).toContain('2 finding(s)')
  expect(line).toContain('1 worth stopping for')
  expect(line).toContain('1 found nothing')
  expect(line).toContain('avg 20s each')
})
