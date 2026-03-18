import * as vscode from 'vscode';

export interface OpenCodeEventPayload {
	type: string;
	properties: Record<string, unknown>;
}

export interface OpenCodeGlobalEvent {
	directory: string;
	payload: OpenCodeEventPayload;
}

export interface OpenCodeSession {
	id: string;
	title: string;
	directory: string;
	parentID?: string;
	projectID?: string;
	workspaceID?: string;
}

export interface OpenCodeSessionStatus {
	type: 'idle' | 'busy' | 'retry';
	attempt?: number;
	message?: string;
	next?: number;
}

export interface OpenCodeMessageInfo {
	id: string;
	sessionID: string;
	role: 'user' | 'assistant';
	time: { created: number; completed?: number };
	parentID?: string;
	error?: unknown;
}

export interface OpenCodePart {
	id: string;
	sessionID: string;
	messageID: string;
	type: string;
	callID?: string;
	tool?: string;
	description?: string;
	prompt?: string;
	agent?: string;
	state?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface OpenCodeMessageWithParts {
	info: OpenCodeMessageInfo;
	parts: OpenCodePart[];
}

const OPENCODE_SERVER_HOST = '127.0.0.1';
const OPENCODE_SERVER_PORT = 18083;
const OPENCODE_SERVER_URL = `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`;
const SERVER_RETRY_COUNT = 60;
const SERVER_RETRY_DELAY_MS = 500;
const SSE_RECONNECT_DELAY_MS = 1500;
const OPENCODE_SERVER_TERMINAL_NAME = 'OpenCode Server';

let serverStartingPromise: Promise<void> | null = null;
let serverTerminal: vscode.Terminal | null = null;

function getOpenCodeExecutable(): string {
	return process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
}

function getOpenCodeServerCommand(): string {
	return `${getOpenCodeExecutable()} --hostname ${OPENCODE_SERVER_HOST} --port ${OPENCODE_SERVER_PORT}`;
}

function ensureOpenCodeServerTerminal(cwd: string, output?: vscode.OutputChannel): vscode.Terminal {
	if (serverTerminal) {
		return serverTerminal;
	}

	const existing = vscode.window.terminals.find((terminal) => terminal.name === OPENCODE_SERVER_TERMINAL_NAME);
	if (existing) {
		serverTerminal = existing;
		return existing;
	}

	const terminal = vscode.window.createTerminal({
		name: OPENCODE_SERVER_TERMINAL_NAME,
		cwd,
		hideFromUser: false,
	});
	serverTerminal = terminal;
	output?.appendLine(`[Open Pixel Agents] Created VS Code terminal "${OPENCODE_SERVER_TERMINAL_NAME}" for OpenCode server startup`);
	return terminal;
}

function getServerUrl(): string {
	return OPENCODE_SERVER_URL;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('aborted'));
		};
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				reject(new Error('aborted'));
				return;
			}
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
}

