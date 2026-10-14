import { atom, read, update } from 'claude-code'
import type { On } from 'claude-code'

// What the watcher last noted, above the prompt. The person reads it and, if they
// have anything to say about it, they say it in the next thing they type — which
// hooks/feedback.ts picks up. There are deliberately no buttons here: answering is
// meant to cost nothing unless the person has something to say. Silence is a valid
// answer and is recorded as one.
const cards = atom({ plugin: 'mimo-supervisor', key: 'cards' } as const, null)
const isHidden = atom({ plugin: 'mimo-supervisor', key: 'isHidden' } as const, false)

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const registerBand = (on: On) => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const shown = await read($, cards)
    if (shown === null || shown.items.length === 0 || (await read($, isHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>
            mimo-supervisor · noted {shown.items.length} ({hhmm(shown.at)}){' '}
          </Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {shown.items.map((f, i) => (
          // The two severities are drawn apart: one worth stopping for leads with `!`,
          // one that can wait is dimmed, so a real problem is not buried under things
          // that could wait. The number in front is what you point at if you ever
          // answer it — the README has the words; they are not printed here, since
          // most people never answer and the hint would only be noise to them.
          <Text key={`item-${i}`} wrap="truncate-end" bold={f.severity === 'you-should-know'} dimColor={f.severity === 'heads-up'}>
            {f.severity === 'you-should-know' ? '! ' : '~ '}
            {i + 1}. {f.what}
          </Text>
        ))}
      </Box>
    )
  })
}
