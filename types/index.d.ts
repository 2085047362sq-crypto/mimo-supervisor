export type Finding = {
  /** What happened, in one plain sentence. */
  what: string
  /** Where it shows: a quote, a file, a command from the conversation. */
  evidence: string
  /** What goes wrong if the assistant keeps going as it is. */
  cost: string
  /**
   * How much of an interruption it deserves: `you-should-know` when acting on it now
   * is worth stopping for, `heads-up` when it can wait. The reviewer says which, and
   * the two are shown differently so the loud one is not drowned by the quiet one.
   */
  severity: 'you-should-know' | 'heads-up'
}

/** What the watcher last noted, drawn in the band above the prompt and in the pane. */
export type Cards = {
  /** When the check that found them settled, epoch ms. */
  at: number
  items: Finding[]
}

/**
 * The watcher's own state, as the pane draws it. The status line used to carry this,
 * and a `$.ui.status` text is drawn with a warning glyph the plugin cannot ask to
 * leave off, so it lives in a pane instead.
 *
 * It is also where the session's memory survives a reload: `register` and
 * `session.start` run again on one and a module's own variables start over, while
 * `$.state` is the host's and stays. So what has been said and how far the checks had
 * stretched out are kept here and read back at session.start.
 */
export type Snapshot = {
  mode: 'on' | 'off'
  watches: boolean
  /** Why it says so: the model it saw, or the endpoint when it saw no model. */
  why: string
  /** The interval between passes, in steps of new work. Fixed — nothing widens it in this build. */
  every: number
  /** Findings raised this session. */
  told: number
  /** When the last one landed, as `2 at 10:44`; empty when none have. */
  last: string
  /** What has been said already, so a reload does not make the watcher say it again. */
  raised: Finding[]
  /** Consecutive passes that found nothing — informational, shown in the pane; nothing widens on it. */
  quietPasses: number
  /** The reviewer's own model (empty = the main model via fork). Shown apart from `why`, which names the session's model. */
  reviewer: string
}

/**
 * Whether the watching is on. Off until asked, and the answer is remembered across
 * sessions in `$.store`: someone who has turned it on once does not have to say so
 * again in every conversation that follows. A reload of the module picks the choice
 * straight back up, since the store is the host's and outlives the module.
 */
export type Mode = 'off' | 'on'

declare module 'claude-code' {
  interface PluginState {
    'mimo-supervisor': {
      cards: Cards | null
      snapshot: Snapshot
    }
  }
}
