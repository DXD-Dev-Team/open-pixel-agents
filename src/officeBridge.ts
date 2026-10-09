import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { getOpenCodeExecutable, getOpenCodeEnvironment } from './opencodeClient.js';
import type { RuntimeGlobalEvent } from './runtime/runtimeAdapter.js';

export type OfficeStatus = 'needs input' | 'failed' | 'working' | 'reading' | 'waiting' | 'done' | 'idle';
export type OfficeProviderKind = 'claude' | 'codex' | 'grok';

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
	| { type: 'runtime'; agentId: number; sessionId: string; event: RuntimeGlobalEvent }
	| { type: 'changed'; agentId: number; binding: OfficeAgentBinding }
	| { type: 'closed'; agentId: number; sessionId: string };

export interface OfficeVisualSnapshot {
	characters: Array<{ id: number; isSubagent: boolean; label?: OfficeLabel; seatId?: string | null; atSeat?: boolean; computerDesk?: boolean }>;
	png: string;
}

export interface OfficeBridgeApi {
	readonly version: 1;
	configureRuntime(options: { executable: string; env: Record<string, string> }): void;
	shutdownRuntime(): Promise<void>;
	getServer(): Promise<OfficeServerConnection>;
	createAgent(input: OfficeAgentInput): Promise<OfficeAgentBinding>;
	listAgents(): Promise<OfficeAgentBinding[]>;
	focusAgent(agentId: number): Promise<void>;
	closeAgent(agentId: number): Promise<void>;
	setMetadata(agentId: number, metadata: OfficeWorkerMetadata): Promise<OfficeAgentBinding>;
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
