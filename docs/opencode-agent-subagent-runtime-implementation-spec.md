# OpenCode Agent/Subagent Runtime Implementation Spec

## 1. Purpose

定义当前 VS Code 插件中 OpenCode runtime 状态同步改造的实施规格。

目标是让插件稳定、可恢复地渲染：

- root OpenCode session -> 主 agent
- child OpenCode session -> subagent

并解决当前问题：

- `session.status` 被过度当作 UI 主状态
- `subtask part.id` 与 `child session.id` 混用
- child 状态传播不完整
- bootstrap / reconnect 顺序错误
- replay 依赖历史事件重放
- webview 仍通过 `Subtask:` 字符串推断 subagent

本文件是实施级 spec，不改代码。

---

## 2. Scope

### In scope

- backend canonical runtime state
- 基于 snapshot + SSE 的状态归约
- root/child/tool/permission 的统一状态模型
- bootstrap / reconnect 时序
- webview runtime 协议升级
- 本仓库内模块拆分与迁移计划
- 测试矩阵、验收标准、回滚策略

### Out of scope

- layout/editor/asset 体系改造
- terminal 创建 UX 改造
- 多 runtime 抽象重构
- 深层递归子树 UI（当前只要求 root + direct children）
- 本文档之外的代码实现

---

## 3. Repo targets

当前改造涉及的核心文件：

- `src/PixelAgentsViewProvider.ts`
- `src/opencodeEventBridge.ts`
- `src/opencodeClient.ts`
- `src/runtime/openCodeRuntimeAdapter.ts`
- `webview-ui/src/hooks/useExtensionMessages.ts`

建议新增模块：

- `src/runtime/runtimeState.ts`
- `src/runtime/runtimeReducer.ts`
- `src/runtime/runtimeProjector.ts`
- `src/runtime/runtimeController.ts`

---

## 4. Architecture

```text
OpenCode HTTP/SSE
  -> src/opencodeClient.ts              // transport only
  -> src/runtime/openCodeRuntimeAdapter.ts
  -> src/runtime/runtimeController.ts   // bootstrap / resync / SSE wiring
  -> src/runtime/runtimeReducer.ts      // canonical state reduction
  -> src/runtime/runtimeProjector.ts    // project canonical state to webview payloads
  -> webview-ui/src/hooks/useExtensionMessages.ts
```

### Core decisions

1. **Backend owns truth**
2. **Subagent identity = child session id**
3. **Hydrate uses current-state reduction, not historical replay**
4. **`session.status` is coarse signal, not UI truth**
5. **Webview becomes renderer, not runtime interpreter**

---

## 5. Canonical runtime model

## 5.1 RuntimeStore

```ts
interface RuntimeStore {
  phase: 'cold' | 'hydrating' | 'live'
  agentsById: Map<number, AgentRuntimeRecord>
  rootSessionToAgentId: Map<string, number>
  sessionsById: Map<string, SessionRuntimeRecord>
  pendingSubtasksByParentSessionId: Map<string, Map<string, PendingSubtaskRecord>>
}
```

用途：

- 维护整个插件的运行时事实状态
- 为 snapshot hydrate 与 SSE live update 提供统一 reducer 入口
- 为 webview 输出稳定的 replace-based runtime payload

---

## 5.2 AgentRuntimeRecord

```ts
interface AgentRuntimeRecord {
  agentId: number
  rootSessionId: string
  terminalName: string
  projectDir: string

  rawStatus?: RuntimeSessionStatus
  displayStatus: 'active' | 'waiting' | 'retry'
  permissionAsked: boolean

  rootToolIds: string[]
  childSessionIds: string[]
}
```

说明：

- 一个 root session 对应一个主 agent
- `displayStatus` 是 UI 投影值，不等于 OpenCode 原始状态

---

## 5.3 SessionRuntimeRecord

