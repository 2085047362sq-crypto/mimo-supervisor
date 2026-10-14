import { atom, read } from 'claude-code'
import type { On } from 'claude-code'

import type { Cards, Snapshot } from '../types'

// The watcher's own state, in a pane rather than the status line. A `$.ui.status`
// text is drawn by the host with a warning glyph in front of it and there is no way
// to ask for one without; a `ui.render` tree is drawn as the plugin wrote it. So the
// status line is gone and this pane holds what it used to say, plus the evidence and
// cost the band above the prompt leaves out.
export const PANE = 'mimo-supervisor'

const EMPTY: Snapshot = {
  mode: 'auto',
  watches: false,
  why: 'not looked at yet',
  every: 6,
  told: 0,
  last: '',
  raised: [],
  quietPasses: 0,
}

const cards = atom({ plugin: 'mimo-supervisor', key: 'cards' } as const, null)
const snapshot = atom({ plugin: 'mimo-supervisor', key: 'snapshot' } as const, EMPTY)

export const registerPane = (on: On) => {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const shown: Cards | null = await read($, cards)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)

    return (
      <Box flexDirection="column">
        <Text bold>{s.watches ? 'watching' : s.mode === 'off' ? 'off' : 'idle'}</Text>
        <Text dimColor>{s.why}</Text>
        <Text dimColor>
          {s.told} noted{s.last === '' ? '' : ` · last: ${s.last}`}
          {s.watches ? ` · every ${s.every} steps` : ''}
        </Text>
        {/* What is being held back from repeating, and how far the checks have
            stretched while they keep finding nothing. Both live in state, so this
            line is also how a test sees that a pass wrote them there. */}
        <Text dimColor>
          {s.raised.length} remembered · {s.quietPasses} quiet pass{s.quietPasses === 1 ? '' : 'es'}
        </Text>

        {shown === null || shown.items.length === 0 ? (
          <Text dimColor>No findings being held.</Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>latest ({shown.items.length})</Text>
            {shown.items.slice(-room).map((f, i) => (
              <Box key={`pane-${i}`} flexDirection="column">
                <Text bold={f.severity === 'you-should-know'} dimColor={f.severity === 'heads-up'}>
                  {f.severity === 'you-should-know' ? '! ' : '~ '}
                  {i + 1}. {f.what}
                </Text>
                <Text dimColor>   evidence: {f.evidence}</Text>
                <Text dimColor>   cost: {f.cost}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
