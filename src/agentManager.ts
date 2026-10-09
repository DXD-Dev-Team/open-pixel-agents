import * as vscode from 'vscode';
import * as path from 'path';
import type { AgentState, PersistedAgent } from './types.js';
import type { RuntimeAdapter } from './runtime/runtimeAdapter.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { WORKSPACE_KEY_AGENTS, WORKSPACE_KEY_AGENT_SEATS } from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { createReadOnlyAttachTerminal } from './officeBridge.js';

export interface AgentLaunchOptions {
	displayName?: string;
	readOnly?: boolean;
}

export function getProjectDirPath(cwd?: string): string | null {
	const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspacePath) {
		return null;
	}
	return workspacePath;
}

function getProjectName(cwd: string): string {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
	if (workspaceFolder?.name) {
		return workspaceFolder.name;
	}
	return path.basename(cwd);
}

function getAgentSessionTitle(cwd: string, idx: number): string {
	return `Open Pixel Agent - ${getProjectName(cwd)}: ${idx}`;
}

function getAgentTerminalName(cwd: string, idx: number): string {
	return getAgentSessionTitle(cwd, idx);
}

function createAgentState(id: number, terminal: vscode.Terminal, projectDir: string, sessionId: string | undefined, serverPort: number | undefined): AgentState {
	return {
		id,
		terminalRef: terminal,
		sessionId,
		projectDir,
		serverPort,
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
	};
}

export async function launchNewTerminal(
	runtime: RuntimeAdapter,
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	folderPath?: string,
	output?: vscode.OutputChannel,
	options?: AgentLaunchOptions,
): Promise<AgentState | undefined> {
	const idx = nextTerminalIndexRef.current++;
	const cwd = folderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!cwd) {
		void vscode.window.showErrorMessage('Open Pixel Agents: No workspace folder found for OpenCode.');
		return undefined;
	}
	if (options?.readOnly && process.platform !== 'darwin') {
		throw new Error('Open Pixel Agents: The read-only attach spike currently requires macOS.');
	}

	await runtime.ensureServer(cwd, output);
	const serverPort = runtime.getServerPort() ?? undefined;
	const title = getAgentSessionTitle(cwd, idx);
	const session = await runtime.createSession(title);
	let terminal: vscode.Terminal;
	try {
		if (options?.readOnly) {
			if (serverPort === undefined) {
				throw new Error('Open Pixel Agents: The server has no resolved port.');
			}
			terminal = createReadOnlyAttachTerminal(options.displayName || getAgentTerminalName(cwd, idx), session.id, cwd, serverPort);
		} else {
			terminal = vscode.window.createTerminal({ name: getAgentTerminalName(cwd, idx), cwd });
		}
	} catch (error) {
		await runtime.deleteSession(session.id).catch(() => undefined);
		throw error;
	}
	terminal.show(true);
	if (!options?.readOnly) {
		terminal.sendText(runtime.buildAttachCommand(session.id, cwd));
	}

	const projectDir = getProjectDirPath(cwd);
	if (!projectDir) {
		console.log(`[Open Pixel Agents] No project dir, cannot track agent`);
		return undefined;
	}

	const id = nextAgentIdRef.current++;
	const agent = createAgentState(id, terminal, projectDir, session.id, serverPort);
	if (options?.readOnly) {
		agent.readOnly = true;
		agent.displayName = options.displayName;
	}

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();
	console.log(`[Open Pixel Agents] Agent ${id}: created for OpenCode session ${session.id} on terminal ${terminal.name}`);
	webview?.postMessage({ type: 'agentCreated', id });
	return agent;
}

export function removeAgent(
	agentId: number,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	persistAgents: () => void,
	shouldPersist = true,
): void {
	const agent = agents.get(agentId);
	if (!agent) {
		return;
	}

	// Cancel timers
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);

	// Remove from maps
	agents.delete(agentId);
	if (shouldPersist) {
		persistAgents();
	}
}

