# Agent;Gate 开发计划

> 基线：`v1.8.3`（`adeca9a`）
>
> 这不是产品愿望清单。每个阶段都应当能独立开发、测试、发布；后续实现以本文件的顺序和验收条件为准。完成后把任务状态改为“已完成”，补上对应版本号和测试结果。

## 目标与边界

Agent;Gate 的核心仍然是 Windows 本地 API 密钥管理和回环网关，不演变成另一个 Codex 客户端。

近期目标是把已经存在但分散的路由、探测、故障切换、恢复和请求统计能力，变成每个客户端都能看懂、能独立配置、能追溯结果的界面。之后再有选择地补齐 Codex 的配置维护能力。

本计划不做：

- 不接入云端账号、遥测或共享代理。
- 不把上游 URL、API Key 或客户端原始认证文件暴露给渲染进程。
- 不接入 Codex UI 注入、皮肤运行时或任何修改官方应用包的功能。
- 不加入以绕过模型安全边界为目的的提示词内容。
- 不重写已经稳定的网关协议适配、钱包登录或现有分组/密钥流程。

## 已完成基线

以下能力已在 `v1.8.3` 完成，只做回归保护和必要的可视化，不再重新设计底层逻辑：

| 能力 | 当前实现 | 回归依据 |
| --- | --- | --- |
| 首 token 计时 | 收到上游第一个有效推理或文本事件时记为 `firstTokenLatencyMs`，而不是等可见正文 | `tests/request-monitor-service.test.mjs`：推理先于正文、空 reasoning 项、分片事件 |
| 首包计时 | 单独记录 `firstByteLatencyMs`；非流式响应不伪造 TTFT | `tests/request-monitor-service.test.mjs`：JSON、未知流和非流式场景 |
| 渠道探测 | 方案保存后可发现模型；每个端点保存当前状态、30 点历史和 60 点时间线 | `electron/services/health-service.cjs`、`tests/health-monitoring.test.mjs` |
| 端点自动择优 | 用户可为各客户端开启故障切换并指定候选密钥；连续失败后只在候选中探测，按健康状况与延迟选择 | `electron/services/auto-switch-service.cjs`、`tests/auto-switch-service.test.mjs` |
| 官方恢复 | 只撤销 Agent;Gate 管理的 Codex provider 与顶层选择，保留用户其他 TOML 内容和现有登录态 | `electron/services/apply-service.cjs`、`tests/apply-service.test.mjs` |
| 安全配置写入 | 网关接管前保存加密基线；停止、恢复或失败时事务化回滚 | `electron/services/apply-service.cjs`、`tests/apply-service.test.mjs` |

## 实施总顺序

```text
P0  配置契约和迁移
 -> P1  客户端路由设置页
 -> P2  状态与故障切换可解释性
 -> P3  备份与官方恢复可视化
 -> P4  请求时间线与首 token 指标复核
 -> P5  Codex 配置维护扩展
 -> P6  可选的提示词与 Skills/MCP 管理
```

每个阶段结束都执行：`pnpm test`、`pnpm build`，并在涉及 Electron 打包或配置写入时追加 Portable/NSIS 冒烟测试。没有覆盖的高风险写入路径，不进入下一阶段。

---

## P0：配置契约和迁移

**状态：已完成（v1.8.3）**

### 目的

把“每客户端是否允许自动切换、能切到哪些方案”从当前 `settings.failover` 明确成稳定的公开契约，并统一前端默认值、Zod 校验、持久化迁移和 IPC 返回值。

### 现有基础

- 全局设置：`electron/services/settings-service.cjs` 中的 `failover.{claude,codex,opencode,gemini}`。
- 单方案设置：`electron/services/schemas.cjs` 中的 `autoSwitch.enabled` 和 `intervalMinutes`。
- 前端默认值：`src/config.ts` 的 `DEFAULT_SETTINGS` 与 `BLANK_PROFILE_INPUT`。

### 改动范围

- `electron/services/settings-service.cjs`
  - 保持每客户端一份 `enabled + profileIds` 的结构。
  - 为旧 `settings.json` 缺失字段提供默认值；删除的方案 ID 在读取或保存时过滤，避免“幽灵候选”。
  - 不在此阶段增加用户看不懂的评分权重、随机策略或全局规则。
- `electron/services/schemas.cjs`、`electron/services/profile-service.cjs`
  - 明确方案探测开关和自动切换开关的职责：方案的 `autoSwitch` 只控制探测频率；客户端的 `failover` 才决定是否有权切换。
  - 若当前字段语义不够清楚，先重命名 UI 文案，不急于破坏存储字段。
- `src/types.ts`、`src/config.ts`、`src/lib/api.ts`
  - 与主进程的公开结构严格一致，不能由前端自行补充隐式字段。

### 验收标准

