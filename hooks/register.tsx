import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, On, PluginOptions, Register, SessionUsage } from 'claude-code'

import type {
  AgentTotals,
  EnhanceRecord,
  EnhanceState,
  HistoryEntry,
  SessionTotals,
  TickerState,
  UsageRound,
  UsageView,
} from '../types'

// ---------------------------------------------------------------------------
// 状态
// 会话内状态热重载后保留；新会话由宿主新建 state，天然从空开始。
// shape 版本与 types/index.d.ts 的契约一一对应。
// ---------------------------------------------------------------------------

const rounds = atom(
  { plugin: 'usage-toolbar', key: 'rounds' } as const,
  [] as UsageRound[],
  { shape: 'rounds-1' },
)
const totals = atom(
  { plugin: 'usage-toolbar', key: 'totals' } as const,
  {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    requests: 0,
    turns: 0,
    genMs: 0,
    ttftTotalMs: 0,
    ttftCount: 0,
    byModel: {},
  } satisfies SessionTotals,
  { shape: 'totals-1' },
)
const agentTotals = atom(
  { plugin: 'usage-toolbar', key: 'agentTotals' } as const,
  {} as Record<string, AgentTotals>,
  { shape: 'agent-totals-1' },
)
const view = atom(
  { plugin: 'usage-toolbar', key: 'view' } as const,
  'speed' as UsageView,
  { shape: 'view-1' },
)
/**
 * 重置的两步确认是否停在第二步。
 *
 * <p>确认放在面板内部而不是 {@code $.ui.ask}：后者本质是一次工具调用，会被宿主画进
 * 会话记录；面板内的确认只存在于渲染树里。写入本状态会让面板重绘到确认步骤。</p>
 */
const resetConfirming = atom(
  { plugin: 'usage-toolbar', key: 'resetConfirming' } as const,
  false,
  { shape: 'reset-confirming-1' },
)
/**
 * 清空当前会话增强记录的两步确认是否停在第二步。
 *
 * <p>与重置确认同一模式：确认只存在于面板渲染树里，不调用会写入会话的 AskUserQuestion。</p>
 */
const clearConfirming = atom(
  { plugin: 'usage-toolbar', key: 'clearConfirming' } as const,
  false,
  { shape: 'clear-confirming-1' },
)
const enhanceRecords = atom(
  { plugin: 'usage-toolbar', key: 'enhanceRecords' } as const,
  [] as EnhanceRecord[],
  { shape: 'enhance-records-1' },
)
const enhanceState = atom(
  { plugin: 'usage-toolbar', key: 'enhanceState' } as const,
  null as EnhanceState | null,
  { shape: 'enhance-state-1' },
)
const ticker = atom(
  { plugin: 'usage-toolbar', key: 'ticker' } as const,
  null as TickerState | null,
  { shape: 'ticker-1' },
)

/** 增强记录跨会话存储键；最多保留 200 条。 */
const ENHANCE_STORE_KEY = 'enhance-records'
/** 用量历史跨会话存储键，保存最近 100 轮与累计快照。 */
const HISTORY_STORE_KEY = 'usage-history'
const RECORD_LIMIT = 200
const TEXT_LIMIT = 4000
/**
 * 实时速率的刷新间隔（毫秒）。
 *
 * <p>按时间节流而不是按 chunk 数量：第三方网关可能按大块返回流式内容，chunk 数不足以
 * 触发「每 N 个刷新一次」，导致整步都停在「⚡ —」。首个 text 块因 lastFlushAt 为 0
 * 会立即刷新，之后每 500 毫秒最多刷新一次。</p>
 */
const STATUS_FLUSH_MS = 500

/** 轮播定时器间隔：每 250 毫秒推进一帧点阵旋转图标，计时仍按整秒显示。 */
const TICKER_TICK_MS = 250
/** 每 20 个 tick 换一句语录，即 5 秒。 */
const TICKER_PHRASE_EVERY_TICKS = 20

/** ZCode 同款立体点阵球（单行）：三个盲文字符拼出球体轮廓，逐帧滚动。 */
const TICKER_FRAMES = ['⣠⣿⣄', '⣴⣿⣦', '⣤⣿⣤', '⣦⣿⣴', '⢠⣿⡄', '⣰⣿⣆']
/** 每帧的颜色，保留彩色轮换效果；#D97757 为 Claude 风格橙棕色。 */
const TICKER_COLORS = ['cyan', '#D97757', 'magenta', 'green']

/**
 * 趣味语录词库，顺序轮播；支持占位符 {elapsed}、{tps}、{model}。
 * 想换成自己的词包时，直接增删这里的句子即可。
 */
const TICKER_PHRASES = [
  '正在把咖啡因转换成 token',
  '正在和上下文搏斗',
  '正在翻阅记忆的抽屉',
  '正在给答案抛光',
  '正在数 token 数到手软',
  '正在和 bug 谈判',
  '正在酝酿一个灵感',
  '正在把逻辑理顺',
  '正在思考人生（和你的问题）',
  '正在努力不胡说八道',
  '正在把想法装进句子里',
  '正在给代码量体温',
  '正在整理思绪的毛线团',
  '正在寻找最优雅的解法',
  '正在替你多检查一遍',
  '正在把复杂的事说简单',
]

/** 热重载时旧副本的定时器会停止；这里保存当前定时器以避免重复启动。 */
let tickerTimer: { cancel: () => void } | null = null

/** 用量面板的 id，命令与输入框上方按钮共用。 */
const PANE_ID = 'usage'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 把 token 数格式化为状态行与面板使用的紧凑单位。 */
function fmtTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)}万`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

/** 每轮真实输出速度：输出 token ÷ 纯生成耗时。 */
function tpsOfRound(round: UsageRound): number {
  return round.genMs > 0 ? (round.outputTokens / round.genMs) * 1000 : 0
}

/** 缓存率：缓存读取 ÷ 输入侧总量；输入侧为 0 时返回 null（无读数）。 */
function cacheRateOf(
  inputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number | null {
  const inputSide = inputTokens + cacheReadTokens + cacheCreationTokens
  return inputSide > 0 ? (cacheReadTokens / inputSide) * 100 : null
}

/**
 * 缓存率分档颜色：<80% 红色告警，80–90% 黄色告警，90–95% 绿色，≥95% 青色。
 *
 * <p>区间左闭右开，红色档与黄色档不重叠，红色告警的优先级由区间保证；
 * 无读数（null）不着色，保持默认文本色。</p>
 */
function cacheRateLevel(rate: number | null): string | undefined {
  if (rate === null) return undefined
  if (rate < 80) return 'error'
  if (rate < 90) return 'warning'
  if (rate < 95) return '#3AAC85'
  return '#2C8F87'
}

/**
 * 状态行文本：速度、本轮 token、会话 token 与上下文占比。
 *
 * <p>生成中传 {@code isLive=true}，显示实时估算速度；空闲时显示「最近 X t/s」，
 * 明确它来自上一轮而不是当前实时值。</p>
 */
function statusText(
  tps: number | null,
  roundTokens: number,
  sessionTokens: number,
  contextPercent: number | null,
  isLive = false,
): string {
  // 生成中显示实时速度（尚无样本时为「—」）；空闲时干脆不显示速度。
  const speed = tps === null
    ? isLive ? '⚡ —' : ''
    : isLive ? `⚡ ${tps.toFixed(1)} t/s` : `⚡ 最近 ${tps.toFixed(1)} t/s`
  const parts = [speed, `本轮 ${fmtTokens(roundTokens)}`, `会话 ${fmtTokens(sessionTokens)}`].filter(
    part => part.length > 0,
  )
  const context = contextPercent === null ? '' : ` · 上下文 ${contextPercent}%`
  return `${parts.join(' · ')}${context}`
}

/** 面板与记录列表使用的时间格式：MM-DD HH:mm。 */
function formatTime(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 长文本截断，保留可读前缀与省略号。 */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 显示用的模型名：去掉 workbuddy/ 这类供应商前缀，只留模型本身。 */
function modelLabel(model: string): string {
  const slash = model.lastIndexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

/**
 * 速度档位与颜色：按参考插件的档位说明图分级。
 *
 * <p>区间左闭右开（如 40-70 表示 40 ≤ 速度 &lt; 70）；颜色取自该图各档位文字的主色，
 * 终端会按 256 色近似渲染。label 直接使用区间文本，与图例保持一致。</p>
 */
function tpsLevel(tps: number | null): { label: string; color: string } {
  if (tps === null) return { label: '—', color: 'gray' }
  if (tps < 40) return { label: '<40', color: '#DF7A68' }
  if (tps < 70) return { label: '40-70', color: '#C19145' }
  if (tps < 150) return { label: '70-150', color: '#3AAC85' }
  if (tps < 200) return { label: '150-200', color: '#2C8F87' }
  if (tps < 300) return { label: '200-300', color: '#2784B0' }
  if (tps < 500) return { label: '300-500', color: '#5974D4' }
  if (tps < 800) return { label: '500-800', color: '#7762CC' }
  if (tps < 1000) return { label: '800-1000', color: '#8E57C3' }
  if (tps < 2000) return { label: '1000-2000', color: '#A14FB1' }
  return { label: '≥2000', color: '#7F62D1' }
}

/**
 * 把 #rrggbb 转成带透明度的 rgba 字符串，供 SVG 面积层使用。
 *
 * <p>SVG 内部无法引用宿主主题变量，颜色只能烘焙成字面量；非十六进制输入
 * （主题键或颜色名）回退为中性灰，避免面积层退化成纯黑或完全透明。</p>
 */
function hexToRgba(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) return `rgba(127,127,127,${alpha})`
  const n = parseInt(match[1] ?? '808080', 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/** 主题语义色在 SVG 内的兜底色值；SVG 的 fill 只接受具体值，不认主题键名。 */
const SVG_THEME_HEX: Record<string, string> = {
  warning: '#C19145',
  error: '#DF7A68',
  success: '#3AAC85',
  text: '#191919',
  subtle: '#747774',
}

/**
 * 把主题键或十六进制色统一成 SVG 可用的十六进制值。
 *
 * <p>分档函数在黄色与红色档返回主题键（{@code warning} / {@code error}），
 * 直接写进 SVG 会被浏览器忽略并回退成黑色；这里按 {@link SVG_THEME_HEX} 映射，
 * 未知键回退到调用方给的默认色，保证进度条始终有可见填充色。</p>
 */
function svgColor(color: string | undefined, fallback: string): string {
  if (typeof color === 'string' && color.startsWith('#')) return color
  if (typeof color === 'string') {
    const mapped = SVG_THEME_HEX[color]
    if (mapped !== undefined) return mapped
  }
  return fallback
}

/**
 * 上下文占比水位条：10 个独立圆角方块，按百分比填充前 N 个。
 *
 * <p>与设计稿一致的方块阵列：每格 6×8px、间隙 2px、圆角 1.5px，未填充格用浅灰轨色。
 * 字符水位条（{@code █} / {@code ░}）在桌面端会渲染成受字距影响的小方块与点阵噪声，
 * 因此桌面端改用 SVG 精确绘制；终端 surface 没有 Svg 元素，仍由字符水位条兜底。</p>
 */
function contextBarSvg(percent: number, fill: string): string {
  const cells = 10
  const cellWidth = 6
  const gap = 2
  const height = 8
  const radius = 1.5
  const totalWidth = cells * cellWidth + (cells - 1) * gap
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" viewBox="0 0 ${totalWidth} ${height}">`,
  ]
  for (let i = 0; i < cells; i += 1) {
    parts.push(
      `<rect x="${i * (cellWidth + gap)}" y="0" width="${cellWidth}" height="${height}" rx="${radius}" fill="${i < filled ? fill : '#CECCCE'}"/>`,
    )
  }
  parts.push('</svg>')
  return parts.join('')
}

/** 图表刻度与柱顶数值的中性灰：比旧的 #8A8F98 更深，保证 9px 小字在浅色底上可读，深色底仍可分辨。 */
const SVG_LABEL_COLOR = '#5F6775'

/**
 * 生成速度趋势 SVG：折线、半透明面积、三条水平网格线与最新值标注。
 *
 * <p>只使用基础图元（line / polyline / path / circle / text），不引入渐变、滤镜
 * 或脚本，桌面端可以按静态图片光栅化；网格与刻度统一用中性灰，在浅色和深色
 * 底色上都可读，档位色只用于折线、数据点与最新值。</p>
 *
 * <p>数据来源：速度视图最近若干轮的输出速度（时间顺序）；结果作为 {@code Svg}
 * 的 source 内联绘制。点数少于 2 时返回空串，由调用方降级为字符 sparkline。</p>
 *
 * <p>宽度由调用方按面板可用列数传入，viewBox 与像素尺寸保持 1:1：面板变宽时
 * 只增加横向绘图空间，刻度与数值字号不变，不会被整体放粗。</p>
 */
