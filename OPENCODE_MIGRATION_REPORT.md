# Open Pixel Agents OpenCode Fork 分析与实现报告

## 结论

这个项目**原先并没有真正完成 OpenCode 可视化支持**。  
它虽然在 README 里声明自己是 OpenCode fork，但核心运行逻辑仍然是：

- 启动 `claude --session-id ...`
- 监听 `~/.claude/projects/.../*.jsonl`
- 解析 Claude Code 的 JSONL 事件格式
- 前端/后端消息仍大量使用 `openClaude`、`Claude Code` 等命名

也就是说，**之前基本还是 Claude Code 版本，只是换了仓库名和部分文档表述**。

我已经补上了项目中最关键、最核心的缺失能力：**真正的 OpenCode 会话启动与事件驱动可视化**。

---

## 我确认过的现状

### 原始参考项目 `ref/open-pixel-agents`
原始项目是一个成熟的 Claude Code agent 可视化扩展，核心能力包括：

- 一个 agent 对应一个终端角色
- 根据工具状态驱动角色行为
- sub-agent / task 可视化
- waiting / permission bubble
- 办公室布局编辑器
- 家具 / 地板 / 墙体 /角色渲染
- 通过 Claude transcript/JSONL 做状态同步

### 当前 fork 在修改前的问题
在本仓库中，我确认到以下事实：

#### 1. 运行链路仍是 Claude Code
关键文件：
- `src/agentManager.ts`
- `src/transcriptParser.ts`
- `src/fileWatcher.ts`
- `src/constants.ts`

表现：
- 终端启动命令仍是 `claude --session-id ...`
- transcript 路径仍指向 `.claude/projects`
- 状态解析逻辑完全基于 Claude JSONL

#### 2. README 与产品目标不一致
README 说是 OpenCode fork，但实际代码不是。

#### 3. 没有真正的 OpenCode runtime integration
仓库里几乎没有现成的 OpenCode 接入代码，只有 README 里提到 OpenCode。

---

## 我做了哪些实现

### 已实现的关键改造

#### 1. 接入 OpenCode Server
新增：
- `src/opencodeClient.ts`

实现内容：
- 检查 OpenCode server 是否存活
- 自动启动 `opencode serve --hostname 127.0.0.1 --port 4096`
- 调用 OpenCode HTTP API
- 创建新 session
- 获取 session status
- 订阅 `/global/event` SSE 实时事件流

#### 2. 将 agent 创建改为 OpenCode 会话
修改：
- `src/agentManager.ts`

实现内容：
- 不再启动 `claude --session-id ...`
- 改为：
  1. 确保 OpenCode server 存在
  2. 创建 OpenCode session
  3. 新建 VS Code terminal
  4. 在 terminal 里执行 `opencode attach http://127.0.0.1:4096 --session <id>`

这一步意味着项目已经从“Claude transcript 驱动”变成了“OpenCode session 驱动”。

#### 3. 新增 OpenCode 事件桥接层
新增：
- `src/opencodeEventBridge.ts`

实现内容：
把 OpenCode SSE 事件转换成当前 webview 已经能理解的消息协议：

- `session.status` → `agentStatus`
- `session.idle` → waiting 状态
- `permission.asked` / `permission.replied` → permission bubble
- `message.part.updated` 中的 `tool` part → `agentToolStart` / `agentToolDone`
- `subtask` / child session → sub-agent character 可视化

这样做的好处是：
- 不需要重写整套前端动画与渲染逻辑
- 复用了原 Open Pixel Agents 的可视化能力
- 最小改动就能跑通 OpenCode

#### 4. PixelAgentsViewProvider 接入 OpenCode 事件总线
修改：
- `src/PixelAgentsViewProvider.ts`

实现内容：
- webview ready 时自动确保 OpenCode server 可用
- 建立 SSE 订阅
- 拉取初始 session 状态
- 将 OpenCode 事件持续推送到 webview

#### 5. agent 状态结构增加 sessionId
修改：
- `src/types.ts`

实现内容：
- `AgentState` / `PersistedAgent` 增加 `sessionId`
- 让角色与 OpenCode session 建立真实关联

#### 6. 默认终端命名改为 OpenCode
修改：
- `src/constants.ts`

内容：
- `TERMINAL_NAME_PREFIX = 'OpenCode'`

#### 7. 修复 seat 持久化里的 hueShift 丢失问题
修改：
- `webview-ui/src/office/components/OfficeCanvas.tsx`

之前回归问题：
- 重新分配座位时只保存 `palette` 和 `seatId`
- 没保存 `hueShift`
- 造成恢复后角色配色可能丢失