- 老的 `settings.json`、`profiles.json` 在升级后能读取且获得默认值。
- 删除候选方案后，任意客户端不再保留该 ID。
- 一个客户端的候选库变更不会影响其他客户端。
- 主进程返回的数据不包含密钥密文、基线文件路径或认证内容。

### 测试

- 新增/扩展 `tests/settings-service.test.mjs`：缺省迁移、非法 ID、删除方案后的过滤、四客户端独立性。
- 扩展 `tests/ipc.test.mjs`：`updateSettings` 的校验和 bootstrap 数据形状。
- 扩展 `tests/ui-state.test.mjs`：前端默认状态与主进程一致。

---

## P1：客户端路由设置页

**状态：已完成（v1.8.3）**

### 目的

让用户从“客户端卡片”进入该客户端的设置，而不是在总设置页猜每个开关影响谁。

### 交互设计

- 概览中的 Claude、Codex、OpenCode、Gemini 卡片可点击，打开一个客户端设置面板或页面。
- 每个客户端只展示与它有关的内容：
  - 当前路由方案和当前端点。
  - 可切换密钥库，多选列表按分组展示；仅显示协议兼容该客户端的方案。
  - “自动择优”开关。
  - 渠道探测开关/频率说明，以及当前方案的实际探测状态。
  - 当前是否被网关接管、最近一次切换原因、最近一次切换时间。
- “自动择优”关闭时，候选库仍可编辑、探测仍可继续；关闭只禁止自动改路由。
- 至少保留当前路由作为候选的推荐操作，但不强行重写用户选择。

### 改动范围

- `src/components/OverviewView.tsx`：给客户端卡片加详情入口。
- 新建 `src/components/ClientRouteSettings.tsx`，或在现有设置组件中增加局部抽屉；只引入一次性 UI，不创建过度通用的配置框架。
- `src/App.tsx`、`src/hooks/useAgentGateController.ts`：传递当前客户端、设置保存和状态刷新。
- `src/i18n/messages.ts`：补齐中文、繁中、日文、英文文案。
- 必要时仅补充读取型 IPC 字段；不让渲染进程参与路由决策。

### 验收标准

- 四个客户端的设置可独立打开、保存并即时刷新概览。
- 无协议兼容方案时，明确显示原因，不能让用户选到不可路由的密钥。
- 候选库只保存方案 ID，不复制 API Key 或 URL 到设置文件。
- 窄窗口下列表、开关和保存按钮不溢出；抽屉关闭不丢失未保存确认逻辑。

### 测试

- `tests/ui-state.test.mjs`：卡片入口、四客户端独立状态、候选筛选与保存。
- `tests/ipc.test.mjs`：设置保存后 bootstrap 的客户端候选数据正确。
- 通过现有 UI 冒烟脚本检查桌面窗口和窄尺寸布局。

---

## P2：状态与故障切换可解释性

**状态：已完成（v1.8.3）**

### 目的

用户应当能知道“为什么没切换”或“为什么切到了这个渠道”，而不是只看到路由变了。

### 需要暴露的信息

- 当前方案和活跃端点。
- 自动择优是否启用、失败计数、触发阈值、冷却状态。
- 候选方案被排除的原因：不在候选库、协议/模型不兼容、探测失败、没有健康样本、延迟改善不足。
- 最近一次故障切换：发生时间、原方案、目标方案、触发错误、选中依据。
- 探测状态独立展示：关闭自动切换时仍显示健康趋势。

### 决策原则

当前实现的选取规则继续作为基线：只在该客户端允许的候选中，先排除不健康或不兼容目标，再以近期健康情况和延迟选择。不要改成单次“最低延迟即切换”。

若需要引入一个可调参数，首选只增加“连续失败阈值”和“切换冷却时间”；延迟权重、P50/P95、成功率权重等高级策略先保持内部固定值，等有真实数据再开放。

### 改动范围

- `electron/services/auto-switch-service.cjs`
  - 提供不含秘密的最近决策摘要和排除原因。
  - 保持现有停止屏障、请求结束回调与探测取消逻辑。
- `electron/services/health-service.cjs`
  - 复用已有历史和时间线，不额外写入响应正文。
- `electron/services/ipc.cjs`、`electron/preload.cjs`、`src/lib/api.ts`
  - 只暴露经过压缩的决策结果，不暴露请求头、密钥、原始错误堆栈。
- `src/components/StatusView.tsx`
  - 把“探测”和“自动切换”拆成两个清晰区域；切换记录以紧凑时间线呈现。

### 验收标准

- 用户可以区分“探测正常但自动择优关闭”和“探测失败所以没有可切换目标”。
- 连续失败未达阈值、候选被排除、切换成功、冷却阻止重复切换，均有可见解释。
- 多个并发失败不会重复切换或覆盖记录。
- 切换事件不会阻塞网关请求路径。

### 测试

