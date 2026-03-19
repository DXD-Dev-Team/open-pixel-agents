import * as vscode from 'vscode';
import * as net from 'net';

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
const OPENCODE_SERVER_PORT_SCAN_LIMIT = 100;
const SERVER_RETRY_COUNT = 60;
const SERVER_RETRY_DELAY_MS = 500;
const SSE_RECONNECT_DELAY_MS = 1500;
const OPENCODE_SERVER_TERMINAL_NAME_PREFIX = 'OpenCode Server';

let serverStartingPromise: Promise<void> | null = null;
let serverTerminal: vscode.Terminal | null = null;
let resolvedServerPort: number | null = null;

function getOpenCodeExecutable(): string {
	return process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
}

function getServerTerminalName(port: number): string {
	return `${OPENCODE_SERVER_TERMINAL_NAME_PREFIX} (${port})`;
}

function parseServerTerminalPort(name: string): number | null {
	const match = name.match(/^OpenCode Server \((\d+)\)$/);
	if (!match) {
		return null;
	}
	const port = Number.parseInt(match[1], 10);
	return Number.isFinite(port) ? port : null;
}

function getResolvedServerPort(): number {
	return resolvedServerPort ?? OPENCODE_SERVER_PORT;
}

function getServerUrl(port = getResolvedServerPort()): string {
	return `http://${OPENCODE_SERVER_HOST}:${port}`;
}

function getOpenCodeServerCommand(port: number): string {
	return `${getOpenCodeExecutable()} --hostname ${OPENCODE_SERVER_HOST} --port ${port}`;
}

function findServerTerminalByPort(port: number): vscode.Terminal | undefined {
	return vscode.window.terminals.find((terminal) => terminal.name === getServerTerminalName(port));
}

function ensureOpenCodeServerTerminal(cwd: string, port: number, output?: vscode.OutputChannel): vscode.Terminal {
	if (serverTerminal) {
		return serverTerminal;
	}

	const existing = findServerTerminalByPort(port);
	if (existing) {
		serverTerminal = existing;
		return existing;
	}

	const terminal = vscode.window.createTerminal({
		name: getServerTerminalName(port),
		cwd,
		hideFromUser: false,
	});
	serverTerminal = terminal;
	output?.appendLine(`[Open Pixel Agents] Created VS Code terminal "${getServerTerminalName(port)}" for OpenCode server startup`);
	return terminal;
}

async function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		const cleanup = () => {
			server.removeAllListeners();
		};
		server.once('error', () => {
			cleanup();
			resolve(false);
		});
		server.once('listening', () => {
			server.close(() => {
				cleanup();
				resolve(true);
			});
		});
		server.listen(port, OPENCODE_SERVER_HOST);
	});
}

async function isOpenCodeServerHealthyAt(port: number): Promise<boolean> {
	try {
		const response = await fetch(`${getServerUrl(port)}/global/health`);
		return response.ok;
	} catch {
		return false;
	}
}

async function resolveOpenCodeServerPort(output?: vscode.OutputChannel): Promise<number> {
	if (resolvedServerPort !== null) {
		return resolvedServerPort;
	}

	for (const terminal of vscode.window.terminals) {
		const port = parseServerTerminalPort(terminal.name);
		if (port === null) {
			continue;
		}
		if (await isOpenCodeServerHealthyAt(port) || await isPortAvailable(port)) {
			resolvedServerPort = port;
			serverTerminal = terminal;
			output?.appendLine(`[Open Pixel Agents] Reusing window-local OpenCode server port ${port} from terminal "${terminal.name}"`);
			return port;
		}
	}

	for (let offset = 0; offset < OPENCODE_SERVER_PORT_SCAN_LIMIT; offset += 1) {
		const port = OPENCODE_SERVER_PORT + offset;
		if (await isPortAvailable(port)) {
			resolvedServerPort = port;
			if (port !== OPENCODE_SERVER_PORT) {
				output?.appendLine(`[Open Pixel Agents] OpenCode default port ${OPENCODE_SERVER_PORT} is occupied, using ${port}`);
			}
			return port;
		}
	}

	throw new Error(`Failed to find an available OpenCode server port starting at ${OPENCODE_SERVER_PORT}`);
}

