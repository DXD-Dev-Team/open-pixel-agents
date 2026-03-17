# Pixel Agents — OpenCode Reference

VS Code extension with an embedded React webview: a pixel-art office where OpenCode sessions appear as animated characters.

## Current System Model

- **Runtime**: OpenCode server + HTTP API + SSE event stream
- **UI**: VS Code webview + React + Canvas 2D office simulation
- **Agent model**: one OpenCode session maps to one primary character
- **Subtask model**: OpenCode child sessions/subtasks map to sub-agent characters
- **Persistence**: layout and seat assignments are persisted; session bindings are restored across reloads when terminals still exist

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
opencode attach http://127.0.0.1:4096 --session <session-id> --dir "<workspace>"
```

7. Agent is created immediately in the office

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

1. Existing terminals are matched against persisted agent records
2. Session IDs are restored into in-memory agent state
3. Current session status is fetched from `/session/status`
4. Session message history is fetched from `/session/:id/message`
5. Child sessions are fetched from `/session/:id/children`
6. Parent and child messages are replayed into the webview protocol to rebuild active tools/subtasks

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
- Layout is persisted at `~/.pixel-agents/layout.json`

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

This repository was forked from a Claude Code-focused project, but the active runtime path is now OpenCode-based. Any documentation or code path that conflicts with that model should be treated as historical residue and updated accordingly.