- 扩展 `tests/auto-switch-service.test.mjs`：每一种排除原因、冷却、并发失败和停止期间取消。
- 扩展 `tests/health-monitoring.test.mjs`：自动切换关闭时探测仍然执行。
- 扩展 `tests/ui-state.test.mjs`：状态文案和事件时间线渲染。

---

## P3：备份、恢复与官方模式可视化

**状态：已完成（v1.8.3）**

### 目的

把已有的安全写入和恢复能力变得可检查、可理解，同时严格维持“不清除用户官方登录态”的保证。

### 功能范围

- 在 Codex 客户端详情中展示：当前是 Agent;Gate 路由还是官方模式、最近一次接管/恢复时间。
- 保留“恢复官方”作为明确命令，执行前说明它只移除 Agent;Gate 管理的 provider/顶层选择，不删除用户 `auth.json` 或其他 provider/MCP 配置。
- 在设置页增加只读“配置变更历史”：时间、操作来源、影响的客户端、结果和可撤销状态。
- 优先复用 `ApplyService.listHistory()` 和既有加密备份；不做任意文件浏览器或导出明文密钥。

### 改动范围

- `electron/services/apply-service.cjs`、`electron/services/schemas.cjs`
  - 若公开历史缺少显示所需的安全摘要，补最小字段。
- `electron/services/ipc.cjs`、`electron/preload.cjs`、`src/lib/api.ts`
  - 暴露只读历史和现有撤销能力；写入仍由主进程统一持锁。
- `src/components/SettingsView.tsx` 或新增小型 `ConfigHistoryView.tsx`
  - 显示历史摘要和“恢复官方”说明；不把恢复入口重复散到多个无关页面。

### 验收标准

- 恢复官方后保留用户当前登录态、用户自己的 provider、MCP 和注释。
- 恢复失败时，网关路由和配置维持原状，并显示可行动的错误。
- 历史列表不显示文件绝对路径、明文 Key、令牌或备份密文。
- 撤销只能作用于当前允许撤销的历史项。

### 测试

- 保留并扩展 `tests/apply-service.test.mjs` 的官方恢复覆盖：用户修改、清理失败、再次恢复、MCP 保留。
- 扩展 `tests/ipc.test.mjs`：历史公开投影与非法撤销。
- UI 冒烟验证恢复确认文案和失败提示。

---

## P4：请求时间线与首 token 统计复核

**状态：已完成（v1.8.3）**

### 目的

固定时间指标的用户语义，避免把首 token 误解为首个可见正文。

### 指标定义

| 字段 | 定义 | 展示名称 |
| --- | --- | --- |
| `startedAt` | Agent;Gate 开始转发请求 | 请求开始 |
| `firstByteLatencyMs` | 上游响应第一字节到达 | 首包 / TTFB |
| `firstTokenLatencyMs` | 上游首次有效推理或文本事件到达 | 首 token / 思考开始 |
| `durationMs` | 请求完成或失败的总耗时 | 总耗时 |

“首 token / 思考开始”是当前用于接近上游开始计费/推理的最佳代理值；它不是模型内部不可见的精确计费时刻。若上游不流式返回，界面只显示首包和总耗时，不虚构首 token。

### 改动范围

- `electron/services/request-monitor-service.cjs`
  - 不改变已有事件判定，除非新增真实协议证据；先补清晰字段说明和边界测试。
- `src/components/ActivityView.tsx`、`src/lib/format.ts`、`src/i18n/messages.ts`
  - 使用清晰标签、悬浮说明和不可用状态；不把 `firstTokenLatencyMs` 写作“首字”。
- `tests/request-monitor-service.test.mjs`、`tests/gateway-service.test.mjs`
  - 锁住 reasoning 先到、空 reasoning、正文晚到五分钟、非流式响应的语义。

### 验收标准

- reasoning 在 1 秒、可见正文在 5 分钟时，首 token 显示约 1 秒而非 5 分钟。
- 非流式响应不显示假的首 token。
- UI 不显示“首字”这种模糊名称；流式使用 TTFT/首 token 语义，非流式只显示 TTFB，历史数据缺字段时有合理回退。

---

## P5：Codex 配置维护扩展

**状态：评估完成；待进入后续迭代**

### 目的

从 Codex-X 借鉴真正有用的维护能力，但保持 Agent;Gate 的多客户端网关定位。

### 候选任务

1. **cc-switch 导入与去重**
   - 读取本机 cc-switch 数据库或导出文件；先预览、再导入。
   - 以规范化 URL、认证模式、密钥指纹和协议作为重复判断，而不是只按名称。
   - 只保存新方案或用户确认覆盖的元数据，绝不把明文 Key 写入日志。

