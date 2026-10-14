# mimo-supervisor

**给接了 mimo-v2.6-pro 的 Claude Code 补上 "You should know"。**

每隔几步，它分出一次旁路审查，看一眼会话到目前为止的工作。发现模型现在就该处理的问题，就直接告诉模型，同时在提示框上方把同样的条目显示给你。

**装着但待命。** 插件一直都在，命令一直可敲，但**不敲 `/mimo-supervisor` 它就什么都不做**——不审查、不花钱、不打扰。要用了敲一句，就只对这一个对话生效。

[English](README.md)

## 为什么做

Claude Code 自带一个叫 "You should know" 的侧边代理，会看着 Claude 干活，把它注意到的问题提出来。但只要 `ANTHROPIC_BASE_URL` 指向的不是 Anthropic，它就会被隐藏：在 2.1.290 上，单这一个变量就能把它关掉。所以用 Claude Code 接 mimo 或其他 Anthropic 兼容接口时，没有任何东西在看着它干活。

mimo-supervisor 就是来补这个空的。

设计上参考了 [deepseek-supervisor](https://github.com/LACAN-1/deepseek-supervisor)。识别方式和几个已知毛病见[和原版的区别](#和原版的区别)。

## 它做什么

主循环每完成 **3 步**（子代理的步数不算），它就分叉出一次审查。**间隔是固定的**——你说 3 步就是 3 步，不会因为查不到东西就偷偷拉宽。想省 fork 的话，`/mimo-supervisor interval auto` 打开"连续空则逐次翻倍到 24 步、有发现就复位"的模式。审查只找下面这几类问题：

- **悄悄选了一种读法**：你的要求有两种读法，结果不一样，模型没问就按其中一种做了。
- **发现了问题却没说**：它看到了不对的地方，没告诉你就继续往下做。
- **说法没有依据**：说"已验证""能跑""看着没问题"，却没有命令、数字或文件支撑；或者描述了一张根本没打开过的图。
- **没试过就说做不到。**
- **范围悄悄变大**，没有说明。
- **盲调**：连改几次都没效果，中间什么也没测。
- **说完成之后又改了文件**，没说改了哪些。

它默认什么都不说。每次最多报 2 条，已经说过的不再重复。

**每条带严重度**，两种画法不同：

| 标记 | 含义 | 显示 |
|---|---|---|
| `!` **you-should-know** | 现在就值得停下来处理 | **加粗** |
| `~` heads-up | 可以再等等 | 淡化 |

两条里的名额按严重度分配，不按审查员写下的先后 —— 一条"再等等"的挤不掉唯一的那条"现在就处理"。

审查员读的是完整会话（含你的文件内容和命令输出），所以提示词里明令**禁止它复述秘密、凭据、令牌、密码、环境变量或个人数据** —— 要引用就写"`.env` 里的那个 key"、"settings 里的密码",不引原文。

发现会送到两个地方：

- **给模型**：作为一条提示，模型在下一步就会读到。提示里写明这是审查员的观察，不是你的指令，不授权你要求以外的任何事。这么写是因为审查读的会话记录里可能有来自网页的文本。
- **给你**：显示在提示框上方的一栏里，带一个 **Hide** 按钮。你再发两条消息后它会自动清掉，和 "You should know" 的卡片一样。

## 它怎么认出 mimo

这一段是这次移植真正的改动，值得说清楚。

原版只看 `ANTHROPIC_BASE_URL` 是不是 Anthropic 的地址。但在这台机器上，这个变量是 `http://127.0.0.1:18080/anthropic`——一个本地代理，地址里根本不带模型名，它后面接什么模型由 `ANTHROPIC_*_MODEL` 决定。只看地址，就没法把 mimo 和接在同一代理上的其他模型区分开。

所以 mimo-supervisor 看的是**模型 ID**，分两层取：

1. **`$.session.model()`**——也就是 `/model` 显示的那个，主循环真正解析出来的模型。这是准的，包括启动时用 `--model` 传进来的，而环境变量记不到这种。
2. 环境变量兜底，依次读 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_CUSTOM_MODEL_OPTION`，取第一个有值的。

取到的名字匹配 `mimo` 就开工。**两层都取不到名字时**，才退回原版的规则：只要不是 Anthropic 的接口就开工——那种情况下看不出是什么模型，但总比不看好。状态栏会写明它凭什么这么判断。

| | |
|---|---|
| 状态面板 | 一个 `Pane`，显示 `watching`/`off`/`idle`、判定理由、当前间隔、已提条数，以及**带证据和代价的最近条目**。**不再有状态栏**：宿主会给 `$.ui.status` 的文字前加一个 ⚠ 图标且无法关闭，所以状态改走面板 |
| `/mimo-supervisor` | **这就是开关。** 裸命令开始监视，并打开面板。插件装着但待命，不敲它就什么都不做 |
| `/mimo-supervisor off` | 停止监视，顺带清掉提示框上方那一栏 |
| `/mimo-supervisor on` / `auto` | 同上但明确指定；`auto` 表示"只在模型是 mimo 时才盯" |
| `/mimo-supervisor show` | 把横幅叫回来。Hide 只是收起显示，条目还在，等下一条提问之后才会被清掉 |
| `/mimo-supervisor log` | 最近 10 次审查，含发现的条目和耗时 |

### 反馈（完全可选，不用也没关系）

**你什么都不用做。** 插件提醒完就走，横幅自己消失。下面这些只在你**想**管它的时候才用——不理它，它照样正常工作。

想让它闭嘴或多提醒时，**顺口说一句**就行（不用按任何按钮）：

| 命令 | 你说的 | 以后 |
|---|---|---|
| 你说 | 意思 | 以后 |
|---|---|---|
| `learn 1` | "这个我知道了" | **永远不再提**（比"已经说过"更硬） |
| `dismiss 2` | "这跟我没关系" | 不再提 |
| `more like 1` | **"这种提醒很好"** | 遇到**新的**同类继续报 |
| `/mimo-supervisor learned` / `dismissed` / `appreciated` | 看看各记了什么 |
| `/mimo-supervisor unlearn \| undismiss \| unappreciate <n>` | 放出来 |

**怎么指到某条**：横幅上每条前面有编号，用 `learn 1` 指第 1 条，`learn 1,2` 指两条。也可以加引号引用原话 —— `learn "5 = 5%"`。

⚠️ **只有编号或引号会被当成反馈**。写别的字（哪怕以 `learn` 开头）都当正常请求发给模型，比如 `learn how the cache works` 不会被吃掉。这是故意的——免得你的正常话凭空消失。

三档按**工作目录**分开记，换个项目互不影响。
| `/mimo-supervisor interval <n>` | 固定审查间隔为 n 步（1–24，默认 3）。**调小让审查更早启动，能在当次回合内出结果**。手设的数字**就是**固定值，空审查不会把它拉宽 |
| `/mimo-supervisor interval auto` | 打开省 fork 模式：3 步起，连续空则翻倍到 24，有发现立刻复位 |

**开不开按工作目录各自记住。** 敲一次 `/mimo-supervisor`，这个**项目**以后的新对话都自动开着；换一个项目目录就是待命状态，要单独敲一次。两边互不干扰。

判断依据是**项目根目录**（`$.session.root()`，不是 `cwd`）：会话启动在哪、或 `/cd` 移到哪就算哪个项目，干活时 shell 的 `cd` 不影响。比较时忽略大小写和斜杠方向，`C:\Work\ALPHA` 和 `c:/work/alpha/` 是同一个项目。

插件的存储（`$.store`）在 `~/.claude/plugins/store/mimo-supervisor_*.json`，由这台机器上**所有会话共用**。里面有五样东西：

| 键 | 内容 | 作用域 |
|---|---|---|
| `modes` | 每个工作目录的开关（开/关/待命） | **按目录** |
| `learned` / `dismissed` / `appreciated` | 三档反馈 | **按目录** |
| `history` | 最近 50 次审查，含每条发现引用的证据 | 全局 |
| `every` | 你用 `interval` 设的审查间隔 | **改一次，所有会话都变** |

想备份或清空反馈，就改这个文件里对应的 `learned` / `dismissed` / `appreciated`。

这些只存在本机，不会发到任何地方。

会话自己的记忆（已说清单、退避档位、计数）在**另一个地方**（`$.state`）：它跨重载保留，但**不跨会话**——换个会话就从头记起。

## 需要什么

- **Claude Code 2.1.290 或更高**。开发和测试都在 **2.1.293** 上进行。

这个版本要求是硬的，不是随便写的：插件用到的 `$.model.fork`（审查通道）、`$.session.append`（把发现投给模型）、`AbovePrompt`（提示框上方那栏）、`atom`/`update`/`read`（状态）在 **2.1.246 里根本不存在**。在旧版上跑只会静默失效。2.1.246 的插件 API 是另一套小得多的东西（只有 `model.complete`、`session.messages`、`store.get` 等），要用它得整套重写。

## 安装

先升级 Claude Code（如果你还在 2.1.246）：

```powershell
npm i -g @anthropic-ai/claude-code@2.1.293
```

> **这台机器上已经装好了**，用户级、从 `<插件目录>` 读，所有项目可用。下面这段是给换机器或重装看的。

把 GitHub 仓库加为 marketplace，然后安装：

```powershell
claude plugin marketplace add 2085047362sq-crypto/mimo-supervisor
claude plugin install mimo-supervisor@mimo-supervisor --scope user
```

`--scope user` 让它在**所有项目**都能用；只想在某一个项目用，去掉这个参数。

或者从本地 clone 运行——把 clone 的目录放在**固定**位置（别放桌面或临时文件夹，移动会让所有项目同时失效），然后：

```powershell
claude plugin marketplace add <本地目录>
claude --plugin-dir <本地目录>
```

没法加命令行参数时（比如会话是别的应用启动的），把这个目录写进环境变量 `CLAUDE_CODE_PLUGIN_DIRS`。

装完用 `claude plugin list` 看 `Read from:` —— **那才是它真正在读的地方**，以后改代码要改那里。

## 成本

每次审查都会分叉整个会话，也就是把完整上下文重读一遍。**能不能命中缓存取决于你的接口，别假设它便宜。**

本机这个本地代理上实测：fork 回报的 `input_tokens` 和 `cache_read_input_tokens` **都是 0**，所以成本没法从 token 数推出来。而按 API 文档，fork 的 `cache_read_input_tokens` 接近 0 往往意味着缓存没命中、**整段转录前缀是按原价付的**——那是贵的那一种，不是原版 README 说的"大部分命中缓存"。

所以 `/mimo-supervisor log` 记的是**墙钟毫秒**（实测一次审查 11–14 秒），token 用量原样附上但不据它算钱。代价可以参考：一次实测的审查花了 11 秒换回 `{"findings": []}`。间隔自动拉宽正是为了摊薄这个。开之前先自己估一下。

## 和原版的区别

| | 原版（deepseek-supervisor） | 这版（mimo-supervisor） |
|---|---|---|
| 认模型 | 只看接口地址 | 先看 `$.session.model()`，再看环境变量，都认不出才看接口地址 |
| 一次最多报几条 | 提示词说 2 条，解析器却留 3 条 | 统一为 2 条（`MAX_ITEMS`），解析器跟着提示词 |
| 记住说过什么 | 最近 12 条，作者自己遇到重复 | 最近 24 条 |
| 「默认不报」 | 只有一句 | 单独成条，并要求条目必须能改变下一步的动作，禁止带"可能""也许"的条目 |
| 审查间隔 | 固定每 6 步 | 默认固定每 **3** 步；`interval auto` 才开"连续空则翻倍到 24" |
| fork 卡死 | 无兜底，`isWatching` 会永久卡住 | 120 秒看门狗，超时放行下一次 |
| 成本记录 | token 数 | 墙钟毫秒 + 原始用量（本地代理上 token 数是 0） |
| 已说过的条目 | what + evidence + cost 全量重发 | 只发 `what` |
| 每步开销 | 每步算一次"该不该跑"，最多 8 次引擎调用 | 每条提问算一次，步骤内读缓存 |
| 命令与状态名 | `deepseek-supervisor` | `mimo-supervisor` |

审查清单那七条**一字未改**：它们是模型无关的，而且是这份代码里最值钱的部分。

## 已知局限

- **审查未必能在当次回合内出结果。** fork 要 11–14 秒才回来，而一个回合可能几步就结束，那时发现只能影响**下一个**回合。默认 3 步已经是权衡过的起点；再调小（`interval 2`）能让审查更早启动、更可能当次生效，代价是同一段工作分叉更多次。
- **面板在窄终端里的首屏时机。** 会话开始自动打开的面板要 ≥144 列才展开；不过它现在也会在**你发第一条消息时**重开一次，而"被你问过"的面板以任意宽度展开，所以窄终端第一条消息之后就能看到。
- **判定缓存最迟滞后到下一条提问。** "该不该跑"按提问算一次，用 `/model` 中途换模型的话，要到下一条提问才重新判定。
- **成本仍是估算。** 本地代理不回报 token，只有墙钟是准的。
- **步数计器不跨重载保留。** 已说清单、退避档位、计数都存在 `$.state` 里，重载后仍在；只有步数计器从零开始，后果是重载后的第一次审查晚几步来。
- **审查清单是固定那七条，没有自定义入口。** 你不想自己维护条目，所以 `check` 通道已移除。真要针对 mimo 调整，直接改 `hooks/prompt.ts` 里 `watchPrompt` 的那七行，改完 `/reload-plugins` 生效。

## 开发

```powershell
claude plugin validate .
claude plugin test .
```

Claude Code 第一次加载插件时，会把类型声明写进 `.claude-plugin/types/`；之后用 `tsc -p .` 就能做类型检查。当前 **34 个测试全过**。

| 文件 | 作用 |
|---|---|
| `hooks/register.ts` | 计步与退避、审查、看门狗、模型识别、给模型的提示、on/off/auto 开关、命令 |
| `hooks/prompt.ts` | 审查用的提示词，以及解析模型的回答 |
| `hooks/band.tsx` | 提示框上方那一栏 |
| `hooks/pane.tsx` | 状态面板，替代被 ⚠ 污染的状态栏 |
| `types/index.d.ts` | 审查条目的结构和插件状态的约定 |
| `tests/watch.test.ts` | 34 个测试，跑在 Claude Code 的插件测试工具上 |

## 许可证

MIT，版权归 LACAN-1。本仓库是在 [LACAN-1/deepseek-supervisor](https://github.com/LACAN-1/deepseek-supervisor) 基础上的衍生作品，原始版权声明保留在 [LICENSE](LICENSE) 中。