现在已修复为同时保存：
- `palette`
- `hueShift`
- `seatId`

#### 8. 修正 TypeScript 编译范围
修改：
- `tsconfig.json`

内容：
- 把 `ref/` 从 tsc 编译范围排除
- 否则参考仓库会干扰当前项目构建

#### 9. 部分前端命名去 Claude 化
修改：
- `webview-ui/src/components/BottomToolbar.tsx`
- `webview-ui/src/hooks/useEditorActions.ts`
- `webview-ui/src/App.tsx`

内容：
- 前端组件属性名从 `onOpenClaude` 调整为更中性的 `onOpenAgentSession`
- 内部仍沿用协议消息 `openClaude`，只是为了兼容现有后端消息协议，避免大面积联动修改

---

## 当前是否已经“完全实现”

### 结论：**还没有 100% 完全实现，但核心 OpenCode 可视化能力已经打通**

### 已完成的核心功能
现在项目已经具备真正的 OpenCode 可视化基础：

- 通过 OpenCode server 启动与连接 session
- 通过 SSE 获取实时事件
- 用 OpenCode 事件驱动 agent 状态
- 工具状态可视化
- waiting / permission 可视化
- subtask / sub-agent 可视化
- 原有 office UI / editor / layout / asset 渲染继续可用

这意味着：

> 这个 fork 现在已经不是“名义上的 OpenCode fork”，而是“真正能以 OpenCode 为 runtime 的 Open Pixel Agents”。

---

## 还缺什么

下面是我认为仍然缺失、但未在这轮继续展开的大项。

### P1：文档与产品描述仍然混杂 Claude 术语
文件：
- `README.md`
- `package.json`

问题：
- 包描述仍是 Claude Code 风格
- README 仍有大量 Claude 说明
- 当前实际行为已经是 OpenCode 驱动

建议后续改：
- extension description
- requirements
- usage
- architecture
- troubleshooting
- roadmap

### P1：代码架构仍是“OpenCode 嵌在 Claude 外壳里”
当前状态是：
- 新增了 OpenCode runtime 支持
- 但 Claude 的 `fileWatcher.ts` / `transcriptParser.ts` / JSONL 状态字段仍保留在主架构里

这不是功能阻塞，但会造成：
- 维护成本高
- 命名混乱
- 后续支持多 provider 时会更难扩展

建议后续改造成：
- provider adapter 抽象层
- `ClaudeAdapter`
- `OpenCodeAdapter`

### P2：session 恢复能力还不够强
当前恢复是：
- 恢复 agent 基本信息
- 刷新 session status

但还没有完整恢复：
- 正在进行的 tool 列表
- OpenCode 历史消息中的 part 状态
- 更完整的 in-flight subtask 状态

后续可以做：
- webview ready 时根据 `/session/:id/message` 回放最近状态

### P2：多 workspace / folder picker 没恢复
参考项目里在多根工作区时可以让用户选择 agent 启动到哪个 folder。  
当前 fork 仍是默认取第一个 workspace folder。

后续可做：
- 后端发送 `workspaceFolders`
- 点击 `+ Agent` 时弹出选择器
- session 与 folder 做更清晰绑定

### P3：前后端消息命名还没完全去 Claude 化
例如：
- `openClaude`

虽然现在功能上已经启动 OpenCode 了，但命名仍是历史遗留。

建议后续统一为：
- `openAgentSession`
- `openOpenCodeSession`

---

## 本轮改动后的验证结果

我已执行：

```bash
npm run build
```

结果：
- TypeScript 检查通过
- ESLint 只有 warning，没有 error
- extension build 成功
- webview build 成功

所以当前实现至少在构建层面是通过的。

---

## 本轮关键改动文件

### 新增文件
- `src/opencodeClient.ts`
- `src/opencodeEventBridge.ts`

### 修改文件
- `src/agentManager.ts`
- `src/PixelAgentsViewProvider.ts`
- `src/types.ts`
- `src/constants.ts`
- `tsconfig.json`
- `webview-ui/src/office/components/OfficeCanvas.tsx`
- `webview-ui/src/components/BottomToolbar.tsx`
- `webview-ui/src/hooks/useEditorActions.ts`
- `webview-ui/src/App.tsx`
- `README.md`

---

## OpenCode Open Pixel Agents 使用指南

# Open Pixel Agents for OpenCode

一个 VS Code 插件，用像素风办公室的方式可视化 OpenCode agent / session 的运行状态。

---

## 功能概览