2. **Codex 会话检查**
   - 在现有 `SessionService` 读取和删除能力上，先增加只读诊断：会话所属项目、最后活动时间、来源客户端。
   - “Provider 不一致修复”必须在拿到 Codex 当前存储格式和真实可复现样本后再设计，不能通过猜测 SQLite 字段直接写库。

3. **配置检查报告**
   - 只读检查 Agent;Gate 管理字段是否漂移、网关是否接管、官方恢复是否可用。
   - 可修复项必须逐项确认，并沿用 `ApplyService` 的事务与备份。

### 不做

- 不直接提供任意 `config.toml` 代码编辑器；现有适配器只修改自己拥有的字段，这是安全边界。
- 不在没有权威协议支持的情况下批量改写 Codex 会话数据。

### 验收标准

- 导入前能展示新增、重复、冲突和跳过数量。
- 诊断功能默认只读，任何写入都有备份和确认。
- 用户其他 provider、MCP、注释和登录态保持不变。

---

## P6：提示词与 Skills/MCP 管理（可选）

**状态：暂缓；仅在 P5 证明有用户需求后进入**

### 提示词中心

- 仅管理 Agent;Gate 创建的受管 Markdown 区块，支持本地模板、导入、启用/禁用和备份。
- 支持“追加到既有规则”和“替换 Agent;Gate 受管规则”两种模式。
- 不替换整个用户 `AGENTS.md`，禁用时只移除自己的带标记区块。
- 在线模板同步不是第一版需求；若做，必须有固定来源、缓存、签名/哈希或用户确认机制。

### Skills / MCP

- 第一版只读枚举现有 Skill 和 MCP，显示来源、启用状态和配置摘要。
- 第二版才考虑导入；ZIP 安装必须检查 Zip Slip、符号链接、文件数和体积上限。
- MCP 开关仅增加/移除受管条目，绝不覆盖用户现有 `mcp_servers`。

### 验收标准

- 所有写入均有回滚测试；用户未受管内容逐字节保留。
- 不把 Skill 内的任意脚本自动执行为“安装成功”的副作用。

---

## 发布检查单

每个进入发布的阶段必须完成以下检查：

- [x] `pnpm test` 全绿；新增行为有针对性回归测试。
- [x] `pnpm build` 通过。
- [x] `git diff --check` 无空白错误。
- [x] 对涉及 Electron 的变更运行 Portable 与 NSIS 构建。
- [x] 用新构建至少验证：启动、加载旧配置、保存一个设置、接管/恢复一个客户端。
- [x] 校验打包 ASAR 中没有农场相关文件或开发测试目录。
- [x] 更新 README/截图仅限界面或用户流程确实变化的部分（本轮无需更新）。

## 执行记录

| 阶段 | 状态 | 版本 | 完成日期 | 验证结果 |
| --- | --- | --- | --- | --- |
| 已完成基线 | 已完成 | 1.8.3 | 2026-07-31 | 402 passed / 1 skipped；TypeScript、Vite、Portable、NSIS、ASAR 排除项和交付整理通过 |
| P0 配置契约和迁移 | 已完成 | 1.8.3 | 2026-07-31 | `tests/settings-service.test.mjs` 12 passed、`tests/ipc.test.mjs` 31 passed、`tests/ui-state.test.mjs` 36 passed；旧配置迁移、候选过滤、四客户端隔离、局部 patch 和删除后内存清理已覆盖 |
| P1 客户端路由设置页 | 已完成 | 1.8.3 | 2026-07-31 | 客户端详情入口、协议兼容候选库、独立保存、未保存关闭确认和窄窗口样式通过 UI 状态测试与构建 |
| P2 故障切换可解释性 | 已完成 | 1.8.3 | 2026-07-31 | `tests/auto-switch-service.test.mjs` 30 passed；状态页覆盖阈值、冷却、排除原因、协议兼容性、历史、停止屏障和生命周期冷却清理 |
| P3 备份与官方恢复可视化 | 已完成 | 1.8.3 | 2026-07-31 | `tests/apply-service.test.mjs` 25 passed / 1 skipped、`tests/ipc.test.mjs` 31 passed、`tests/ui-state.test.mjs` 36 passed；历史公开投影不含路径/密文 |
| P4 请求时间线与首 token 复核 | 已完成 | 1.8.3 | 2026-07-31 | `tests/request-monitor-service.test.mjs` 52 passed、`tests/gateway-service.test.mjs` 46 passed；reasoning 先到、正文延迟、非流式 TTFB 和多语言说明已锁定 |
| P5 Codex 配置维护扩展 | 评估完成 | - | 2026-07-31 | 暂只保留只读诊断/导入预览方向；未确认 Codex-X/cc-switch 数据格式前不写 SQLite、会话库或任意 TOML |
| P6 提示词与 Skills/MCP | 暂缓 | - | 2026-07-31 | 不做猜测性管理；后续仅在明确需求和协议证据下先做只读枚举，再设计受管区块写入 |
