# Pixel Agents OpenCode Migration Progress

Last updated: 2026-03-17

## Overall Status

- Current phase: OpenCode runtime boundary cleanup
- Current focus: Next planned task is optional lint-warning reduction and package polish
- Build status: Passing (`npm run build`)
- Notes: Runtime is now OpenCode-driven. Claude JSONL runtime path has been removed from active code. Restore replay is implemented from OpenCode session history.

---

## Plan Tasks

### Completed

- [x] Analyze the current fork against `ref/pixel-agents`
- [x] Confirm whether real OpenCode visualization support was implemented
- [x] Identify missing core OpenCode runtime functionality
- [x] Implement OpenCode server client integration
- [x] Implement OpenCode session creation and terminal attach flow
- [x] Implement OpenCode SSE event subscription
- [x] Bridge OpenCode events into existing webview agent/tool/subtask UI messages
- [x] Add `sessionId` to in-memory and persisted agent state
- [x] Update terminal naming to OpenCode
- [x] Fix seat persistence to retain `hueShift`
- [x] Exclude `ref/` from TypeScript compilation
- [x] Save migration analysis and usage guide to repo root as `OPENCODE_MIGRATION_REPORT.md`
- [x] Rewrite root docs and package metadata to reflect real OpenCode support
- [x] Rename active runtime message flow to `openAgentSession` while keeping backward compatibility for `openClaude`
- [x] Remove Claude JSONL watcher/parser runtime path from active code
- [x] Extract shared tool status formatting into `src/toolStatus.ts`
- [x] Remove JSONL fields from `AgentState` and `PersistedAgent`
- [x] Simplify backend lifecycle code to OpenCode-only active runtime
- [x] Verify build after each cleanup stage
- [x] Restore multi-root workspace picker for choosing which folder a new agent session runs in
- [x] Establish a formal runtime/provider adapter boundary for the OpenCode runtime
- [x] Remove local `ref/` directory assumptions from active config and packaging rules

### Pending

- [x] Enhance OpenCode session restore so active tools/subtasks can be reconstructed after reload
- [x] Remove backward-compatibility branch for `openClaude` once all callers are migrated
- [x] Continue cleanup of historical Claude-specific docs/comments such as `CLAUDE.md` where appropriate
- [ ] Optionally reduce existing ESLint warnings unrelated to functional migration

---

## Current Progress Log

### 2026-03-17

#### Completed this session

1. Verified the fork was still Claude JSONL-based before changes
2. Added real OpenCode runtime support via server/session/SSE integration
3. Updated the extension and docs to reflect OpenCode behavior
4. Removed active JSONL watcher/parser dependencies from runtime code
5. Rebuilt successfully after cleanup
6. Created this progress tracker
7. Implemented OpenCode session restore replay using session message and child-session history
8. Fixed VSIX packaging metadata so the extension can be packaged with a valid publisher identifier
9. Restored multi-root workspace folder selection for creating new OpenCode agent sessions
10. Removed the last runtime `openClaude` backward-compatibility branch
11. Replaced the outdated `CLAUDE.md` with a current `AGENTS.md` that documents the real OpenCode architecture
12. Introduced a runtime adapter boundary so provider/agent management no longer import OpenCode transport details directly
13. Fixed webview build packaging so Vite no longer clears the extension backend output before VSIX creation
14. Updated config and packaging rules so removing the local `ref/` directory does not require follow-up config changes
15. Switched TypeScript config to explicit `src/**/*.ts` includes so local comparison folders no longer affect compilation
16. Reduced lint warnings in the actively maintained backend runtime files by normalizing control-flow style issues
17. Normalized `src/assetLoader.ts` style warnings, removing the remaining high-volume lint noise source
18. Fixed Windows OpenCode server startup to launch `opencode.cmd` and surface real spawn errors from the extension host
19. Fixed Windows `.cmd` process launching by routing OpenCode server startup through `cmd.exe /c` instead of direct spawn
20. Made OpenCode server startup shell-based across Windows and Unix-like systems, and increased readiness waiting for slow local startups
21. Restored the upstream default furniture scene by loading manifest-based furniture assets, versioned default layouts, and upstream floors/walls asset folders
22. Added legacy `ASSET_*` layout fallback so previously saved incompatible layouts reset to a valid bundled furniture scene
23. Re-tightened VSIX packaging rules so the local `ref/` directory stays available in the repo but is excluded from packaged extensions

#### In Progress

- Preparing the next stage: optional lint-warning reduction and package polish

#### Next Up

1. Optionally reduce non-functional lint warnings
2. Continue polishing package/docs consistency where needed
3. Optionally slim the VSIX by excluding `ref/` from packaging

---

## Update Rule

When a task is completed:

1. Move it from **Pending** to **Completed**
2. Add a dated note to **Current Progress Log**
3. Update **Overall Status** if the current focus changes
