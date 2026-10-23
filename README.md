# mimo-supervisor

**Puts "You should know" back into a Claude Code running mimo-v2.6-pro.**

Every few steps it runs one review pass over the session's work so far. The reviewer runs on **mimo-v2.6-flash** (Mify ¥1/¥2) by default: `fork` cannot change models, so the pass goes through `complete` with the conversation assembled — fast enough to land inside the turn it looks at. A failing reviewer model falls back to the main model and says so; `reviewer mimo|flash|<id>` switches. When it finds something the model should handle now, it tells the model, and shows you the same items in the pane on the right (the pane was cut — the pane carried everything it showed).

**Installed but dormant.** The plugin is always there and its command is always available, but type nothing and it does nothing — no review, no cost, no interruption. Ask for it and it watches that one conversation.

[中文](README.zh-CN.md)

## Why

Claude Code ships a side agent called "You should know" that watches Claude at work and raises what it notices. But it hides itself whenever `ANTHROPIC_BASE_URL` points away from Anthropic — on 2.1.290 that one variable is enough — so a Claude Code wired to mimo or any other Anthropic-compatible endpoint has nothing watching it at all.

mimo-supervisor fills that gap.

Design references [deepseek-supervisor](https://github.com/LACAN-1/deepseek-supervisor). See [What changed](#what-changed) for how the session is recognised and for a few known rough edges.

## What it does

Every **3** finished steps of the main loop (a subagent's steps are its own) it forks a review. **The interval is fixed** — say 3 steps and it is 3 steps, never quietly widened just because a pass found nothing. (One honest wrinkle: a *chained* check also needs at least 6 steps of new work since the last one landed, so two passes in a row do not poke at one wave of work. The first check of a conversation honours the number exactly.) It looks for only these:

- **A reading picked silently**: the request allows two readings that change the result, and the model built on one without asking.
- **A problem noticed and not raised**: it saw something wrong and moved on without telling you.
- **A claim with nothing behind it**: "verified", "works", "looks right" with no command, number or file behind it; or a described image it never opened.
- **"Cannot do X" said without having tried X.**
- **Scope that grew**, unannounced.
- **Guessing**: change after change with no effect and no measurement between them.
- **Files changed after it said it was done**, without saying which.

It defaults to silence, reports at most 2 items per pass, and never repeats itself.

**Each item carries a severity**, and the two are drawn apart:

| Mark | Meaning | Drawn |
|---|---|---|
| `!` **you-should-know** | worth stopping for right now | **bold** |
| `~` heads-up | it can wait | dimmed |

So the one that matters is not drowned by three that could wait.

The reviewer reads the whole transcript, including your file contents and command output, so its prompt **forbids reproducing secrets, credentials, tokens, keys, passwords, environment values or personal data** — refer to them ("the key in `.env`", "the password in settings") instead of quoting them.

Findings go two places:

- **To the model**, as a note it reads at its next step. The note says plainly that this is a reviewer's observation and not your instruction, authorizing nothing beyond what you asked for — because the transcript it reads may contain text from the web.
- **To you**, in the pane on the right (the pane was cut — the pane carried everything it showed) with a **Hide** button. It clears after two of your prompts, like "You should know" cards.

## How it recognises mimo

This is the one real change, so it is worth spelling out.

The original only looked at whether `ANTHROPIC_BASE_URL` is Anthropic's. On this machine that variable is `http://127.0.0.1:18080/anthropic` — a local proxy whose address carries no model name at all; what runs behind it is decided by `ANTHROPIC_*_MODEL`. Looking at the host cannot tell mimo apart from any other model served through the same proxy.

So mimo-supervisor reads the **model id**, in two layers:

1. **`$.session.model()`** — the one `/model` shows, the model the main loop actually resolved. This is the accurate one: it includes a model passed as `--model` at launch, which no environment variable records.
2. The environment as a fallback, first one set of `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_CUSTOM_MODEL_OPTION`.

If the name matches `mimo`, it works. **Only when neither layer yields a name** does it fall back to the original rule — anything that is not Anthropic's endpoint is worth watching — since in that case the model is unknown but watching still beats not watching. The status line says which of the three it is going by.

| | |
|---|---|
| Status pane | A `Pane` (in Chinese) showing `监视中`/`已停止`, the reason, the current interval, the running count, and **the recent items with their evidence and cost**. **There is no status line any more**: the host draws a `$.ui.status` text with a warning glyph in front of it and offers no way to ask for one without, so the state moved to a pane |
| `/mimo-supervisor` | **This is the switch.** The bare command starts watching and opens the pane. The plugin is installed but dormant — type nothing and it does nothing |
| `/mimo-supervisor off` | Stop watching, and clear the pane |
| `/mimo-supervisor log` | Last 10 passes with findings and how long each took, plus what is closed |
| `/mimo-supervisor interval <n>` | Fix the interval at n steps of new work (1–24). A number you pick is used **exactly** — empty passes do not widen it. A chained check still needs 6 steps of new work since the last one landed |
| `/mimo-supervisor undo <n>` | Reopen a closed item — the numbering is the one `log` prints (oldest closed first, so the numbers do not shift) |

### Feedback (entirely optional — ignoring it is fine)

**You do not have to do anything.** The plugin flags what it notices and the held items age out (after two of your prompts, or when the next finding lands). Everything below is only for when you *want* to steer it.

Answer the pane in the next thing you type — no buttons to press. The line is taken out of your prompt (a drop), so it never reaches the model:

| In your next message | What it says | Afterwards |
|---|---|---|
| `learn 1` (or `learn "…"` quoting the item) | "I know about this one" | **never raised again**, in any wording (harder than "already raised") |
| `dismiss 1` | "Not for me" | not raised again |
| `more like 1` | **"More like this"** | this kind keeps being raised |

All three are remembered **per working directory**, so one project's answer says nothing about another's. `log` lists what is closed and `undo <n>` takes one back off.

**It remembers the last thing you chose.** Type `/mimo-supervisor` once and every conversation after that starts watching on its own; type `off` and they all start dormant. You do not retype the command in each one.

The plugin's store (`$.store`) is shared by **every session on this machine**, so a change reaches all of them. It holds:

| Key | What | Note |
|---|---|---|
| `modes` | the on/off switch, per working directory | **per project** |
| `learned` / `dismissed` / `appreciated` | the three feedback lists | **per project** |
| `history` | the last 50 passes, with the evidence each finding quotes | `/mimo-supervisor log` reads it |
| `agg` | all-time counters (passes / findings / loud-quiet / superseded / wall-clock) that never roll off | global |
| `every` | the interval you set with `interval` | **change it once and every session changes** |

All of it stays on this machine and is sent nowhere.

The session's own memory (what has been said, the backoff level, the counts) lives **elsewhere** (`$.state`): it survives a reload but does not cross sessions — a new session starts fresh.

## What you need

- **Claude Code 2.1.290 or later.** Developed and tested on **2.1.293**.

That floor is real, not decorative. The plugin uses `$.model.fork` (the review pass), `$.session.append` (delivering findings to the model), `AbovePrompt` (the pane) and `atom`/`update`/`read` (state) — **none of which exist in 2.1.246**, where it would silently do nothing. 2.1.246's plugin API is a much smaller, different thing (`model.complete`, `session.messages`, `store.get` and little else); targeting it means rewriting the plugin rather than porting it.

## Install

Upgrade Claude Code first if you are still on 2.1.246:

```powershell
npm i -g @anthropic-ai/claude-code@2.1.293
```

> **Already installed on this machine** — user scope, read from the plugin folder, available in every project. What follows is for a new machine or a reinstall.

Add the GitHub repository as a marketplace, then install:

```powershell
claude plugin marketplace add 2085047362sq-crypto/mimo-supervisor
claude plugin install mimo-supervisor@mimo-supervisor --scope user
```

`--scope user` makes it work in **every** project; drop the flag to have it in one project only.

To run from a local clone instead, keep the cloned folder in a **fixed** place (not the desktop, not a temp folder — moving it breaks every project at once) and:

```powershell
claude plugin marketplace add <the local folder>
claude --plugin-dir <the local folder>
```

If you cannot add a command-line flag (because something else starts the session), put the folder in the `CLAUDE_CODE_PLUGIN_DIRS` environment variable.

After installing, run `claude plugin list` and look at `Read from:` — **that is the folder it actually runs from**, and it is the one to edit later.

## Cost

Every pass forks the whole session and re-reads the full context. **Whether that lands in the prompt cache depends on your endpoint — do not assume it is cheap.**

Measured through this machine's local proxy: a fork reports `input_tokens` and `cache_read_input_tokens` of **both 0**, so cost cannot be derived from tokens at all. And per the API docs, a fork whose `cache_read_input_tokens` is near zero usually means the cache missed and **the whole transcript prefix was billed at full price** — the expensive case, not the "mostly cache hits" the original README assumed.

So `/mimo-supervisor log` records **wall-clock milliseconds** per pass, with the raw usage attached but not turned into money. How long is a pass? Measured over 50 real passes: **p50 126s, p90 227s, max 302s** — minutes, not seconds, because the fork re-reads the whole transcript and slows down as the conversation grows. (The earlier "11–14s per pass" figure was an early short-session sample and is obsolete; do not size anything on it.) The widening interval exists to amortise exactly that. Do the arithmetic before turning it on.

## What changed

| | Original (deepseek-supervisor) | This (mimo-supervisor) |
|---|---|---|
| Recognises the session by | the endpoint only | `$.session.model()` first, then the environment, then the endpoint |
| Items per pass | prompt said 2, parser kept 3 | 2 in both (`MAX_ITEMS`) |
| Remembers raised items | last 12; the author saw repeats | last 24 |
| "Default to silence" | one line | its own rule, requiring an item to change the next action, banning hedged items |
| Interval between passes | fixed at 6 steps | fixed at **3** by default (`interval <n>` changes it; empty passes never do) |
| A fork that hangs | no back-out; `isWatching` sticks forever | a 120s guard lets the next one run |
| Cost recorded | token counts | wall-clock ms plus raw usage (this gateway reports tokens as 0) |
| Already-raised block | resent with what + evidence + cost | `what` alone |
| Cost of deciding to run | worked out every step, up to 8 engine calls | worked out once per prompt, cached across the steps |
| Command and state name | `deepseek-supervisor` | `mimo-supervisor` |

The seven-item checklist is **unchanged**. It is model-agnostic and it is the most valuable part of the code.

## Known limits

- **The review may not land inside the turn it looks at.** A fork takes minutes on a long transcript (p50 126s / p90 227s over 50 real passes — the old 11–14s was a short-session sample and is obsolete), and a turn can end in a few steps, where the finding only reaches a **later** turn. The default of 3 steps is a worked-out compromise for density, not latency; `interval 2` starts reviews earlier, at the price of more forks over the same work.
- **The pane's first appearance in a narrow terminal.** The one opened at session start seats only from 144 columns; it is now also re-opened behind **your first prompt**, and a pane that was asked for seats at any width, so a narrow terminal gets it from the first message on.
- **The decision cache lags until the next prompt.** "Is this worth watching" is worked out once per prompt, so switching model with `/model` mid-session is picked up at the next prompt, not before.
- **Cost is still an estimate.** This gateway reports no tokens; only wall-clock is real.
- **The step counter does not survive a reload.** What has been said, the backoff level and the counts live in `$.state` and stay; only the step counter starts over, which means the first pass after a reload comes a few steps later.
- **The checklist is fixed at those seven; there is no custom-checks entry.** You did not want to maintain your own items, so the `check` channel is gone. To tune for mimo, edit the seven lines in `watchPrompt` in `hooks/prompt.ts` and `/reload-plugins`.

## Development

```powershell
claude plugin validate .
claude plugin test .
```

Claude Code writes the type declarations into `.claude-plugin/types/` the first time it loads the plugin; after that `tsc -p .` type-checks. Currently **41 tests, all passing**.

| File | What it does |
|---|---|
| `hooks/register.ts` | step counting and the chain floor, the review pass, the watchdog, model detection, the note to the model, on/off, the command |
| `hooks/prompt.ts` | the review prompt, and parsing the model's answer |
| `hooks/pane.tsx` | the status pane, which replaced a status line the host marked with a warning glyph |
| `types/index.d.ts` | the finding shape and the plugin state contract |
| `tests/watch.test.ts` | 41 tests on Claude Code's plugin test kit |

## License

MIT — see [LICENSE](LICENSE).