```ts
interface SessionRuntimeRecord {
  sessionId: string
  kind: 'root' | 'child'
  agentId: number
  parentSessionId?: string
  title: string

  rawStatus?: RuntimeSessionStatus
  permissionAsked: boolean

  toolsById: Map<string, ToolRuntimeRecord>
  visible: boolean
  completingUntil?: number
}
```

说明：

- root 与 child 都统一建模为 session record
- subagent 是否渲染由 `visible` 决定
- `completingUntil` 用于支持“完成后短暂停留再消失”的显示层策略

---

## 5.4 ToolRuntimeRecord

```ts
interface ToolRuntimeRecord {
  toolId: string
  toolName: string
  label: string
  state: 'pending' | 'running'
}
```

规则：

- `toolId = callID ?? part.id`
- terminal tool state 不保留在 active set 中

---

## 5.5 PendingSubtaskRecord

```ts
interface PendingSubtaskRecord {
  launchId: string
  parentSessionId: string
  description: string
  boundChildSessionId?: string
}
```

说明：

- 它表示“发起了子任务意图”
- 不是 subagent
- 不能参与 subagent 数量统计

---

## 5.6 Invariants

- 一个 root session 只能映射到一个 agent
- 一个 child session 只能映射到一个 parent agent
- 一个 subagent 只能由一个 `child session.id` 标识
- `subtask part.id` 永远不能作为 subagent id
- tool identity 只能来自 `callID ?? part.id`
- timer 只能是 UI 辅助，不是 canonical state

---

## 6. Display derivation rules

## 6.1 Root agent status

优先级：

1. `retry`：若 root `rawStatus.type === 'retry'`
2. `active`：若任一条件成立
   - root 有 active tool
   - 有 visible child
   - root permissionAsked = true
   - root rawStatus 为 `busy`
3. `waiting`：仅当
   - root rawStatus 为 `idle`
   - root 无 active tool
   - 无 visible child
   - 无 permissionAsked

---

## 6.2 Child session visibility

child 渲染为 subagent 的条件：

- rawStatus 为 `busy` 或 `retry`
- 或存在 active tools
- 或 permissionAsked = true

若 child：

- rawStatus = `idle`
- 且无 active tools
- 且无 permission

则应先进入 `completing`，在短暂停留与完成动画结束后，再从运行时视图中移除。

### Completing state

`completing` 是显示层专用状态，不代表 OpenCode 新增状态。

用途：

- 给用户一个“subagent 已完成任务”的视觉反馈
- 避免角色瞬间消失过于突兀
- 同时避免 idle child 长期堆积

建议默认参数：

- `completionGraceMs = 3000`
- `completionBubbleMs = 800~1500`
- `completionExitAnimationMs = 400~700`

---

## 6.3 Pending subtask display

root session 的 `subtask` part 可投影为“launching subtask”之类的临时父级状态，但：

- 不创建 subagent
- 不计入 subagent 个数
- 一旦 child session 建立或 snapshot 证实不存在，应消失

---

## 7. Event reduction rules

## 7.1 `session.created`

输入关键字段：

- `info.id`
- `info.parentID`
- `info.title`

处理规则：

1. 若 `parentID` 对应某个 tracked root agent，则创建/更新 child session record
2. 设置：
   - `kind = 'child'`
   - `parentSessionId = parentID`
   - `agentId = parent agent id`
   - `title = info.title || 'OpenCode subtask'`
3. 将 child session id 加入 parent `childSessionIds`
4. 尝试把它绑定到一个 unresolved pending subtask：
   - 先按标准化 title/description 匹配
   - 否则若只有一个 unresolved launch，则绑定
   - 若仍不确定，则不绑定
5. **禁止**把 `subtask launch id` 当成渲染身份

---

## 7.2 `session.status`

处理规则：

1. 仅更新目标 session 的 `rawStatus`
2. 重算显示状态
3. 不创建/结束 tool
4. 不创建/删除 child session

---

## 7.3 `session.idle`

处理规则：

- 等价于 `session.status = { type: 'idle' }`
- 若目标是 child 且同时满足：
  - idle
  - 无 active tools
  - 无 permission
  - 则 child 应进入 `completing` 状态，并在 grace period 结束后隐藏/移除