function speedChartSvg(points: readonly number[], color: string, width = 560, height = 110): string {
  if (points.length < 2) return ''
  const left = 36
  const right = 14
  const top = 14
  const bottom = 18
  const innerW = width - left - right
  const innerH = height - top - bottom
  // 纵轴取整到 10 的倍数并留 15% 余量，避免峰值点贴顶。
  const max = Math.max(10, Math.ceil((Math.max(...points) * 1.15) / 10) * 10)
  const stepX = innerW / (points.length - 1)
  const xOf = (index: number) => left + index * stepX
  const yOf = (value: number) => top + innerH - (Math.max(0, value) / max) * innerH
  const coords = points.map((value, index) => `${xOf(index).toFixed(1)},${yOf(value).toFixed(1)}`)
  const baseline = (top + innerH).toFixed(1)
  const lastX = xOf(points.length - 1)
  const lastY = yOf(points[points.length - 1] ?? 0)
  const lastValue = points[points.length - 1] ?? 0
  const grid = [0, 0.5, 1]
    .map(ratio => {
      const gy = top + innerH - ratio * innerH
      const label = Math.round(max * ratio)
      return `<line x1="${left}" y1="${gy.toFixed(1)}" x2="${width - right}" y2="${gy.toFixed(1)}" stroke="rgba(127,127,127,0.22)" stroke-width="1" stroke-dasharray="3 4"/><text x="${left - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end" font-family="monospace" font-size="9" fill="${SVG_LABEL_COLOR}">${label}</text>`
    })
    .join('')
  const areaPath = `M${left},${baseline} ${coords.map(coord => `L${coord}`).join(' ')} L${lastX.toFixed(1)},${baseline} Z`
  const dots = points
    .map((value, index) => `<circle cx="${xOf(index).toFixed(1)}" cy="${yOf(value).toFixed(1)}" r="2" fill="${color}"/>`)
    .join('')
  const labelX = Math.min(width - right, lastX + 8)

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${grid}<path d="${areaPath}" fill="${hexToRgba(color, 0.16)}"/><polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" fill="${color}" stroke="${hexToRgba(color, 0.3)}" stroke-width="5"/><text x="${labelX.toFixed(1)}" y="${(lastY - 8).toFixed(1)}" text-anchor="end" font-family="monospace" font-size="10" fill="${color}">${lastValue.toFixed(1)}</text></svg>`
}

/**
 * 生成轮次柱状图 SVG：每轮一根柱，柱顶标速度、底部标轮次序号、左侧标速度刻度。
 *
 * <p>柱宽按轮次数均分可用宽度，单根上限 56px，避免宽面板下柱子过细而疏。柱顶数值与
 * 底部序号在步距不足时按间隔稀疏标注：从最新一根向前数，保证最右侧轮次一定有编号与
 * 读数；轮次少、步距够宽时步距为 1，退化为逐根标注。宽度由调用方按面板可用列数传入，
 * 字号不随宽度放大。柱色由调用方按该轮档位传入，和折线图、指标卡保持同一套颜色语义。
 * 无数据时返回空串，由调用方退回字符条形图。</p>
 */
