# Open Pixel Agents

- English
- [简体中文](README.md)

Forked from the original pixel-agents project, this version is maintained for **OpenCode only**.

Open Pixel Agents is a VS Code extension that turns OpenCode sessions into animated pixel characters inside a virtual office. Each session appears as a character that can walk, sit at a desk, show status bubbles, and reflect current activity in real time.

![Open Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

## Current Features

- **OpenCode-only runtime** — the extension launches and visualizes OpenCode sessions through the local OpenCode server API and SSE event stream
- **One session, one character** — each primary OpenCode session becomes a pixel agent in the office
- **Sub-agent visualization** — OpenCode child sessions/subtasks appear as temporary sub-agent characters
- **Live status feedback** — characters react to working, reading, waiting, permission requests, retries, and completion
- **Workspace session persistence** — reopening the project reattaches persisted agent sessions unless the user explicitly deletes them from the UI
- **Terminal integration** — each agent opens in a matching VS Code terminal and attaches to the corresponding OpenCode session
- **Window-local server management** — each VS Code window keeps its own resolved OpenCode server port and aligns attach/API/SSE traffic to it
- **Seat assignment and office simulation** — agents can be selected, reassigned to seats, and return to their desks automatically
- **Layout editor** — edit floors, walls, furniture placement, and office arrangement directly in the webview
- **Import/export layouts** — save and share office layouts as JSON
- **Optional completion sound** — play a chime when work completes
- **Mouse camera controls** — left-drag to pan, middle click to re-center, wheel to zoom

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Open Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## Requirements

- VS Code 1.50.0 or later
- [OpenCode CLI](https://github.com/anomalyco/opencode) installed and available on your `PATH`

## Getting Started

### Run from source

```bash
git clone https://github.com/inkbottle/open-pixel-agents.git
cd open-pixel-agents
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host.

### Basic usage

1. Open the **Open Pixel Agents** panel
2. Click **+ Agent** to create a new OpenCode session
3. Work in the attached terminal or OpenCode flow as usual
4. Watch the office reflect session and subtask activity in real time
5. Click an agent to focus/select it
6. Click a seat to reassign the selected agent
7. Click the close button on an agent to remove it and delete its persisted session binding

## How It Works

When you create an agent, the extension:

1. Ensures a window-local OpenCode server is available
2. Resolves a localhost port for the current VS Code window
3. Creates a new OpenCode session over HTTP
4. Opens a VS Code terminal named like the session
5. Runs:

```bash
opencode attach http://127.0.0.1:<resolved-port> --session <session-id> --dir "<workspace>"
```

6. Subscribes to OpenCode's `/global/event` SSE stream
7. Maps session/tool/subtask/permission events into office state, overlays, and character animation

Session and terminal titles use this format:

```text
Open Pixel Agent - <project-name>: <index>
```

Reopening the same project restores persisted agents by reconnecting to their saved OpenCode sessions when those sessions still exist. Deleting a pixel agent from the UI removes its persisted record and deletes the corresponding OpenCode session.

## Layout Editor

The built-in editor supports:

- floor painting
- wall painting
- erase/select/pick/place tools
- furniture move / rotate / delete
- undo / redo
- layout import / export
- expandable grid editing up to 64×64

## Office Assets

The office tileset used by the optional asset pipeline is **[Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset)** by **Donarg**.

This tileset is not included in the repository. To use the full furniture catalog locally, purchase the tileset and run:

```bash
npm run import-tileset
```

The extension still works without the tileset using the bundled default assets and layout.

## Development

```bash
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Package the extension with:

```bash
npx @vscode/vsce package
```

## Current Scope

- OpenCode is the only supported runtime
- The extension is centered on VS Code webview visualization of OpenCode sessions
- Some historical naming and structure from the earlier project lineage still remain internally, but the active runtime path is OpenCode-based

## Author

- **Shawn Fang**
- Repository: https://github.com/inkbottle/open-pixel-agents.git

## License

This project is licensed under the [MIT License](LICENSE).
