# Open Pixel Agents (OpenCode Fork)

A VS Code extension that turns your OpenCode sessions into animated pixel art characters in a virtual office.

Each OpenCode session you launch from the extension spawns a character that walks around, sits at desks, and visually reflects what the agent is doing — typing when writing code, reading when searching files, waiting when it needs your attention.

This fork started from the original Open Pixel Agents project and adapts its visualization model to OpenCode's server API and event stream.


![Open Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

## Features

- **One session, one character** — every OpenCode session gets its own animated character
- **Live activity tracking** — characters animate based on what the agent is actually doing (writing, reading, running commands)
- **Office layout editor** — design your office with floors, walls, and furniture using a built-in editor
- **Speech bubbles** — visual indicators when an agent is waiting for input or needs permission
- **Sound notifications** — optional chime when an agent finishes its turn
- **Sub-agent visualization** — OpenCode subtasks and child sessions spawn as separate characters linked to their parent
- **Persistent layouts** — your office design is saved and shared across VS Code windows
- **Diverse characters** — 6 diverse characters.

<p align="center">
  <img src="webview-ui/public/characters.png" alt="Open Pixel Agents characters" width="320" height="72" style="image-rendering: pixelated;">
</p>

## Requirements

- VS Code 1.50.0 or later
- [OpenCode CLI](https://github.com/anomalyco/opencode) installed and available on your PATH

## Getting Started

If you want to use, develop, or contribute to this fork:

### Install from source

```bash
git clone https://github.com/pablodelucca/open-pixel-agents.git
cd open-pixel-agents
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host.

### Usage

1. Open the **Open Pixel Agents** panel (it appears in the bottom panel area alongside your terminal)
2. Click **+ Agent** to spawn a new OpenCode session and its character
3. Start coding with OpenCode — watch the character react in real time
4. Click a character to select it, then click a seat to reassign it
5. Click **Layout** to open the office editor and customize your space

## Layout Editor

The built-in editor lets you design your office:

- **Floor** — Full HSB color control
- **Walls** — Auto-tiling walls with color customization
- **Tools** — Select, paint, erase, place, eyedropper, pick
- **Undo/Redo** — 50 levels with Ctrl+Z / Ctrl+Y
- **Export/Import** — Share layouts as JSON files via the Settings modal

The grid is expandable up to 64×64 tiles. Click the ghost border outside the current grid to grow it.

### Office Assets

The office tileset used in this project and available via the extension is **[Office Interior Tileset (16x16)](https://donarg.itch.io/officetileset)** by **Donarg**, available on itch.io for **$2 USD**.

This is the only part of the project that is not freely available. The tileset is not included in this repository due to its license. To use Open Pixel Agents locally with the full set of office furniture and decorations, purchase the tileset and run the asset import pipeline:

```bash
npm run import-tileset
```

Fair warning: the import pipeline is not exactly straightforward — the out-of-the-box tileset assets aren't the easiest to work with, and while I've done my best to make the process as smooth as possible, it may require some manual tweaking. If you have experience creating pixel art office assets and would like to contribute freely usable tilesets for the community, that would be hugely appreciated.

The extension will still work without the tileset — you'll get the default characters and basic layout, but the full furniture catalog requires the imported assets.

## How It Works

Open Pixel Agents talks to OpenCode through its local server API.

When you click **+ Agent**, the extension:

1. Ensures an OpenCode server is running
2. Creates a new OpenCode session via HTTP
3. Opens a VS Code terminal attached to that session
4. Subscribes to OpenCode's SSE event stream
5. Maps OpenCode session, tool, permission, and subtask events into character animations and UI state

The extension prefers OpenCode's default localhost port and, if it is already occupied, automatically tries the next port number so multiple VS Code windows can run side by side. Each VS Code window keeps its own resolved OpenCode server port rather than intentionally sharing another window's server. The attach command and all API/SSE traffic stay aligned to the same resolved port for that window.

New sessions are named `Open Pixel Agent - <project-name>: <index>`. Agent/session bindings are persisted per workspace, so reopening the project reattaches those sessions by default. Removing a pixel agent from the UI deletes the underlying OpenCode session and clears its persisted binding.

The webview runs a lightweight game loop with canvas rendering, BFS pathfinding, and a character state machine (idle → walk → type/read). Everything is pixel-perfect at integer zoom levels.

## Tech Stack

- **Extension**: TypeScript, VS Code Webview API, esbuild
- **Webview**: React 19, TypeScript, Vite, Canvas 2D

## Known Limitations

- **Hybrid codebase** — the fork now supports OpenCode at runtime, but parts of the old Claude-oriented architecture still exist internally and need cleanup.
- **Session restore depth** — restored agents recover session identity and idle/active state, but richer in-flight tool history is not fully replayed yet.
- **Single-root launch flow** — in multi-root workspaces the extension currently launches agents in the first workspace folder.
- **Windows-first testing** — the extension has mainly been tested on Windows 11. It may work on macOS or Linux, but there could still be path, terminal, or environment differences.

## Roadmap

There are several areas where contributions would be very welcome:

- **Improve session restore** — rebuild richer live tool and subtask state after reloading VS Code
- **Provider abstraction** — separate OpenCode integration cleanly from any legacy Claude-era implementation details
- **Community assets** — freely usable pixel art tilesets or characters that anyone can use without purchasing third-party assets
- **Agent creation and definition** — define agents with custom skills, system prompts, names, and skins before launching them
- **Desks as directories** — click on a desk to select a working directory, drag and drop agents or click-to-assign to move them to specific desks/projects
- **Multi-root workspace picker** — choose which workspace folder a new OpenCode session should run in
- **Git worktree support** — agents working in different worktrees to avoid conflict from parallel work on the same files
- **Support for other agentic frameworks** — beyond OpenCode, adapt the office visualization model to other agent runtimes as well

If any of these interest you, feel free to open an issue or submit a PR.

## Contributions

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for instructions on how to contribute to this project.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Supporting the Project

If you find Open Pixel Agents useful, consider supporting its development:

<a href="https://github.com/sponsors/pablodelucca">
  <img src="https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github" alt="GitHub Sponsors">
</a>
<a href="https://ko-fi.com/pablodelucca">
  <img src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi" alt="Ko-fi">
</a>

## License

This project is licensed under the [MIT License](LICENSE).