---

## 7.4 `permission.asked`

处理规则：

1. 按 `sessionID` 找到对应 session record
2. 设置 `permissionAsked = true`
3. 重算 agent / child 显示状态
4. root permission 影响 root agent
5. child permission 影响 child subagent

---

## 7.5 `permission.replied`

处理规则：

1. 按 `sessionID` 找到对应 session record
2. 设置 `permissionAsked = false`
3. 重算可见性与显示状态
4. 必须同时支持 root 与 child

这是当前实现缺失的关键修复点之一。

---

## 7.6 `message.part.updated`

### A. `part.type = 'tool'`

规则：

1. `toolId = callID ?? id`
2. `label = formatToolStatus(toolName, input)`
3. 若 `state.status in ['pending', 'running']`：upsert active tool
4. 否则：从 active tools 删除
5. root session tool 更新 root agent tools
6. child session tool 更新 child session tools
7. tool 生命周期只由 tool part 决定，不由 session.status 决定

### B. `part.type = 'subtask'`

规则：

1. 仅对 root session 有意义
2. upsert `PendingSubtaskRecord`
3. `description = part.description || 'OpenCode subtask'`
4. 不创建 subagent
5. 可选择在父级投影为临时 launching 状态

### C. `part.type in ['text', 'reasoning', 'step-start']`

规则：

- 标记该 session 仍有活动
- 不修改工具集合
- 不修改 child identity

### D. `part.type = 'step-finish'`

规则：

- 不直接改变 child identity
- 若 child 已 idle 且无 tool/permission，可在重算时进入 `completing`

### E. unknown part type

规则：

- 忽略
- debug 模式记录日志

---

## 8. Snapshot hydrate and reconnect

OpenCode 在当前集成路径里没有可恢复 cursor，因此 bootstrap 目标应是：

- **当前状态正确**
- 而不是保证所有瞬时事件都被完整重放

说明：

- `completing` 属于短时显示层状态
- reconnect / full snapshot hydrate 时，不要求恢复已过期的 `completing` 动画
- snapshot 只需恢复“当前活跃状态”；完成动画可视为非持久 UI 效果

---

## 8.1 Initial bootstrap sequence

### Required order

1. webview 发送 `webviewReady`
2. extension `ensureServer`
3. `restoreAgents()`，恢复持久化 agent / terminal 绑定
4. 发送非 runtime 初始化消息：
   - settings
   - workspace folders
   - assets
   - layout
   - `existingAgents`
5. 并行抓取所有 restored root agent 的 session snapshot
6. 用 snapshot 构建 canonical runtime state（per-agent full replace）
7. 向 webview 发送 runtime snapshot
8. 再启动 SSE 订阅
9. 应用后续 live events

### Why

这样可避免当前 `startRuntimeEvents()` 早于 `restoreAgents()` 导致 hydrate 漏掉 restored agents 的问题。

---

## 8.2 SSE reconnect sequence

当 SSE 出错 / 重连时：

1. 保留当前 UI runtime state，不清空
2. 重建 SSE 连接
3. 立刻为所有 tracked root sessions 执行 snapshot resync
4. 用 fresh snapshot 替换各 agent runtime slice
5. 继续处理 live events

### Rule

reconnect 后必须做全量 resync，不能只依赖继续接收 SSE。

---

## 8.3 New agent creation sequence

当 `launchNewTerminal()` 创建新 OpenCode session 后：

1. 先创建/persist agent shell
2. attach 命令发出后抓一次 root snapshot
3. reduce snapshot
4. 投影 runtime state

---

## 9. Webview contract

保留现有：

- asset / layout / settings / existingAgents / agentCreated / agentClosed

替换现有 runtime 相关协议。

---

## 9.1 Protocol versioning

`webviewReady` 建议支持：

```ts
{ type: 'webviewReady', runtimeProtocols: [1, 2] }
```

