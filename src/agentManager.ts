import * as vscode from 'vscode';
import type { AgentState, PersistedAgent } from './types.js';
import type { RuntimeAdapter } from './runtime/runtimeAdapter.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { TERMINAL_NAME_PREFIX, WORKSPACE_KEY_AGENTS, WORKSPACE_KEY_AGENT_SEATS } from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';

	export function getProjectDirPath(cwd?: string): string | null {
	const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspacePath) {
		return null;
	}
	return workspacePath;
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
): Promise<AgentState | undefined> {
	const idx = nextTerminalIndexRef.current++;
	const cwd = folderPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!cwd) {
		void vscode.window.showErrorMessage('Open Pixel Agents: No workspace folder found for OpenCode.');
		return undefined;
	}

	await runtime.ensureServer(cwd, output);
	const serverPort = runtime.getServerPort() ?? undefined;
	const session = await runtime.createSession(`Pixel Agent ${idx}`);
	const terminal = vscode.window.createTerminal({
		name: `${TERMINAL_NAME_PREFIX} #${idx}`,
		cwd,
	});
	terminal.show(true);
	terminal.sendText(runtime.buildAttachCommand(session.id, cwd));

	const projectDir = getProjectDirPath(cwd);
	if (!projectDir) {
		console.log(`[Open Pixel Agents] No project dir, cannot track agent`);
		return undefined;
	}

	const id = nextAgentIdRef.current++;
	const agent: AgentState = {
		id,
		terminalRef: terminal,
		sessionId: session.id,
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
	persistAgents();
}

export function persistAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
): void {
	const persisted: PersistedAgent[] = [];
	for (const agent of agents.values()) {
		persisted.push({
			id: agent.id,
			terminalName: agent.terminalRef.name,
			sessionId: agent.sessionId,
			projectDir: agent.projectDir,
			serverPort: agent.serverPort,
		});
	}
	context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
	context: vscode.ExtensionContext,
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	doPersist: () => void,
): void {
	const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
	if (persisted.length === 0) {
		return;
	}

	const liveTerminals = vscode.window.terminals;
	let maxId = 0;
	let maxIdx = 0;

	for (const p of persisted) {
		const terminal = liveTerminals.find(t => t.name === p.terminalName);
		if (!terminal) {
			continue;
		}

		const agent: AgentState = {
			id: p.id,
			terminalRef: terminal,
			sessionId: p.sessionId,
			projectDir: p.projectDir,
			serverPort: p.serverPort,
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
		};

		agents.set(p.id, agent);
		console.log(`[Open Pixel Agents] Restored agent ${p.id} → terminal "${p.terminalName}" session=${p.sessionId ?? 'unknown'}`);

		if (p.id > maxId) {
			maxId = p.id;
		}
		// Extract terminal index from name like "OpenCode #3"
		const match = p.terminalName.match(/#(\d+)$/);
		if (match) {
			const idx = parseInt(match[1], 10);
			if (idx > maxIdx) {
				maxIdx = idx;
			}
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
