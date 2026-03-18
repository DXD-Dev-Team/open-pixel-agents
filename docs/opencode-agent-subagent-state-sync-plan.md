# OpenCode Agent/Subagent 实时状态同步方案

## 1. 目标

当前 VS Code 插件连接 OpenCode session 后，UI 应正确反映：

- 主 agent 是否在工作
- 当前存在多少个真实 subagent
- 每个 subagent 是否在工作 / 等待权限 / 重试 / 已完成
- reload / reattach 后仍能恢复正确状态

UI **不应主要依据 session.status 本身做展示**；`session.status` 只是循环状态，不等于 agent 实际工作状态。

---

## 2. 结论

当前问题不是单点 bug，而是状态建模有偏差：

1. **把 session.status 当成了主要 UI 状态来源**
2. **subtask part.id 和 child session id 被混用了**
3. **child session 的 busy / retry / permission clear 没有完整进入聚合逻辑**
4. **bootstrap / restore / SSE 存在时序竞争**
5. **webview 仍在按旧协议自行推断 subagent，而不是消费规范化状态**

因此，正确方案不是继续修补若干 event handler，而是：

- 在扩展侧建立 **canonical runtime state**
- 以 **child session id 作为唯一 subagent 标识**
- 以 **message parts + permission + child session linkage** 作为主要事实来源
- 用 `session.status` 做辅助信号，不做主事实
- bootstrap 使用 **snapshot + SSE buffer + reconciliation**
- webview 变为“渲染层”，不再负责解释运行时语义

---

## 3. OpenCode 的权威状态模型

基于 `ref/opencode` 源码：

### 3.1 session.status 的语义
来源：
- `ref/opencode/packages/opencode/src/session/status.ts`
- `ref/opencode/packages/opencode/src/server/routes/session.ts`

`session.status` 只有：

- `idle`
- `busy`
- `retry`

它表示的是 **session loop 状态**，不是 agent 正在做什么。

---

### 3.2 agent 真正“在做什么”来自哪里
来源：
- `ref/opencode/packages/opencode/src/session/message-v2.ts`
- `ref/opencode/packages/opencode/src/session/processor.ts`

真实工作状态来自 assistant message parts：

- `tool`
- `text`
- `reasoning`
- `step-start`
- `step-finish`
- `subtask`

尤其：

- tool 生命周期由 `message.part.updated` 驱动
- 文本/推理流也通过 message part 更新体现
- subtask part 只是“发起子任务的意图”

---

### 3.3 subagent 的真实存在依据
来源：
- `ref/opencode/packages/opencode/src/tool/task.ts`
- `ref/opencode/packages/opencode/src/session/index.ts`
- `GET /session/:id/children`

真实 child session 是由 task tool 创建的：

- `Session.create({ parentID: ctx.sessionID, ... })`

因此 **真实 subagent 的唯一身份是 child session.id**，不是 `subtask part.id`。

---

### 3.4 权限等待
来源：
- `ref/opencode/packages/opencode/src/permission/service.ts`

权限等待来自：

- `permission.asked`
- `permission.replied`

这也是实际工作状态的一部分，不能只靠 waiting timer 推断。

---

### 3.5 重连恢复
来源：
- `GET /session/status`
- `GET /session/:id/message`
- `GET /session/:id/children`
- `/global/event`

正确恢复必须：

1. 先拿 snapshot
2. 再接 SSE
3. 并在 reconnect 后做 reconcile

---

## 4. 当前项目中的核心问题

## 4.1 subagent identity 混乱
来源：
- `src/opencodeEventBridge.ts:202-206`
- `src/opencodeEventBridge.ts:243-245`
- `src/opencodeEventBridge.ts:382-393`
- `src/opencodeEventBridge.ts:286-293`
- `src/opencodeEventBridge.ts:412-413`

当前代码里：

- live `subtask` part 用 `part.id`
- `session.created` 用 `childSessionId`
- replay 也用 `childSessionId`
- child tool 更新又按 `part.sessionID` 分发

这会导致：

- 重复 subagent
- orphan subagent
- live 和 replay 对不上
- subagent 数量错误

---

## 4.2 直接把 session.status 映射成 active/waiting
来源：
- `src/opencodeEventBridge.ts:138-155`
- `src/opencodeEventBridge.ts:323-333`

