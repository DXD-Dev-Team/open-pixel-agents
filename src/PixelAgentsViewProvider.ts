import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentState } from './types.js';
import type { AgentLaunchOptions } from './agentManager.js';
import type { OfficeAgentBinding, OfficeAgentInput, OfficeBridgeEvent, OfficeServerConnection, OfficeVisualSnapshot, OfficeWorkerMetadata } from './officeBridge.js';
import {
	launchNewTerminal,
	removeAgent,
	restoreAgents,
	persistAgents,
	sendExistingAgents,
	sendLayout,
	getProjectDirPath,
} from './agentManager.js';
import { loadFurnitureAssets, sendAssetsToWebview, loadFloorTiles, sendFloorTilesToWebview, loadWallTiles, sendWallTilesToWebview, loadCharacterSprites, sendCharacterSpritesToWebview, loadDefaultLayout } from './assetLoader.js';
import { WORKSPACE_KEY_AGENT_SEATS, GLOBAL_KEY_SOUND_ENABLED, WORKSPACE_KEY_OPENCODE_SERVER_PORT, VIEW_ID, OFFICE_BRIDGE_READY_TIMEOUT_MS, OFFICE_SNAPSHOT_TIMEOUT_MS } from './constants.js';
import { writeLayoutToFile, readLayoutFromFile, watchLayoutFile } from './layoutPersistence.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import type { RuntimeAdapter } from './runtime/runtimeAdapter.js';
import { OpenCodeRuntimeAdapter } from './runtime/openCodeRuntimeAdapter.js';
import { getOpenCodeEnvironment, isOfficeDeskManaged, resetOpenCodeServerTerminal } from './opencodeClient.js';
import { RuntimeController } from './runtime/runtimeController.js';
import { normalizeOfficeMetadata } from './runtime/officeTelemetry.js';

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
	nextAgentId = { current: 1 };
	nextTerminalIndex = { current: 1 };
	agents = new Map<number, AgentState>();
	webviewView: vscode.WebviewView | undefined;

	waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
	permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

	activeAgentId = { current: null as number | null };

	// Bundled default layout (loaded from assets/default-layout.json)
	defaultLayout: Record<string, unknown> | null = null;

	// Cross-window layout sync
	layoutWatcher: LayoutWatcher | null = null;
	runtimeEvents: { dispose: () => void } | null = null;
	readonly output = vscode.window.createOutputChannel('Open Pixel Agents');
	runtimeController: RuntimeController | null = null;
	isDisposing = false;
	private initialization: Promise<void> | null = null;
	private resolveReady: () => void = () => undefined;
	private rejectReady: (error: Error) => void = () => undefined;
	private ready = this.createReadyPromise();
	readonly bridgeEvents = new vscode.EventEmitter<OfficeBridgeEvent>();
	private snapshotIndex = 0;
	private readonly pendingSnapshots = new Map<number, { resolve: (snapshot: OfficeVisualSnapshot) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private readonly pendingCapacity = new Map<number, { resolve: (seatId: string | null) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private managedCreateTail: Promise<unknown> = Promise.resolve();
	private viewListeners: vscode.Disposable[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly runtime: RuntimeAdapter = new OpenCodeRuntimeAdapter(),
	) {}

	private get extensionUri(): vscode.Uri {
		return this.context.extensionUri;
	}

	private get webview(): vscode.Webview | undefined {
		return this.webviewView?.webview;
	}

	private persistAgents = (): PromiseLike<void> => {
		return persistAgents(this.agents, this.context);
	};

	private removeAgentSeatMeta(agentId: number): void {
		const agentMeta = this.context.workspaceState.get<Record<string, { palette?: number; seatId?: string }>>(WORKSPACE_KEY_AGENT_SEATS, {});
		if (!(String(agentId) in agentMeta)) {
			return;
		}
		const nextMeta = { ...agentMeta };
		delete nextMeta[String(agentId)];
		void this.context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, nextMeta);
	}

	private removeAgentUi(agentId: number, shouldPersist: boolean): void {
		this.removeAgentSeatMeta(agentId);
		removeAgent(
			agentId, this.agents,
			this.waitingTimers, this.permissionTimers,
			this.persistAgents,
			shouldPersist,
		);
		this.runtimeController?.removeAgent(agentId);
		this.webview?.postMessage({ type: 'agentClosed', id: agentId });
	}

	private get controller(): RuntimeController {
		if (!this.runtimeController) {
			this.runtimeController = new RuntimeController(this.runtime, this.agents, () => this.webview);
		}
		return this.runtimeController;
	}

	private createReadyPromise(): Promise<void> {
		const ready = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		// UI-only users may never request the bridge, so bootstrap rejection must
		// remain handled even when no API caller is currently waiting.
		void ready.catch(() => undefined);
		return ready;
	}

	private async ensureReady(show = true): Promise<void> {
		if (this.isDisposing) {
			throw new Error('Open Pixel Agents: The office is shutting down.');
		}
		if (show || !this.initialization) {
			await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
			this.webviewView?.show(false);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.ready,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error('Open Pixel Agents: Timed out waiting for the office view.')), OFFICE_BRIDGE_READY_TIMEOUT_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	async getServerConnection(): Promise<OfficeServerConnection> {
		await this.ensureReady();
		const port = this.runtime.getServerPort();
		if (port === null) {
			throw new Error('Open Pixel Agents: The window server has no resolved port.');
		}
		return { port, url: `http://127.0.0.1:${port}` };
	}

	private async createAgent(folderPath?: string, options?: AgentLaunchOptions): Promise<AgentState | undefined> {
		await this.ready;
		const agent = await launchNewTerminal(
			this.runtime, this.nextAgentId, this.nextTerminalIndex,
			this.agents, this.activeAgentId, this.waitingTimers, this.permissionTimers,
			this.webview, this.persistAgents, folderPath, this.output, options,
		);
		if (agent) {
			this.controller.registerAgent(agent);
			await this.controller.hydrateAll().catch(() => {
				this.output.appendLine('[Open Pixel Agents] Failed to hydrate agent runtime state.');
			});
		}
		return agent;
	}

	private managedBinding(agent: AgentState): OfficeAgentBinding {
		if (!agent.readOnly || !agent.sessionId || agent.serverPort === undefined) {
			throw new Error('Open Pixel Agents: This agent is not managed by the office bridge.');
		}
		return {
			agentId: agent.id,
			sessionId: agent.sessionId,
			displayName: agent.displayName || agent.terminalRef.name,
			cwd: agent.projectDir,
			port: agent.serverPort,
			url: `http://127.0.0.1:${agent.serverPort}`,
			readOnly: true,
			metadata: agent.officeMetadata,
		};
	}

	async createManagedAgent(input: OfficeAgentInput): Promise<OfficeAgentBinding> {
		const operation = this.managedCreateTail.then(() => this.createManagedAgentNow(input));
		this.managedCreateTail = operation.catch(() => undefined);
		return operation;
	}

	private async reserveComputerDesk(requestId: number): Promise<string | null> {
		return new Promise<string | null>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingCapacity.delete(requestId);
				void this.webview?.postMessage({ type: 'officeSeatRelease', requestId });
				reject(new Error('The office did not acknowledge its available computer desks.'));
			}, OFFICE_SNAPSHOT_TIMEOUT_MS);
			this.pendingCapacity.set(requestId, { resolve, reject, timer });
			void this.webview?.postMessage({ type: 'officeSeatCapacityRequest', requestId });
		});
	}

	private async createManagedAgentNow(input: OfficeAgentInput): Promise<OfficeAgentBinding> {
		const displayName = input.displayName?.trim();
		if (!displayName || displayName.length > 100 || /[\r\n\0]/.test(displayName)) {
			throw new Error('Open Pixel Agents: A display name of 1–100 characters is required.');
		}
		const cwd = input.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!cwd || !path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) {
			throw new Error('Open Pixel Agents: An existing absolute workspace directory is required.');
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot || fs.realpathSync(cwd) !== fs.realpathSync(workspaceRoot)) {
			throw new Error('Open Pixel Agents: The bridge spike requires the window server workspace directory.');
		}
		await this.ensureReady();
		const metadata = input.metadata ? normalizeOfficeMetadata(input.metadata) : undefined;
		const reservationId = ++this.snapshotIndex;
		if (!await this.reserveComputerDesk(reservationId)) {
			throw new Error('Add an available chair facing a desk with a computer in the office Layout editor before starting another worker.');
		}
		let agent: AgentState | undefined;
		try {
			agent = await this.createAgent(cwd, { displayName, readOnly: true, metadata, reservationId });
		} finally {
			void this.webview?.postMessage({ type: 'officeSeatRelease', requestId: reservationId });
		}
		if (!agent) {
			throw new Error('Open Pixel Agents: Could not create the managed session.');
		}
		await this.persistAgents();
		const binding = this.managedBinding(agent);
		this.bridgeEvents.fire({ type: 'changed', agentId: agent.id, binding });
		return binding;
	}

	async setManagedMetadata(agentId: number, patch: OfficeWorkerMetadata): Promise<OfficeAgentBinding> {
		await this.ensureReady(false);
		const agent = this.agents.get(agentId);
		if (!agent?.readOnly) {
			throw new Error('Open Pixel Agents: No managed agent exists with this id.');
		}
		agent.officeMetadata = normalizeOfficeMetadata(patch, agent.officeMetadata);
		this.controller.updateMetadata(agentId, patch);
		await this.persistAgents();
		const binding = this.managedBinding(agent);
		this.bridgeEvents.fire({ type: 'changed', agentId, binding });
		return binding;
	}

	async getVisualSnapshot(): Promise<OfficeVisualSnapshot> {
		if (getOpenCodeEnvironment().OPEN_PIXEL_AGENTS_TEST_SNAPSHOT !== '1') {
			throw new Error('Open Pixel Agents: Visual snapshots are enabled only in the test host.');
		}
		await this.ensureReady();
		const requestId = ++this.snapshotIndex;
		return new Promise<OfficeVisualSnapshot>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingSnapshots.delete(requestId);
				reject(new Error('Open Pixel Agents: The office canvas did not acknowledge the snapshot request.'));
			}, OFFICE_SNAPSHOT_TIMEOUT_MS);
			this.pendingSnapshots.set(requestId, { resolve, reject, timer });
			void this.webview?.postMessage({ type: 'officeSnapshotRequest', requestId });
		});
	}

	async listManagedAgents(): Promise<OfficeAgentBinding[]> {
		await this.ensureReady();
		return [...this.agents.values()].filter((agent) => agent.readOnly).map((agent) => this.managedBinding(agent));
	}

	private focusAgent(agentId: number): void {
		const agent = this.agents.get(agentId);
		if (agent) {
			agent.terminalRef.show();
			this.webview?.postMessage({ type: 'agentSelected', id: agentId });
		}
	}

	async focusManagedAgent(agentId: number): Promise<void> {
		await this.ensureReady();
		const agent = this.agents.get(agentId);
		if (!agent?.readOnly) {
			throw new Error('Open Pixel Agents: No managed agent exists with this id.');
		}
		this.focusAgent(agentId);
	}

	private async closeAgent(agentId: number): Promise<void> {
		const agent = this.agents.get(agentId);
		if (!agent) {
			return;
		}
		if (agent.sessionId) {
			await this.runtime.deleteSession(agent.sessionId);
		}
		if (!this.agents.has(agentId)) {
			await this.persistAgents();
			return;
		}
		this.removeAgentUi(agent.id, true);
		await this.persistAgents();
		agent.terminalRef.dispose();
		if (agent.sessionId) {
			this.bridgeEvents.fire({ type: 'closed', agentId, sessionId: agent.sessionId });
		}
	}

	async closeManagedAgent(agentId: number): Promise<void> {
		await this.ensureReady();
		const agent = this.agents.get(agentId);
		if (agent && !agent.readOnly) {
			throw new Error('Open Pixel Agents: This agent is not managed by the office bridge.');
		}
		await this.closeAgent(agentId);
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		for (const listener of this.viewListeners.splice(0)) { listener.dispose(); }
		this.webviewView = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);
		this.context.subscriptions.push(webviewView.onDidDispose(() => {
			if (this.webviewView !== webviewView) {
				return;
			}
			for (const listener of this.viewListeners.splice(0)) { listener.dispose(); }
			this.rejectReady(new Error('Open Pixel Agents: The office view was disposed.'));
			this.webviewView = undefined;
			this.initialization = null;
			this.ready = this.createReadyPromise();
		}));

		this.viewListeners.push(webviewView.webview.onDidReceiveMessage(async (message) => {
			if (message.type === 'openAgentSession') {
				if (isOfficeDeskManaged()) {
					await vscode.commands.executeCommand('office-desk.createWorker');
				} else {
					await this.createAgent(message.folderPath as string | undefined);
				}
			} else if (message.type === 'officeSeatCapacity') {
				const pending = this.pendingCapacity.get(message.requestId as number);
				if (pending) {
					this.pendingCapacity.delete(message.requestId as number);
					clearTimeout(pending.timer);
					if (message.seatId !== null && typeof message.seatId !== 'string') {
						pending.reject(new Error('The office returned invalid computer desk availability.'));
					} else {
						pending.resolve(message.seatId as string | null);
					}
				}
			} else if (message.type === 'officeSnapshotReady') {
				if (this.pendingSnapshots.has(message.requestId as number)) {
					this.output.appendLine(`[Office canvas snapshot] ${JSON.stringify(message.diagnostic)}`);
				}
			} else if (message.type === 'officeSnapshot') {
				const pending = this.pendingSnapshots.get(message.requestId as number);
				if (pending) {
					this.pendingSnapshots.delete(message.requestId as number);
					clearTimeout(pending.timer);
					if (typeof message.png !== 'string' || !message.png.startsWith('data:image/png;base64,') || !Array.isArray(message.characters)) {
						pending.reject(new Error('Open Pixel Agents: The office canvas returned an invalid snapshot.'));
					} else {
						pending.resolve({ png: message.png, characters: message.characters });
					}
				}
			} else if (message.type === 'focusAgent') {
				this.focusAgent(message.id as number);
			} else if (message.type === 'closeAgent') {
				try {
					const agent = this.agents.get(message.id as number);
					if (isOfficeDeskManaged() && agent?.officeMetadata?.workerId) {
						await vscode.commands.executeCommand('office-desk.closeWorker', agent.officeMetadata.workerId);
					} else if (isOfficeDeskManaged()) {
						void vscode.window.showInformationMessage('Close this managed session from Office Desk.');
					} else {
						await this.closeAgent(message.id as number);
					}
				} catch {
					void vscode.window.showErrorMessage('Open Pixel Agents: Could not delete the OpenCode session. The agent remains registered.');
				}
			} else if (message.type === 'saveAgentSeats') {
				// Store seat assignments in a separate key (never touched by persistAgents)
				console.log(`[Open Pixel Agents] saveAgentSeats:`, JSON.stringify(message.seats));
				this.context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, message.seats);
			} else if (message.type === 'saveLayout') {
				this.layoutWatcher?.markOwnWrite();
				writeLayoutToFile(message.layout as Record<string, unknown>);
			} else if (message.type === 'setSoundEnabled') {
				this.context.globalState.update(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
			} else if (message.type === 'webviewReady') {
				if (!this.initialization) {
					const resolveReady = this.resolveReady;
					const rejectReady = this.rejectReady;
					this.initialization = this.bootstrapWebview();
					void this.initialization.then(resolveReady, () => {
						rejectReady(new Error('Open Pixel Agents: Office initialization failed.'));
					});
				}
				await this.initialization.catch(() => undefined);
			} else if (message.type === 'openSessionsFolder') {
				const projectDir = getProjectDirPath();
				if (projectDir && fs.existsSync(projectDir)) {
					vscode.env.openExternal(vscode.Uri.file(projectDir));
				}
			} else if (message.type === 'exportLayout') {
				const layout = readLayoutFromFile();
				if (!layout) {
					vscode.window.showWarningMessage('Open Pixel Agents: No saved layout to export.');
					return;
				}
				const uri = await vscode.window.showSaveDialog({
					filters: { 'JSON Files': ['json'] },
					defaultUri: vscode.Uri.file(path.join(os.homedir(), 'open-pixel-agents-layout.json')),
				});
				if (uri) {
					fs.writeFileSync(uri.fsPath, JSON.stringify(layout, null, 2), 'utf-8');
					vscode.window.showInformationMessage('Open Pixel Agents: Layout exported successfully.');
				}
			} else if (message.type === 'importLayout') {
				const uris = await vscode.window.showOpenDialog({
					filters: { 'JSON Files': ['json'] },
					canSelectMany: false,
				});
				if (!uris || uris.length === 0) {
					return;
				}
				try {
					const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
					const imported = JSON.parse(raw) as Record<string, unknown>;
					if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
						vscode.window.showErrorMessage('Open Pixel Agents: Invalid layout file.');
						return;
					}
					this.layoutWatcher?.markOwnWrite();
					writeLayoutToFile(imported);
					this.webview?.postMessage({ type: 'layoutLoaded', layout: imported });
					vscode.window.showInformationMessage('Open Pixel Agents: Layout imported successfully.');
				} catch {
					vscode.window.showErrorMessage('Open Pixel Agents: Failed to read or parse layout file.');
				}
			}
		}));

		this.viewListeners.push(vscode.window.onDidChangeActiveTerminal((terminal) => {
			this.activeAgentId.current = null;
			if (!terminal) {
				return;
			}
			for (const [id, agent] of this.agents) {
				if (agent.terminalRef === terminal) {
					this.activeAgentId.current = id;
					webviewView.webview.postMessage({ type: 'agentSelected', id });
					break;
				}
			}
		}));

		this.viewListeners.push(vscode.window.onDidCloseTerminal((closed) => {
			const serverClose = resetOpenCodeServerTerminal(closed);
			if (serverClose.wasServerTerminal) {
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				if (workspaceRoot) {
					void (async () => {
						try {
							await this.runtime.ensureServer(workspaceRoot, this.output, serverClose.port ?? undefined);
							const activePort = this.runtime.getServerPort();
							if (activePort !== null) {
								await this.context.workspaceState.update(WORKSPACE_KEY_OPENCODE_SERVER_PORT, activePort);
							}
							this.runtimeEvents?.dispose();
							this.runtimeEvents = null;
							this.startRuntimeEvents();
							await this.controller.hydrateAll().catch((error) => {
								this.output.appendLine(`[Open Pixel Agents] Failed to re-hydrate after OpenCode server restart: ${String(error)}`);
							});
						} catch (error) {
							this.output.appendLine(`[Open Pixel Agents] Failed to restart OpenCode server after terminal close: ${String(error)}`);
						}
					})();
				}
			}
			for (const [id, agent] of this.agents) {
				if (agent.terminalRef === closed) {
					if (this.activeAgentId.current === id) {
						this.activeAgentId.current = null;
					}
					if (agent.readOnly && !this.isDisposing) {
						const close = isOfficeDeskManaged() && agent.officeMetadata?.workerId
							? vscode.commands.executeCommand('office-desk.closeWorker', agent.officeMetadata.workerId)
							: this.closeAgent(id);
						void Promise.resolve(close).catch(() => {
							this.output.appendLine('[Open Pixel Agents] Could not delete the managed session after its terminal closed.');
						});
					} else {
						this.removeAgentUi(id, !this.isDisposing);
					}
				}
			}
		}));
	}

	private async bootstrapWebview(): Promise<void> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const preferredPort = this.context.workspaceState.get<number | undefined>(WORKSPACE_KEY_OPENCODE_SERVER_PORT, undefined);
		if (workspaceRoot) {
			try {
				await this.runtime.ensureServer(workspaceRoot, this.output, preferredPort);
				const activePort = this.runtime.getServerPort();
				if (activePort !== null) {
					void this.context.workspaceState.update(WORKSPACE_KEY_OPENCODE_SERVER_PORT, activePort);
				}
			} catch (error) {
				this.output.appendLine(`[Open Pixel Agents] Failed to start OpenCode server: ${String(error)}`);
				void vscode.window.showErrorMessage('Open Pixel Agents: Failed to start OpenCode server in the VS Code terminal. Check the "OpenCode Server" terminal and Open Pixel Agents output logs.');
				throw new Error('Open Pixel Agents: OpenCode server startup failed.');
			}
		}
		await restoreAgents(
			this.runtime,
			this.context,
			this.nextAgentId, this.nextTerminalIndex,
			this.agents, this.waitingTimers, this.permissionTimers,
			this.webview, this.persistAgents, this.output,
		);
		for (const agent of this.agents.values()) {
			this.controller.registerAgent(agent);
		}
		// Send persisted settings to webview
		const soundEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
		this.webview?.postMessage({ type: 'settingsLoaded', soundEnabled });
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 1) {
			this.webview?.postMessage({
				type: 'workspaceFolders',
				folders: workspaceFolders.map((folder) => ({
					name: folder.name,
					path: folder.uri.fsPath,
				})),
			});
		}

		// Restored characters are buffered by the webview until layoutLoaded.
		// Queue them before assets/layout so the initial layout can spawn them.
		sendExistingAgents(this.agents, this.context, this.webview);
		const projectDir = getProjectDirPath();
		console.log('[Extension] workspaceRoot:', workspaceRoot);
		console.log('[Extension] projectDir:', projectDir);
		if (projectDir) {
			// Load furniture assets BEFORE sending layout
			await (async () => {
				try {
					console.log('[Extension] Loading furniture assets...');
					const extensionPath = this.extensionUri.fsPath;
					console.log('[Extension] extensionPath:', extensionPath);

					// Check bundled location first: extensionPath/dist/assets/
					const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
					let assetsRoot: string | null = null;
					if (fs.existsSync(bundledAssetsDir)) {
						console.log('[Extension] Found bundled assets at dist/');
						assetsRoot = path.join(extensionPath, 'dist');
					} else if (workspaceRoot) {
						// Fall back to workspace root (development or external assets)
						console.log('[Extension] Trying workspace for assets...');
						assetsRoot = workspaceRoot;
					}

					if (!assetsRoot) {
						console.log('[Extension] ⚠️  No assets directory found');
						if (this.webview) {
							sendLayout(this.context, this.webview, this.defaultLayout);
							this.startLayoutWatcher();
						}
						return;
					}

					console.log('[Extension] Using assetsRoot:', assetsRoot);

					// Load bundled default layout
					this.defaultLayout = loadDefaultLayout(assetsRoot);

					// Load character sprites
					const charSprites = await loadCharacterSprites(assetsRoot);
					if (charSprites && this.webview) {
						console.log('[Extension] Character sprites loaded, sending to webview');
						sendCharacterSpritesToWebview(this.webview, charSprites);
					}

					// Load floor tiles
					const floorTiles = await loadFloorTiles(assetsRoot);
					if (floorTiles && this.webview) {
						console.log('[Extension] Floor tiles loaded, sending to webview');
						sendFloorTilesToWebview(this.webview, floorTiles);
					}

					// Load wall tiles
					const wallTiles = await loadWallTiles(assetsRoot);
					if (wallTiles && this.webview) {
						console.log('[Extension] Wall tiles loaded, sending to webview');
						sendWallTilesToWebview(this.webview, wallTiles);
					}

					const assets = await loadFurnitureAssets(assetsRoot);
					if (assets && this.webview) {
						console.log('[Extension] ✅ Assets loaded, sending to webview');
						sendAssetsToWebview(this.webview, assets);
					}
				} catch (err) {
					console.error('[Extension] ❌ Error loading assets:', err);
				}
				// Always send saved layout (or null for default)
				if (this.webview) {
					console.log('[Extension] Sending saved layout');
					sendLayout(this.context, this.webview, this.defaultLayout);
					this.startLayoutWatcher();
				}
			})();
		} else {
			// No project dir — still try to load floor/wall tiles, then send saved layout
			await (async () => {
				try {
					const ep = this.extensionUri.fsPath;
					const bundled = path.join(ep, 'dist', 'assets');
					if (fs.existsSync(bundled)) {
						const distRoot = path.join(ep, 'dist');
						this.defaultLayout = loadDefaultLayout(distRoot);
						const cs = await loadCharacterSprites(distRoot);
						if (cs && this.webview) {
							sendCharacterSpritesToWebview(this.webview, cs);
						}
						const ft = await loadFloorTiles(distRoot);
						if (ft && this.webview) {
							sendFloorTilesToWebview(this.webview, ft);
						}
						const wt = await loadWallTiles(distRoot);
						if (wt && this.webview) {
							sendWallTilesToWebview(this.webview, wt);
						}
					}
				} catch { /* ignore */ }
				if (this.webview) {
					sendLayout(this.context, this.webview, this.defaultLayout);
					this.startLayoutWatcher();
				}
			})();
		}
		await this.controller.hydrateAll().catch((error) => {
			this.output.appendLine(`[Open Pixel Agents] Failed to fetch initial OpenCode session statuses: ${String(error)}`);
		});
		this.startRuntimeEvents();
	}

	private startRuntimeEvents(): void {
		if (this.runtimeEvents) {
			return;
		}
		this.runtimeEvents = this.runtime.subscribeToEvents(
			(event) => {
				const tracked = this.controller.handleEvent(event);
				if (tracked) {
					this.bridgeEvents.fire({ type: 'runtime', ...tracked, event });
					if (event.payload.type === 'session.deleted') {
						const agent = this.agents.get(tracked.agentId);
						if (agent?.sessionId === tracked.sessionId) {
							this.removeAgentUi(agent.id, true);
							agent.terminalRef.dispose();
							this.bridgeEvents.fire({ type: 'closed', agentId: agent.id, sessionId: tracked.sessionId });
						}
					}
				}
			},
			(error) => {
				this.output.appendLine(`[Open Pixel Agents] OpenCode event stream error: ${String(error)}`);
			},
		);
	}

	/** Export current saved layout to webview-ui/public/assets/default-layout.json (dev utility) */
	exportDefaultLayout(): void {
		const layout = readLayoutFromFile();
		if (!layout) {
			vscode.window.showWarningMessage('Open Pixel Agents: No saved layout found.');
			return;
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			vscode.window.showErrorMessage('Open Pixel Agents: No workspace folder found.');
			return;
		}
		const targetPath = path.join(workspaceRoot, 'webview-ui', 'public', 'assets', 'default-layout.json');
		const json = JSON.stringify(layout, null, 2);
		fs.writeFileSync(targetPath, json, 'utf-8');
		vscode.window.showInformationMessage(`Open Pixel Agents: Default layout exported to ${targetPath}`);
	}

	private startLayoutWatcher(): void {
		if (this.layoutWatcher) {
			return;
		}
		this.layoutWatcher = watchLayoutFile((layout) => {
			console.log('[Open Pixel Agents] External layout change — pushing to webview');
			this.webview?.postMessage({ type: 'layoutLoaded', layout });
		});
	}

	dispose() {
		for (const listener of this.viewListeners.splice(0)) { listener.dispose(); }
		this.isDisposing = true;
			this.rejectReady(new Error('Open Pixel Agents: The office is shutting down.'));
			for (const pending of this.pendingSnapshots.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error('Open Pixel Agents: The office is shutting down.'));
			}
			this.pendingSnapshots.clear();
			for (const pending of this.pendingCapacity.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error('The office is shutting down.'));
			}
			this.pendingCapacity.clear();
			this.bridgeEvents.dispose();
		this.runtimeEvents?.dispose();
		this.runtimeEvents = null;
		this.runtimeController?.dispose();
		this.runtimeController = null;
		this.output.dispose();
		this.layoutWatcher?.dispose();
		this.layoutWatcher = null;
		for (const id of [...this.agents.keys()]) {
			const agent = this.agents.get(id);
			removeAgent(
				id, this.agents,
				this.waitingTimers, this.permissionTimers,
				this.persistAgents,
				false,
			);
			if (agent?.readOnly) {
				agent.terminalRef.dispose();
			}
		}
	}
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
	const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

	let html = fs.readFileSync(indexPath, 'utf-8');

	html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match: string, attr: string, filePath: string) => {
		const fileUri = vscode.Uri.joinPath(distPath, filePath);
		const webviewUri = webview.asWebviewUri(fileUri);
		return `${attr}="${webviewUri}"`;
	});

	return html;
}
