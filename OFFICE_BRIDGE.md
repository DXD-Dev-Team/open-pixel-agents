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

API version `1` exposes `configureRuntime`, `shutdownRuntime`, `getServer`, `createAgent`, `listAgents`, `focusAgent`, `closeAgent`, `setMetadata`, `setRepositories`, `openAgentPanel`, `setAgentPanelState`, and `onDidEvent`. This paired integration requires VS Code 1.100 or later and a trusted local workspace. `runtimeOwnershipVersion: 1` advertises strict owned-child runtime validation. Configure the pinned executable and isolated runtime environment before requesting the server. Create returns `agentId`, `sessionId`, `displayName`, `cwd`, the resolved `port` and `url`, and `readOnly: true`. The office view must initialize before the operation proceeds; the API opens it and waits for assets, session restore, and controller hydration.

The fork installs as `dxd-dev-team.office-pixel-agents`, with separate command/view identifiers and `~/.office-pixel-agents/layout.json` persistence. Marketplace updates to the upstream extension cannot replace it. Disable the upstream office extension to avoid two office panels.

Managed workers stay seated at a desk with a computer during idle and input waits. Arrivals still walk to their seats. The original hand-drawn sprites provide twelve computer desks per repository when the optional asset pack is absent: six in Build, two in Security, two in Verification, and two in Management. Existing six-builder offices therefore remain valid. The safe repository roster repeats these areas on the same canvas, with repository and role signs; up to eight repository areas are supported. Valid user layouts retain their furniture. Unzoned custom desks serve the first repository only; other repositories need zone metadata on their own desks. Creation checks actual free computer desks for the worker's effective role and repository before creating a session and refuses when none remain. Children use spare desks; a child without a spare seat continues contributing its input/status to the parent without spawning an unseated character.

`createAgent` accepts optional public worker metadata. `setMetadata` updates worker name, provider/account/model identifiers, status, input state, cumulative usage, and exact-model pricing. Unknown fields are discarded. Each character has one persistent label; child characters inherit the parent worker name. Completed assistant messages are deduplicated by ID, and token counts appear only for Codex workers. Questions and permissions raise a hand in that label. Real assistant text, including streamed text, appears in an eight-second speech bubble above only the speaking session's character. A task tool's actual prompt appears above its parent as it delegates; a child's reply appears above that child. These excerpts are plain text, limited to 96 characters/two rendered lines, with common credential-shaped strings redacted. Historical messages are not replayed as new speech. The existing canvas renders both speech and permanent labels; speech expiry preserves the worker label. Status precedence is needs input, failed, working, reading, waiting, done, idle.

`onDidEvent` emits registered runtime events, changed bindings, and closed bindings. The companion owns account binding, whole-turn provider locks, live permission/question replies, and worker persistence. With `OFFICE_DESK_MANAGED=1`, ordinary **+ Agent** and close actions route through companion commands; restored legacy writable agents are refused.

The companion owns the selected repository paths. `cwd` may identify another existing absolute repository directory; session creation, restore, history, children, status, pending input, and deletion pass `x-opencode-directory` for that worker. A single owned server and global SSE stream remain shared, with session bindings selecting the correct characters. The webview receives repository IDs/names only, never paths or credentials.


## Character controls and role transactions

Managed character clicks open a centered React dialog over the existing canvas. Children open the parent's controls with a child-session notice. Standalone characters retain terminal focus behavior. `openAgentPanel(agentId)` explicitly opens controls; `setAgentPanelState(agentId, state)` publishes whitelisted state without reopening a dismissed dialog or stealing focus. Agent deletion closes its dialog.

Roles are `builder`, `security-reviewer`, `verifier`, and `manager` (legacy defaults to builder). Managers with `managerForRole` set to a team role occupy that role's desks; `all` occupies Management. Public metadata includes `repoId`, `repoName`, and manager `managerRepoIds`; the avatar occupies its home repository, and its label identifies multi-repository assignment. Role/scope/home-repository changes reserve the destination desk, persist a metadata snapshot, await a successful renderer apply acknowledgment, then release the old desk. Persistence/apply failure restores the old metadata and seat. An unavailable destination refuses before changing the companion registry.

Public dialog state includes worker identity/role/status/model/repository, user/assistant chat, busy/pending/error, permission/question previews, safe account labels/connectivity, safe repository labels, and manager mode/scope/paused/coordinating/executing/team/repository/proposal state. Proposal statuses include pending, approved, rejected, running, done, and failed. Unknown fields are discarded. Credentials belong only to the companion's secure authentication flow.

The dialog emits `onDidEvent({ type: 'agent-action', agentId, requestId, action, ... })` for managed primary bindings. Actions are open/send/start/stop/close/role/attention, manager-mode/manager-scope/assign-team/manager-repos/approve/reject, and sign-in/change-account/add-account. Optional fields are text, role, mode (`auto` or `human-approval`), scopeRole, teamIds, repoIds, proposalId, accountId, and provider kind. The companion validates authoritative account/team/repository bindings and performs actions; the webview does not run model requests. Stop stays available during pending sends and manager coordination; Start resumes paused managers. Enter sends, Shift+Enter inserts a newline, drafts survive dismissal and streaming updates, and a draft clears only after the native transcript acknowledges acceptance. Copy reply and idle retry use the displayed conversation.

`setRepositories([{id,name}])` waits for acknowledgment from the existing renderer. The default layout follows this roster; editor changes mark it custom so future roster updates preserve user furniture.

Managed terminals are macOS read-only pseudoterminals. `/usr/bin/script` allocates a TTY for `opencode attach`; input from the keyboard, paste, or `Terminal.sendText` is discarded. The read-only marker persists across restoration. The current spike uses fixed startup terminal dimensions and rejects managed attachment on other operating systems.

The window server starts with `opencode serve --hostname 127.0.0.1` and its resolved port. HTTP health, JSON, deletion, and SSE clients honor `OPENCODE_SERVER_PASSWORD` and optional `OPENCODE_SERVER_USERNAME` through Basic authentication. Attach commands contain no credentials.

Test hosts may enable `OPEN_PIXEL_AGENTS_TEST_SNAPSHOT=1` in the configured runtime environment. `getVisualSnapshot` then requests an acknowledged capture of the existing office canvas and its actual character labels. It waits for two animation frames when available, then flushes the existing game-loop renderer; a timer uses that same renderer if native background frames are suspended. It returns PNG pixels and public character/seat state; it never creates another canvas. The parent project's native fixture uses fabricated loopback provider responses and records that distinction from real provider inference.

The parent project also provides `node spike/probe-renderer.mjs`: an offscreen production-webview fixture that never opens VS Code. It simulates session events and the VS Code message transport, then captures the actual existing canvas through its acknowledgment protocol. Its `office_renderer_*.png` files prove rendering, seating, usage labels, and speaking/input overlays under those fixtures. The same fixture checks actual React modal actions, draft handling, Stop/Resume, account controls, team/repository selectors, and proposals; `office_agent_*.png` captures the rendered dialogs. They do not prove native VS Code end-to-end transport, provider authentication, or real inference. The native full-companion fixture remains a separate test and must not be described as passing when capture acknowledgment fails.