- 每个 OpenCode session 对应一个像素角色
- 根据工具执行状态显示角色行为
- 支持 waiting / permission 气泡提示
- 支持 subtask / sub-agent 可视化
- 支持办公室布局编辑
- 支持角色座位分配和布局持久化
- 支持资产加载（角色、地板、墙体、家具）

---

## 运行原理

插件不再依赖 Claude Code transcript。

当前版本通过以下方式接入 OpenCode：

1. 启动或连接 OpenCode server
2. 调用 OpenCode HTTP API 创建 session
3. 使用 `opencode attach` 在 VS Code terminal 中连接该 session
4. 订阅 OpenCode 的 `/global/event` SSE 事件流
5. 将 OpenCode 的 session/tool/subtask/permission 事件映射为 Open Pixel Agents 的角色状态与动画

---

## 环境要求

- VS Code
- Node.js
- 已安装 `opencode` CLI，并且可以在终端中直接执行 `opencode`

可自行验证：

```bash
opencode --version
```

如果命令不可用，请先安装 OpenCode CLI 并确保它在 PATH 中。

---

## 安装依赖

项目根目录执行：

```bash
npm install
cd webview-ui
npm install
cd ..
```

---

## 构建

```bash
npm run build
```

构建产物包括：

- 扩展后端：`dist/`
- Webview 前端：`dist/webview/`

---

## 在 VS Code 中调试运行

1. 用 VS Code 打开项目根目录
2. 执行构建：

```bash
npm run build
```

3. 按 `F5`
4. 在新的 Extension Development Host 窗口中打开 **Open Pixel Agents** 面板

---

## 如何启动一个 OpenCode Agent

在 Open Pixel Agents 面板中点击：

```text
+ Agent
```

插件会自动：

1. 检查 OpenCode server 是否可用
2. 如果不可用，自动启动：

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

3. 创建一个新的 OpenCode session
4. 打开一个 VS Code terminal
5. 在终端中执行类似命令：

```bash
opencode attach http://127.0.0.1:4096 --session <session-id> --dir "<workspace>"
```

然后该 session 会在办公室中显示成一个角色。

---

## 角色状态说明

### Active
当 OpenCode session 正在工作时，角色会处于活动状态。

### Waiting
当 session 进入 idle / waiting 状态时，角色头顶会出现等待提示。

### Permission
当 OpenCode 发出权限请求时，角色头顶会出现 permission bubble。

### Subtask / Sub-agent
当 OpenCode 产生子任务或子 session 时，会生成对应的子角色。

---

## 布局编辑器

点击底部工具栏中的：

```text
Layout
```

可以进入办公室布局编辑模式。

支持：

- 地板绘制
- 墙体绘制
- 擦除
- 家具放置
- 家具旋转
- 家具状态切换
- Undo / Redo
- Save / Reset
- 布局导入导出

---

## 座位分配

普通模式下：

1. 点击角色
2. 再点击一个空座位

角色会被重新分配到对应位置，并持久化保存：
- palette
- hueShift
- seatId

---

## 设置与资源

支持：

- 声音开关
- Debug 视图
- 布局导入 / 导出

资源会在插件启动时自动加载，包括：

- character sprites
- floor tiles
- wall tiles
- furniture assets
- default layout

---

## 已知限制

当前版本已经支持 OpenCode 的核心会话可视化，但仍有一些限制：

1. 文档与部分内部命名仍保留 Claude 时代痕迹
2. 多根 workspace 的 folder picker 尚未恢复
3. session 恢复仍以基础状态恢复为主，尚未完整回放历史 tool 状态
4. 内部仍保留部分旧的 Claude transcript 兼容代码，后续会继续清理

---

## 常见问题

### 1. 点击 `+ Agent` 没反应
请先确认：

```bash
opencode --version
```

如果命令不存在，需要先安装 OpenCode CLI。

---

### 2. OpenCode server 启动失败
插件默认尝试启动：

```bash
opencode serve --hostname 127.0.0.1 --port 4096
```

请确认：
- 本机未占用 4096 端口
- `opencode` 可执行
- PATH 配置正确

---

### 3. 构建通过但看不到角色变化
请确认你创建的 session 是通过插件触发，或 OpenCode 事件流可正常连接。  
插件依赖 OpenCode `/global/event` SSE 流实时更新状态。

---

## 开发建议

后续推荐继续做的改进：

- 抽象 provider adapter（OpenCode / Claude / 其他）
- 完整移除旧的 Claude JSONL 栈
- 支持多 workspace folder picker
- 基于 OpenCode message history 做更完整的 session 恢复
- 全面去 Claude 化命名与文档
