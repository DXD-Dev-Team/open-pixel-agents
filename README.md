# Open Pixel Agents

- 简体中文
- [English](README.en.md)

本项目 fork 自原始的 pixel-agents，并维护为 **仅支持 OpenCode** 的版本。

Open Pixel Agents 是一个 VS Code 扩展，它会把 OpenCode session 可视化为虚拟办公室里的像素角色。每个 session 都会以一个角色的形式出现，可以行走、入座、显示状态气泡，并实时反映当前工作状态。

![Open Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

## 当前功能

- **仅支持 OpenCode runtime** —— 通过本地 OpenCode server API 和 SSE 事件流启动并可视化 OpenCode session
- **一个 session 对应一个角色** —— 每个主 OpenCode session 都会变成办公室里的一个像素 agent
- **子 agent 可视化** —— OpenCode 的 child session / subtask 会显示为临时 sub-agent 角色
- **实时状态反馈** —— 角色会根据工作中、读取中、等待中、权限请求、重试、完成等状态变化
- **workspace 级 session 持久化** —— 重新打开项目时，会重新连接已持久化的 agent session，除非用户在 UI 中显式删除
- **终端集成** —— 每个 agent 都会打开对应的 VS Code terminal，并 attach 到对应的 OpenCode session
- **窗口级 server 管理** —— 每个 VS Code 窗口维护自己的 OpenCode server 端口，并让 attach / API / SSE 使用同一端口
- **工位分配与办公室模拟** —— agent 可以被选中、重新分配座位，并自动回到工位
- **布局编辑器** —— 可直接在 webview 中编辑地板、墙体、家具和办公室布局
- **布局导入/导出** —— 可以把办公室布局保存和共享为 JSON
- **可选完成提示音** —— 工作完成时播放提示音
- **鼠标视角控制** —— 左键拖动画面，中键回中，滚轮缩放

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Open Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## 环境要求

- VS Code 1.50.0 或更高版本
- 已安装 [OpenCode CLI](https://github.com/anomalyco/opencode)，并且可以通过 `PATH` 直接调用

## 快速开始

### 从源码运行

```bash
git clone https://github.com/inkbottle/open-pixel-agents.git
cd open-pixel-agents
npm install
cd webview-ui && npm install && cd ..
npm run build
```

然后在 VS Code 中按 **F5** 启动 Extension Development Host。

### 基本使用

1. 打开 **Open Pixel Agents** 面板
2. 点击 **+ Agent** 创建新的 OpenCode session
3. 在 attach 的 terminal 中正常使用 OpenCode
4. 观察办公室如何实时反映 session 和 subtask 的状态
5. 点击 agent 可以聚焦/选中它
6. 点击座位可以给选中的 agent 重新分配工位
7. 点击 agent 的关闭按钮会移除该角色，并删除对应的持久化 session 绑定

## 工作方式

当你创建一个 agent 时，扩展会：

1. 确保当前 VS Code 窗口有可用的 OpenCode server
2. 为当前窗口解析一个本地端口
3. 通过 HTTP 创建新的 OpenCode session
4. 打开一个与 session 同名的 VS Code terminal
5. 执行：

```bash
opencode attach http://127.0.0.1:<resolved-port> --session <session-id> --dir "<workspace>"
```

6. 订阅 OpenCode 的 `/global/event` SSE 事件流
7. 把 session / tool / subtask / permission 事件映射为办公室状态、覆盖层和角色动画

session 和 terminal 使用以下命名格式：

```text
Open Pixel Agent - <project-name>: <index>
```

重新打开同一个项目时，如果这些 OpenCode session 仍然存在，扩展会自动重连已持久化的 agent。若用户在 UI 中删除像素小人，扩展会删除对应的持久化记录，并删除相应的 OpenCode session。

## 布局编辑器

内置编辑器支持：

- 地板绘制
- 墙体绘制
- 擦除 / 选择 / 吸取 / 放置工具
- 家具移动 / 旋转 / 删除
- 撤销 / 重做
- 布局导入 / 导出
- 最大 64×64 的可扩展网格编辑

## 办公室素材

可选素材导入流程使用的办公室 tileset 为 **[Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset)**，作者是 **Donarg**。

该 tileset 不包含在当前仓库中。如果你想在本地使用完整家具目录，需要先购买该素材包，然后执行：

```bash
npm run import-tileset
```

即使不导入该 tileset，扩展仍可使用仓库内置的默认素材和默认布局正常工作。

## 开发

```bash
npm install
cd webview-ui && npm install && cd ..
npm run build
```

扩展打包命令：

```bash
npx @vscode/vsce package
```

## 当前范围

- OpenCode 是唯一支持的 runtime
- 项目核心是对 OpenCode session 的 VS Code webview 可视化
- 内部仍保留少量历史项目结构和命名，但当前实际运行链路已经是 OpenCode

## 作者

- **Shawn Fang**
- 仓库地址：https://github.com/inkbottle/open-pixel-agents.git

## 赞助

如果这个扩展对你有帮助，请我喝杯咖啡吧

<p align="center">
  <img src="https://inkbottle.github.io/images/payee_code/alipay_fc.jpg" alt="支付宝" width="180" />
  <img src="https://inkbottle.github.io/images/payee_code/wepay_fc.jpg" alt="微信" width="180" />
</p>

## License

本项目基于 [MIT License](LICENSE) 开源。