- `1` = 现有 legacy runtime message stream
- `2` = 新 canonical runtime snapshot protocol

---

## 9.2 Runtime v2 messages

### Full snapshot

```ts
{
  type: 'runtimeSnapshot',
  protocolVersion: 2,
  agents: AgentRuntimeVm[]
}
```

### Per-agent replace

```ts
{
  type: 'agentRuntimeReplace',
  protocolVersion: 2,
  agent: AgentRuntimeVm
}
```

### VM types

```ts
interface AgentRuntimeVm {
  agentId: number
  sessionId: string
  status: 'active' | 'waiting' | 'retry'
  permissionAsked: boolean
  tools: ToolVm[]
  subagents: SubagentRuntimeVm[]
}

interface SubagentRuntimeVm {
  sessionId: string
  label: string
  status: 'active' | 'waiting' | 'retry' | 'completing'
  permissionAsked: boolean
  tools: ToolVm[]
  completionHint?: string
}

interface ToolVm {
  id: string
  name: string
  label: string
  state: 'pending' | 'running'
}
```

---

## 9.3 Webview implementation rules

- runtime v2 应由 `sessionId` 维护 subagent 身份
- 不能再依赖 `status.startsWith('Subtask:')`
- layout ready 之前可 buffer runtime v2 消息
- runtime replace 应覆盖当前 agent runtime slice，而非叠加旧状态
- `completing` 应由 webview 执行短暂反馈与消失动画，结束后再真正移除角色

---

## 9.4 Migration plan

### Phase A

backend 构建 canonical store，但继续输出 legacy runtime 消息。

### Phase B

backend 同时输出：

- legacy v1
- runtime v2

### Phase C

`useExtensionMessages.ts` 优先消费 v2，v1 作为 fallback。

### Phase D

删除 legacy subagent 推断逻辑：

- 删除 `Subtask:` 字符串驱动的 subagent 创建
- 删除基于 parentToolId 的伪身份管理

---

## 10. File-level implementation plan

## 10.1 `src/PixelAgentsViewProvider.ts`

改造目标：

- runtime orchestration only
- 不再直接调用 `processOpenCodeEvent()` / `replayOpenCodeSessionState()` 驱动 UI
- 改由 `runtimeController` 统一协调
- 修复 bootstrap 顺序：先 restore，再 hydrate，再 live subscribe
- 增加 runtime protocol negotiation

---

## 10.2 `src/opencodeEventBridge.ts`

改造目标：

- 从“直接 postMessage 到 webview”改为“事件归一化 / reducer 入口”
- 删除 subtask id 作为 child identity 的假设
- 不再把 `session.status` 直接翻译成 agent waiting/active

建议最终职责：

- 若保留，则仅做 raw OpenCode event -> normalized runtime action 转换

---

## 10.3 `src/runtime/openCodeRuntimeAdapter.ts`

改造目标：

- 继续作为 transport boundary
- 保留 `getSessionSnapshot()`
- 必要时补充 bulk snapshot helper

不应在此层承担 UI 推导职责。

---

## 10.4 `src/opencodeClient.ts`

改造目标：

- 强化 OpenCode event typing
- 集中处理 raw payload parsing
- SSE reconnect 保持 transport-only

不在此处维护业务状态。

---

## 10.5 `webview-ui/src/hooks/useExtensionMessages.ts`

改造目标：

- 增加 runtime v2 path
- 在 layout ready 前 buffer v2 runtime payload
- 通过 `child sessionId` 管理 subagent
- 移除字符串推断 subagent 的逻辑

---

## 10.6 New module responsibilities

### `src/runtime/runtimeState.ts`

- canonical types
- helper constructors
- invariant helpers

### `src/runtime/runtimeReducer.ts`

- 纯 reducer
- snapshot -> canonical state
- event -> canonical state

### `src/runtime/runtimeProjector.ts`

- canonical state -> legacy v1 runtime messages
- canonical state -> v2 runtime snapshot payloads