async function resolveOpenCodeServerPortWithPreference(preferredPort: number | undefined, output?: vscode.OutputChannel): Promise<number> {
	if (resolvedServerPort !== null) {
		return resolvedServerPort;
	}

	if (preferredPort !== undefined) {
		const existingTerminal = findServerTerminalByPort(preferredPort);
		if (existingTerminal && (await isOpenCodeServerHealthyAt(preferredPort) || await isPortAvailable(preferredPort))) {
			resolvedServerPort = preferredPort;
			serverTerminal = existingTerminal;
			output?.appendLine(`[Open Pixel Agents] Using preferred OpenCode server port ${preferredPort}`);
			return preferredPort;
		}
		if (!existingTerminal && !(await isPortAvailable(preferredPort))) {
			output?.appendLine(`[Open Pixel Agents] Preferred OpenCode server port ${preferredPort} is occupied by another process, allocating a new window-local port`);
		} else if (existingTerminal) {
			output?.appendLine(`[Open Pixel Agents] Preferred OpenCode server port ${preferredPort} is unavailable, scanning for another port`);
		}

		for (let offset = 0; offset < OPENCODE_SERVER_PORT_SCAN_LIMIT; offset += 1) {
			const port = preferredPort + offset;
			const terminal = findServerTerminalByPort(port);
			if (terminal) {
				if (await isOpenCodeServerHealthyAt(port) || await isPortAvailable(port)) {
					resolvedServerPort = port;
					serverTerminal = terminal;
					output?.appendLine(`[Open Pixel Agents] Reusing window-local OpenCode server port ${port} from terminal "${terminal.name}"`);
					return port;
				}
				continue;
			}
			if (await isPortAvailable(port)) {
				resolvedServerPort = port;
				if (port !== preferredPort) {
					output?.appendLine(`[Open Pixel Agents] Allocated new OpenCode server port ${port} for this window (preferred ${preferredPort} unavailable)`);
				}
				return port;
			}
		}

		throw new Error(`Failed to find an available window-local OpenCode server port starting at ${preferredPort}`);
	}

	return resolveOpenCodeServerPort(output);
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

async function fetchVoid(pathname: string, init?: RequestInit): Promise<void> {
	const response = await fetch(`${getServerUrl()}${pathname}`, init);
	if (!response.ok) {
		throw new Error(`OpenCode request failed: ${response.status} ${response.statusText}`);
	}
}

export async function isOpenCodeServerHealthy(): Promise<boolean> {
	return isOpenCodeServerHealthyAt(getResolvedServerPort());
}

export function getCurrentOpenCodeServerPort(): number | null {
	return resolvedServerPort;
}

export async function ensureOpenCodeServer(cwd: string, output?: vscode.OutputChannel, preferredPort?: number): Promise<void> {
	const port = await resolveOpenCodeServerPortWithPreference(preferredPort, output);
	if (await isOpenCodeServerHealthy()) {
		return;
	}
	if (serverStartingPromise) {
		return serverStartingPromise;
	}
	serverStartingPromise = (async () => {
		output?.appendLine(`[Open Pixel Agents] Starting OpenCode server at ${getServerUrl(port)}`);
		try {
			const terminal = ensureOpenCodeServerTerminal(cwd, port, output);
			terminal.show(false);
			terminal.sendText(getOpenCodeServerCommand(port), true);
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


export function resetOpenCodeServerTerminal(closedTerminal: vscode.Terminal): { wasServerTerminal: boolean; port: number | null } {
	if (serverTerminal === closedTerminal) {
		const port = resolvedServerPort;
		serverTerminal = null;
		resolvedServerPort = null;
		return { wasServerTerminal: true, port };
	}
	return { wasServerTerminal: false, port: null };
}

export async function createOpenCodeSession(title?: string): Promise<OpenCodeSession> {
	return fetchJson<OpenCodeSession>('/session', {
		method: 'POST',
		body: JSON.stringify(title ? { title } : {}),
	});
}

export async function getOpenCodeSession(sessionId: string): Promise<OpenCodeSession> {
	return fetchJson<OpenCodeSession>(`/session/${sessionId}`);
}

export async function deleteOpenCodeSession(sessionId: string): Promise<void> {
	await fetchVoid(`/session/${sessionId}`, { method: 'DELETE' });
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