function speedBarsSvg(values: readonly number[], colors: readonly string[], width = 560, height = 160): string {
  if (values.length === 0) return ''
  const left = 36
  const right = 12
  const top = 18
  const bottom = 24
  const innerW = width - left - right
  const innerH = height - top - bottom
  // 纵轴留 20% 余量，柱顶数值不会被裁掉。
  const max = Math.max(10, Math.ceil((Math.max(...values) * 1.2) / 10) * 10)
  const slot = innerW / values.length
  const barW = Math.max(6, Math.min(56, slot * 0.66))
  const baseline = top + innerH
  const grid = [0, 0.5, 1]
    .map(ratio => {
      const gy = baseline - ratio * innerH
      const label = Math.round(max * ratio)
      return `<line x1="${left}" y1="${gy.toFixed(1)}" x2="${width - right}" y2="${gy.toFixed(1)}" stroke="rgba(127,127,127,0.22)" stroke-width="1" stroke-dasharray="3 4"/><text x="${left - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end" font-family="monospace" font-size="9" fill="${SVG_LABEL_COLOR}">${label}</text>`
    })
    .join('')
  // 柱顶数值与底部序号按步距稀疏标注：50 轮时 slot 只有 10–20px，逐根标会互相压住。
  // 从最右一根向前每隔 stride 根标一次，保证最新轮次一定有读数；轮次少时 stride 为 1，
  // 与逐根标注完全等价。
  // 柱顶读数实际最长宽度（9px 等宽约 5.4px/字符）决定步距：18 根柱、读数 4 字符时
  // 仍逐根标注，出现 3 位数读数才隔根。
  const labelWidth = Math.max(...values.map(value => value.toFixed(1).length)) * 5.4 + 2
  const valueStride = Math.max(1, Math.ceil(labelWidth / slot))
  const indexStride = Math.max(1, Math.ceil(16 / slot))
  const bars = values
    .map((value, index) => {
      const x = left + index * slot + (slot - barW) / 2
      const barHeight = Math.max(1, (Math.max(0, value) / max) * innerH)
      const y = baseline - barHeight
      const labelY = Math.max(top + 9, y - 4)
      const centerX = x + barW / 2
      const fromEnd = values.length - 1 - index
      const valueText =
        fromEnd % valueStride === 0
          ? `<text x="${centerX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-family="monospace" font-size="9" fill="${SVG_LABEL_COLOR}">${value.toFixed(1)}</text>`
          : ''
      const indexText =
        fromEnd % indexStride === 0
          ? `<text x="${centerX.toFixed(1)}" y="${(height - 6).toFixed(1)}" text-anchor="middle" font-family="monospace" font-size="9" fill="${SVG_LABEL_COLOR}">${index + 1}</text>`
          : ''
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="2" fill="${colors[index] ?? '#3AAC85'}"/>${valueText}${indexText}`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${grid}${bars}</svg>`
}

/**
 * 生成单轮速度块条 SVG：只画格子，不含任何文字。
 *
 * <p>宿主面板的 SVG 渲染器与浏览器对 text 的字体大小和基线处理不同：把序号、速率画进
 * SVG 会被放大并向左撑进条区，同时与相邻行产生半行错位。因此 SVG 只负责格子，文字交给
 * 宿主的 Text 组件排版，两者在 flex 行内各占一列，任何字体度量都不会相交。</p>
 *
 * <p>格子按 value / maxValue 的比例点亮，非零值至少一格；格数按宽度推导（约 16px 一格，
 * 限制在 8–40 格），单格宽度 = 步距 - 3px 间隙。调用方保证 width ≥ 160。</p>
 */
function speedBarRowSvg(value: number, maxValue: number, color: string, width: number, height: number): string {
  const cells = Math.max(8, Math.min(40, Math.floor(width / 16)))
  const pitch = width / cells
  const cellW = Math.max(2, pitch - 3)
  const lit = value <= 0 ? 0 : Math.max(1, Math.min(cells, Math.round((value / maxValue) * cells)))
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
  ]
  for (let i = 0; i < cells; i += 1) {
    parts.push(
      `<rect x="${(i * pitch).toFixed(1)}" y="0" width="${cellW.toFixed(1)}" height="${height}" rx="1.5" fill="${i < lit ? color : '#CECCCE'}"/>`,
    )
  }
  parts.push('</svg>')
  return parts.join('')
}

/** 把工作中耗时格式化为「X 分 X 秒」。 */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`
}


// ---------------------------------------------------------------------------
// 采集
// ---------------------------------------------------------------------------

/**
 * 一轮进行中的采集状态。
 *
 * <p>turn.start 建立，turn.step 逐步累加纯生成耗时与 TTFT，turn.complete 归一化为
 * UsageRound。主循环与子代理共用同一结构，由 agentId 区分；它只存在内存，热重载会
 * 丢失进行中的轮次，下一轮开始后自然恢复。</p>
 */
type PendingTurn = {
  startedAt: number
  genMs: number
  ttftMs: number | null
  model: string
  agentId?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

const pending = new Map<string, PendingTurn>()

/**
 * 状态行缓存：避免生成中的每个 chunk 都调用 $.session.usage()。
 * turn.complete 时刷新一次，生成中直接用缓存拼实时速度。
 */
const statusCache = {
  sessionTokens: 0,
  contextPercent: null as number | null,
  lastTps: null as number | null,
}

/** 指标分档颜色：青=最佳、绿=良好、黄=偏慢/偏高、红=告警；与缓存率同一套语义。 */
const TIER_COLORS = {
  teal: '#2C8F87',
  green: '#3AAC85',
  yellow: 'warning',
  red: 'error',
} as const

/** 三档升序阈值；比较一律左闭右开，达到最后一档为红色。 */
type TierBounds = readonly [number, number, number]

/** 升序阈值取档：低于首阈为青，随后绿、黄，达到末阈为红；无读数不着色。 */
function tierColor(value: number | null, bounds: TierBounds): string | undefined {
  if (value === null) return undefined
  if (value < bounds[0]) return TIER_COLORS.teal
  if (value < bounds[1]) return TIER_COLORS.green
  if (value < bounds[2]) return TIER_COLORS.yellow
  return TIER_COLORS.red
}

/** 平均耗时阈值（毫秒）：<10s 青、10–30s 绿、30–60s 黄、≥60s 红；越低越好。 */
const DURATION_BOUNDS_MS: TierBounds = [10_000, 30_000, 60_000]
/** 上下文占比阈值（百分比）：<40 青、40–60 绿、60–80 黄、≥80 红；越高越接近压缩阈值。 */
const CONTEXT_BOUNDS_PERCENT: TierBounds = [40, 60, 80]
/** 延迟默认阈值（秒）：<2 青、2–4 绿、4–8 黄、≥8 红；可由 userConfig 覆盖。 */
const DEFAULT_LATENCY_BOUNDS_SEC: TierBounds = [2, 4, 8]

/** 秒阈值换算为毫秒。 */
function latencyBoundsMs(sec: TierBounds): TierBounds {
  return [sec[0] * 1000, sec[1] * 1000, sec[2] * 1000]
}

/** 当前生效的延迟阈值（毫秒）；register 时按 userConfig 重建，模块重载即回到默认值。 */
let latencyBounds: TierBounds = latencyBoundsMs(DEFAULT_LATENCY_BOUNDS_SEC)
/** 阈值配置无效时的回退原因，由 session.start 写调试日志。 */
let latencyConfigIssue: string | null = null

/** 延迟（毫秒）对应颜色：升序阈值左闭右开；无样本不着色。 */
function latencyColor(ms: number | null): string | undefined {
  return tierColor(ms, latencyBounds)
}

/**
 * 按 userConfig 重建延迟分档。
 *
 * <p>字段：latencyTealMaxSec / latencyGreenMaxSec / latencyYellowMaxSec（秒），
 * 默认 2 / 4 / 8。单个值缺失或非正数时按该项默认值补齐；三者未严格递增时整体回退
 * 默认值，并在 session.start 写一条调试日志；宿主已按 number 类型校验，这里只检查业务约束。</p>
 */
function applyLatencyConfig(options: PluginOptions): void {
  const read = (key: string, fallback: number): number => {
    const raw = options[key]
    const value = typeof raw === 'number' ? raw : Number(raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  const bounds: [number, number, number] = [
    read('latencyTealMaxSec', DEFAULT_LATENCY_BOUNDS_SEC[0]),
    read('latencyGreenMaxSec', DEFAULT_LATENCY_BOUNDS_SEC[1]),
    read('latencyYellowMaxSec', DEFAULT_LATENCY_BOUNDS_SEC[2]),
  ]
  if (bounds[0] < bounds[1] && bounds[1] < bounds[2]) {
    latencyBounds = latencyBoundsMs(bounds)
    latencyConfigIssue = null
    return
  }

  latencyBounds = latencyBoundsMs(DEFAULT_LATENCY_BOUNDS_SEC)
  latencyConfigIssue = `延迟阈值未严格递增（${bounds.join('/')} 秒），已回退默认 ${DEFAULT_LATENCY_BOUNDS_SEC.join('/')} 秒`
}

function emptyAgent(): AgentTotals {
  return {
    requests: 0,
    turns: 0,
    genMs: 0,
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    lastSeenAt: 0,
  }
}

/** 主循环请求计数：requests 加一，并按模型累计请求数。 */
function addRequest(byModel: SessionTotals['byModel'], model: string): SessionTotals['byModel'] {
  const key = model || 'unknown'
  const prev = byModel[key] ?? {
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    genMs: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
  return { ...byModel, [key]: { ...prev, requests: prev.requests + 1 } }
}

/** 主循环轮次汇总：把一轮的真实用量并入会话累计与模型明细。 */
function addRoundTotals(current: SessionTotals, round: UsageRound): SessionTotals {
  const key = round.model || 'unknown'
  const prev = current.byModel[key] ?? {
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    genMs: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
  return {
    ...current,
    inputTokens: current.inputTokens + round.inputTokens,
    outputTokens: current.outputTokens + round.outputTokens,
    cacheReadTokens: current.cacheReadTokens + round.cacheReadTokens,
    cacheCreationTokens: current.cacheCreationTokens + round.cacheCreationTokens,
    turns: current.turns + 1,
    genMs: current.genMs + round.genMs,
    ttftTotalMs: current.ttftTotalMs + (round.ttftMs ?? 0),
    ttftCount: current.ttftCount + (round.ttftMs === null ? 0 : 1),
    byModel: {
      ...current.byModel,
      [key]: {
        inputTokens: prev.inputTokens + round.inputTokens,
        outputTokens: prev.outputTokens + round.outputTokens,
        requests: prev.requests,
        genMs: prev.genMs + round.genMs,
        // 热重载保留的旧形状没有按模型的缓存字段，按 0 起算。
        cacheReadTokens: (prev.cacheReadTokens ?? 0) + round.cacheReadTokens,
        cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + round.cacheCreationTokens,
      },
    },
  }
}

/**
 * 刷新输入框下方的状态行。
 *
 * <p>数据来源：会话累计来自 state，上下文占比来自官方 $.session.usage()。
 * 读取失败时按「无读数」处理，清空上下文缓存并写日志，不阻断对话。</p>
 *
 * <p>会话压缩后，宿主在新窗口产生第一次响应前不提供上下文读数；压缩完成时必须调用本函数，
 * 否则状态行会继续显示压缩前的百分比。</p>
 */
async function refreshStatus($: EngineInterface): Promise<void> {
  const current = await read($, totals)
  const list = await read($, rounds)
  let contextPercent: number | null = null

  try {
    const usage = await $.session.usage()
    contextPercent = usage.context.percent ?? null
  } catch (error) {
    $.ui.log(`usage-toolbar: 读取会话用量失败 ${String(error)}`)
  }

  const last = list.length > 0 ? (list[list.length - 1] ?? null) : null
  const lastTps = last ? tpsOfRound(last) : null
  statusCache.sessionTokens = current.outputTokens
  statusCache.contextPercent = contextPercent
  statusCache.lastTps = lastTps
  $.ui.status(statusText(null, last?.outputTokens ?? 0, current.outputTokens, contextPercent, false))
}

/** 注册用量采集相关的事件钩子。 */
function registerCollectors(on: On): void {
  // 提交前增强：以 !! 开头的普通消息在回合开始前改写，第一条消息也能用。
  // 斜杠命令、用户不可见的 meta prompt 和空草稿直接放行；增强失败时按原文提交。
  on('prompt.submit', async ($, e, next) => {
    const prefix = SUBMIT_ENHANCE_PREFIXES.find(item => e.text.startsWith(item))
    if (e.command || e.isMeta || !prefix) return next(e)
    const original = e.text.slice(prefix.length).trim()
    if (!original) return next(e)

    $.ui.status('✦ 正在增强提示词…')
    const enhanced = await enhanceForSubmit($, original)
    if (enhanced === null) return next(e)
    return next({ ...e, text: enhanced })
  })

  // 子代理启动：记录所属 workflow run 与序号，供代理页按运行分组、按时间倒序展示。
  // 这是门控 hook（可改写 prompt/model、可拒绝），必须先放行 next(e)；
  // 记录失败只写调试日志，不影响子代理启动。
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const agentId = result?.agentId
    if (agentId === undefined) return result
    try {
      const now = await $.clock.now()
      await update($, agentTotals, maps => {
        const prev = maps[agentId] ?? emptyAgent()
        return {
          ...maps,
          [agentId]: {
            ...prev,
            lastSeenAt: now,
            workflowRunId: e.workflow?.runId ?? prev.workflowRunId,
            workflowIndex: e.workflow?.agentIndex ?? prev.workflowIndex,
            spawnDescription: e.description || prev.spawnDescription,
          },
        }
      })
      $.ui.log(
        `usage-toolbar: agent.spawn 已记录 agent=${agentId} run=${e.workflow?.runId ?? '-'} index=${e.workflow?.agentIndex ?? '-'}`,
        { to: 'debug' },
      )
    } catch (error) {
      $.ui.log(`usage-toolbar: agent.spawn 记录分组失败 ${String(error)}`, { to: 'debug' })
    }
    return result
  })

  // 轮次开始：记录起点，供 TTFT 与纯生成耗时使用。
  on('turn.start', async ($, e, next) => {
    const startedAt = await $.clock.now()
    pending.set(e.turnId, {
      startedAt,
      genMs: 0,
      ttftMs: null,
      model: '',
      agentId: e.agentId,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })

    // 主循环开始一轮：启动语录轮播；子代理的轮次不覆盖主会话提示。
    if (e.agentId === undefined) {
      await update($, ticker, () => ({
        phrase: TICKER_PHRASES[0] ?? '',
        index: 0,
        startedAt,
        isWorking: true,
        frame: 0,
      }))
      // 新一轮开始先把上一轮速率清掉，避免被误读成当前实时值。
      $.ui.status(statusText(null, 0, statusCache.sessionTokens, statusCache.contextPercent, true))
    }

    return next(e)
  })

  // 模型请求流：逐块采样 TTFT 与实时速度，结束时记录每步真实用量。
  // 统计失败只写日志，绝不阻断或丢弃流式块。
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    let firstTextAt: number | null = null
    let firstOutputAt: number | null = null
    let stepChars = 0
    let lastFlushAt = 0
    const turn = pending.get(e.turnId)
    if (turn && e.model) turn.model = e.model

    // 请求计数：主循环与子代理分开累计，供面板显示请求次数。
    if (e.agentId === undefined) {
      await update($, totals, current => ({
        ...current,
        requests: current.requests + 1,
        byModel: addRequest(current.byModel, e.model),
      }))
    } else {
      const agentId = e.agentId
      // 记录最后一次活动时间：代理页按时间倒序排列，最新的子代理排在最前。
      const seenAt = await $.clock.now()
      await update($, agentTotals, maps => {
        const prev = maps[agentId] ?? emptyAgent()
        return { ...maps, [agentId]: { ...prev, requests: prev.requests + 1, lastSeenAt: seenAt } }
      })
    }

    const stream = next(e)
    for await (const chunk of stream) {
      try {
        if (chunk.kind === 'text' || chunk.kind === 'thinking' || chunk.kind === 'input') {
          // TTFT 只由可见文本或思考的首块决定，工具参数不参与首字延迟。
          if (chunk.kind !== 'input' && firstTextAt === null) {
            const arrivedAt = await $.clock.now()
            firstTextAt = arrivedAt
            if (turn && turn.ttftMs === null) turn.ttftMs = arrivedAt - startedAt
          }

          // 文本、思考与工具参数 JSON 都是模型输出，统一计入实时字符；
          // 面板速度用 output_tokens，含这三类，实时值与面板口径保持一致。
          // 三个分支分别取值，不依赖联合类型在条件表达式中的窄化，兼容宿主编译器。
          let piece = ''
          if (chunk.kind === 'text') {
            piece = chunk.text
          } else if (chunk.kind === 'thinking') {
            piece = chunk.text
          } else {
            piece = chunk.json
          }
          stepChars += piece.length
          const now = await $.clock.now()
          // 速率分母从首个输出块到达时起算，与分子覆盖同一段 token 产出区间，不含首字前的等待。
          if (firstOutputAt === null) firstOutputAt = now
          // 按时间节流：首个输出块（lastFlushAt 为 0）立即刷新，之后每 500 毫秒最多一次。
          if (now - lastFlushAt >= STATUS_FLUSH_MS) {
            lastFlushAt = now
            const elapsed = now - firstOutputAt
            const tps = elapsed > 0 ? stepChars / 3.5 / (elapsed / 1000) : null
            // 本轮 = 已完成步骤的真实 output_tokens + 当前步骤的估算值。
            const roundTokens = (turn?.outputTokens ?? 0) + Math.round(stepChars / 3.5)
            statusCache.lastTps = tps
            $.ui.status(
              statusText(tps, roundTokens, statusCache.sessionTokens, statusCache.contextPercent, true),
            )
          }
        } else if (chunk.kind === 'stop') {
          const endedAt = await $.clock.now()
          if (turn) {
            turn.genMs += endedAt - startedAt
            if (chunk.usage) {
              turn.model = chunk.usage.model || turn.model
              turn.inputTokens += chunk.usage.input_tokens
              turn.outputTokens += chunk.usage.output_tokens
              turn.cacheReadTokens += chunk.usage.cache_read_input_tokens
              turn.cacheCreationTokens += chunk.usage.cache_creation_input_tokens
            }
          }

          // 子代理每个请求结束就把本轮上报的模型写入累计，不必等 turn.complete：
          // 中断的轮次也能显示模型，代理页「未知模型」的窗口从整轮缩短到首个请求。
          if (e.agentId !== undefined && chunk.usage?.model) {
            const agentId = e.agentId
            const model = chunk.usage.model
            await update($, agentTotals, maps => {
              const prev = maps[agentId] ?? emptyAgent()
              if (prev.model === model) return maps
              return { ...maps, [agentId]: { ...prev, model } }
            })
          }

          // 每次响应结束后重读宿主读数：压缩后新窗口的第一次响应一回来，上下文占比即可用，
          // 不必等到整轮结束才恢复状态行；子代理请求不改变主会话窗口，跳过。
          if (e.agentId === undefined) {
            try {
              const usage = await $.session.usage()
              statusCache.contextPercent = usage.context.percent ?? null
            } catch (error) {
              $.ui.log(
                `usage-toolbar: turn.step 结束刷新上下文失败 turn=${e.turnId} ${String(error)}`,
                { to: 'debug' },
              )
            }
            // 面板是拉取式绘制：state 写入不会自动重绘，须显式失效才会重读宿主读数。
            $.ui.invalidate('ui.render')
          }

          // 每步结束时把最终估算值推给状态行与实时快照；分母同样从首个输出块起算。
          const elapsed = endedAt - (firstOutputAt ?? startedAt)
          const finalTps = elapsed > 0 && stepChars > 0 ? stepChars / 3.5 / (elapsed / 1000) : null
          if (finalTps !== null) {
            // usage 已并入 turn.outputTokens 时不再重复加估算；usage 缺失时才用估算补齐。
            const roundTokens = turn
              ? turn.outputTokens + (chunk.usage ? 0 : Math.round(stepChars / 3.5))
              : Math.round(stepChars / 3.5)
            statusCache.lastTps = finalTps
            $.ui.status(
              statusText(finalTps, roundTokens, statusCache.sessionTokens, statusCache.contextPercent, true),
            )
          }
        }
      } catch (error) {
        $.ui.log(`usage-toolbar: turn.step 统计失败 ${String(error)}`)
      }

      yield chunk
    }

    return await stream.result
  })

  // 轮次结束：归一化本轮用量，主循环并入会话累计，子代理独立累计。
  on('turn.complete', async ($, e, next) => {
    const endedAt = await $.clock.now()
    const turn = pending.get(e.turnId)
    pending.delete(e.turnId)
    const usage = e.usage
    const round: UsageRound = {
      turnId: e.turnId,
      model: usage?.model ?? turn?.model ?? 'unknown',
      inputTokens: usage?.input_tokens ?? turn?.inputTokens ?? 0,
      outputTokens: usage?.output_tokens ?? turn?.outputTokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? turn?.cacheReadTokens ?? 0,
      cacheCreationTokens: usage?.cache_creation_input_tokens ?? turn?.cacheCreationTokens ?? 0,
      durationMs: e.durationMs,
      genMs: turn?.genMs ?? e.durationMs,
      ttftMs: turn?.ttftMs ?? null,
      startedAt: turn?.startedAt ?? endedAt - e.durationMs,
    }

    try {
      if (e.agentId === undefined) {
        await update($, rounds, list => [...list, round].slice(-100))
        await update($, totals, current => addRoundTotals(current, round))
        await update($, ticker, () => null)
        await refreshStatus($)
        queueHistorySave($)
        // 轮次状态写入同样不会自动重绘面板，显式失效让面板展示本轮最终值。
        $.ui.invalidate('ui.render')
      } else {
        const agentId = e.agentId
        // 子代理按 agentId 独立累计：输入与缓存字段来自本轮的宿主 usage，
        // 旧快照没有这些字段时按 0 相加，避免 undefined 参与运算产生 NaN；
        // 模型记录本轮实际应答的模型，宿主未报模型时保留上一次的值。
        await update($, agentTotals, maps => {
          const prev = maps[agentId] ?? emptyAgent()
          return {
            ...maps,
            [agentId]: {
              requests: prev.requests,
              turns: prev.turns + 1,
              genMs: prev.genMs + round.genMs,
              outputTokens: prev.outputTokens + round.outputTokens,
              inputTokens: (prev.inputTokens ?? 0) + round.inputTokens,
              cacheReadTokens: (prev.cacheReadTokens ?? 0) + round.cacheReadTokens,
              cacheCreationTokens: (prev.cacheCreationTokens ?? 0) + round.cacheCreationTokens,
              model: round.model === 'unknown' ? prev.model : round.model,
              lastSeenAt: endedAt,
            },
          }
        })
      }
    } catch (error) {
      $.ui.log(`usage-toolbar: turn.complete 统计失败 ${String(error)}`)
    }

    return next(e)
  })
}

// ---------------------------------------------------------------------------
// 提示词增强
// ---------------------------------------------------------------------------

/** 从跨会话存储恢复增强记录；旧形状或损坏数据被忽略。 */
async function loadRecords($: EngineInterface): Promise<void> {
  try {
    const stored = await $.store.get(ENHANCE_STORE_KEY)
    if (!Array.isArray(stored)) return

    const records = stored.filter((item): item is EnhanceRecord => {
      const candidate = item as Partial<EnhanceRecord> | null
      return (
        typeof candidate === 'object' &&
        candidate !== null &&
        typeof candidate.id === 'string' &&
        typeof candidate.original === 'string' &&
        typeof candidate.enhanced === 'string'
      )
    })

    await update($, enhanceRecords, () => records.slice(0, RECORD_LIMIT))
  } catch (error) {
    $.ui.log(`usage-toolbar: 读取增强记录失败 ${String(error)}`)
  }
}

/** SQLite 存储脚本的命令执行封装：优先 python，回退 python3。 */
async function runUsageStore(
  $: EngineInterface,
  args: string[],
  stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
  const script = `${$.plugin.root}/scripts/usage_store.py`
  const commands = [
    ['python', script, ...args],
    ['python3', script, ...args],
  ]
  let lastError = ''

  for (const argv of commands) {
    try {
      const result = await $.process.run(argv, { stdin, timeoutMs: 15000 })
      if (result.exitCode === 0) return { stdout: result.stdout, stderr: result.stderr }
      lastError = result.stderr || `exit ${result.exitCode}`
    } catch (error) {
      lastError = String(error)
    }
  }

  throw new Error(lastError || 'python not found')
}

/**
 * 读取本地存储中的会话记录，只用于回填当前会话的统计。
 *
 * <p>其他会话的数据仅在内存中短暂参与匹配，不会被写入状态或展示。</p>
 */
async function loadHistory($: EngineInterface): Promise<void> {
  try {
    const result = await runUsageStore($, ['load', '20'])
    const entries = JSON.parse(result.stdout.trim()) as HistoryEntry[]
    if (Array.isArray(entries)) {
      await restoreSessionStats($, entries)
      return
    }
  } catch (error) {
    $.ui.log(`usage-toolbar: 读取 SQLite 历史失败 ${String(error)}`)
  }

  // 旧版本只写过 $.store 单快照；SQLite 不可用时仍尽力用它回填。
  try {
    const stored = await $.store.get(HISTORY_STORE_KEY)
    const candidate = stored as HistoryEntry | null
    if (candidate && Array.isArray(candidate.rounds) && candidate.sessionId) {
      await restoreSessionStats($, [candidate])
    }
  } catch (error) {
    $.ui.log(`usage-toolbar: 读取本地历史回退失败 ${String(error)}`)
  }
}

/**
 * 从 SQLite 历史回填当前会话的内存统计。
 *
 * <p>数据来源：loadHistory 已读到的会话条目。宿主 {@code $.state} 只保证热重载后保留，
 * 应用重启或插件重装后会被重建，而面板直接读内存状态，重置后已有轮次会显示为空。</p>
 *
 * <p>以 rounds 表为准而不是 sessions 行的累计：sessions 行每次保存都用当时的内存快照
 * 覆盖，被重置过的会话累计会失真；rounds 表按 turn_id 累积，保留完整轮次。</p>
 *
 * <p>轮次与代理计数分开判断：各自为空时才从快照恢复，热重载保留了状态时不重复计数。
 * 代理计数没有宿主侧的重建来源（工作流子代理不在 {@code $.agent.list()} 中），必须随
 * 会话快照持久化。</p>
 */
async function restoreSessionStats(
  $: EngineInterface,
  entries: HistoryEntry[] | null,
): Promise<void> {
  try {
    const [existingRounds, existingAgents] = await Promise.all([
      read($, rounds),
      read($, agentTotals),
    ])
    const needsRounds = existingRounds.length === 0
    const needsAgents = Object.keys(existingAgents).length === 0
    if (!needsRounds && !needsAgents) return
    if (!entries || entries.length === 0) return

    let sessionId: string
    try {
      sessionId = await $.session.id()
    } catch (error) {
      $.ui.log(`usage-toolbar: 回填时读取会话 id 失败 ${String(error)}`)
      return
    }

    const entry = entries.find(item => item.sessionId === sessionId)
    if (!entry) return

    if (needsRounds && entry.rounds.length > 0) {
      const restored = totalsFromRounds(entry.rounds)
      await update($, rounds, () => entry.rounds.slice(-100))
      await update($, totals, () => restored)
      await refreshStatus($)
      $.ui.log(`usage-toolbar: 已从数据库回填当前会话 ${entry.rounds.length} 轮`)
    }

    // 代理计数只存在快照里；重启后宿主名单无法重建工作流子代理与已回收的子代理。
    if (needsAgents && entry.agentTotals && Object.keys(entry.agentTotals).length > 0) {
      await update($, agentTotals, () => entry.agentTotals ?? {})
      $.ui.log(
        `usage-toolbar: 已回填当前会话 ${Object.keys(entry.agentTotals).length} 个代理的计数`,
        { to: 'debug' },
      )
    }
  } catch (error) {
    $.ui.log(`usage-toolbar: 回填当前会话统计失败 ${String(error)}`)
  }
}

/**
 * 从轮次记录聚合会话累计。
 *
 * <p>rounds 表不保存每轮请求数，requests 无法精确还原，按轮数作为下限近似；
 * 这样保证「请求数 ≥ 轮数」，且模型明细的请求数之和与总数一致。</p>
 */
/** 空的会话累计；重置统计与状态恢复共用同一形状。 */
function emptyTotals(): SessionTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    requests: 0,
    turns: 0,
    genMs: 0,
    ttftTotalMs: 0,
    ttftCount: 0,
    byModel: {},
  }
}

function totalsFromRounds(list: UsageRound[]): SessionTotals {
  const result = emptyTotals()

  for (const round of list) {
    const key = round.model || 'unknown'
    const prev = result.byModel[key] ?? {
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
      genMs: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }
    result.inputTokens += round.inputTokens
    result.outputTokens += round.outputTokens
    result.cacheReadTokens += round.cacheReadTokens
    result.cacheCreationTokens += round.cacheCreationTokens
    result.requests += 1
    result.turns += 1
    result.genMs += round.genMs
    result.ttftTotalMs += round.ttftMs ?? 0
    result.ttftCount += round.ttftMs === null ? 0 : 1
    result.byModel[key] = {
      inputTokens: prev.inputTokens + round.inputTokens,
      outputTokens: prev.outputTokens + round.outputTokens,
      requests: prev.requests + 1,
      genMs: prev.genMs + round.genMs,
      cacheReadTokens: prev.cacheReadTokens + round.cacheReadTokens,
      cacheCreationTokens: prev.cacheCreationTokens + round.cacheCreationTokens,
    }
  }

  return result
}

/** 启动（或加入）历史加载；加载完成后当前会话的回填一起就绪。 */
function startHistoryLoad($: EngineInterface): Promise<void> {
  if (!historyTask) {
    historyTask = loadHistory($).finally(() => {
      historyTask = null
    })
  }
  return historyTask
}

/**
 * 确保当前会话的内存统计可用：内存为空时从 SQLite 回填。
 *
 * <p>面板与状态行都读内存状态，而宿主在应用重启或插件重装后会重建
 * {@code $.state}；打开面板前做一次惰性恢复，避免用户先看到空数据。</p>
 */
async function ensureSessionRestored($: EngineInterface): Promise<void> {
  try {
    if ((await read($, rounds)).length > 0) return
    // 重新读库而不是复用会话启动时的快照：会话期间每次轮次结束都会写库，
    // 启动时读到的历史条目可能缺少最近的轮次。
    await startHistoryLoad($)
  } catch (error) {
    $.ui.log(`usage-toolbar: 惰性恢复会话统计失败 ${String(error)}`)
  }
}

/**
 * 重置当前会话的统计：清空内存轮次与累计，并删除数据库中该会话的行。
 *
 * <p>内存与数据库必须一起清：saveHistory 每轮都把内存中的全部轮次写回数据库，
 * 只清库时旧数据会在下一次轮次结束时重新出现。只影响当前会话，其他会话的
 * 记录不动。</p>
 */
async function resetSessionStats($: EngineInterface): Promise<void> {
  let sessionId: string
  try {
    sessionId = await $.session.id()
  } catch (error) {
    $.ui.log(`usage-toolbar: 重置统计读取会话 id 失败 ${String(error)}`, { to: 'debug' })
    $.ui.toast('重置失败：读取会话 id 出错')
    return
  }

  await update($, rounds, () => [])
  await update($, totals, () => emptyTotals())
  await update($, agentTotals, () => ({}))
  // 内存已清空，界面立即收起确认态；后续删除数据库失败只提示，不回滚已清空的内存统计。
  await update($, resetConfirming, () => false)

  // 旧版本的单会话快照只在 SQLite 不可用时作为回退，一并删除避免恢复出旧数据。
  try {
    await $.store.delete(HISTORY_STORE_KEY)
  } catch (error) {
    $.ui.log(`usage-toolbar: 重置本地快照失败 ${String(error)}`, { to: 'debug' })
  }

  try {
    await runUsageStore($, ['delete', sessionId])
  } catch (error) {
    $.ui.log(`usage-toolbar: 删除数据库会话失败 ${String(error)}`, { to: 'debug' })
    $.ui.toast('内存统计已重置，但删除数据库记录失败')
  }

  await refreshStatus($)
  // 成功不往 transcript 写行：重置是用户主动发起的静默操作，面板数据清空即反馈。
  $.ui.log(`usage-toolbar: 已重置会话 ${sessionId} 的统计`, { to: 'debug' })
}

/**
 * 把当前会话的轮次、累计、费用与上下文写入本地 SQLite。
 *
 * <p>写入按会话 ID 区分，不并入其他会话统计。SQLite 失败时写 $.store 单快照作为回退。</p>
 */
async function saveHistory($: EngineInterface): Promise<void> {
  let payload: HistoryEntry | null = null

  try {
    const sessionId = await $.session.id()
    const [list, current, agentMap] = await Promise.all([
      read($, rounds),
      read($, totals),
      read($, agentTotals),
    ])
    let costUsd: number | undefined
    let contextPercent: number | undefined
    try {
      const usage = await $.session.usage()
      costUsd = usage.cost?.usd
      contextPercent = usage.context.percent
    } catch (error) {
      $.ui.log(`usage-toolbar: 读取历史费用失败 ${String(error)}`)
    }

    payload = {
      sessionId,
      totals: current,
      rounds: list.slice(-100),
      agentTotals: agentMap,
      costUsd,
      contextPercent,
      updatedAt: await $.clock.now(),
    }

    await runUsageStore($, ['save'], JSON.stringify(payload))
  } catch (error) {
    $.ui.log(`usage-toolbar: 保存 SQLite 历史失败 ${String(error)}`)
    if (payload) {
      try {
        await $.store.set(HISTORY_STORE_KEY, payload)
      } catch (storeError) {
        $.ui.log(`usage-toolbar: 保存历史回退失败 ${String(storeError)}`)
      }
    }
  }
}

/** 串行化后台保存，避免同一会话的并发 SQLite 写入互相覆盖。 */
let historySaving = false
let historyPending = false
/** 进行中的历史加载任务；并发调用复用同一个 Promise，避免重复读库。 */
let historyTask: Promise<void> | null = null

function queueHistorySave($: EngineInterface): void {
  if (historySaving) {
    historyPending = true
    return
  }

  historySaving = true
  void (async () => {
    try {
      await saveHistory($)
    } finally {
      historySaving = false
      if (historyPending) {
        historyPending = false
        queueHistorySave($)
      }
    }
  })()
}

/** 把模型调用失败原因翻译成用户可读文本。 */
function reasonText(reason: string): string {
  if (reason === 'api-error') return '接口错误'
  if (reason === 'empty-reply') return '模型未返回文本'
  if (reason === 'aborted') return '调用被中断'
  return reason
}

/**
 * 用当前会话模型改写输入框草稿。
 *
 * <p>数据来源：草稿来自 $.prompt.read()，模型来自 $.session.model()，改写由独立的
 * $.model.complete 完成（不带会话上下文，成本更低）。写回前再次读取草稿，用户已修改时
 * 只保存记录、不覆盖输入。记录先写入 state 与跨会话存储，再写回草稿，保证写回失败时
 * 结果仍可在面板查看。</p>
 */
async function runEnhance($: EngineInterface): Promise<void> {
  const running = await read($, enhanceState)
  if (running?.isRunning) {
    $.ui.toast('提示词增强正在进行')
    return
  }

  const draft = await $.prompt.read()
  const original = draft.text.trim()
  if (!original) {
    $.ui.toast('输入框为空，先写上要增强的内容')
    return
  }

  const model = await $.session.model()
  const startedAt = await $.clock.now()
  await update($, enhanceState, () => ({ isRunning: true, startedAt, model }))
  $.ui.status('✦ 正在增强提示词…')

  try {
    const result = await $.model.complete({
      model,
      system:
        '你是提示词改写助手。只输出改写后的提示词正文，不要解释、不要加引号或前后缀。保持原意，使表达更清晰、具体、可执行。',
      prompt: original,
      maxTokens: 2048,
      effort: 'low',
    })

    if (!result.isAnswered) {
      $.ui.toast(`增强失败：${reasonText(result.reason)}`)
      $.ui.log(`usage-toolbar: 增强调用未返回文本 ${result.reason}`)
      return
    }

    const enhanced = result.text.trim()
    if (!enhanced) {
      $.ui.toast('增强结果为空')
      $.ui.log('usage-toolbar: 增强结果为空')
      return
    }

    // 写回前再次确认草稿：用户可能已经改过内容，不能覆盖新输入。
    const current = await $.prompt.read()
    const isUnchanged = current.text.trim() === original
    const finishedAt = await $.clock.now()
    const record: EnhanceRecord = {
      id: `${startedAt}-${(await read($, enhanceRecords)).length}`,
      model,
      original: original.slice(0, TEXT_LIMIT),
      enhanced: enhanced.slice(0, TEXT_LIMIT),
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      durationMs: finishedAt - startedAt,
      at: startedAt,
    }

    // 先保存记录再写回草稿，确保写回失败时增强结果仍可查看。
    await rememberEnhance($, record)

    if (!isUnchanged) {
      $.ui.toast('草稿已变化，增强结果已保存到记录，未覆盖输入框')
      return
    }

    const filled = await $.prompt.fill({ text: enhanced, mode: 'replace' })
    if (!filled.isFilled) {
      const reason = filled.refusal === 'dialog' ? '当前有弹窗占用输入框' : '输入框不可用'
      $.ui.toast(`写回输入框失败：${reason}`)
      $.ui.log(`usage-toolbar: prompt.fill 被拒绝 ${filled.refusal ?? 'unknown'}`)
      return
    }

    $.ui.toast('提示词已增强')
  } catch (error) {
    $.ui.toast('增强调用失败，请查看调试日志')
    $.ui.log(`usage-toolbar: 增强调用异常 ${String(error)}`)
  } finally {
    await update($, enhanceState, () => null)
    $.ui.status(undefined)
  }
}

/**
 * 保存一条增强记录：补齐当前会话 id 后先写会话状态，再写本地存储。
 *
 * <p>记录按会话 id 归属，面板只展示当前会话的记录。会话 id 读取失败时
 * 记录仍保存，但没有归属，不会出现在任何会话的列表中。</p>
 *
 * <p>存储失败只记日志，不影响已写入的会话状态与写回结果。</p>
 */
async function rememberEnhance(
  $: EngineInterface,
  record: Omit<EnhanceRecord, 'sessionId'>,
): Promise<void> {
  let sessionId: string | undefined
  try {
    sessionId = await $.session.id()
  } catch (error) {
    $.ui.log(`usage-toolbar: 增强记录读取会话 id 失败 ${String(error)}`)
  }

  const entry: EnhanceRecord = sessionId ? { ...record, sessionId } : record
  let saved: EnhanceRecord[] = []
  await update($, enhanceRecords, list => {
    saved = [entry, ...list].slice(0, RECORD_LIMIT)
    return saved
  })
  try {
    await $.store.set(ENHANCE_STORE_KEY, saved)
  } catch (error) {
    $.ui.log(`usage-toolbar: 保存增强记录失败 ${String(error)}`)
  }
}

/**
 * 清空当前会话的增强记录：更新内存视图并写回持久层，其他会话的记录保留。
 *
 * <p>删除不可恢复，入口只允许经过面板内两步确认；调用前已确认会话 id 存在。
 * 用函数式更新过滤内存，避免把清空瞬间新增的记录覆盖掉。</p>
 */
async function clearEnhanceRecords($: EngineInterface, sessionId: string): Promise<void> {
  let remaining: EnhanceRecord[] = []
  await update($, enhanceRecords, list => {
    remaining = list.filter(record => record.sessionId !== sessionId)
    return remaining
  })
  // 记录已清空，界面立即收起确认态。
  await update($, clearConfirming, () => false)

  try {
    await $.store.set(ENHANCE_STORE_KEY, remaining)
  } catch (error) {
    // 内存已清空但持久层失败：提示用户，重启后记录可能恢复，不影响当前会话继续使用。
    $.ui.log(`usage-toolbar: 保存清空后的增强记录失败 ${String(error)}`, { to: 'debug' })
    $.ui.toast('清空失败：本地记录保存出错')
  }
}

/**
 * 提交前增强的触发前缀：消息以其中之一开头时，先改写再发出。
 *
 * <p>不用 `!`：Claude Code 把行首 `!` 交给 shell，PowerShell 会把 `!!` 当一元运算符执行，
 * 消息不会进入 `prompt.submit`。`++` 与中英文冒号的「增强：」都不占用宿主保留前缀。</p>
 */
const SUBMIT_ENHANCE_PREFIXES = ['++', '增强：', '增强:']

/**
 * 提交前增强：把 `!!` 后的草稿交给独立模型改写。
 *
 * <p>模型来自当前会话；读取模型、调用失败或结果为空时返回 null，调用方按原文提交，
 * 绝不阻断发送。成功时与按钮增强共用同一份增强记录，面板的「增强」视图可见。</p>
 */
async function enhanceForSubmit($: EngineInterface, original: string): Promise<string | null> {
  let model: string
  try {
    model = await $.session.model()
  } catch (error) {
    $.ui.log(`usage-toolbar: 提交前增强读取模型失败 ${String(error)}`)
    return null
  }

  const startedAt = await $.clock.now()
  try {
    const result = await $.model.complete({
      model,
      system:
        '你是提示词改写助手。只输出改写后的提示词正文，不要解释、不要加引号或前后缀。保持原意，使表达更清晰、具体、可执行。',
      prompt: original,
      maxTokens: 2048,
      effort: 'low',
    })

    if (!result.isAnswered) {
      $.ui.log(`usage-toolbar: 提交前增强未返回文本 ${result.reason}`)
      return null
    }

    const enhanced = result.text.trim()
    if (!enhanced) {
      $.ui.log('usage-toolbar: 提交前增强结果为空')
      return null
    }

    const finishedAt = await $.clock.now()
    await rememberEnhance($, {
      id: `${startedAt}-${(await read($, enhanceRecords)).length}`,
      model,
      original: original.slice(0, TEXT_LIMIT),
      enhanced: enhanced.slice(0, TEXT_LIMIT),
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      durationMs: finishedAt - startedAt,
      at: startedAt,
    })
    return enhanced
  } catch (error) {
    $.ui.log(`usage-toolbar: 提交前增强异常 ${String(error)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// 绘制
// ---------------------------------------------------------------------------

/**
 * 打开用量面板。
 *
 * <p>用 focus + closeOnEscape + holdToasts 请求对话框形态：宿主把面板升起并交给键盘焦点，
 * Esc 交还焦点并关闭；打开期间 toast 栈由面板代持。面板尺寸按宿主上限裁剪。</p>
 */
async function openUsagePane($: EngineInterface) {
  // 打开前确保当前会话统计已从数据库回填，避免面板先渲染空数据。
  await ensureSessionRestored($)
  return $.ui.open({
    id: PANE_ID,
    title: '用量',
    rows: 30,
    columns: 72,
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
  })
}

/** 注册输入框上方按钮与用量面板的绘制钩子。 */
function registerUi(on: On): void {
  // 输入框上方的一行操作：增强当前草稿、打开用量面板。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isCollapsed) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const tick = await read($, ticker)
    const list = await read($, rounds)
    const now = await $.clock.now()
    const last = list.length > 0 ? (list[list.length - 1] ?? null) : null

    // 左侧语录轮播：彩色圆环 + 已用时间 + 趣味文案；空闲时只显示完成提示。
    const elapsed = tick?.isWorking ? formatElapsed(now - tick.startedAt) : ''
    const phrase = tick?.phrase
      .replace('{elapsed}', elapsed)
      .replace('{tps}', statusCache.lastTps === null ? '—' : statusCache.lastTps.toFixed(1))
      .replace('{model}', last?.model ? modelLabel(last.model) : '当前模型') ?? ''
    const frameIndex = (tick?.frame ?? 0) % TICKER_FRAMES.length
    const frame = TICKER_FRAMES[frameIndex] ?? '⣠⣿⣄'
    const frameColor = TICKER_COLORS[frameIndex % TICKER_COLORS.length] ?? 'cyan'
    const phraseWidth = Math.max(10, e.props.bodyColumns - 26)
    const left = tick?.isWorking ? (
      <Box flexDirection="row">
        <Text color={frameColor}>{frame}</Text>
        <Text dimColor> {elapsed} · {clip(phrase, phraseWidth)}</Text>
      </Box>
    ) : list.length === 0 ? (
      <Text dimColor>✳ 准备就绪，随时可以开始</Text>
    ) : (
      <Box flexDirection="row">
        <Text color="#D97757">✓</Text>
        <Text dimColor> 本轮工作已完成，随时可以继续</Text>
      </Box>
    )

    return (
      <Box flexDirection="row" justifyContent="space-between">
        {left}
        <Box flexDirection="row" gap={1}>
          <Button
            key="enhance"
            label="✦ 增强"
            onPress={() => {
              void runEnhance($)
            }}
          />
          <Button
            key="open-usage"
            label="▦ 用量"
            onPress={() => {
              void (async () => {
                // 从入口按钮打开时从头开始，不继承上一次遗留的危险确认。
                await update($, resetConfirming, () => false)
                await update($, clearConfirming, () => false)
                await openUsagePane($)
              })()
            }}
          />
        </Box>
      </Box>
    )
  })

  // 用量面板：四个视图共用一份会话数据，切换只改变当前视图。
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // Svg 只存在于非终端 surface 的元素表；终端表没有该键，按 surface 收窄后再取，
    // 终端绘制时保持 null，由字符条形图承担趋势展示。
    const SvgTag = e.surface === 'terminal' ? null : $.ui.resolve(e).Svg
    const current = await read($, view)
    const confirmingReset = await read($, resetConfirming)
    const confirmingClear = await read($, clearConfirming)
    const list = await read($, rounds)
    const sum = await read($, totals)
    const maps = await read($, agentTotals)
    const allRecords = await read($, enhanceRecords)

    let usage: SessionUsage | null = null
    try {
      usage = await $.session.usage()
    } catch (error) {
      $.ui.log(`usage-toolbar: 面板读取会话用量失败 ${String(error)}`)
    }

    let agents: AgentInfo[] = []
    try {
      agents = await $.agent.list()
    } catch (error) {
      $.ui.log(`usage-toolbar: 面板读取子代理失败 ${String(error)}`)
    }

    // 面板所有视图都只展示当前会话的数据：会话 id 用于过滤增强记录。
    let currentSessionId: string | null = null
    try {
      currentSessionId = await $.session.id()
    } catch (error) {
      $.ui.log(`usage-toolbar: 读取当前会话 id 失败 ${String(error)}`)
    }

    // 视图切换：宿主没有原生 Tab，用一排 Button 写入 view 状态。
    const tab = (id: UsageView, label: string) => (
      <Button
        key={id}
        label={label}
        variant={current === id ? 'primary' : 'secondary'}
        onPress={() => {
          void (async () => {
            await update($, view, () => id)
            // 切页签即视为取消两种危险确认，避免回到原页签时停留在确认步骤。
            await update($, resetConfirming, () => false)
            await update($, clearConfirming, () => false)
          })()
        }}
      />
    )

    /**
     * 键值行：标签靠左、数值靠右，同一列内形成一条右对齐的数值边。
     *
     * <p>与「标签在上、数值在下」的卡片式指标相比，右对齐让不同位数的读数可以按末位
     * 纵向比较；会话视图的 Token 构成与请求与性能两组都使用这种行式布局。</p>
     */
    const kvRow = (label: string, value: string, color?: string) => (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text dimColor size="caption">{label}</Text>
        <Text color={color}>{value}</Text>
      </Box>
    )

    // 代理视图的网格指标卡：标题在上、数值在下，列数随面板宽度自适应；
    // 会话视图已改用右对齐的 kvRow，两者按各视图的读数数量分别使用。
    const gridColumns = e.props.bodyColumns >= 56 ? 5 : e.props.bodyColumns >= 36 ? 4 : 2
    const cardWidth = Math.max(8, Math.floor((e.props.bodyColumns - (gridColumns - 1)) / gridColumns))
    const metric = (label: string, value: string, color?: string) => (
      <Box flexDirection="column" width={cardWidth}>
        <Text dimColor size="caption">{label}</Text>
        <Text color={color}>{value}</Text>
      </Box>
    )

    /**
     * 水位条：按百分比把 10 格方块填满，未填充部分用 dim 的浅块占位。
     *
     * <p>用于上下文占比与缓存率这类「当前水平」指标；颜色沿用对应分档色，
     * 无读数时由调用方传 0 并单独显示「—」，不在这里分支。</p>
     */
    const waterBar = (percent: number, color?: string) => {
      const filled = Math.max(0, Math.min(10, Math.round(percent / 10)))
      return (
        <Text color={color}>
          {'█'.repeat(filled)}
          <Text dimColor>{'░'.repeat(10 - filled)}</Text>
        </Text>
      )
    }

    /** 行内小指标：标签 dim、数值同行常规字重，用于峰值/最低/最新这类次要读数。 */
    const compactMetric = (label: string, value: string, color?: string) => (
      <Box flexDirection="row" gap={1}>
        <Text dimColor size="caption">{label}</Text>
        <Text color={color}>{value}</Text>
      </Box>
    )

    // 生成速度视图：平均速度、档位、峰值/最低/最新与按面板宽度铺开的轮次条。
    const speedView = () => {
      // 面板够宽才画柱状图：每轮占一列，540px 画布只容得下 20 根；窄面板与终端每轮
      // 一行，纵向可铺开 50 轮。统计窗口跟随展示窗口，顶部平均值与下方图形口径一致。
      const wide = e.surface !== 'terminal' && e.props.bodyColumns >= 64
      const recent = list.slice(-(wide ? 20 : 50))
      const totalOut = recent.reduce((n, r) => n + r.outputTokens, 0)
      const totalGen = recent.reduce((n, r) => n + r.genMs, 0)
      const avg = totalGen > 0 ? (totalOut / totalGen) * 1000 : null
      const latestRound = recent.length > 0 ? (recent[recent.length - 1] ?? null) : null
      const latest = latestRound ? tpsOfRound(latestRound) : null
      const values = recent.map(tpsOfRound).filter(v => v > 0)
      const peak = values.length > 0 ? Math.max(...values) : null
      const low = values.length > 0 ? Math.min(...values) : null
      const level = tpsLevel(avg)
      const model = latestRound
        ? clip(modelLabel(latestRound.model), Math.max(10, e.props.bodyColumns - 30))
        : '—'
      const rows = recent
      // 窄面板块条每轮一行、纵向不受画布宽度限制，展示最近 50 轮完整历史；
      // 宽面板柱状图受柱宽与柱顶数值限制，仍用上面的 rows。
      const narrowRows = list.slice(-50)
      const maxTps = peak ?? 1
      // 条形区按面板可用列数分配，并给编号和数值留固定列，保证纵向扫读时数字对齐。
      const barMax = Math.max(6, e.props.bodyColumns - 20)
      // 折线画在条形图上方：只用基础 SVG 图元，面板足够宽且至少 2 轮时才绘制，
      // 窄侧栏或终端退回条形图，不出现半截图。
      const trend = rows.map(tpsOfRound)
      const showChart = wide && trend.length >= 2
      // 图表像素宽度随面板列数增长：每列按 7.6px 保守估算（宁可略窄也不越过槽位），下界 540 保持窄面板
      // 刻度不被压缩，上界 1080 避免超宽面板把绘图区拉成细线。高度按宽度小幅补偿，视觉比例不失衡。
      const chartWidth = Math.min(1080, Math.max(540, Math.round(e.props.bodyColumns * 7.6)))
      const chartHeight = Math.min(190, Math.round(110 + (chartWidth - 540) * 0.08))
      const chartSvg = showChart ? speedChartSvg(trend, level.color, chartWidth, chartHeight) : ''
      // 宽面板柱状图（原有实现）：高度随宽度小幅补偿，柱色取每轮档位色。
      const barsHeight = Math.min(250, Math.round(160 + (chartWidth - 540) * 0.11))
      const barColors = rows.map(round => tpsLevel(tpsOfRound(round)).color)
      const barsSvg = showChart ? speedBarsSvg(trend, barColors, chartWidth, barsHeight) : ''
      // 窄面板块条：序号 2 列 + 间距 + 数值 6 列，其余列给条；按 7px/列保守换算，
      // 宁可条略窄也不让整行越过面板宽度。数值省略 " t/s"，单位已在标题里标明。
      const narrowBarPx = Math.max(40, Math.round((e.props.bodyColumns - 10) * 7))
      const rowMaxTps = Math.max(1, ...narrowRows.map(tpsOfRound))

      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor size="caption">当前会话 · 最近 {recent.length} 轮平均输出速度</Text>
          {/* 主数值独占一行，单位用小字；档位与模型另起一行，避免挤在一起。 */}
          <Box flexDirection="row" alignItems="flex-end" gap={1}>
            <Text color={level.color} size="heading">
              {avg === null ? '—' : avg.toFixed(1)}
            </Text>
            <Text dimColor size="caption">t/s</Text>
            <Text color={level.color} size="caption">{level.label}</Text>
            <Text dimColor size="caption">· {model}</Text>
          </Box>
          {/* 趋势折线：网格与刻度中性灰，折线与面积用当前档位色；无数据时不绘制。 */}
          {chartSvg !== '' && SvgTag !== null && (
            <SvgTag
              source={chartSvg}
              alt={`最近 ${trend.length} 轮生成速度趋势，最新 ${latest === null ? '—' : latest.toFixed(1)} t/s`}
              width={chartWidth}
              height={chartHeight}
            />
          )}
          {/* 峰值/最低/最新并列一行，三个数值统一按自身速度档位着色，与下方轮次条共用
              同一套颜色语义：同一读数在指标行和图表里必须是同一个颜色。 */}
          <Box flexDirection="row" gap={2}>
            {compactMetric('峰值', peak === null ? '—' : peak.toFixed(1), tpsLevel(peak).color)}
            {compactMetric('最低', low === null ? '—' : low.toFixed(1), tpsLevel(low).color)}
            {compactMetric('最新', latest === null ? '—' : latest.toFixed(1), tpsLevel(latest).color)}
          </Box>
          {rows.length === 0 ? (
            <Text dimColor size="caption">还没有完成的轮次</Text>
          ) : showChart && SvgTag !== null ? (
            // 宽面板保留垂直柱状图：柱顶有数值、底部有轮次序号、左侧有刻度。
            <Box flexDirection="column" gap={1}>
              <Text size="caption" weight="bold">最近 {rows.length} 轮生成速度（t/s）</Text>
              <SvgTag
                source={barsSvg}
                alt={`最近 ${rows.length} 轮生成速度柱状图，峰值 ${peak === null ? '—' : peak.toFixed(1)} t/s`}
                width={chartWidth}
                height={barsHeight}
              />
            </Box>
          ) : SvgTag === null ? (
            // 终端没有 Svg 元素：退回字符条，保证每轮都有可读的数值。
            <Box flexDirection="column">
              <Text dimColor size="caption">最近 {rows.length} 轮生成速度</Text>
              {rows.map((round, index) => {
                const tps = tpsOfRound(round)
                const roundLevel = tpsLevel(tps)
                const width = Math.max(1, Math.round((tps / maxTps) * barMax))
                return (
                  <Box key={round.turnId} flexDirection="row">
                    <Text dimColor size="caption">{String(index + 1).padStart(2, ' ')} </Text>
                    <Box width={barMax}>
                      <Text color={roundLevel.color}>{'█'.repeat(width)}</Text>
                    </Box>
                    <Text color={roundLevel.color}> {tps.toFixed(1)} t/s</Text>
                  </Box>
                )
              })}
            </Box>
          ) : (
            // 窄面板用分格块条：序号与速率交给宿主 Text 排版，SVG 只画格子；三段各占一列，
            // 字体度量再大也不会压住数字。数值省略单位；标题与图表之间用 marginTop 留一行间距。
            <Box flexDirection="column">
              <Text size="caption" weight="bold">最近 {narrowRows.length} 轮生成速度（t/s）</Text>
              <Box flexDirection="column" marginTop={1}>
                {narrowRows.map((round, index) => {
                  const tps = tpsOfRound(round)
                  const roundLevel = tpsLevel(tps)
                  return (
                    <Box key={round.turnId} flexDirection="row" alignItems="center" gap={1}>
                      <Box width={2}>
                        <Text dimColor size="caption">{String(index + 1).padStart(2, ' ')}</Text>
                      </Box>
                      <SvgTag
                        source={speedBarRowSvg(tps, rowMaxTps, roundLevel.color, narrowBarPx, 10)}
                        alt={`第 ${index + 1} 轮生成速度 ${tps.toFixed(1)} t/s`}
                        width={narrowBarPx}
                        height={10}
                      />
                      <Box width={6} justifyContent="flex-end">
                        <Text color={roundLevel.color} size="caption">{tps.toFixed(1)}</Text>
                      </Box>
                    </Box>
                  )
                })}
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    // 增强记录视图：只展示当前会话的记录，卡片列出原文、增强文、token 与耗时。
    const enhanceView = () => {
      // 窄侧栏下卡片首行的模型名与元信息会互相挤压、各自折行导致错位，
      // 改为上下排列；宽面板仍保持左名右数字的一行式。
      const narrow = e.props.bodyColumns < 48
      // 旧版本记录没有 sessionId，不属于任何会话；读不到会话 id 时同样不展示。
      const records = currentSessionId
        ? allRecords.filter(record => record.sessionId === currentSessionId)
        : []

      return (
        <Box flexDirection="column" gap={1}>
          {/* 行宽显式取面板可用列数，再用弹性占位把按钮推到最右：Pane 内的 Box 宽度随内容收缩，
              只写 justifyContent 时没有剩余空间可分布。 */}
          <Box flexDirection="row" width={e.props.bodyColumns}>
            <Text dimColor size="caption">最近增强记录 {records.length} 条</Text>
            <Box flexGrow={1} />
            <Button
              key="clear-records"
              label="清空记录…"
              onPress={() => {
                if (!currentSessionId) {
                  $.ui.log('usage-toolbar: 未取得会话 id，跳过清空增强记录', { to: 'debug' })
                  return
                }
                void update($, clearConfirming, () => true)
              }}
            />
          </Box>
          {/* 与重置告警同一形态：左侧红色竖条 + 红色标题说明范围，正文保持默认色，
              确认放在面板内部，不写入会话。 */}
          {/* 左侧竖条用 Box 背景色绘制：块字符受行距影响会断成三段，背景色块可以连续铺满，
              alignSelf="stretch" 让它与右侧文字块等高；字符保留作背景色不可用时的兜底。 */}
          <Box flexDirection="row" gap={1} alignItems="stretch">
            <Box width={1} backgroundColor="error">
              <Text color="error">{'▌\n▌\n▌'}</Text>
            </Box>
            <Box flexDirection="column">
              <Text weight="bold" color="error">清空当前会话的增强记录</Text>
              <Text>删除当前会话的全部增强记录，且无法恢复。</Text>
              <Text dimColor>其他会话的记录不受影响。</Text>
            </Box>
          </Box>
          {confirmingClear && (
            <Box flexDirection="column">
              <Text weight="bold">确认清空？此操作无法恢复。</Text>
              <Box flexDirection="row" width={e.props.bodyColumns} gap={1}>
                <Box flexGrow={1} />
                <Button
                  key="clear-cancel"
                  onPress={() => {
                    void update($, clearConfirming, () => false)
                  }}
                >
                  {'取消'}
                </Button>
                <Button
                  key="clear-confirm"
                  onPress={() => {
                    if (!currentSessionId) {
                      $.ui.log('usage-toolbar: 清空确认时未取得会话 id，跳过', { to: 'debug' })
                      void update($, clearConfirming, () => false)
                      return
                    }
                    void clearEnhanceRecords($, currentSessionId)
                  }}
                >
                  {'确认清空'}
                </Button>
              </Box>
            </Box>
          )}
          {records.length === 0 && (
            <Text dimColor size="caption">还没有增强记录。点击输入框上方的「✦ 增强」或执行 /enhance。</Text>
          )}
          {/* 记录卡片：首行放模型与消耗元信息，正文两行带 dim 标签；
              卡片之间与代理页一致，用 gap 留一行间隔。 */}
          <Box flexDirection="column" gap={1}>
            {records.slice(0, 8).map(record => (
              <Box key={record.id} flexDirection="column" borderStyle="round" borderColor="#C8C8C8" paddingX={1}>
                <Box flexDirection={narrow ? 'column' : 'row'} gap={1}>
                  <Text dimColor size="caption">{modelLabel(record.model)}</Text>
                  {!narrow && <Box flexGrow={1} />}
                  <Box flexDirection="row" gap={1} flexWrap="wrap">
                    <Text dimColor size="caption">
                      {record.inputTokens}/{record.outputTokens} tok
                    </Text>
                    <Text dimColor size="caption">{Math.round(record.durationMs)}ms</Text>
                    <Text dimColor size="caption">{formatTime(record.at)}</Text>
                  </Box>
                </Box>
                {/* 窄侧栏下标签独占一行：内联标签后的折行会从行首开始、与标签错位，
                    用换行符让正文另起一行，读起来更整齐。 */}
                <Text>
                  <Text dimColor>{narrow ? '原文\n' : '原文 '}</Text>
                  {clip(record.original, Math.max(16, e.props.bodyColumns - (narrow ? 4 : 16)))}
                </Text>
                <Text>
                  <Text dimColor>{narrow ? '增强\n' : '增强 '}</Text>
                  {clip(record.enhanced, Math.max(16, e.props.bodyColumns - (narrow ? 4 : 16)))}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    // 会话累计视图：只展示当前会话，费用取宿主 /cost 的本地估算。
    const sessionView = () => {
      const display = sum
      const total = display.inputTokens + display.outputTokens
      const avgDuration = display.turns > 0 ? display.genMs / display.turns : 0
      const avgTtft = display.ttftCount > 0 ? display.ttftTotalMs / display.ttftCount : 0
      const avgTps = display.genMs > 0 ? (display.outputTokens / display.genMs) * 1000 : null
      // 缓存率：缓存读取 ÷ 输入侧总量；尚未产生输入时无读数，显示「—」。
      const cacheRate = cacheRateOf(display.inputTokens, display.cacheReadTokens, display.cacheCreationTokens)
      const cost = usage?.cost?.usd ?? null
      const contextPercent = usage?.context.percent ?? null
      // 模型明细列宽：卡片占 4 列（边框 2 + paddingX 2）、三处列间距占 3 列；
      // 30 列窄侧栏下模型名保留 9 列，其余宽度由输出/请求/缓存率共用。
      const tokenWidth = 8
      const requestWidth = 4
      const cacheWidth = 6
      const modelWidth = Math.max(9, e.props.bodyColumns - tokenWidth - requestWidth - cacheWidth - 8)
      const contextLevel = tierColor(contextPercent, CONTEXT_BOUNDS_PERCENT)
      // 三卡并排时每卡内容宽约 (列数 - 2) / 3 - 4（边框与 paddingX 各占 2 列）；
      // 卡 1 第三行最长约 16 列（三位数请求数 + 两位数轮数），因此低于 64 列改为纵向堆叠，
      // 避免该行折行把卡片撑高、破坏三卡等高。
      const summaryRow = e.props.bodyColumns >= 64
      // 键值两列需要每列至少约 24 列；更窄时回落单列，保证标签与数值同行可读。
      const kvColumns = e.props.bodyColumns >= 48

      return (
        // 整个视图统一用 gap 控制纵向间距，不再插入空 `<Text>` 行：
        // 空行的实际高度是行高，比 gap 的字符格更大，混用会导致间距不一致。
        <Box flexDirection="column" gap={1}>
          {/* 摘要：三张圆角卡承载核心读数，用块级边界替代空白堆叠；上下文卡内嵌 10 格水位条，
              百分比用大数值，水位条只做余量提示。 */}
          <Box flexDirection={summaryRow ? 'row' : 'column'} gap={1}>
            <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="#C8C8C8" paddingX={1} paddingY={1}>
              <Text dimColor size="caption" weight="bold">当前会话累计</Text>
              <Text size="heading">{fmtTokens(total)}</Text>
              <Text dimColor size="caption">{display.requests} 请求 · {display.turns} 轮</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="#C8C8C8" paddingX={1} paddingY={1}>
              <Text dimColor size="caption" weight="bold">估算费用</Text>
              <Text size="heading">{cost === null ? '不可得' : `$${cost.toFixed(2)}`}</Text>
              <Text dimColor size="caption">本地估算</Text>
            </Box>
            <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="#C8C8C8" paddingX={1} paddingY={1}>
              <Text dimColor size="caption" weight="bold">上下文</Text>
              <Text size="heading" color={contextLevel}>
                {contextPercent === null ? '—' : `${contextPercent}%`}
              </Text>
              {/* 桌面端用 SVG 画连续圆角进度条；终端没有 Svg 元素，退回字符水位条。 */}
              {SvgTag !== null ? (
                <SvgTag
                  source={contextBarSvg(contextPercent ?? 0, svgColor(contextLevel, '#2C8F87'))}
                  alt={`上下文占比 ${contextPercent === null ? '无读数' : `${contextPercent}%`}`}
                  width={78}
                  height={8}
                />
              ) : (
                waterBar(contextPercent ?? 0, contextLevel)
              )}
            </Box>
          </Box>
          {/* 指标按语义分两组，每组一张圆角卡，与顶部摘要卡同一视觉层级；
              组内为两列键值行，窄侧栏回落单列；摘要三卡与明细卡、明细卡之间
              都留一行间隔，与速度、增强、代理三个页签的卡片间距一致。 */}
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column" borderStyle="round" borderColor="#C8C8C8" paddingX={1} paddingY={1}>
              <Text size="caption" weight="bold">Token 构成</Text>
              {kvColumns ? (
                <Box flexDirection="row" gap={4}>
                  <Box flexDirection="column" flexGrow={1}>
                    {kvRow('输入', fmtTokens(display.inputTokens))}
                    {kvRow('输出', fmtTokens(display.outputTokens))}
                    {kvRow('缓存率', cacheRate === null ? '—' : `${cacheRate.toFixed(1)}%`, cacheRateLevel(cacheRate))}
                  </Box>
                  <Box flexDirection="column" flexGrow={1}>
                    {kvRow('缓存读取', fmtTokens(display.cacheReadTokens))}
                    {kvRow('缓存写入', fmtTokens(display.cacheCreationTokens))}
                  </Box>
                </Box>
              ) : (
                <Box flexDirection="column">
                  {kvRow('输入', fmtTokens(display.inputTokens))}
                  {kvRow('输出', fmtTokens(display.outputTokens))}
                  {kvRow('缓存读取', fmtTokens(display.cacheReadTokens))}
                  {kvRow('缓存写入', fmtTokens(display.cacheCreationTokens))}
                  {kvRow('缓存率', cacheRate === null ? '—' : `${cacheRate.toFixed(1)}%`, cacheRateLevel(cacheRate))}
                </Box>
              )}
            </Box>
            <Box flexDirection="column" borderStyle="round" borderColor="#C8C8C8" paddingX={1} paddingY={1}>
              <Text size="caption" weight="bold">请求与性能</Text>
              {kvColumns ? (
                <Box flexDirection="row" gap={4}>
                  <Box flexDirection="column" flexGrow={1}>
                    {kvRow('请求次数', String(display.requests))}
                    {kvRow('轮数', String(display.turns))}
                    {kvRow('平均速度', avgTps === null ? '—' : `${avgTps.toFixed(1)} t/s`, tpsLevel(avgTps).color)}
                  </Box>
                  <Box flexDirection="column" flexGrow={1}>
                    {kvRow('平均耗时', display.turns > 0 ? `${(avgDuration / 1000).toFixed(1)}s` : '—', tierColor(display.turns > 0 ? avgDuration : null, DURATION_BOUNDS_MS))}
                    {kvRow('平均延迟', display.ttftCount > 0 ? `${(avgTtft / 1000).toFixed(1)}s` : '—', latencyColor(display.ttftCount > 0 ? avgTtft : null))}
                  </Box>
                </Box>
              ) : (
                <Box flexDirection="column">
                  {kvRow('请求次数', String(display.requests))}
                  {kvRow('轮数', String(display.turns))}
                  {kvRow('平均耗时', display.turns > 0 ? `${(avgDuration / 1000).toFixed(1)}s` : '—', tierColor(display.turns > 0 ? avgDuration : null, DURATION_BOUNDS_MS))}
                  {kvRow('平均延迟', display.ttftCount > 0 ? `${(avgTtft / 1000).toFixed(1)}s` : '—', latencyColor(display.ttftCount > 0 ? avgTtft : null))}
                  {kvRow('平均速度', avgTps === null ? '—' : `${avgTps.toFixed(1)} t/s`, tpsLevel(avgTps).color)}
                </Box>
              )}
            </Box>
            {/* 模型明细：标题与列头合并成一行，整块包在圆角卡内，与上面两组同层级。 */}
            <Box flexDirection="column" borderStyle="round" borderColor="#C8C8C8" paddingX={1} paddingY={1}>
              <Box flexDirection="row" gap={1}>
                <Box width={modelWidth}><Text size="caption" weight="bold">模型明细</Text></Box>
                <Box width={tokenWidth} justifyContent="flex-end"><Text dimColor size="caption" weight="bold">输出</Text></Box>
                <Box width={requestWidth} justifyContent="flex-end"><Text dimColor size="caption" weight="bold">请求</Text></Box>
                <Box width={cacheWidth} justifyContent="flex-end"><Text dimColor size="caption" weight="bold">缓存率</Text></Box>
              </Box>
              {Object.entries(display.byModel).length === 0 && <Text dimColor size="caption">还没有模型用量</Text>}
              {Object.entries(display.byModel).map(([model, modelTotals]) => {
                // 旧快照可能没有按模型的缓存字段，按 0 处理；无输入侧时显示「—」。
                const rate = cacheRateOf(
                  modelTotals.inputTokens,
                  modelTotals.cacheReadTokens ?? 0,
                  modelTotals.cacheCreationTokens ?? 0,
                )
                return (
                  <Box key={model} flexDirection="row" gap={1}>
                    <Box width={modelWidth}><Text>{clip(modelLabel(model), modelWidth)}</Text></Box>
                    <Box width={tokenWidth} justifyContent="flex-end">
                      <Text>{fmtTokens(modelTotals.outputTokens)}</Text>
                    </Box>
                    <Box width={requestWidth} justifyContent="flex-end">
                      <Text>{String(modelTotals.requests)}</Text>
                    </Box>
                    <Box width={cacheWidth} justifyContent="flex-end">
                      <Text color={cacheRateLevel(rate)}>
                        {rate === null ? '—' : `${rate.toFixed(1)}%`}
                      </Text>
                    </Box>
                  </Box>
                )
              })}
            </Box>
          </Box>
          {/* 脚注由外层 gap 与表格分隔，不再单独插空行。 */}
          <Text dimColor size="caption">费用为宿主 /cost 的本地估算，不是账单。</Text>
          {/* 桌面端原生 Button 不呈现子 Text 的颜色（运行时截图确认），风险不能只靠颜色传达：
              左侧红色竖条 + 红色标题常驻说明清空范围与不可恢复性，正文保持默认色，既保留告警
              语义，又不与上方数据抢视觉；确认放在面板内部，不调用会写入会话的 AskUserQuestion 卡片。 */}
          {/* 与增强视图的清空告警同一形态：背景色块竖条 + 拉伸等高，避免字符行距造成断线。 */}
          <Box flexDirection="row" gap={1} alignItems="stretch">
            <Box width={1} backgroundColor="error">
              <Text color="error">{'▌\n▌\n▌'}</Text>
            </Box>
            <Box flexDirection="column">
              <Text weight="bold" color="error">重置当前会话统计</Text>
              <Text>清空本会话的轮次与累计，并删除数据库中该会话的记录。</Text>
              <Text dimColor>删除后无法恢复；其他会话的数据不受影响。</Text>
            </Box>
          </Box>
          {confirmingReset ? (
            <Box flexDirection="column">
              <Text weight="bold">确认重置？此操作无法恢复。</Text>
              <Box flexDirection="row" width={e.props.bodyColumns} gap={1}>
                <Box flexGrow={1} />
                <Button
                  key="reset-cancel"
                  onPress={() => {
                    void update($, resetConfirming, () => false)
                  }}
                >
                  {'取消'}
                </Button>
                <Button
                  key="reset-confirm"
                  onPress={() => {
                    void resetSessionStats($)
                  }}
                >
                  {'确认重置'}
                </Button>
              </Box>
            </Box>
          ) : (
            <Box flexDirection="row" width={e.props.bodyColumns}>
              <Box flexGrow={1} />
              <Button
                key="reset-stats"
                onPress={() => {
                  void update($, resetConfirming, () => true)
                }}
              >
                {'重置统计…'}
              </Button>
            </Box>
          )}
        </Box>
      )
    }

    // 子代理视图：独立统计，明确标注不计入会话累计。
    // 宿主名单（$.agent.list）不收录工作流子代理与引擎内部循环，但它们的 turn 事件带
    // agentId，已被 agentTotals 按 id 计数；名单之外的条目单独聚合，模型只记录
    // 最近一次响应上报的模型 id，不把它伪装成有名称、有状态的具体代理。
    const agentsView = () => {
      // 窄侧栏下长文本会按字符折行，标题与指标字段需要拆成可换行的独立文本块。
      const narrow = e.props.bodyColumns < 48
      const listedIds = new Set(agents.map(agent => agent.id))
      // 按最后活动时间倒序：最新的子代理排在最前；旧快照没有时间字段时排在最后。
      const unlisted = Object.entries(maps)
        .filter(([id]) => !listedIds.has(id))
        .sort(([, a], [, b]) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
      // 按 workflow run 分组：同一 run 的子代理排在一起，没有 runId 的旧记录归入「无分组」；
      // 组之间按组内最新活动时间倒序，组内沿用上面的时间倒序。
      const grouped = new Map<string, Array<[string, AgentTotals]>>()
      for (const entry of unlisted) {
        const key = entry[1].workflowRunId ?? ''
        const bucket = grouped.get(key)
        if (bucket) bucket.push(entry)
        else grouped.set(key, [entry])
      }
      const unlistedGroups = Array.from(grouped.entries()).sort(([, a], [, b]) => {
        const latest = (list: Array<[string, AgentTotals]>) =>
          list.reduce((n, [, item]) => Math.max(n, item.lastSeenAt ?? 0), 0)
        return latest(b) - latest(a)
      })
      // 名单外循环的汇总：输入与缓存字段在旧快照里可能缺省，按 0 相加保证缓存率不发散。
      const unlistedTotals = unlisted.reduce(
        (acc, [, counted]) => ({
          requests: acc.requests + counted.requests,
          turns: acc.turns + counted.turns,
          outputTokens: acc.outputTokens + counted.outputTokens,
          genMs: acc.genMs + counted.genMs,
          inputTokens: acc.inputTokens + (counted.inputTokens ?? 0),
          cacheReadTokens: acc.cacheReadTokens + (counted.cacheReadTokens ?? 0),
          cacheCreationTokens: acc.cacheCreationTokens + (counted.cacheCreationTokens ?? 0),
        }),
        {
          requests: 0,
          turns: 0,
          outputTokens: 0,
          genMs: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      )
      const unlistedTps =
        unlistedTotals.genMs > 0 ? (unlistedTotals.outputTokens / unlistedTotals.genMs) * 1000 : null
      // 缓存率与会话页、模型明细共用 cacheRateOf 的口径；输入侧为 0 时无读数。
      const unlistedCacheRate = cacheRateOf(
        unlistedTotals.inputTokens,
        unlistedTotals.cacheReadTokens,
        unlistedTotals.cacheCreationTokens,
      )

      // 名单与按 id 计数都为空，才是真的没有可展示的子代理。
      if (agents.length === 0 && unlisted.length === 0) {
        return (
          <Box flexDirection="column">
            <Text dimColor size="caption">子代理 · 独立统计，不计入会话累计</Text>
            <Text dimColor size="caption">当前会话还没有子代理</Text>
          </Box>
        )
      }

      // 名单内子代理的总览：输入/输出/缓存直接来自宿主 AgentInfo 的 usage 明细，
      // 与卡片内的单代理读数同源；首个请求被 /cost 计数前 usage 为空，缓存率无读数。
      const agentUsage = agents.reduce(
        (acc, agent) => {
          const usageRows = agent.usage ?? []
          acc.input += usageRows.reduce((n, row) => n + row.input_tokens, 0)
          acc.output += usageRows.reduce((n, row) => n + row.output_tokens, 0)
          acc.cacheRead += usageRows.reduce((n, row) => n + row.cache_read_input_tokens, 0)
          acc.cacheCreation += usageRows.reduce((n, row) => n + row.cache_creation_input_tokens, 0)
          acc.cost += agent.cost?.usd ?? 0
          return acc
        },
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 },
      )
      const agentCacheRate = cacheRateOf(agentUsage.input, agentUsage.cacheRead, agentUsage.cacheCreation)
      const requests = agents.reduce((n, agent) => n + (maps[agent.id]?.requests ?? 0), 0)
      const turns = agents.reduce((n, agent) => n + (maps[agent.id]?.turns ?? 0), 0)
      const genMs = agents.reduce((n, agent) => n + (maps[agent.id]?.genMs ?? 0), 0)
      // 速度的分子必须与分母同源：genMs 来自插件的 turn.complete 累计，
      // 因此输出也取同一累计，而不是宿主 /cost 账本（后者含重试、压缩等额外请求）。
      const pluginOutput = agents.reduce((n, agent) => n + (maps[agent.id]?.outputTokens ?? 0), 0)
      const avgTps = genMs > 0 ? (pluginOutput / genMs) * 1000 : null

      return (
        // 与其它视图一致：纵向间距统一交给 gap，不插入空 `<Text>` 行。
        <Box flexDirection="column" gap={1}>
          <Text dimColor size="caption">子代理 · 独立统计，不计入会话累计</Text>
          {agents.length > 0 && (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="row" flexWrap="wrap" rowGap={1}>
                {metric('总用量', fmtTokens(agentUsage.input + agentUsage.output))}
                {metric('输入', fmtTokens(agentUsage.input))}
                {metric('输出', fmtTokens(agentUsage.output))}
                {metric('缓存率', agentCacheRate === null ? '—' : `${agentCacheRate.toFixed(1)}%`, cacheRateLevel(agentCacheRate))}
                {metric('请求次数', String(requests))}
                {metric('轮数', String(turns))}
                {metric('平均速度', avgTps === null ? '—' : `${avgTps.toFixed(1)} t/s`)}
                {metric('估算费用', `$${agentUsage.cost.toFixed(2)}`)}
              </Box>
              <Text dimColor size="caption">任务列表</Text>
              {/* 每个子代理一张卡片：名称做主行，类型/状态/模型放小字，两行行内指标；
                  卡片之间留一空行，避免多张卡的边框连成一片。 */}
              <Box flexDirection="column" gap={1}>
                {agents.map(agent => {
                  const counted = maps[agent.id]
                  const speed = counted && counted.genMs > 0 ? (counted.outputTokens / counted.genMs) * 1000 : null
                  // 卡片内的输入/输出/缓存率取宿主 AgentInfo 的 usage 明细，与顶部总览同源；
                  // usage 为空（首个请求尚未被 /cost 计数）时不显示 0，按「—」表示无读数。
                  const usageRows = agent.usage ?? []
                  const usageInput = usageRows.reduce((n, row) => n + row.input_tokens, 0)
                  const usageOutput = usageRows.reduce((n, row) => n + row.output_tokens, 0)
                  const usageCacheRate = cacheRateOf(
                    usageInput,
                    usageRows.reduce((n, row) => n + row.cache_read_input_tokens, 0),
                    usageRows.reduce((n, row) => n + row.cache_creation_input_tokens, 0),
                  )
                  return (
                    <Box key={agent.id} flexDirection="column" borderStyle="round" borderColor="#C8C8C8" paddingX={1}>
                      <Text weight="bold">
                        {clip(agent.description || agent.id, Math.max(12, e.props.bodyColumns - 30))}
                      </Text>
                      <Box flexDirection="row" gap={1} flexWrap="wrap">
                        <Text dimColor size="caption">{agent.type}</Text>
                        <Text dimColor size="caption">{agent.status}</Text>
                        <Text dimColor size="caption">
                          {agent.model ? modelLabel(agent.model) : '未知模型'}
                        </Text>
                      </Box>
                      <Box flexDirection="row" gap={2} flexWrap="wrap">
                        {compactMetric('输入', usageRows.length === 0 ? '—' : fmtTokens(usageInput))}
                        {compactMetric('输出', usageRows.length === 0 ? '—' : fmtTokens(usageOutput))}
                        {compactMetric('缓存率', usageCacheRate === null ? '—' : `${usageCacheRate.toFixed(1)}%`, cacheRateLevel(usageCacheRate))}
                      </Box>
                      <Box flexDirection="row" gap={2} flexWrap="wrap">
                        {compactMetric('请求', String(counted?.requests ?? 0))}
                        {compactMetric('速度', speed === null ? '—' : `${speed.toFixed(1)} t/s`)}
                      </Box>
                    </Box>
                  )
                })}
              </Box>
            </Box>
          )}
          {unlisted.length > 0 && (
            <Box flexDirection="column" gap={1}>
              <Text dimColor size="caption">
                {narrow
                  ? `未列出的代理循环 · ${unlisted.length} 个`
                  : `宿主未列出的代理循环（工作流子代理或引擎内部任务）· ${unlisted.length} 个`}
              </Text>
              {/* 每个字段独立成一个 Text，由 flexWrap 在字段之间换行：
                  整行塞进一个 Text 时，窄面板会在字符中间断开，读起来像溢出。 */}
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                <Text dimColor size="caption">合计</Text>
                <Text dimColor size="caption">请求 {unlistedTotals.requests}</Text>
                <Text dimColor size="caption">轮数 {unlistedTotals.turns}</Text>
                <Text dimColor size="caption">输入 {fmtTokens(unlistedTotals.inputTokens)}</Text>
                <Text dimColor size="caption">输出 {fmtTokens(unlistedTotals.outputTokens)}</Text>
                <Text dimColor size="caption">缓存率</Text>
                {unlistedCacheRate === null ? (
                  <Text dimColor size="caption">—</Text>
                ) : (
                  <Text color={cacheRateLevel(unlistedCacheRate)} size="caption">
                    {`${unlistedCacheRate.toFixed(1)}%`}
                  </Text>
                )}
              </Box>
              {/* 宿主不提供这些循环的脚本名与状态，列表按 workflow run 分组：
                  组标题显示 run id 与数量，组内按 agentIndex 标注序号；无 runId 的旧记录
                  归入「无分组」。指标与会话页同口径，旧快照缺输入/缓存字段时按 0 展示。 */}
              {/* 组标题只在拿到 runId 时显示；旧记录没有 runId 时直接平铺，
                  卡片标题回退到 agentId，不显示「无分组」这类空分组。 */}
              {unlistedGroups.map(([runId, items]) => (
                <Box key={runId === '' ? 'ungrouped' : runId} flexDirection="column" gap={1}>
                  {runId !== '' && (
                    <Text dimColor size="caption">{`${runId} · ${items.length} 个`}</Text>
                  )}
                  <Box flexDirection="column" gap={1}>
                    {items.map(([id, counted]) => {
                      const speed = counted.genMs > 0 ? (counted.outputTokens / counted.genMs) * 1000 : null
                      const rate = cacheRateOf(
                        counted.inputTokens ?? 0,
                        counted.cacheReadTokens ?? 0,
                        counted.cacheCreationTokens ?? 0,
                      )
                      return (
                        <Box key={id} flexDirection="column" borderStyle="round" borderColor="#C8C8C8" paddingX={1}>
                          <Text dimColor size="caption">
                            {counted.workflowIndex !== undefined ? `#${counted.workflowIndex} · ` : ''}
                            {counted.spawnDescription
                              ? clip(counted.spawnDescription, Math.max(12, e.props.bodyColumns - 30))
                              : clip(id, Math.max(12, e.props.bodyColumns - 6))}
                          </Text>
                          <Box flexDirection="row" gap={1} flexWrap="wrap">
                            <Text dimColor size="caption">
                              {counted.model ? modelLabel(counted.model) : '未知模型'}
                            </Text>
                            <Text dimColor size="caption">请求 {counted.requests}</Text>
                            <Text dimColor size="caption">轮数 {counted.turns}</Text>
                            <Text dimColor size="caption">
                              速度 {speed === null ? '—' : `${speed.toFixed(1)} t/s`}
                            </Text>
                            <Text dimColor size="caption">
                              最近 {counted.lastSeenAt ? formatTime(counted.lastSeenAt) : '—'}
                            </Text>
                          </Box>
                          <Box flexDirection="row" gap={2} flexWrap="wrap">
                            {compactMetric('输入', fmtTokens(counted.inputTokens ?? 0))}
                            {compactMetric('输出', fmtTokens(counted.outputTokens))}
                            {compactMetric('缓存率', rate === null ? '—' : `${rate.toFixed(1)}%`, cacheRateLevel(rate))}
                          </Box>
                        </Box>
                      )
                    })}
                  </Box>
                </Box>
              ))}
              {/* 脚注由外层 gap 分隔。 */}
              <Text dimColor size="caption">宿主不提供这些循环的名称与费用；模型取最近一次响应。</Text>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          {tab('speed', '速度')}
          {tab('enhance', '增强')}
          {tab('session', '会话')}
          {tab('agents', '代理')}
        </Box>
        {current === 'speed' && speedView()}
        {current === 'enhance' && enhanceView()}
        {current === 'session' && sessionView()}
        {current === 'agents' && agentsView()}
      </Box>
    )
  })
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  // 延迟分档阈值来自 userConfig；/config 改动会重新加载模块并再次执行这里。
  applyLatencyConfig(options)
  registerCollectors(on)
  registerUi(on)

  // 宿主测量推送：每轮主循环结束后与配额窗口变化时给出最新上下文与费用。
  // 这里只同步上下文缓存并要求面板重绘，不写 state，避免干扰生成中的状态行。
  on('session.measure', async ($, e, next) => {
    statusCache.contextPercent = e.context.percent ?? null
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // 会话压缩：钩子在压缩开始前触发，await next(e) 返回时压缩已完成。
  // 压缩前的状态行缓存与已打开的面板不再代表当前窗口，宿主在新窗口第一次响应前
  // 也不提供上下文读数；这里重读一次并按无读数处理，再要求宿主重绘面板。
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      // 子代理或 fork 自己的转录压缩，不影响主会话窗口，不刷新主状态行。
      $.ui.log(`usage-toolbar: 子代理压缩不刷新主会话读数 agent=${e.agentId}`, { to: 'debug' })
      return result
    }

    try {
      await refreshStatus($)
      $.ui.invalidate('ui.render')
    } catch (error) {
      $.ui.log(`usage-toolbar: 压缩后刷新用量失败 ${String(error)}`, { to: 'debug' })
    }
    return result
  })

  // 会话开始：恢复增强记录、注册命令并初始化状态行。
  // 用量统计不在这里重置：热重载保留状态，应用重启后由 loadHistory 末尾的回填恢复。
  on('session.start', async ($, e, next) => {
    await loadRecords($)
    // 阈值配置无效时已回退默认值，这里补一条调试日志便于定位。
    if (latencyConfigIssue) {
      $.ui.log(`usage-toolbar: ${latencyConfigIssue}`, { to: 'debug' })
    }
    void startHistoryLoad($)
    await $.command.register({ name: 'usagebar', description: '打开用量面板' })
    await $.command.register({ name: 'enhance', description: '增强当前输入框草稿' })
    await $.command.register({ name: 'resetusage', description: '重置当前会话统计' })
    await refreshStatus($)

    // 语录轮播：每秒推进动画帧，每 5 秒换一句；只有主循环生成时才写入。
    // 热重载会停止旧副本的定时器，这里先取消本实例的旧定时器再启动新的。
    tickerTimer?.cancel()
    tickerTimer = $.clock.every(TICKER_TICK_MS, () => {
      void (async () => {
        const current = await read($, ticker)
        if (!current?.isWorking) return
        const frame = current.frame + 1
        const shouldRotate = frame % TICKER_PHRASE_EVERY_TICKS === 0
        const index = shouldRotate ? (current.index + 1) % TICKER_PHRASES.length : current.index
        const phrase = shouldRotate ? (TICKER_PHRASES[index] ?? current.phrase) : current.phrase
        await update($, ticker, value => (value ? { ...value, frame, index, phrase } : value))
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'usagebar' }, async $ => {
    // 普通打开从头开始，不继承上一次遗留的危险确认。
    await update($, resetConfirming, () => false)
    await update($, clearConfirming, () => false)
    const opened = await openUsagePane($)
    if (opened.isPlaced) return { text: '用量面板已打开' }

    return { text: `用量面板未打开：${opened.reason ?? '当前窗口宽度不足'}` }
  })

  on('command.run', { command: 'enhance' }, async $ => {
    await runEnhance($)

    return { text: '提示词增强已结束' }
  })

  on('command.run', { command: 'resetusage' }, async $ => {
    // 不直接重置，也不在会话里弹确认卡：打开面板并停在第二步确认。
    // 不返回 text：成功或取消都不在对话里留行。
    const opened = await openUsagePane($)
    if (!opened.isPlaced) {
      $.ui.log('usage-toolbar: 重置未执行：用量面板无法打开', { to: 'debug' })
      $.ui.toast('重置未执行：用量面板无法打开')
      return {}
    }

    await update($, view, () => 'session')
    await update($, clearConfirming, () => false)
    await update($, resetConfirming, () => true)

    return {}
  })
}