async function fetchJson<T>(pathname: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${getServerUrl()}${pathname}`, {
		...init,
		headers: {
			'content-type': 'application/json',
			...(init?.headers || {}),
		},
	});
	if (!response.ok) {
		throw new Error(`OpenCode request failed: ${response.status} ${response.statusText}`);
	}
	return response.json() as Promise<T>;
}

export async function isOpenCodeServerHealthy(): Promise<boolean> {
	try {
		const response = await fetch(`${getServerUrl()}/global/health`);
		return response.ok;
	} catch {
		return false;
	}
}

export async function ensureOpenCodeServer(cwd: string, output?: vscode.OutputChannel): Promise<void> {
	if (await isOpenCodeServerHealthy()) {
		return;
	}
	if (serverStartingPromise) {
		return serverStartingPromise;
	}
	serverStartingPromise = (async () => {
		output?.appendLine(`[Open Pixel Agents] Starting OpenCode server at ${getServerUrl()}`);
		try {
			const terminal = ensureOpenCodeServerTerminal(cwd, output);
			terminal.show(false);
			terminal.sendText(getOpenCodeServerCommand(), true);
		} catch (error) {
			output?.appendLine(`[Open Pixel Agents] Failed to launch OpenCode server terminal command: ${String(error)}`);
			serverStartingPromise = null;
			throw error;
		}

		output?.appendLine(`[Open Pixel Agents] Waiting for OpenCode server readiness (timeout ${Math.round((SERVER_RETRY_COUNT * SERVER_RETRY_DELAY_MS) / 1000)}s)`);
		for (let i = 0; i < SERVER_RETRY_COUNT; i += 1) {
			if (await isOpenCodeServerHealthy()) {
				serverStartingPromise = null;
				output?.appendLine('[Open Pixel Agents] OpenCode server is ready');
				return;
			}
			await delay(SERVER_RETRY_DELAY_MS);
		}
		serverStartingPromise = null;
		throw new Error('Timed out waiting for OpenCode server to become ready');
	})();
	return serverStartingPromise;
}

export function resetOpenCodeServerTerminal(closedTerminal: vscode.Terminal): void {
	if (serverTerminal === closedTerminal) {
		serverTerminal = null;
	}
}

export async function createOpenCodeSession(title?: string): Promise<OpenCodeSession> {
	return fetchJson<OpenCodeSession>('/session', {
		method: 'POST',
		body: JSON.stringify(title ? { title } : {}),
	});
}

export async function getOpenCodeSessionStatuses(): Promise<Record<string, OpenCodeSessionStatus>> {
	return fetchJson<Record<string, OpenCodeSessionStatus>>('/session/status');
}

export async function getOpenCodeSessionMessages(sessionId: string): Promise<OpenCodeMessageWithParts[]> {
	return fetchJson<OpenCodeMessageWithParts[]>(`/session/${sessionId}/message`);
}

export async function getOpenCodeSessionChildren(sessionId: string): Promise<OpenCodeSession[]> {
	return fetchJson<OpenCodeSession[]>(`/session/${sessionId}/children`);
}

export function getOpenCodeAttachCommand(sessionId: string, cwd?: string): string {
	const url = getServerUrl();
	const dirPart = cwd ? ` --dir "${cwd.replace(/"/g, '\\"')}"` : '';
	return `opencode attach ${url} --session ${sessionId}${dirPart}`;
}

export function subscribeToOpenCodeEvents(
	onEvent: (event: OpenCodeGlobalEvent) => void,
	onError?: (error: unknown) => void,
): { dispose: () => void } {
	const controller = new AbortController();
	const decoder = new TextDecoder();

	const run = async (): Promise<void> => {
		while (!controller.signal.aborted) {
			try {
				const response = await fetch(`${getServerUrl()}/global/event`, {
					signal: controller.signal,
					headers: { accept: 'text/event-stream' },
				});
				if (!response.ok || !response.body) {
					throw new Error(`OpenCode SSE failed: ${response.status} ${response.statusText}`);
				}

				const reader = response.body.getReader();
				let buffer = '';
				while (!controller.signal.aborted) {
					const next = await reader.read();
					if (next.done) {
						break;
					}
					buffer += decoder.decode(next.value, { stream: true });
					let boundary = buffer.indexOf('\n\n');
					while (boundary !== -1) {
						const rawEvent = buffer.slice(0, boundary);
						buffer = buffer.slice(boundary + 2);
						const dataLines = rawEvent
							.split(/\r?\n/)
							.filter((line) => line.startsWith('data:'))
							.map((line) => line.slice(5).trimStart());
						if (dataLines.length > 0) {
							const data = dataLines.join('\n');
							try {
								onEvent(JSON.parse(data) as OpenCodeGlobalEvent);
							} catch (error) {
								onError?.(error);
							}
						}
						boundary = buffer.indexOf('\n\n');
					}
				}
			} catch (error) {
				if (controller.signal.aborted) {
					return;
				}
				onError?.(error);
				try {
					await delay(SSE_RECONNECT_DELAY_MS, controller.signal);
				} catch {
					return;
				}
			}
		}
	};

	void run();

	return {
		dispose: () => controller.abort(),
	};
}
