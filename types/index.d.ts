/**
 * claude-usage-toolbar 的状态契约。
 *
 * <p>会话内统计（轮次、实时速度、累计、子代理计数）存于宿主会话状态 {@code $.state}，
 * 热重载后保留、新会话重置；增强记录跨会话保留，存于 {@code $.store}。
 * 每个值带独立 shape 版本，代码结构变化时递增版本以拒绝旧形状。</p>
 */

/** 一轮主会话（或子代理）的模型用量与耗时，由 turn.complete 归一化得到。 */
export type UsageRound = {
  /** 宿主轮次 id，用于把 turn.start、turn.step 与 turn.complete 对齐。 */
  turnId: string
  /** 本轮最后一个响应的模型 id，用于分组与显示。 */
  model: string
  /** 本轮各请求的未缓存输入 token 之和。 */
  inputTokens: number
  /** 本轮各请求的输出 token 之和。 */
  outputTokens: number
  /** 本轮从提示缓存读取的输入 token 之和。 */
  cacheReadTokens: number
  /** 本轮写入提示缓存的输入 token 之和。 */
  cacheCreationTokens: number
  /** 整轮墙钟耗时（含工具执行间隙），来自 turn.complete。 */
  durationMs: number
  /** 纯生成耗时：各 step 起止之差的和，用于计算真实输出速度。 */
  genMs: number
  /** 首字延迟：首个文本或思考块到达时间减去请求开始时间；无文本响应为 null。 */
  ttftMs: number | null
  /** 本轮开始时间（epoch 毫秒）。 */
  startedAt: number
}

/** 单个模型的会话累计用量。 */
export type ModelTotals = {
  /** 该模型各请求的未缓存输入 token 之和。 */
  inputTokens: number
  outputTokens: number
  requests: number
  genMs: number
  /** 该模型从提示缓存读取的输入 token 之和；热重载保留的旧形状可能缺少该字段，按 0 处理。 */
  cacheReadTokens: number
  /** 该模型写入提示缓存的输入 token 之和；热重载保留的旧形状可能缺少该字段，按 0 处理。 */
  cacheCreationTokens: number
}

/** 主会话累计用量，只统计主循环，不含子代理。 */
export type SessionTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 模型请求次数（turn.step 次数）。 */
  requests: number
  /** 完整轮数（turn.complete 次数）。 */
  turns: number
  /** 累计纯生成耗时（毫秒）。 */
  genMs: number
  /** TTFT 累计值与样本数，用于求平均延迟。 */
  ttftTotalMs: number
  ttftCount: number
  /** 按模型分组的累计，用于面板模型明细表。 */
  byModel: Record<string, ModelTotals>
}

/** 单个子代理的累计用量，独立统计、不计入主会话。 */
export type AgentTotals = {
  requests: number
  turns: number
  genMs: number
  outputTokens: number
  /** 输入侧 token（未缓存输入）；旧快照没有该字段，读取时按 0 处理。 */
  inputTokens?: number
  /** 缓存读取 token；旧快照没有该字段，读取时按 0 处理。 */
  cacheReadTokens?: number
  /** 缓存写入 token；旧快照没有该字段，读取时按 0 处理。 */
  cacheCreationTokens?: number
  /** 最近一次响应的模型 id；名单外循环在首个轮次完成前没有该字段。 */
  model?: string
  /** 所属 workflow run 的 id（如 wf_xxx）；由 agent.spawn 记录，旧快照没有。 */
  workflowRunId?: string
  /** 该子代理在所属 run 中的 agent() 序号（从 1 开始）；由 agent.spawn 记录。 */
  workflowIndex?: number
  /** 宿主在 spawn 时给的短描述；workflow 子代理可能为空或占位符。 */
  spawnDescription?: string
  /** 最后一次活动的 epoch 毫秒，用于列表按时间倒序；旧快照没有该字段。 */
  lastSeenAt?: number
}

/** 一条提示词增强记录，写入跨会话存储。 */
export type EnhanceRecord = {
  /** 记录 id，时间戳加序号，用于列表 key。 */
  id: string
  /** 产生该记录的会话 id；旧版本记录没有该字段，不属于任何会话，不参与展示。 */
  sessionId?: string
  /** 实际执行改写的模型 id。 */
  model: string
  /** 用户原始草稿。 */
  original: string
  /** 模型改写后的文本。 */
  enhanced: string
  inputTokens: number
  outputTokens: number
  /** 改写调用耗时（毫秒）。 */
  durationMs: number
  /** 记录时间（epoch 毫秒）。 */
  at: number
}

/** 增强调用的进行中状态，用于按钮禁用与状态提示。 */
export type EnhanceState = {
  isRunning: boolean
  startedAt: number
  model: string
}

/** 面板当前视图。 */
export type UsageView = 'speed' | 'enhance' | 'session' | 'agents'

/** 输入框上方状态轮播的当前状态。 */
export type TickerState = {
  /** 当前显示的语录，可能含 {elapsed}/{tps}/{model} 占位符。 */
  phrase: string
  /** 语录在词包中的序号。 */
  index: number
  /** 本轮开始时间（epoch 毫秒）。 */
  startedAt: number
  /** 是否有正在生成的主循环轮次。 */
  isWorking: boolean
  /** 动画帧序号，每秒递增。 */
  frame: number
}

/** 一次历史会话的用量快照，按会话 ID 区分。 */
export type HistoryEntry = {
  /** 会话 id（transcript 文件名）。 */
  sessionId: string
  /** 该会话结束时的累计用量。 */
  totals: SessionTotals
  /** 最近 100 轮主会话记录。 */
  rounds: UsageRound[]
  /** 该会话的代理计数，按 agentId 分组的请求/轮数/输出/生成耗时；旧快照没有该字段。 */
  agentTotals?: Record<string, AgentTotals>
  /** 会话结束时的估算费用（USD）；宿主无账本时缺省。 */
  costUsd?: number
  /** 会话结束时的上下文占比。 */
  contextPercent?: number
  /** 快照写入时间（epoch 毫秒）。 */
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-toolbar': {
      rounds: Shaped<UsageRound[]>
      totals: Shaped<SessionTotals>
      agentTotals: Shaped<Record<string, AgentTotals>>
      view: Shaped<UsageView>
      resetConfirming: Shaped<boolean>
      clearConfirming: Shaped<boolean>
      enhanceRecords: Shaped<EnhanceRecord[]>
      enhanceState: Shaped<EnhanceState | null>
      ticker: Shaped<TickerState | null>
    }
  }
}
