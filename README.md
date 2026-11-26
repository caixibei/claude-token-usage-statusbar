# 📊 usage-toolbar

[![Version](https://img.shields.io/badge/version-0.2.56-2ea44f?style=flat-square)](.claude-plugin/plugin.json)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Claude%20Desktop%20%7C%20Claude%20Code-6f42c1?style=flat-square)
![Type](https://img.shields.io/badge/type-Claude%20mod-ff8c00?style=flat-square)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.x-3776AB?style=flat-square&logo=python&logoColor=white)](https://www.python.org/)
[![SQLite](https://img.shields.io/badge/SQLite-usage.db-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org/)
![i18n](https://img.shields.io/badge/i18n-中文-d73a4a?style=flat-square)

Claude Desktop / Claude Code 的用量与提示词增强 mod：⚡ 实时生成速度、⏱️ 首字延迟、🧮 当前会话累计用量、🤖 子代理独立统计，以及 ✨ 提示词增强与增强记录。

`claude-desktop` · `claude-code` · `plugin` · `mod` · `usage-stats` · `tokens` · `prompt-enhancement` · `sqlite` · `typescript`

> [!NOTE]
> 本项目参考社区插件 [zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar) 的功能设计，使用 Claude 官方 mod 机制实现，不修改宿主程序文件。

## ✨ 功能

| 功能 | 说明 |
|---|---|
| ⚡ 实时速率 | 生成过程中在输入框下方状态行显示估算速度（t/s）、本轮 token、会话 token 与上下文占比 |
| 🎞️ 状态轮播 | 输入框上方左侧显示彩色点阵球 + 已用时间 + 趣味语录，每 5 秒换一句；支持 `{elapsed}`、`{tps}`、`{model}` 占位符；空闲时显示「本轮工作已完成」 |
| 🚦 速度分级 | 所有 tps 读数统一按「速度 / 满格刻度」分 5 档着色：`<10%`、`10–25%`、`25–45%`、`45–70%`、`≥70%`，越接近满格颜色越冷；顶部另标绝对速度档位文本（`<40`、`40-70`…`≥2000`），区间左闭右开 |
| 🗄️ 历史会话 | 本地 SQLite 按会话保存最近 100 轮与累计；重启后自动回填当前会话，面板只展示当前会话 |
| 📈 生成速度明细 | 面板展示最近轮次平均速度、峰值、最低、最新，以及每轮字符柱状图 |
| ✨ 提示词增强 | 输入框上方「✦ 增强」、`/enhance`，或消息以 `++` / `增强：` 开头时提交前自动改写；用当前会话模型改写，记录带会话 id，只展示当前会话的记录 |
| 🧮 当前会话累计 | 输入/输出/缓存读取/缓存写入/缓存率、请求次数、轮数、平均耗时、平均延迟、平均速度、估算费用、模型明细（含每模型缓存率） |
| 🤖 子代理用量 | 子代理独立统计，不计入会话累计；显示每个子代理的状态、模型、输入/输出、缓存率、请求数与速度；宿主未列出的代理循环（工作流子代理或引擎内部任务）按 `agentId` 聚合显示输入/输出、缓存率、请求、轮数与速度，并标注最近一次响应的模型 |

## 🖥️ 界面与使用

![usage-toolbar 界面总览：右侧用量面板的会话视图，输入框上方状态轮播与增强/用量入口，底部实时速率行](assets/overview.png)

> 图中标注了三处入口：右侧「▦ 用量」面板的会话视图，输入框上方的状态轮播，以及底部状态行的实时速率与本轮/会话 token、上下文占比。

- 🖋️ **输入框上方**：左侧为状态轮播；右上方 `✦ 增强`（改写当前草稿）、`▦ 用量`（打开用量面板）
- 📉 **底部状态行**：生成中显示实时估算速度；结束后不显示速率，只保留本轮/会话 token 与上下文占比，例如 `本轮 327 · 会话 289.9万 · 上下文 12%`
- ⌨️ **`/usagebar`**：打开用量面板（宿主已保留 `/usage`，因此命令名为 `usagebar`）
- ✨ **`/enhance`**：增强当前输入框草稿
- 🧹 **清空记录**：增强视图右上角的「清空记录…」使用面板内两步确认，只删除当前会话的增强记录，删除后无法恢复；确认不会写入会话；可在 `userConfig` 中把 `allowEnhanceClear` 设为「不可重置」关闭该入口
- ♻️ **`/resetusage`**：重置当前会话统计；会话视图底部的「重置统计…」按钮效果相同。两个入口都使用面板内两步确认：先点「重置统计…」，再点「确认重置」；`/resetusage` 会打开面板并停在确认步骤。确认只存在于面板内，不会写入会话。取消、切换页签或关闭面板都视为取消；重置成功或取消都不向对话发送消息，诊断信息只写入调试日志；可在 `userConfig` 中把 `allowSessionReset` 设为「不可重置」关闭该入口与命令
- 🚀 **发送前增强**：消息以 `++` 或 `增强：` 开头时，提交前用当前模型改写再发出；第一条消息也能用，普通消息不受影响。不要用 `!`：宿主会把行首 `!` 交给 shell
- 🗂️ **面板四个视图**：速度、增强、会话、代理；面板以对话框形态打开，Esc 关闭
- 🔄 **面板刷新**：面板由宿主拉取式绘制，插件在每次模型响应结束、宿主测量推送与压缩完成后请求重绘；面板里的上下文与费用始终来自最近一次宿主读数
- 🔒 **会话隔离**：四个视图都只展示当前会话的数据；增强记录按会话 id 归属，只显示和清空当前会话的记录

### 📊 面板四视图

四个视图共享同一份会话数据，切换只改变展示方式。以下截图均来自真实会话。

#### ⚡ 速度：最近轮次的输出速度

![速度视图：最近 18 轮平均输出速度折线、峰值/最低/最新读数，以及按统一分档着色的柱状图与逐轮块条](assets/panel-speed.png)

- 顶部直接给出当前会话最近轮次的平均输出速度、绝对速度档位（如 `70-150`）与模型
- 三张图各自带标题与一行说明：速度趋势（折线）、逐轮柱状图、逐轮明细（块条），不用猜每张图看什么
- 折线图展示逐轮趋势，峰值、最低、最新三项读数标在下方，一眼看出波动
- 宽面板同时显示柱状图与逐轮块条（同一窗口 20 轮）；窄面板只显示块条（最近 50 轮）
- 柱状图与块条按「速度 / 满格刻度」分 5 档着色：条长和颜色表达同一个达成度，越接近满格颜色越冷
- 块条整格实心、末格按比例部分填充，相近读数也能看出差别；柱状图标题标出满格刻度
- 桌面端用 SVG 绘制，终端回退字符柱状图；速度是字符估算值，真实值在每步或每轮结束时回填

#### ✨ 增强：改写记录逐条可查

![增强视图：当前会话最近 3 条增强记录，含原文/增强对照、模型、输入输出 token、耗时与时间](assets/panel-enhance.png)

- 每条记录保留原文与增强结果对照，以及实际执行改写的模型、输入/输出 token、耗时与时间
- 只展示当前会话的记录，按会话 id 归属；旧版本没有会话归属的记录不会出现
- 「清空记录…」两步确认后只删除当前会话的增强记录，删除后无法恢复，其他会话不受影响
- 记录先保存再写回草稿，写回失败时增强结果仍可在面板查看

#### 🧮 会话：当前会话的完整账单

![会话视图：当前会话累计、估算费用、上下文水位条、Token 构成、请求与性能、模型明细与重置入口](assets/panel-session.png)

- 三张摘要卡：累计 token、估算费用、上下文占比（10 格方块水位条）
- Token 构成：输入、输出、缓存读取、缓存写入与缓存率，缓存率按 95/90/80 三档着色
- 请求与性能：请求次数、轮数、平均耗时、平均延迟、平均速度；平均速度按「速度满格与分档配置」的 5 档着色，其余按各自档位着色
- 模型明细：每个模型的输出 token、请求数与缓存率，多模型会话分行展示
- 底部「重置统计…」两步确认后清空本会话统计与数据库记录，其他会话不受影响；估算费用是宿主对整条会话的累计读数，不随重置清空

#### 🤖 代理：子代理与未列出循环

![代理视图：子代理合计，以及 10 个宿主未列出循环按 agentId 聚合的独立统计卡片](assets/panel-agents.png)

- 名单内子代理显示状态、模型、输入/输出、缓存率、请求数与速度
- 宿主未列出的循环（工作流子代理或引擎内部任务）按 `agentId` 聚合，按最近活动时间倒序排列
- 每张卡片显示请求数、轮数、速度、最近活动时间与缓存率，最新完成的子代理排在最前
- 子代理独立统计，不计入会话累计；宿主不提供这些循环的名称与费用，模型取最近一次响应

### 🎞️ 状态轮播

- 生成中：ZCode 同款单行立体点阵球（三个盲文字符拼出球体，逐帧滚动）+ 已用时间 + 趣味语录；每 250 毫秒滚动一帧，每秒刷新计时，每 5 秒换一句；不额外占高度。
- 语录词库在 `hooks/register.tsx` 的 `TICKER_PHRASES`，可直接增删句子。
- 语录支持占位符 `{elapsed}`、`{tps}`、`{model}`。
- 空闲时显示「本轮工作已完成，随时可以继续」，不显示速率；尚未开始过轮次时显示「准备就绪」。

### 🎨 指标分档

面板指标按同一套颜色语义分档：青=最佳、绿=良好、黄=偏慢/偏高、红=告警；区间左闭右开，无读数显示「—」且不着色。速度读数不在这套四档里，另按「速度满格与分档配置」的红→紫 5 档着色。

| 指标 | 青色 | 绿色 | 黄色 | 红色 |
|---|---|---|---|---|
| 缓存率 | ≥95% | 90–95% | 80–90% | <80% |
| 平均延迟 | <2s | 2–4s | 4–8s | ≥8s |
| 平均耗时（每轮请求平均） | <10s | 10–30s | 30–60s | ≥60s |
| 上下文占比 | <40% | 40–60% | 60–80% | ≥80% |

### ⚙️ 延迟分档配置

平均延迟按四档着色：`<2s` 青色、`2–4s` 绿色、`4–8s` 黄色、`≥8s` 红色；区间左闭右开，与缓存率共用同一套颜色语义（青=最佳、绿=良好、黄=偏慢、红=告警）。

阈值通过插件 `userConfig` 配置，`/config` 中对应 `usage-toolbar.latencyTealMaxSec`、`usage-toolbar.latencyGreenMaxSec`、`usage-toolbar.latencyYellowMaxSec`（单位：秒）；也可以直接写入 `~/.claude/settings.json`：

```json
{
  "pluginConfigs": {
    "usage-toolbar": {
      "options": {
        "latencyTealMaxSec": 2,
        "latencyGreenMaxSec": 4,
        "latencyYellowMaxSec": 8
      }
    }
  }
}
```

- 三个值必须为正数且严格递增；否则整体回退默认 2/4/8，并在调试日志记录回退原因。
- 配置改动会在插件重新加载后生效。

### ⚙️ 速度满格与分档配置

所有 tps 读数——顶部平均速度与档位标签、峰值/最低/最新、每轮块条与同行读数、柱状图、会话视图的平均速度——统一按「速度 / 满格刻度」分 5 档着色，区间左闭右开：

| 达成满格比例 | 颜色 | 满格 300 时对应 |
|---|---|---|
| `<10%` | 红 `#E5484D` | `<30` t/s |
| `10–25%` | 橙 `#F5A524` | 30–75 |
| `25–45%` | 绿 `#17C964` | 75–135 |
| `45–70%` | 蓝 `#3B82F6` | 135–210 |
| `≥70%` | 紫 `#A855F7` | ≥210 |

满格刻度通过 `userConfig` 的 `barFullScaleTps` 配置（默认 300），`/config` 中对应 `usage-toolbar.barFullScaleTps`，也可写入 `~/.claude/settings.json` 的 `pluginConfigs.usage-toolbar.options`。块条长度与颜色共用这个基准；峰值超过基准时，条长基准自动上浮到 100 的倍数，颜色基准保持不变。配置改动在插件重新加载后生效。

### 🔒 重置开关

两项破坏性入口各自独立配置，选择「不可重置」后对应按钮与命令都不出现（默认「可重置」）：

| 配置项 | 作用 | 取值 | 默认 |
|---|---|---|---|
| `allowSessionReset` | 会话视图的「重置统计…」与 `/resetusage` 命令 | 可重置 / 不可重置 | 可重置 |
| `allowEnhanceClear` | 增强视图的「清空记录…」入口 | 可重置 / 不可重置 | 可重置 |

`/config` 中对应 `usage-toolbar.allowSessionReset`、`usage-toolbar.allowEnhanceClear`；也可以写入 `~/.claude/settings.json` 的 `pluginConfigs.usage-toolbar.options`。配置改动在插件重新加载后生效。

## 📊 数据口径

> [!IMPORTANT]
> 速度是字符估算，费用是宿主 `/cost` 的本地计价，上下文取宿主状态行口径——三者都不是账单或精确计量，请以宿主与账单为准。

| 指标 | 数据来源 | 口径说明 |
|---|---|---|
| 实时速度 | `turn.step` 的 `text`、`thinking`、`input` 流式块 | 字符增量 ÷ 3.5 ≈ token，再除以「首个输出块到达后」的已生成时间；分子分母覆盖同一段 token 产出区间，不含首字等待；是**估算值** |
| 首字延迟 | `turn.step` 首个 `text`/`thinking` 块 | 首个块到达时间 − 该步请求开始时间 |
| 平均延迟分档 | 会话累计的 TTFT 平均值 | `<2s` 青色、`2–4s` 绿色、`4–8s` 黄色、`≥8s` 红色；阈值可由 `userConfig` 覆盖（见「延迟分档配置」）；区间左闭右开，无样本不着色 |
| 每轮速度 | `turn.complete.usage.output_tokens` | 输出 token ÷ 各步纯生成耗时之和，不含工具等待；颜色按「速度 / 满格刻度」5 档（见「速度满格与分档配置」） |
| 会话累计 | `turn.complete.usage` 逐轮累加 | 只统计主循环；中断或 API 错误时缺失的 usage 按 0 处理 |
| 缓存率 | 会话累计与模型明细的输入侧字段 | 缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入）；输入侧为 0 时显示「—」；模型明细按模型分别计算。分档：<80% 红色告警、80–90% 黄色告警、90–95% 绿色、≥95% 青色；区间左闭右开 |
| 请求次数 | `turn.step` 次数 | 每个 `turn.step` 对应一次模型请求 |
| 轮数 | `turn.complete` 次数 | 主循环与子代理分开计数 |
| 平均耗时 | 会话累计的 `genMs` | 各轮模型请求耗时之和 ÷ 轮数，含首字等待、不含工具执行间隙；分档 `<10s` 青、`10–30s` 绿、`30–60s` 黄、`≥60s` 红 |
| 上下文占比 | `$.session.usage().context.percent` | 最近一次响应的输入侧占模型窗口比例；压缩后宿主在新窗口第一次响应前不提供读数。状态行在每次响应结束时刷新，面板在响应结束、宿主测量推送与压缩完成后重绘，均重读宿主当前值。分档 `<40%` 青、`40–60%` 绿、`60–80%` 黄、`≥80%` 红（越高越接近压缩阈值） |
| 估算费用 | `$.session.usage().cost.usd` | 宿主 `/cost` 的本地估算，不是账单；第三方模型可能显示「不可得」 |
| 子代理用量 | `$.agent.list()` + `turn.step`/`turn.complete` 的 `agentId` | 名单内代理的输入/输出/缓存来自 AgentInfo 的 `usage`，请求数与轮数自行计数；名单外循环由 `turn.complete` 的 usage 累计输入/输出/缓存，模型取最近一次响应的 `usage.model`；费用仅名单内代理有（AgentInfo 的 `cost`） |
| 历史会话 | `$.process.run` 调用 `scripts/usage_store.py` | 数据库 `~/.claude/usage-toolbar/usage.db`，按 `session.id()` 分会话，保留最近 20 个；数据库只用于回填当前会话，面板不展示其他会话；启动或打开面板时若内存统计为空，从 `rounds` 表聚合回填；代理计数随会话快照保存并回填 |
| 提示词增强 | `$.prompt.read()` → `$.model.complete()` → `$.prompt.fill()`；`++` / `增强：` 前缀走 `prompt.submit` | 独立调用，不带会话上下文，成本更低；写回前二次读取草稿，用户改过则不覆盖；前缀在提交前直接改写发送文本；记录带 `sessionId`，按会话隔离展示 |

```mermaid
graph LR
  A["Claude 会话事件：turn.start / turn.step / turn.complete"] --> B["采集层：TTFT、实时速率、轮次用量、子代理计数"]
  B --> C["会话状态：轮次、累计、当前视图"]
  C --> D["底部状态行"]
  C --> E["用量面板：速度 / 增强 / 会话 / 代理"]
  F["prompt.read"] --> G["model.complete 改写"]
  G --> H["prompt.fill 写回草稿"]
  G --> I["store 增强记录"]
  I --> E
```

## 📦 安装

前置条件：Claude Desktop / Claude Code 2.1.326 或更新版本；Python 3（标准库 sqlite3，用于历史用量存储）；不需要 Node.js 或第三方 Python 包。

### 🧩 方式一：桌面端插件界面（日常使用推荐）

1. 在 Claude Desktop 输入框旁点击 `+`，选择 **Plugins**。
2. 选择 **Add marketplace**，填入以下之一：
   - 本地源码目录：`F:\claude-usages-toolbar`
   - 已发布的 GitHub 仓库：`<owner>/<repo>`
3. 在列表中找到 `usage-toolbar`，选择 **Add plugin**，安装范围选 **user**（当前用户的所有会话可用）。
4. 如果没有立即出现，重新打开一个会话。

> [!NOTE]
> Desktop 的 Code tab 输入框不支持 `/plugin` 命令；请用上面的界面操作，或在终端里安装。

### 💻 方式二：终端安装（本地文件夹或 GitHub）

本地文件夹：

```bash
claude plugin marketplace add F:\claude-usages-toolbar
claude plugin install usage-toolbar --marketplace usage-toolbar-local
```

GitHub 仓库（发布后）：

```bash
claude plugin install usage-toolbar --marketplace <owner>/<repo>
```

安装到 user scope 后，每个新会话都会加载；已打开的会话可以用 `/reload-plugins` 重新读取。

### 🛠️ 方式三：开发调试（当前会话热重载）

任选一种：

1. 复制到本会话的 mod 目录：`~/.claude/dev-mods/<session-id>/usage-toolbar/`，宿主会自动热重载。
2. 启动时指定：`claude --plugin-dir F:\claude-usages-toolbar`。
3. 在用户级 `~/.claude/settings.json` 的 `env` 中设置：

```json
{ "CLAUDE_CODE_PLUGIN_DIRS": "F:\\claude-usages-toolbar" }
```

第一次加载 mods 时，需要允许「Turn on the mods Claude writes in this session?」。

> [!WARNING]
> 正式安装后，不要再让 dev-mods 中的同名副本同时加载，避免重复 hook。保留一种加载方式即可。

### ✅ 验证安装

- 输入框上方出现彩色点阵球（生成中）或「✓ 本轮工作已完成」。
- 输入框上方右侧出现 `✦ 增强`、`▦ 用量`。
- 执行 `/usagebar` 能打开用量面板。
- `claude plugin validate F:\claude-usages-toolbar` 返回 `Validation passed`。

### 🔄 更新与卸载

- 更新：替换源码后重新安装，或让热重载重新加载；已安装的副本需要重新 Add plugin 或 `claude plugin update usage-toolbar`。
- 卸载：在 Plugins 列表中移除 `usage-toolbar`；或终端执行 `claude plugin uninstall usage-toolbar`（以当前 CLI 支持为准）。同时删除 dev-mods 中的调试副本（如存在）。

## 🗂️ 文件结构

```
.
├── .claude-plugin/
│   ├── plugin.json        # mod 清单
│   └── marketplace.json   # 本地 marketplace 清单
├── hooks/
│   ├── hooks.json         # 模块声明
│   └── register.tsx       # 采集、增强、绘制、命令
├── scripts/
│   └── usage_store.py     # SQLite 历史存储（Python 标准库）
├── types/
│   └── index.d.ts         # 状态契约
├── assets/
│   ├── overview.png       # 界面总览截图
│   ├── panel-speed.png    # 速度视图
│   ├── panel-enhance.png  # 增强视图
│   ├── panel-session.png  # 会话视图
│   └── panel-agents.png   # 代理视图
├── README.md
└── LICENSE
```

`.claude-plugin/types/` 是宿主加载 mod 时生成的类型目录，不应提交到版本库（已加入 `.gitignore`）。

> [!NOTE]
> `read`/`update` 引用的 atom 必须与 atom 定义在同一模块，这是引擎静态扫描的约束，因此实现集中在 `hooks/register.tsx`。

## 🧪 开发与验证

```bash
# 校验清单、hooks 与 TypeScript 类型
claude plugin validate <本目录>

# 类型检查（先让 mod 加载一次，生成 .claude-plugin/types/tsconfig.json）
tsc -p <本目录>

# 确认 Python 与 sqlite3 可用
python -c "import sqlite3; print(sqlite3.sqlite_version)"
```

- 保存文件后，热重载在本次回合结束或新会话时生效。
- 调试日志：用 `claude --debug` 启动，或查看会话 transcript 中 `usage-toolbar:` 开头的行。
- 当前未提供 `*.test.ts`；如需回归测试，可使用 `claude plugin test <本目录>`。

## ⚠️ 已知限制

> [!WARNING]
> 以下限制会影响读数的解读：估算值不要当作账单，历史回填可能低于真实值，压缩后上下文读数会短暂缺失。

- `/usage` 是 Claude Code 内置命令，本 mod 使用 `/usagebar`。
- 实时速度是字符估算，真实值在每步或每轮结束时回填。
- 费用是宿主 `/cost` 的本地估算，不是账单；第三方模型可能没有已知价格。
- 子代理请求次数由 `turn.step` 自行计数，宿主不提供现成字段。
- 历史会话需要本机 Python 3；SQLite 不可用时回退到宿主 `$.store` 的单会话快照。
- 重启后回填的请求次数按轮数近似（`rounds` 表不保存每轮请求数），可能低于真实值。
- 代理计数随会话快照保存；重启后代理的名称与状态不可恢复，面板按 `agentId` 聚合展示，模型取最近一次响应记录的值。
- 旧版本保存的增强记录没有 `sessionId`，不属于任何会话，升级后不会出现在面板中。
- 历史费用与上下文是会话结束时的快照，不是账单；历史会话的费用可能显示「不可得」。
- 执行 `/compact` 后，宿主在新窗口产生第一次响应前不提供上下文读数：状态行暂时不显示上下文，面板显示「—」；压缩完成时会立即刷新，不会停留在压缩前的旧值，第一次响应后自动恢复。
- 回答末尾速率行未实现：`TurnDuration` 只在终端 surface 触发，Desktop 不绘制。
- 面板按窄侧栏约 30 列优化；更宽时内容会留白，不会溢出。
- 桌面端的原生 `Button` 不呈现子 `Text` 的颜色；重置入口改用边框告警块与宿主原生确认对话框表达风险，不再依赖按钮颜色。
- 工作流子代理与引擎内部循环不在宿主的 `$.agent.list()` 中；代理页对它们显示按 `agentId` 聚合的输入/输出、缓存率、请求、轮数、速度与最近一次响应的模型，不显示名称与费用。

## 📄 许可

MIT License，见 [LICENSE](LICENSE)。

## 🙏 致谢

功能设计参考 [ByteRax/zcode-token-usage-statusbar](https://github.com/ByteRax/zcode-token-usage-statusbar)（MIT）。
