import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, On, Register, SessionUsage } from 'claude-code'

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

function emptyAgent(): AgentTotals {
  return { requests: 0, turns: 0, genMs: 0, outputTokens: 0 }
}

/** 主循环请求计数：requests 加一，并按模型累计请求数。 */
function addRequest(byModel: SessionTotals['byModel'], model: string): SessionTotals['byModel'] {
  const key = model || 'unknown'
  const prev = byModel[key] ?? { inputTokens: 0, outputTokens: 0, requests: 0, genMs: 0 }
  return { ...byModel, [key]: { ...prev, requests: prev.requests + 1 } }
}

/** 主循环轮次汇总：把一轮的真实用量并入会话累计与模型明细。 */
function addRoundTotals(current: SessionTotals, round: UsageRound): SessionTotals {
  const key = round.model || 'unknown'
  const prev = current.byModel[key] ?? { inputTokens: 0, outputTokens: 0, requests: 0, genMs: 0 }
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
      },
    },
  }
}

/**
 * 刷新输入框下方的状态行。
 *
 * <p>数据来源：会话累计来自 state，上下文占比来自官方 $.session.usage()。
 * 读取失败时保留旧缓存并写日志，不阻断对话。</p>
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
      await update($, agentTotals, maps => {
        const prev = maps[agentId] ?? emptyAgent()
        return { ...maps, [agentId]: { ...prev, requests: prev.requests + 1 } }
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
      } else {
        const agentId = e.agentId
        await update($, agentTotals, maps => {
          const prev = maps[agentId] ?? emptyAgent()
          return {
            ...maps,
            [agentId]: {
              requests: prev.requests,
              turns: prev.turns + 1,
              genMs: prev.genMs + round.genMs,
              outputTokens: prev.outputTokens + round.outputTokens,
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
    const prev = result.byModel[key] ?? { inputTokens: 0, outputTokens: 0, requests: 0, genMs: 0 }
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

    // 指标卡：标题在上、数值在下；按面板可用列数每行放 4 个，避免右侧被裁。
    const cardWidth = Math.max(10, Math.floor((e.props.bodyColumns - 2) / 4))
    const metric = (label: string, value: string, color?: string) => (
      <Box flexDirection="column" width={cardWidth}>
        <Text dimColor>{label}</Text>
        <Text weight="semibold" color={color}>{value}</Text>
      </Box>
    )

    // 生成速度视图：最近轮次平均、峰值/最低/最新与字符柱状图；按速度档位着色。
    const speedView = () => {
      const recent = list.slice(-18)
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
      const maxTps = peak ?? 1
      const scope = '当前会话'

      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>{scope} · 最近 {recent.length} 轮平均输出速度</Text>
          <Text color={level.color} weight="bold" size="heading">
            {avg === null ? '—' : avg.toFixed(1)} <Text>t/s</Text>
          </Text>
          <Box flexDirection="row">
            <Text color={level.color}>{level.label}</Text>
            <Text dimColor> · {model}</Text>
          </Box>
          <Box flexDirection="row">
            {metric('峰值', peak === null ? '—' : peak.toFixed(1), tpsLevel(peak).color)}
            {metric('最低', low === null ? '—' : low.toFixed(1), tpsLevel(low).color)}
            {metric('最新', latest === null ? '—' : latest.toFixed(1), tpsLevel(latest).color)}
          </Box>
          <Text dimColor>最近 {Math.min(12, recent.length)} 轮生成速度</Text>
          {recent.length === 0 && <Text dimColor>还没有完成的轮次</Text>}
          {recent.slice(-12).map((round, index) => {
            const tps = tpsOfRound(round)
            const roundLevel = tpsLevel(tps)
            const width = Math.max(1, Math.round((tps / maxTps) * 10))
            return (
              <Box key={round.turnId} flexDirection="row">
                <Text dimColor>{String(index + 1).padStart(2, ' ')} </Text>
                <Text color={roundLevel.color}>{'█'.repeat(width)}</Text>
                <Text color={roundLevel.color}> {tps.toFixed(1)} t/s</Text>
              </Box>
            )
          })}
        </Box>
      )
    }

    // 增强记录视图：只展示当前会话的记录，卡片列出原文、增强文、token 与耗时。
    const enhanceView = () => {
      // 旧版本记录没有 sessionId，不属于任何会话；读不到会话 id 时同样不展示。
      const records = currentSessionId
        ? allRecords.filter(record => record.sessionId === currentSessionId)
        : []

      return (
        <Box flexDirection="column" rowGap={1}>
          {/* 行宽显式取面板可用列数，再用弹性占位把按钮推到最右：Pane 内的 Box 宽度随内容收缩，
              只写 justifyContent 时没有剩余空间可分布。 */}
          <Box flexDirection="row" width={e.props.bodyColumns}>
            <Text dimColor>最近增强记录 {records.length} 条</Text>
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
          {/* 与重置告警同一形态：红色边框 + 红色标题说明范围，确认放在面板内部，
              不写入会话。 */}
          <Box flexDirection="column" borderStyle="round" borderColor="error" paddingX={1}>
            <Text weight="semibold" color="error">⚠ 危险操作 · 清空当前会话的增强记录</Text>
            <Text>删除当前会话的全部增强记录，且无法恢复。</Text>
            <Text dimColor>其他会话的记录不受影响。</Text>
          </Box>
          {confirmingClear && (
            <Box flexDirection="column">
              <Text weight="semibold">确认清空？此操作无法恢复。</Text>
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
            <Text dimColor>还没有增强记录。点击输入框上方的「✦ 增强」或执行 /enhance。</Text>
          )}
          {records.slice(0, 8).map(record => (
            <Box key={record.id} flexDirection="column" borderStyle="round" paddingX={1}>
              <Text dimColor>模型 {modelLabel(record.model)}</Text>
              <Text>原文：{clip(record.original, Math.max(20, e.props.bodyColumns - 16))}</Text>
              <Text>增强：{clip(record.enhanced, Math.max(20, e.props.bodyColumns - 16))}</Text>
              <Text dimColor>
                消耗 {record.inputTokens}/{record.outputTokens} token · {formatTime(record.at)} ·{' '}
                {Math.round(record.durationMs)}ms
              </Text>
            </Box>
          ))}
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
      const cost = usage?.cost?.usd ?? null
      const contextPercent = usage?.context.percent ?? null
      const tokenWidth = 8
      const requestWidth = 6
      const modelWidth = Math.max(12, e.props.bodyColumns - tokenWidth - requestWidth - 4)
      const scope = '当前会话累计'

      return (
        <Box flexDirection="column">
          <Text dimColor>{scope}</Text>
          <Box flexDirection="row" flexWrap="wrap" rowGap={1}>
            {metric('总用量', fmtTokens(total))}
            {metric('输入', fmtTokens(display.inputTokens))}
            {metric('输出', fmtTokens(display.outputTokens))}
            {metric('缓存读取', fmtTokens(display.cacheReadTokens))}
            {metric('缓存写入', fmtTokens(display.cacheCreationTokens))}
            {metric('请求次数', String(display.requests))}
            {metric('轮数', String(display.turns))}
            {metric('平均耗时', display.turns > 0 ? `${(avgDuration / 1000).toFixed(1)}s` : '—')}
            {metric('平均延迟', display.ttftCount > 0 ? `${(avgTtft / 1000).toFixed(1)}s` : '—')}
            {metric('平均速度', avgTps === null ? '—' : `${avgTps.toFixed(1)} t/s`, tpsLevel(avgTps).color)}
            {metric('估算费用', cost === null ? '不可得' : `$${cost.toFixed(2)}`)}
            {metric('上下文', contextPercent === null ? '—' : `${contextPercent}%`)}
          </Box>
          {/* 与上方指标卡拉开一行，避免两个区块黏在一起。 */}
          <Text>{' '}</Text>
          <Text dimColor>模型明细</Text>
          <Box flexDirection="row" gap={1}>
            <Box width={modelWidth}><Text dimColor>模型</Text></Box>
            <Box width={tokenWidth} justifyContent="center"><Text dimColor>Token</Text></Box>
            <Box width={requestWidth} justifyContent="center"><Text dimColor>请求</Text></Box>
          </Box>
          {Object.entries(display.byModel).length === 0 && <Text dimColor>还没有模型用量</Text>}
          {Object.entries(display.byModel).map(([model, modelTotals]) => (
            <Box key={model} flexDirection="row" gap={1}>
              <Box width={modelWidth}><Text>{clip(modelLabel(model), modelWidth)}</Text></Box>
              <Box width={tokenWidth} justifyContent="center">
                <Text>{fmtTokens(modelTotals.outputTokens)}</Text>
              </Box>
              <Box width={requestWidth} justifyContent="center">
                <Text>{String(modelTotals.requests)}</Text>
              </Box>
            </Box>
          ))}
          <Text dimColor>费用为宿主 /cost 的本地估算，不是账单。</Text>
          <Text>{' '}</Text>
          {/* 桌面端原生 Button 不呈现子 Text 的颜色（运行时截图确认），风险不能只靠颜色传达：
              边框告警块常驻说明清空范围与不可恢复性；确认放在面板内部，不调用会写入会话的
              AskUserQuestion 卡片。 */}
          <Box flexDirection="column" borderStyle="round" borderColor="error" paddingX={1}>
            <Text weight="semibold" color="error">⚠ 危险操作 · 重置当前会话统计</Text>
            <Text>清空本会话的轮次与累计，并删除数据库中该会话的记录。</Text>
            <Text dimColor>删除后无法恢复；其他会话的数据不受影响。</Text>
          </Box>
          <Text>{' '}</Text>
          {confirmingReset ? (
            <Box flexDirection="column">
              <Text weight="semibold">确认重置？此操作无法恢复。</Text>
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
    // agentId，已被 agentTotals 按 id 计数；名单之外的条目单独聚合成一行，不把未知 id
    // 伪装成有名称、模型的具体代理。
    const agentsView = () => {
      const listedIds = new Set(agents.map(agent => agent.id))
      const unlisted = Object.entries(maps).filter(([id]) => !listedIds.has(id))
      const unlistedTotals = unlisted.reduce(
        (acc, [, counted]) => ({
          requests: acc.requests + counted.requests,
          turns: acc.turns + counted.turns,
          outputTokens: acc.outputTokens + counted.outputTokens,
          genMs: acc.genMs + counted.genMs,
        }),
        { requests: 0, turns: 0, outputTokens: 0, genMs: 0 },
      )
      const unlistedTps =
        unlistedTotals.genMs > 0 ? (unlistedTotals.outputTokens / unlistedTotals.genMs) * 1000 : null

      // 名单与按 id 计数都为空，才是真的没有可展示的子代理。
      if (agents.length === 0 && unlisted.length === 0) {
        return (
          <Box flexDirection="column">
            <Text dimColor>子代理 · 独立统计，不计入会话累计</Text>
            <Text dimColor>当前会话还没有子代理</Text>
          </Box>
        )
      }

      const agentUsage = agents.reduce(
        (acc, agent) => {
          const usageRows = agent.usage ?? []
          acc.input += usageRows.reduce((n, row) => n + row.input_tokens, 0)
          acc.output += usageRows.reduce((n, row) => n + row.output_tokens, 0)
          acc.cost += agent.cost?.usd ?? 0
          return acc
        },
        { input: 0, output: 0, cost: 0 },
      )
      const requests = agents.reduce((n, agent) => n + (maps[agent.id]?.requests ?? 0), 0)
      const turns = agents.reduce((n, agent) => n + (maps[agent.id]?.turns ?? 0), 0)
      const genMs = agents.reduce((n, agent) => n + (maps[agent.id]?.genMs ?? 0), 0)
      const avgTps = genMs > 0 ? (agentUsage.output / genMs) * 1000 : null

      return (
        <Box flexDirection="column">
          <Text dimColor>子代理 · 独立统计，不计入会话累计</Text>
          {agents.length > 0 && (
            <Box flexDirection="column">
              <Box flexDirection="row" flexWrap="wrap" rowGap={1}>
                {metric('总用量', fmtTokens(agentUsage.input + agentUsage.output))}
                {metric('输入', fmtTokens(agentUsage.input))}
                {metric('输出', fmtTokens(agentUsage.output))}
                {metric('请求次数', String(requests))}
                {metric('轮数', String(turns))}
                {metric('平均速度', avgTps === null ? '—' : `${avgTps.toFixed(1)} t/s`)}
                {metric('估算费用', `$${agentUsage.cost.toFixed(2)}`)}
              </Box>
              <Text dimColor>任务列表</Text>
              {agents.map(agent => {
                const counted = maps[agent.id]
                const speed = counted && counted.genMs > 0 ? (counted.outputTokens / counted.genMs) * 1000 : null
                return (
                  <Box key={agent.id} flexDirection="column">
                    <Text weight="semibold">
                      {clip(agent.description || agent.id, Math.max(12, e.props.bodyColumns - 30))}
                    </Text>
                    <Text dimColor>{agent.type} · {agent.status} · {agent.model ? modelLabel(agent.model) : '未知模型'}</Text>
                    <Text>
                      Token {fmtTokens(agent.tokenCount)} · 请求 {counted?.requests ?? 0} · 速度{' '}
                      {speed === null ? '—' : `${speed.toFixed(1)} t/s`}
                    </Text>
                  </Box>
                )
              })}
            </Box>
          )}
          {unlisted.length > 0 && (
            <Box flexDirection="column">
              {agents.length > 0 && <Text>{' '}</Text>}
              <Text dimColor>宿主未列出的代理循环（工作流子代理或引擎内部任务）</Text>
              <Text>
                请求 {unlistedTotals.requests} · 轮数 {unlistedTotals.turns} · 输出{' '}
                {fmtTokens(unlistedTotals.outputTokens)} · 平均速度{' '}
                {unlistedTps === null ? '—' : `${unlistedTps.toFixed(1)} t/s`}
              </Text>
              <Text dimColor>宿主不提供这些循环的名称、模型与费用，仅按 agentId 计数。</Text>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {tab('speed', '速度')}
          {tab('enhance', '增强')}
          {tab('session', '会话')}
          {tab('agents', '代理')}
        </Box>
        {/* Pane 按行绘制，空 Box 不产生行；用一行空白 Text 撑开标签与内容的间距。 */}
        <Text>{' '}</Text>
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

export const register: Register = on => {
  registerCollectors(on)
  registerUi(on)

  // 会话开始：恢复增强记录、注册命令并初始化状态行。
  // 用量统计不在这里重置：热重载保留状态，应用重启后由 loadHistory 末尾的回填恢复。
  on('session.start', async ($, e, next) => {
    await loadRecords($)
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
