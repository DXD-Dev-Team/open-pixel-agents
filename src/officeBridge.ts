import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { getOpenCodeExecutable, getOpenCodeEnvironment } from './opencodeClient.js';
import type { RuntimeGlobalEvent } from './runtime/runtimeAdapter.js';

export type OfficeStatus = 'needs input' | 'failed' | 'working' | 'reading' | 'waiting' | 'done' | 'idle';
export type OfficeProviderKind = 'claude' | 'codex' | 'grok';
export type OfficeRole = 'builder' | 'security-reviewer' | 'verifier' | 'manager';
export type OfficeManagerScope = 'all' | 'builder' | 'security-reviewer' | 'verifier';
export type OfficeManagerMode = 'auto' | 'human-approval';
export type OfficeAgentActionName = 'open' | 'send' | 'start' | 'restart' | 'stop' | 'close' | 'role' | 'manager-mode' | 'assign-team' | 'approve' | 'reject' | 'attention' | 'sign-in' | 'change-account' | 'add-account' | 'manager-repos' | 'manager-scope' | 'thread-select' | 'thread-new' | 'thread-rename' | 'thread-archive' | 'thread-more' | 'thread-fork' | 'thread-compact' | 'reset-usage' | 'usage-refresh' | 'credit-reset' | 'worker-model' | 'worker-mode';

export interface OfficeAgentAction {
	type: 'agent-action';
	agentId: number;
	requestId: string;
	viewId?: string;
	action: OfficeAgentActionName;
	text?: string;
	role?: OfficeRole;
	mode?: OfficeManagerMode;
	teamIds?: string[];
	proposalId?: string;
	accountId?: string;
	kind?: OfficeProviderKind;
	repoIds?: string[];
	scopeRole?: OfficeManagerScope;
	threadId?: string;
	title?: string;
	before?: string;
	modelId?: string;
	workerMode?: 'fast' | 'reasoning';
	resetTicket?: string;
	confirmed?: boolean;
	repoId?: string;
}

export interface OfficeRepository { id: string; name: string }

export interface OfficePanelAccount { id: string; name: string; kind: OfficeProviderKind; connected: boolean; authType?: string; loginName?: string }

export interface OfficeThread { id: string; workerId: string; repoId: string; title: string; kind: 'root' | 'child'; parentThreadId?: string; accountId: string; providerId: string; modelId: string; mode: 'fast' | 'reasoning'; createdAt: number; updatedAt: number; archived: boolean; unavailable?: boolean; recoveredUnknown?: boolean }
export interface OfficePanelCapabilities { threads?: boolean; usageReset?: boolean; threadFork?: boolean; threadCompact?: boolean; creditReset?: boolean }

export interface OfficeAgentPanelState {
	viewId?: string;
	worker: { id: string; name: string; role: OfficeRole; status: OfficeStatus; started: boolean; repoId?: string; repoName?: string; providerKind?: OfficeProviderKind; modelId?: string; accountId?: string; mode?: 'fast' | 'reasoning' };
	modelOptions?: Array<{ id: string; name: string }>;
	capabilities?: OfficePanelCapabilities;
	threads?: { items: OfficeThread[]; selectedId?: string };
	chatThreadId?: string;
	chatPage?: { hasMore: boolean; before?: string; older?: boolean };
	accountQuota?: { available: boolean; reason?: string; accountName?: string; limits?: Array<{ id: string; name?: string; usedPercent: number; windowDurationMins: number; resetsAt: number }>; reset?: { availableCount?: number; ticket?: string } };
	usage?: { tokens: number; estimatedCost?: number; resettable: boolean; totalTokens?: number; threadTokens?: number; byRepository?: Array<{ id: string; tokens: number; estimatedCost?: number }> };
	chat: Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: number }>;
	pending: boolean;
	busy: boolean;
	error?: string;
	account?: OfficePanelAccount;
	accounts?: OfficePanelAccount[];
	repositories?: OfficeRepository[];
	attention?: Array<{ id: string; kind: 'permission' | 'question'; ask: string }>;
	manager?: { mode: OfficeManagerMode; scopeRole?: OfficeManagerScope; repoIds?: string[]; teamIds: string[]; team: Array<{ id: string; name: string; role: OfficeRole; repoId?: string; repoName?: string }>; paused?: boolean; triaging?: boolean; coordinating?: boolean; executing?: boolean; error?: string;
		proposals: Array<{ id: string; text: string; workerId?: string; workerName?: string; status: 'pending' | 'approved' | 'rejected' | 'running' | 'done' | 'failed'; error?: string }> };
}