当前 `applySessionStatus()` 直接：

- `idle -> waiting`
- 非 idle -> active`

这不符合 OpenCode 模型，因为：

- parent 可能 idle，但 child 仍在忙
- busy 不代表当前一定在执行 tool，也可能在等权限或 retry

---

## 4.3 child session 的状态传播不完整
来源：
- `src/opencodeEventBridge.ts:301-320`
- `src/opencodeEventBridge.ts:354-364`

当前 child 只在 `session.idle` 时被 finish；
但 child 的：

- `busy`
- `retry`
- `permission.replied`

都没有完整进入 UI 聚合逻辑。

结果是 parent 容易过早进入 waiting。

---

## 4.4 bootstrap 顺序有问题
来源：
- `src/PixelAgentsViewProvider.ts:93-109`
- `src/PixelAgentsViewProvider.ts:303-343`

当前 `webviewReady` 时先：

1. `startRuntimeEvents()`
2. 然后 `restoreAgents()`

但 `startRuntimeEvents()` 内部马上 `refreshInitialRuntimeState()`，而它遍历的是 `this.agents`。

这意味着 restored agents 可能还没恢复完，首次 snapshot replay 直接漏掉。

这是 attach/reload 状态错误的关键原因之一。

---

## 4.5 replay 是“事件重放式”，不是“当前状态归约式”
来源：
- `src/opencodeEventBridge.ts:219-259`
- `webview-ui/src/hooks/useExtensionMessages.ts:167-326`

当前 replay 通过 start/done/clear 事件去重建 UI。
问题是：

- 历史完成过的 tool 也会影响当前显示
- Webview 维护的是“事件累积视图”
- 不是“当前 canonical state”

这会让 reconnect 后容易出现陈旧状态。

---

## 4.6 webview 仍在靠字符串推断 subagent
来源：
- `webview-ui/src/hooks/useExtensionMessages.ts:180-188`

当前只要收到：

- `agentToolStart`
- 且 `status.startsWith('Subtask:')`

就创建 subagent 角色。

这说明 webview 仍在解释协议，而不是消费真实运行时模型。

---

## 5. 目标架构

## 5.1 总原则

### 事实来源优先级
1. **child session linkage**
2. **message parts**
3. **permission events**
4. **session.status**

### 身份规则
- 主 agent：插件内 `agentId`
- root runtime identity：`rootSessionId`
- subagent：**childSessionId**
- tool：`callID`，fallback `part.id`
- `subtask part.id`：只能作为临时占位 / 关联提示，**不能作为 subagent id**

---

## 5.2 扩展侧 canonical state

建议在 extension backend 建立每个 root agent 的 runtime store：

```ts
AgentRuntimeState {
  agentId
  rootSessionId
  sessions: Map<sessionId, SessionNode>
  pendingSubtasks: Map<subtaskPartId, PendingSubtask>
  revision
}
```

### SessionNode
```ts
SessionNode {
  sessionId
  parentSessionId | null
  title
  kind: 'root' | 'child'
  loopStatus: 'idle' | 'busy' | 'retry' | 'unknown'
  permissionPending: boolean
  activeTools: Map<toolId, ToolState>
  lastContentActivityAt
  phase
}
```

### phase 建议值
- `permission`
- `working`
- `retry`
- `waiting`
- `done`

---

## 5.3 Webview 职责

Webview 只负责：

- 渲染主 agent / subagent
- 渲染 tool overlay / bubble
- 动画
- seat / palette / selection

Webview 不再负责：

- 从 `"Subtask:"` 字符串推断 subagent
- 从 tool start/done 序列推断 canonical 状态
- 自行决定 parent 是否 waiting

---

## 5.4 建议的新前后端协议

从“事件流协议”改为“状态快照协议”：

```ts
agentRuntimeSnapshot {
  agentId
  revision
  overallPhase
  root: { ... }
  subagents: [
    {
      sessionId
      title
      phase
      activeTools
      permissionPending
    }
  ]
}
```

Webview 仅接受更高 revision 的 snapshot。

---

## 6. live update 策略

## 6.1 `session.created`
- 创建 child SessionNode
- 用 `parentID` 挂到父 session
- 立刻让它成为真实 subagent
- 可用 title 作为显示名

**child session 是真实 subagent 的唯一来源。**

---

## 6.2 `message.part.updated`

### tool part
- key = `callID || part.id`
- `pending/running` => active tool
- `completed/error` => close tool
- 更新该 session 的 phase

### subtask part
- 只创建 `PendingSubtask`
- 表示“父 agent 发起过子任务意图”
- **不直接创建真实 subagent**

### text / reasoning / step-start
- 记为该 session 有工作活动
- 参与 phase 推导

### step-finish
- 清理 transient thinking
- 不能单独用来删除真实 child session

---

## 6.3 `permission.asked`
- 对 sessionNode 设置 `permissionPending = true`
- 如果是 child session，则 child 显示 permission bubble
- parent 聚合状态必须保持非 waiting

---

## 6.4 `permission.replied`
- 清除对应 session 的 `permissionPending`
- 对 root 和 child 都要生效
- 当前实现缺 child clear，这必须修正

---

## 6.5 `session.status`
只存入 `loopStatus`，**不直接映射 UI**。

它只用于辅助推导：

- `retry` 展示
- 没有工具且没有权限时，决定是否进入 waiting
- 作为 fallback 信号

---

## 7. 聚合规则

## 7.1 单个 session 的 phase 优先级
建议：

1. `permission`：若 `permissionPending`
2. `working`：若存在 active tool
3. `retry`：若 `loopStatus === retry`
4. `working`：若最近有 text/reasoning/step-start 活动且尚未 idle
5. `waiting`：若 idle 且无 active tool 且无 permission
6. `done`：仅对子 session，表示运行时任务已完成；显示层可先进入短暂完成态，再隐藏

---

## 7.2 parent agent 的 overallPhase
parent 应按聚合计算：

- 只要 root 或任一 child 在 `working / permission / retry`
  - parent 就应显示为 working
- 只有当：
  - root 不在工作
  - 所有 child 都不在工作
  - 没有待关联 subtask placeholder
  - 才能进入 waiting

这能修复“parent idle 但 child 还在工作时 UI 已 waiting”的错误。

---

## 7.3 child 完成后的显示策略

当 child session 满足以下条件时：

- `loopStatus = idle`
- 无 active tool
- 无 permission

可视为 runtime 层已经完成。

但显示层**不立即移除** subagent，而是进入一个短暂的 `completing` 阶段：

1. 保留 subagent 小人短暂停留
2. 显示提示性反馈，例如：
   - 说话气泡（如 `Done` / `Finished`）
   - 完成音效（可选）
   - 收尾动作或停顿
3. 播放消失动画
4. 动画结束后再从显示层移除

建议默认参数：

- 完成停留：`3000ms`
- 提示气泡：`800~1500ms`
- 消失动画：`400~700ms`

说明：

- 这是**显示层策略**，不是 OpenCode runtime 语义
- runtime 上 child session 仍可能继续存在，只是进入 `idle`
- 显示层为避免像素小人无限累积，可在完成反馈后隐藏

---

## 8. bootstrap / restore / reconnect 策略

## 8.1 正确顺序
应调整为：

1. `restoreAgents()`
2. 建立 runtime store
3. 订阅 SSE，并先 buffer
4. 获取每个 root session snapshot
5. 用 snapshot 构建 canonical state
6. 回放 buffer 中的 SSE
7. 产出 UI snapshot
8. 切换到 live 模式

---

## 8.2 reconnect 策略
SSE 断开重连后必须：

1. 保留当前 canonical state
2. 重新订阅 SSE
3. 对所有 root session 做一次 reconcile snapshot
4. merge 到本地 store
5. 重新下发 revision++

因为 SSE 不是可恢复游标流，必须靠 snapshot 补洞。

---

## 8.3 snapshot 处理原则
snapshot 不能简单“重放历史事件”，应做“当前状态归约”：

- 哪些 tool 还开着
- 哪些 child 还活跃
- 哪些 permission 还 pending
- 哪些 session 只是历史上出现过，但当前已完成

这样 reconnect 后不会把历史 tool 误渲染成当前 tool。

---

## 9. 边界情况

## 9.1 child session 先于 subtask part 到达
处理：
- 直接创建真实 subagent
- 后续 subtask part 只用于补 label / metadata
- 绝不能创建第二个 subagent

---

## 9.2 subtask part 到达，但 child session 尚未创建
处理：
- 只创建 placeholder
- parent 保持 working
- placeholder 不计入真实 subagent 数量
- 若最终没有 child session，placeholder 过期后移除

---

## 9.3 child 正在等权限
处理：
- permission 归 child session
- child 显示权限气泡
- parent overallPhase 仍为 working / blocked，而不是 waiting

---

## 9.4 retry
处理：
- retry 不是 waiting
- 不应清除 subagent / tools
- 应作为工作中的恢复态展示

---

## 9.5 root idle，但 child 仍 active
处理：
- parent 必须继续显示工作中
- waiting bubble 不能出现

---

## 9.6 SSE 重复 / 乱序
必须保证 reducer 幂等：

- tool terminal state 不能被旧 running 覆盖
- 同一 child session 不能重复创建
- revision/snapshot 需要防止旧状态覆盖新状态

---

## 9.7 replay 后 lingering history
处理：
- UI 只渲染当前 open tools / active children
- 已完成历史不应复活为当前活跃状态；若命中“刚完成”窗口，可进入短暂 `completing` 显示态，然后消失

---

## 10. 实施计划

## Phase 0：语义冻结
定义并确认：

- working / waiting / permission / retry 的显示语义
- “真实 subagent” 与 “pending subtask placeholder” 的区别
- subagent 数量是否只统计 child session  
建议：**只统计真实 child session**

---

## Phase 1：扩展侧 canonical reducer
新增 backend runtime store，统一处理：

- snapshot
- `session.created`
- `message.part.updated`
- `permission.asked/replied`
- `session.status`

停止直接把 OpenCode event 映射成 webview legacy event。

---

## Phase 2：修正 bootstrap / reconnect
改成：

- 先 restoreAgents
- 再 SSE + buffer
- 再 snapshot hydrate
- 再 replay buffer
- reconnect 时执行 reconcile

---

## Phase 3：替换 webview 协议
把当前：

- `agentToolStart`
- `agentToolDone`
- `subagentToolStart`
- `subagentClear`
- `"Subtask:"` 推断

逐步迁移为 snapshot 协议。

---

## Phase 4：兼容迁移
短期可由 canonical store 同时派生：

- 新 snapshot 协议
- 旧 event 协议

验证稳定后删除旧推断逻辑。

---

## 11. 验证清单

完成后至少验证：

- attach 到已有活跃 session 时，agent 状态正确
- reconnect 后 subagent 个数正确
- 同一 child session 不会生成两个 subagent
- child 权限等待能显示并清除
- root idle + child busy 时 parent 不 waiting
- retry 不会显示成 waiting
- 历史完成的 tool 不会在 reload 后重新出现
- snapshot 不会覆盖比它更新的 live 状态
- webview 不再依赖 `"Subtask:"` 文本推断 subagent

---

## 12. 最关键的设计决策

### 必须做
1. **child session id 作为唯一 subagent id**
2. **message/permission/child-linkage 优先于 session.status**
3. **backend canonical state**
4. **snapshot + SSE buffer + reconcile**
5. **webview 从解释器变成渲染器**

### 不建议继续做
1. 继续用 `subtask part.id` 代表 subagent
2. 继续让 webview 根据字符串创建 subagent
3. 继续把 `session.status` 直接映射成 active/waiting
4. 继续用“历史事件重放”替代“当前状态归约”

---

## 13. 相关源码依据

### 当前项目
- `src/opencodeEventBridge.ts`
- `src/PixelAgentsViewProvider.ts`
- `src/runtime/openCodeRuntimeAdapter.ts`
- `webview-ui/src/hooks/useExtensionMessages.ts`

### OpenCode 参考源码
- `ref/opencode/packages/opencode/src/tool/task.ts`
- `ref/opencode/packages/opencode/src/session/message-v2.ts`
- `ref/opencode/packages/opencode/src/session/status.ts`
- `ref/opencode/packages/opencode/src/session/index.ts`
- `ref/opencode/packages/opencode/src/permission/service.ts`
- `ref/opencode/packages/opencode/src/server/routes/session.ts`
- `ref/opencode/packages/opencode/src/server/routes/global.ts`

---

如果你要，我下一步可以把这份文档继续收敛成一份**可执行改造 spec**，直接细化到：
- 需要新增的数据结构
- 事件 reducer 设计
- 新的 webview message schema
- 迁移步骤与测试用例矩阵。
