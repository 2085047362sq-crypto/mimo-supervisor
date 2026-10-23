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
  mode: 'off',
  watches: false,
  why: 'not looked at yet',
  every: 3,
  told: 0,
  last: '',
  raised: [],
  quietPasses: 0,
  reviewer: '',
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
        <Text bold>
          {s.watches ? '监视中' : '已停止'}
          {s.watches ? ` · 每 ${s.every} 步新工作检查一次` : ''}
        </Text>
        {/* 审查员和主会话是两个模型,分开写清楚——不然看的人会把主会话
            的模型名当成审查员的(切到 flash 之后这里最容易误会)。 */}
        <Text dimColor>审查员 {s.reviewer || '(主模型 fork)'} · {s.why}</Text>
        <Text dimColor>
          本会话共报出 {s.told} 条提醒{s.last === '' ? '' : ` · 最近一次 ${s.last}`}
        </Text>
        {/* 去重记忆:审查员"已经说过"的句子,以后不会再重复提(封顶 24 条)。
            和上面"报出几条"是两回事——一个是本会话的产出,一个是防复读的记忆。
            两者都存在会话状态里,这条线也是测试确认 pass 写入了状态的地方。 */}
        <Text dimColor>
          去重记忆 {s.raised.length} 条:已说过的不会再重复 · 连续空审查 {s.quietPasses} 次
        </Text>

        {shown === null || shown.items.length === 0 ? (
          <Text dimColor>暂无正在提醒的条目。</Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              正在提醒 {shown.items.length} 条(! 该尽快处理 · ~ 可稍后)
            </Text>
            {shown.items.slice(-room).map((f, i) => (
              <Box key={`pane-${i}`} flexDirection="column">
                <Text bold={f.severity === 'you-should-know'} dimColor={f.severity === 'heads-up'}>
                  {f.severity === 'you-should-know' ? '! ' : '~ '}
                  {i + 1}. {f.what}
                </Text>
                <Text dimColor>      证据: {f.evidence}</Text>
                <Text dimColor>      代价: {f.cost}</Text>
              </Box>
            ))}
          </Box>
        )}
        {/* 回应图例原先画在横幅上;横幅删了,它跟着搬到这里——
            否则 learn 1 这些写法就无处可见了。 */}
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            回应(下一条消息里打):learn 1 知道了 · dismiss 1 不相关 · more like 1 多来点 · learn all 全部关掉 · undo &lt;n&gt; 放出
          </Text>
        </Box>
      </Box>
    )
  })
}