export function persistAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
): PromiseLike<void> {
	const persisted: PersistedAgent[] = [];
	for (const agent of agents.values()) {
		persisted.push({
			id: agent.id,
			terminalName: agent.terminalRef.name,
			sessionId: agent.sessionId,
			projectDir: agent.projectDir,
			serverPort: agent.serverPort,
			...(agent.readOnly ? { readOnly: true, displayName: agent.displayName } : {}),
		});
	}
	return context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export async function restoreAgents(
	runtime: RuntimeAdapter,
	context: vscode.ExtensionContext,
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	doPersist: () => void,
	output?: vscode.OutputChannel,
): Promise<void> {
	const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
	if (persisted.length === 0) {
		return;
	}

	const liveTerminals = vscode.window.terminals;
	let maxId = 0;
	let maxIdx = 0;

	for (const p of persisted) {
		if (!p.sessionId) {
			output?.appendLine(`[Open Pixel Agents] Skipping persisted agent ${p.id} with no session id`);
			continue;
		}

		try {
			await runtime.getSession(p.sessionId);
		} catch (error) {
			output?.appendLine(`[Open Pixel Agents] Removing stale persisted agent ${p.id}; session ${p.sessionId} is unavailable: ${String(error)}`);
			continue;
		}

		// A managed session must never restore into an ordinary writable shell.
		const existingAgent = agents.get(p.id);
		let terminal = p.readOnly
			? existingAgent?.readOnly && liveTerminals.includes(existingAgent.terminalRef) ? existingAgent.terminalRef : undefined
			: liveTerminals.find(t => t.name === p.terminalName);
		if (!terminal) {
			if (p.readOnly) {
				const port = runtime.getServerPort();
				if (port === null) {
					throw new Error('Open Pixel Agents: The server has no resolved port for restore.');
				}
				terminal = createReadOnlyAttachTerminal(p.terminalName, p.sessionId, p.projectDir, port);
			} else {
				terminal = vscode.window.createTerminal({ name: p.terminalName, cwd: p.projectDir });
				terminal.sendText(runtime.buildAttachCommand(p.sessionId, p.projectDir));
			}
			terminal.show(false);
			output?.appendLine(`[Open Pixel Agents] Reattached persisted agent ${p.id} to session ${p.sessionId}`);
		}

		const agent = createAgentState(p.id, terminal, p.projectDir, p.sessionId, runtime.getServerPort() ?? p.serverPort);
		if (p.readOnly) {
			agent.readOnly = true;
			agent.displayName = p.displayName;
		}

		agents.set(p.id, agent);
		console.log(`[Open Pixel Agents] Restored agent ${p.id} → terminal "${p.terminalName}" session=${p.sessionId ?? 'unknown'}`);

		if (p.id > maxId) {
			maxId = p.id;
		}
		const match = p.terminalName.match(/: (\d+)$/);
		if (match) {
			const idx = parseInt(match[1], 10);
			if (idx > maxIdx) {
				maxIdx = idx;
			}
		}
		if (p.readOnly && p.id > maxIdx) {
			maxIdx = p.id;
		}

	}

	// Advance counters past restored IDs
	if (maxId >= nextAgentIdRef.current) {
		nextAgentIdRef.current = maxId + 1;
	}
	if (maxIdx >= nextTerminalIndexRef.current) {
		nextTerminalIndexRef.current = maxIdx + 1;
	}

	// Re-persist cleaned-up list (removes entries whose terminals are gone)
	doPersist();
	void waitingTimers;
	void permissionTimers;
	void webview;
}

export function sendExistingAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) {
		return;
	}
	const agentIds: number[] = [];
	for (const id of agents.keys()) {
		agentIds.push(id);
	}
	agentIds.sort((a, b) => a - b);

	// Include persisted palette/seatId from separate key
	const agentMeta = context.workspaceState.get<Record<string, { palette?: number; seatId?: string }>>(WORKSPACE_KEY_AGENT_SEATS, {});
	console.log(`[Open Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`);

	webview.postMessage({
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
	});

	sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) {
		return;
	}
	for (const [agentId, agent] of agents) {
		// Re-send active tools
		for (const [toolId, status] of agent.activeToolStatuses) {
			webview.postMessage({
				type: 'agentToolStart',
				id: agentId,
				toolId,
				status,
			});
		}
		// Re-send waiting status
		if (agent.isWaiting) {
			webview.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	}
}

export function sendLayout(
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
	defaultLayout?: Record<string, unknown> | null,
): void {
	if (!webview) {
		return;
	}
	const layout = migrateAndLoadLayout(context, defaultLayout);
	webview.postMessage({
		type: 'layoutLoaded',
		layout,
	});
}
