# Office companion integration

This fork adds a small extension API for the companion in [the-office](https://github.com/DXD-Dev-Team/the-office). It keeps the existing office and uses the same session/character creation helper as **+ Agent**. The upstream base is `03cd46168276bbb9b6e58684b67dbc9c95934ab0`.

```ts
const extension = vscode.extensions.getExtension('dxd-dev-team.office-pixel-agents');
const office = await extension!.activate();
const server = await office.getServer();
const worker = await office.createAgent({
  displayName: 'Reviewer',
  cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
});
await office.focusAgent(worker.agentId);
await office.closeAgent(worker.agentId);
```

API version `1` exposes `configureRuntime`, `shutdownRuntime`, `getServer`, `createAgent`, `listAgents`, `focusAgent`, `closeAgent`, `setMetadata`, and `onDidEvent`. Configure the pinned executable and isolated runtime environment before requesting the server. Create returns `agentId`, `sessionId`, `displayName`, `cwd`, the resolved `port` and `url`, and `readOnly: true`. The office view must initialize before the operation proceeds; the API opens it and waits for assets, session restore, and controller hydration.

The fork installs as `dxd-dev-team.office-pixel-agents`, with separate command/view identifiers and `~/.office-pixel-agents/layout.json` persistence. Marketplace updates to the upstream extension cannot replace it. Disable the upstream office extension to avoid two office panels.

Managed workers stay seated at a desk with a computer during idle and input waits. Arrivals still walk to their seats. The original hand-drawn sprites provide twelve computer desks when the optional asset pack is absent; valid user layouts retain their furniture. Creation checks actual free computer desks before creating a session and refuses when none remain. Children use spare desks; a child without a spare seat continues contributing its input/status to the parent without spawning an unseated character.

`createAgent` accepts optional public worker metadata. `setMetadata` updates worker name, provider/account/model identifiers, status, input state, cumulative usage, and exact-model pricing. Unknown fields are discarded. Each character has one persistent label; child characters inherit the parent worker name. Completed assistant messages are deduplicated by ID, and token counts appear only for Codex workers. Questions and permissions raise a hand in that label. Real assistant text, including streamed text, appears in an eight-second speech bubble above only the speaking session's character. A task tool's actual prompt appears above its parent as it delegates; a child's reply appears above that child. These excerpts are plain text, limited to 96 characters/two rendered lines, with common credential-shaped strings redacted. Historical messages are not replayed as new speech. The existing canvas renders both speech and permanent labels; speech expiry preserves the worker label. Status precedence is needs input, failed, working, reading, waiting, done, idle.

`onDidEvent` emits registered runtime events, changed bindings, and closed bindings. The companion owns account binding, whole-turn provider locks, live permission/question replies, and worker persistence. With `OFFICE_DESK_MANAGED=1`, ordinary **+ Agent** and close actions route through companion commands; restored legacy writable agents are refused.

For this spike, `cwd` must resolve to the window's first workspace folder, where the shared server runs. Other directories are rejected rather than returning an attachment for a session created in the wrong workspace.

Managed terminals are macOS read-only pseudoterminals. `/usr/bin/script` allocates a TTY for `opencode attach`; input from the keyboard, paste, or `Terminal.sendText` is discarded. The read-only marker persists across restoration. The current spike uses fixed startup terminal dimensions and rejects managed attachment on other operating systems.

The window server starts with `opencode serve --hostname 127.0.0.1` and its resolved port. HTTP health, JSON, deletion, and SSE clients honor `OPENCODE_SERVER_PASSWORD` and optional `OPENCODE_SERVER_USERNAME` through Basic authentication. Attach commands contain no credentials.

Test hosts may enable `OPEN_PIXEL_AGENTS_TEST_SNAPSHOT=1` in the configured runtime environment. `getVisualSnapshot` then requests an acknowledged capture of the existing office canvas and its actual character labels. It waits for two animation frames when available, then flushes the existing game-loop renderer; a timer uses that same renderer if native background frames are suspended. It returns PNG pixels and public character/seat state; it never creates another canvas. The parent project's native fixture uses fabricated loopback provider responses and records that distinction from real provider inference.

The parent project also provides `node spike/probe-renderer.mjs`: an offscreen production-webview fixture that never opens VS Code. It simulates session events and the VS Code message transport, then captures the actual existing canvas through its acknowledgment protocol. Its `office_renderer_*.png` files prove rendering, seating, usage labels, and speaking/input overlays under those fixtures. They do not prove native VS Code end-to-end transport, provider authentication, or real inference. The native full-companion fixture remains a separate test and must not be described as passing when capture acknowledgment fails.