export interface OfficePricing {
	providerId: string;
	modelId: string;
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** Account ids and catalog prices only. Credentials never belong here. */
export interface OfficeWorkerMetadata {
	workerId?: string;
	name?: string;
	providerKind?: OfficeProviderKind;
	providerId?: string;
	modelId?: string;
	accountId?: string;
	status?: OfficeStatus;
	needsInput?: boolean;
	usageTokens?: number;
	estimatedCost?: number;
	pricing?: OfficePricing;
	role?: OfficeRole;
	managerForRole?: OfficeManagerScope;
	repoId?: string;
	repoName?: string;
	managerRepoIds?: string[];
	managerPaused?: boolean;
	activeRepoId?: string;
	activeRepoName?: string;
}

export interface OfficeSpeech {
	text: string;
	expiresAt: number;
	source: 'assistant' | 'task';
}

export interface OfficeLabel {
	name: string;
	status: OfficeStatus;
	providerKind?: OfficeProviderKind;
	usageTokens?: number;
	estimatedCost?: number;
	needsInput: boolean;
	managed?: boolean;
	speech?: OfficeSpeech;
	role?: OfficeRole;
	managerForRole?: OfficeManagerScope;
	repoId?: string;
	repoName?: string;
	managerRepoIds?: string[];
	managerPaused?: boolean;
	activeRepoId?: string;
	activeRepoName?: string;
}

export interface OfficeAgentInput {
	displayName: string;
	cwd?: string;
	metadata?: OfficeWorkerMetadata;
}

export interface OfficeServerConnection {
	port: number;
	url: string;
}

export interface OfficeAgentBinding extends OfficeServerConnection {
	agentId: number;
	sessionId: string;
	displayName: string;
	cwd: string;
	readOnly: true;
	metadata?: OfficeWorkerMetadata;
}

export type OfficeBridgeEvent =
	| OfficeAgentAction
	| { type: 'runtime'; agentId: number; sessionId: string; event: RuntimeGlobalEvent }
	| { type: 'changed'; agentId: number; binding: OfficeAgentBinding }
	| { type: 'closed'; agentId: number; sessionId: string };

export interface OfficeVisualSnapshot {
	characters: Array<{ id: number; isSubagent: boolean; label?: OfficeLabel; seatId?: string | null; atSeat?: boolean; computerDesk?: boolean }>;
	png: string;
}

export interface OfficeBridgeApi {
	readonly version: 1;
	readonly runtimeOwnershipVersion: 1;
	readonly threadHistoryVersion: 1;
	exportOfficeLayout?(): Promise<{ layout: Record<string, unknown> | null; seats: Record<string, unknown> }>;
	configureRuntime(options: { executable: string; env: Record<string, string> }): void;
	shutdownRuntime(): Promise<void>;
	getServer(): Promise<OfficeServerConnection>;
	createAgent(input: OfficeAgentInput): Promise<OfficeAgentBinding>;
	attachAgent(input: OfficeAgentInput & { sessionId: string; agentId?: number }): Promise<OfficeAgentBinding>;
	detachAgent(agentId: number, expectedSessionId?: string): Promise<void>;
	listAgents(): Promise<OfficeAgentBinding[]>;
	focusAgent(agentId: number): Promise<void>;
	closeAgent(agentId: number): Promise<void>;
	setMetadata(agentId: number, metadata: OfficeWorkerMetadata): Promise<OfficeAgentBinding>;
	setAgentPanelState(agentId: number, state: unknown): Promise<void>;
	openAgentPanel(agentId: number): Promise<void>;
	setRepositories(repositories: OfficeRepository[]): Promise<void>;
	openBrowserOffice(): Promise<string>;
	closeBrowserOffice(): Promise<void>;
	setDeskState(state: unknown): void;
	readonly onDidEvent: vscode.Event<OfficeBridgeEvent>;
	getVisualSnapshot(): Promise<OfficeVisualSnapshot>;
}

/**
 * macOS script allocates the actual TTY required by `opencode attach`. The VS
 * Code terminal only receives its output: input is deliberately never written
 * to the child, including Terminal.sendText calls from another extension.
 */
export function createReadOnlyAttachTerminal(name: string, sessionId: string, cwd: string, port: number): vscode.Terminal {
	if (process.platform !== 'darwin') {
		throw new Error('Open Pixel Agents: The read-only attach spike currently requires macOS.');
	}
	const writes = new vscode.EventEmitter<string>();
	let child: ChildProcess | undefined;
	let closed = false;
	const pty: vscode.Pseudoterminal = {
		onDidWrite: writes.event,
		open(dimensions) {
			if (closed || child) {
				return;
			}
			writes.fire('Read-only OpenCode session. Send prompts through Office Desk.\r\n');
			const executable = getOpenCodeExecutable();
			child = spawn('/usr/bin/script', [
				'-q', '/dev/null', executable, 'attach', `http://127.0.0.1:${port}`,
				'--session', sessionId, '--dir', cwd,
			], {
				cwd,
				detached: true,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: {
					...getOpenCodeEnvironment(),
					TERM: 'xterm-256color',
					COLUMNS: String(dimensions?.columns ?? 120),
					LINES: String(dimensions?.rows ?? 30),
				},
			});
			child.stdout?.on('data', (data: Buffer) => {
				if (!closed) {
					writes.fire(data.toString('utf8'));
				}
			});
			child.stderr?.on('data', (data: Buffer) => {
				if (!closed) {
					writes.fire(data.toString('utf8'));
				}
			});
			child.on('error', () => {
				if (!closed) {
					writes.fire('\r\nUnable to launch the read-only OpenCode attachment.\r\n');
				}
			});
			child.on('exit', () => {
				if (!closed) {
					writes.fire('\r\nOpenCode attachment ended. The office session is still registered.\r\n');
				}
			});
		},
		handleInput() {
			// Never forward keyboard, pasted input, or Terminal.sendText to OpenCode.
		},
		close() {
			closed = true;
			if (child?.pid && child.exitCode === null && child.signalCode === null) {
				try {
					process.kill(-child.pid, 'SIGTERM');
				} catch {
					child.kill();
				}
			}
			writes.dispose();
		},
	};
	return vscode.window.createTerminal({ name, pty, isTransient: true });
}
