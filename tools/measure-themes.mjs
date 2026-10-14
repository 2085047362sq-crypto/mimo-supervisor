#!/usr/bin/env node
// 量一量这个插件报的东西里有多少是「同一个教训换措辞」反复报的——这是判断它吵不吵、
// 去重有没有用的可复现基线。用法：
//   node tools/measure-themes.mjs [path/to/store.json]
// 不给路径就用本机默认那份 .claude/plugins/store/mimo-supervisor_*.json 里最大的。
//
// 关键:这里把两类**分开数**,不混计——
//   meta     「没测就断言 / 没读数据就下结论」——元教训,报一次就够,反复报就是噪声。
//   tech     「验证 X 能不能 Y」——技术任务,每次都是新事实,不是重复,不该被抑制。
// 早先把两者混进一个正则会把「先测再断言」数虚高(把技术验证也算了进去),
// 用那个数去调抑制强度会把有用的「验证 X」一起砍掉。所以下面按 meta 优先、tech 兜底 归类,
// 且每个 what 只计入一类。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const arg = process.argv[2]
let file = arg
if (!file) {
  const dir = path.join(os.homedir(), '.claude', 'plugins', 'store')
  const cands = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith('mimo-supervisor') && f.endsWith('.json'))
        .map((f) => ({ f: path.join(dir, f), n: safeLen(path.join(dir, f)) }))
        .sort((a, b) => b.n - a.n)
    : []
  file = cands[0]?.f
}
if (!file || !fs.existsSync(file)) {
  console.error('no store json found; pass a path: node tools/measure-themes.mjs <store.json>')
  process.exit(1)
}

function safeLen(p) {
  try { return (JSON.parse(fs.readFileSync(p, 'utf8')).history || []).length } catch { return 0 }
}

const j = JSON.parse(fs.readFileSync(file, 'utf8'))
const whats = []
for (const p of j.history || []) if (Array.isArray(p.findings)) for (const it of p.findings) whats.push(it.what || '')

// meta 优先:先认「没测/没读/推断」这类过程批判;剩下的「验证/确认 X」才归技术任务。
const META = /没测|没读|没验证|没确认|没.{0,4}(依据|证据|就)|先读|先测|推断|臆测|就断言|下结论|别没读|没.*读.*log|没.*读.*日志|without (measur|read|test|verif|check)|no measurement|没数就|目测/i
const TECH = /验证|确认|检查|核实|verify|confirm|check/i
const OTHER = {
  '构建/编译后': /构建|编译|build|未编译|补.*标签|再写|csproj|复制.*输出/i,
  '翻页/翻牌': /翻页|翻牌|翻转|place-items|flipDigit|上下半|机械感/i,
  '拖动/命中': /拖动|拖拽|拖不|HTCAPTION|WM_NCHITTEST|命中/i,
  '玻璃/外观': /玻璃|折射|毛玻璃|磨砂|背景|圆角|液态|Acrylic|backdrop|WebGL/i,
  '别替用户决定': /别替|先问|问清|二选一|放手做|默认一套/i,
  '清理/收尾': /删|清理|收尾|死代码|快捷方式|启动入口|依赖/i,
}

const bucket = { meta: [], tech: [], ...Object.fromEntries(Object.keys(OTHER).map((k) => [k, []])) }
for (const w of whats) {
  if (META.test(w)) bucket.meta.push(w)
  else if (TECH.test(w)) bucket.tech.push(w)
  else {
    let hit = false
    for (const [k, re] of Object.entries(OTHER)) if (re.test(w)) { bucket[k].push(w); hit = true; break }
    if (!hit) bucket['其他'] ??= [], bucket['其他'].push(w)
  }
}

console.log(`文件: ${file}`)
console.log(`发现总数 = ${whats.length}\n`)
console.log('按类分开计数(meta=过程元教训,反复报即噪声; tech=技术验证任务,是新事实不是重复):')
for (const [k, arr] of Object.entries(bucket)) {
  if (arr.length === 0) continue
  const tag = k === 'meta' ? '⚠ 元教训(该只报一次)' : k === 'tech' ? '  技术验证(不该抑制)' : ' '
  console.log(`  ${tag} [${arr.length}x] ${k}`)
}
const meta = bucket.meta.length
console.log(`\n元教训(meta)被报 ${meta}/${whats.length} 次 = ${whats.length ? Math.round((meta / whats.length) * 100) : 0}%  ← 这个该趋近 1 次,是「变安静」的度量`)
console.log(`技术验证(tech) ${bucket.tech.length} 次  ← 这些是正常的,别拿 meta 计数去压它们`)
console.log('\nmeta 类的原文(看是不是同一个教训换措辞):')
for (const w of bucket.meta) console.log('  · ' + w.slice(0, 80))
