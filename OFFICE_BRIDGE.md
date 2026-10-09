# Office companion integration spike

This fork adds a small extension API for the companion in [the-office](https://github.com/DXD-Dev-Team/the-office). It keeps the existing office and uses the same session/character creation helper as **+ Agent**. The upstream base is `03cd46168276bbb9b6e58684b67dbc9c95934ab0`.

```ts
const extension = vscode.extensions.getExtension('inkbottle.open-pixel-agents');
const office = await extension!.activate();
const server = await office.getServer();
const worker = await office.createAgent({
  displayName: 'Reviewer',
  cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
});
await office.focusAgent(worker.agentId);
await office.closeAgent(worker.agentId);
```

API version `1` exposes `getServer`, `createAgent`, `listAgents`, `focusAgent`, and `closeAgent`. Create returns `agentId`, `sessionId`, `displayName`, `cwd`, the resolved `port` and `url`, and `readOnly: true`. The office view must initialize before the operation proceeds; the API opens it and waits for assets, session restore, and controller hydration.

For this spike, `cwd` must resolve to the window's first workspace folder, where the shared server runs. Other directories are rejected rather than returning an attachment for a session created in the wrong workspace.

Managed terminals are macOS read-only pseudoterminals. `/usr/bin/script` allocates a TTY for `opencode attach`; input from the keyboard, paste, or `Terminal.sendText` is discarded. The read-only marker persists across restoration. The current spike uses fixed startup terminal dimensions and rejects managed attachment on other operating systems.

The window server starts with `opencode serve --hostname 127.0.0.1` and its resolved port. HTTP health, JSON, deletion, and SSE clients honor `OPENCODE_SERVER_PASSWORD` and optional `OPENCODE_SERVER_USERNAME` through Basic authentication. Attach commands contain no credentials.

This bridge does not manage provider credentials or locks, turn this fork's ordinary **+ Agent** sessions into managed workers, merge project sharing settings, or implement worker labels and attention UI. It is an integration spike, not the completed office product. The parent project's probes and README record verification and remaining blockers.
