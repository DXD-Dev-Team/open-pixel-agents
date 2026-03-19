# Open Pixel Agents — OpenCode Reference

VS Code extension with an embedded React webview: a pixel-art office where OpenCode sessions appear as animated characters.

## Current System Model

- **Runtime**: OpenCode server + HTTP API + SSE event stream
- **UI**: VS Code webview + React + Canvas 2D office simulation
- **Agent model**: one OpenCode session maps to one primary character
- **Subtask model**: OpenCode child sessions/subtasks map to sub-agent characters
- **Persistence**: layout, seat assignments, and agent session bindings are persisted; reopening the project reattaches to persisted sessions unless the user explicitly deletes an agent from the UI

This file reflects the **current** project state. It replaces the old Claude JSONL-based notes.

---

## Architecture

```text
src/                          — Extension backend (Node.js, VS Code API)
  constants.ts                — Backend constants
  extension.ts                — Extension entrypoint
  PixelAgentsViewProvider.ts  — Webview provider, message dispatch, OpenCode integration bootstrap
  agentManager.ts             — Session/terminal lifecycle: create, restore, persist, remove
  opencodeClient.ts           — OpenCode server HTTP/SSE client helpers
  opencodeEventBridge.ts      — Maps OpenCode events/history into existing webview protocol
  toolStatus.ts               — Shared tool label/status formatting
  assetLoader.ts              — Furniture/character/floor/wall/default-layout asset loading
  layoutPersistence.ts        — User-level layout file I/O and cross-window syncing
  timerManager.ts             — Waiting/permission timer logic
  types.ts                    — Shared interfaces (AgentState, PersistedAgent)

webview-ui/src/               — React + TypeScript (Vite)
  App.tsx                     — Composition root
  constants.ts                — Webview constants
  notificationSound.ts        — Completion chime
  hooks/
    useExtensionMessages.ts   — Extension message handler + runtime state sync
    useEditorActions.ts       — Editor callbacks and commands
    useEditorKeyboard.ts      — Keyboard shortcuts
  components/
    BottomToolbar.tsx         — + Agent / Layout / Settings, includes multi-root picker
    ZoomControls.tsx          — Zoom UI
    SettingsModal.tsx         — Sound/debug/import/export settings
    DebugView.tsx             — Debug overlay
  office/
    engine/                   — Office simulation / character state / renderer
    editor/                   — Layout editing state + tools
    layout/                   — Layout serialization/catalog/tile map
    sprites/                  — Sprite data/cache
    components/               — Office canvas + overlays

scripts/                      — Asset extraction/import pipeline and utilities
```

---

## Core Concepts

### Vocabulary

- **Session**: an OpenCode session created via the local OpenCode server
- **Agent**: a primary character in the office representing one OpenCode session
- **Sub-agent**: a temporary child character representing a subtask/child session
- **Terminal**: the VS Code terminal attached to an OpenCode session using `opencode attach`

### Extension ↔ Webview protocol

Important messages include:

- `openAgentSession`
- `agentCreated` / `agentClosed`
- `focusAgent`
- `agentToolStart` / `agentToolDone` / `agentToolsClear`
- `agentStatus`
- `existingAgents`
- `workspaceFolders`
- `layoutLoaded`
- `furnitureAssetsLoaded`
- `floorTilesLoaded`
- `wallTilesLoaded`
- `characterSpritesLoaded`
- `saveLayout`
- `saveAgentSeats`
- `settingsLoaded`
- `setSoundEnabled`

### Session creation flow

Clicking **+ Agent** triggers:

1. Webview posts `openAgentSession`
2. In multi-root workspaces, the user may pick a workspace folder first
3. Backend ensures `opencode serve` is running
4. Backend creates a new OpenCode session via HTTP
5. Backend opens a VS Code terminal at the selected `cwd`
6. Backend runs:

```bash
opencode attach http://127.0.0.1:<resolved-port> --session <session-id> --dir "<workspace>"
```

7. Agent is created immediately in the office

Session titles use the format:

```text
Open Pixel Agent - <project-name>: <index>
```

Notes:

- The backend starts a window-local OpenCode server on `127.0.0.1`, preferring the default port and incrementing by `+1` when that port is already occupied by another process.
- If this VS Code window already has its own OpenCode server terminal, it reuses that server; it does not intentionally attach to a server started by a different VS Code window.
- The attach command, HTTP API calls, restore flow, and SSE subscription all use the same resolved port for the current VS Code window.

---

## Runtime Integration

### OpenCode transport

OpenCode integration is implemented through:

- `GET /global/health`
- `POST /session`
- `GET /session/status`
- `GET /session/:id/message`
- `GET /session/:id/children`
- `GET /global/event` (SSE)

### Live event mapping

`opencodeEventBridge.ts` converts OpenCode events into the existing webview protocol.

Key mappings:

- `session.status` / `session.idle` → `agentStatus`
- `message.part.updated` with `tool` parts → `agentToolStart` / `agentToolDone`
- `message.part.updated` with `subtask` parts → task/sub-agent creation
- `permission.asked` / `permission.replied` → permission bubble UI
- `session.created` with `parentID` → child session / sub-agent linkage

### Restore strategy

Restore no longer relies on transcript files.

On reload:

1. Persisted agent records are loaded from workspace state
2. The extension verifies each persisted OpenCode session still exists
3. Missing terminals are recreated and reattached with `opencode attach ... --session <id>`
4. Session IDs are restored into in-memory agent state
5. Current session status is fetched from `/session/status`
6. Session message history is fetched from `/session/:id/message`
7. Child sessions are fetched from `/session/:id/children`
8. Parent and child messages are replayed into the webview protocol to rebuild active tools/subtasks

If the user deletes a pixel agent from the UI, the extension deletes the corresponding OpenCode session and removes its persisted agent record.

This provides richer restore than the initial OpenCode port, though permission restore is still primarily live-event driven.

---

## Office UI / Editor Notes

These behaviors remain core to the project and are still accurate:

- Pixel-perfect canvas rendering with integer zoom
- Imperative `OfficeState` as the simulation model
- Character FSM for idle / walk / type / read
- Seat assignment and persistence
- Matrix spawn/despawn effects
- Sub-agent characters inherit parent palette/hue shift
- Layout editor supports floor/wall/furniture placement, undo/redo, import/export
- Layout is persisted at `~/.open-pixel-agents/layout.json`

---

## Current Limitations

- The codebase still contains historical documentation and naming influenced by the original project lineage
- Runtime/provider abstraction is not yet formalized, even though OpenCode is now the active runtime
- ESLint warnings remain in multiple files but do not currently block build/packaging
- The historical `ref/` comparison directory is optional and may be removed entirely from working copies

---

## Build & Dev

```bash
npm install
cd webview-ui && npm install && cd ..
npm run build
```

For packaging:

```bash
npx @vscode/vsce package
```

---

## TypeScript / Project Constraints

- No `enum` usage (`erasableSyntaxOnly`)
- Use `import type` for type-only imports
- `noUnusedLocals` / `noUnusedParameters` enabled
- Keep constants centralized in `src/constants.ts` and `webview-ui/src/constants.ts`

---

## Practical Guidance for Future Changes

### When editing runtime behavior

- Start with `src/PixelAgentsViewProvider.ts`
- Then inspect `src/agentManager.ts`
- Then inspect `src/opencodeClient.ts` and `src/opencodeEventBridge.ts`

### When editing tool visualization

- Backend mapping: `src/opencodeEventBridge.ts`
- Shared labels: `src/toolStatus.ts`
- Frontend state: `webview-ui/src/hooks/useExtensionMessages.ts`
- Character behavior: `webview-ui/src/office/engine/officeState.ts`

### When editing create-session UX

- Frontend button/picker: `webview-ui/src/components/BottomToolbar.tsx`
- Message dispatch: `webview-ui/src/hooks/useEditorActions.ts`
- Backend launch path: `src/PixelAgentsViewProvider.ts` and `src/agentManager.ts`

### When editing restore behavior

- Snapshot fetch: `src/opencodeClient.ts`
- Replay logic: `src/opencodeEventBridge.ts`
- Bootstrap timing: `src/PixelAgentsViewProvider.ts`

---

## Historical Note

This repository was forked from the original pixel-agents project. The active product/runtime target in this repository is now OpenCode only. Any documentation or code path that conflicts with that model should be treated as historical residue and updated accordingly.