### `src/runtime/runtimeController.ts`

- bootstrap
- resync
- live SSE wiring
- dispatch to reducer/projector

---

## 11. Test plan

## 11.1 Test layers

1. 纯 reducer tests
2. projector tests
3. bootstrap sequencing tests
4. webview hook v2 tests

---

## 11.2 Fixture matrix

至少覆盖：

1. root idle, no tools, no children
2. root busy with one running tool
3. root pending subtask launch, no child yet
4. child created with different `subtask part.id` and `child session.id`
5. child running tool
6. child idle with no tools -> enters completing, then disappears
7. root permission asked/replied
8. child permission asked/replied
9. reconnect with root + child active
10. duplicate `session.created`
11. `session.status=idle` while tool still running
12. two child sessions with same title
13. retry on root
14. unknown part types ignored

每个 fixture 应定义：

- restored agents
- snapshot inputs
- optional live event stream
- expected canonical store
- expected legacy projection
- expected v2 projection

---

## 12. Rollout phases

## Phase 1 — Canonical backend under legacy UI

- 建立 reducer/store/projector
- 继续沿用现有 webview 协议

### Acceptance

- 当前 UI 仍可工作
- child identity mismatch 在 backend 内部被消除

---

## Phase 2 — Bootstrap/reconnect correctness

- 用 snapshot reduction 替代 event replay hydrate
- 增加 reconnect resync

### Acceptance

- reload / reconnect 后 child 状态可稳定恢复

---

## Phase 3 — Webview runtime v2

- 增加 protocol negotiation
- 实现 `runtimeSnapshot` / `agentRuntimeReplace`

### Acceptance

- webview v2 路径不再依赖 `Subtask:`

---

## Phase 4 — Legacy cleanup

- 删除 legacy task-label identity logic
- 精简 bridge complexity

### Acceptance

- 只保留 canonical runtime path

---

## 13. Acceptance criteria

- reload VS Code 后，活跃 root/child runtime state 能正确恢复
- 每个 subagent 与 `child session.id` 一一对应
- `subtask part.id` 不再作为渲染身份
- child 的 permission/tool/status 变化能完整传播
- `session.status` 不再负责启动/结束 tool
- webview v2 不再通过 `Subtask:` 推断 subagent
- SSE reconnect 后会触发全量 resync 并收敛到正确状态
- legacy protocol 在迁移期仍可用
- child 完成后会先进入短暂 `completing` 反馈态，再从显示层移除

---

## 14. Risks

### 14.1 No SSE cursor

bootstrap 期间可能丢失瞬时事件。

### Mitigation

- 优先保证 snapshot correctness
- reconnect 后强制 full resync

---

### 14.2 Ambiguous subtask-to-child binding

多个 launch title 相同可能导致绑定不明确。

### Mitigation

- 子 session 始终按 `session.id` 独立渲染
- launch 绑定失败也不影响 child 正常显示

---

### 14.3 Dual protocol divergence

v1/v2 并存期可能产生显示不一致。

### Mitigation

- projector tests 同时校验两种投影
- 增加 debug diff 日志

---

### 14.4 New OpenCode payload variants

未来 event payload 变更可能引发状态漂移。

### Mitigation

- 未识别类型仅忽略并记录 debug log
- 出现不变量冲突时触发 full snapshot replacement

---

## 15. Fallback plan

若 v2 runtime path 在 rollout 中出现问题：

1. 保留 canonical backend store
2. 暂时继续只输出 legacy projector
3. 在不回退 reducer 的前提下关闭 webview v2
4. 对异常 agent 执行 full snapshot replacement 纠偏

---

## 16. Immediate next steps

建议实施顺序：

1. 先实现 `runtimeState.ts` / `runtimeReducer.ts`
2. 再实现 snapshot-based hydrate 与 reconnect resync
3. 再实现 projector 与 legacy 对接
4. 最后引入 webview runtime v2

---

## 17. Related docs

- `docs/opencode-agent-subagent-state-sync-plan.md`
