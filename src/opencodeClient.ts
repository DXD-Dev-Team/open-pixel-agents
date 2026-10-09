import * as vscode from 'vscode';
import * as net from 'net';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { OFFICE_BRIDGE_READY_TIMEOUT_MS } from './constants.js';

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
let runtimeOptions: { executable: string; env: Record<string, string> } | undefined;
let managedServerProcess: ChildProcess | undefined;
let runtimeConfigured: (() => void) | undefined;
const runtimeConfigurationReady = new Promise<void>(resolve => { runtimeConfigured = resolve; });
const runtimeLifetime = new AbortController();
let runtimeShutdownTask: Promise<void> | undefined;

function assertRuntimeRunning(): void {
	if (runtimeLifetime.signal.aborted) {
		throw new Error('The office runtime is shutting down. Reload this window to reconnect.');
	}
}

export function configureOpenCodeRuntime(options: { executable: string; env: Record<string, string> }): void {
	assertRuntimeRunning();
	if (resolvedServerPort !== null || serverStartingPromise) {
		throw new Error('Reload this window before enabling Office Desk; its runtime must be configured before the office starts.');
	}
	if (!options.executable || options.executable.includes('\0')) {
		throw new Error('An OpenCode executable is required.');
	}
	runtimeOptions = { executable: options.executable, env: { ...options.env } };
	runtimeConfigured?.();
}

export function getOpenCodeEnvironment(): NodeJS.ProcessEnv {
	if (!runtimeOptions) {
		const environment = { ...process.env };
		delete environment.OFFICE_RUNTIME_TEST_CODEX_URL;
		delete environment.OFFICE_RUNTIME_TEST_PROVIDER_ORIGIN;
		return environment;
	}
	const base: NodeJS.ProcessEnv = {};
	for (const name of ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TMPDIR']) {
		if (process.env[name]) { base[name] = process.env[name]; }
	}
	return { ...base, ...runtimeOptions.env };
}

export function isOfficeDeskManaged(): boolean {
	return runtimeOptions?.env.OFFICE_DESK_MANAGED === '1';
}

export function getOpenCodeExecutable(): string {
	return runtimeOptions?.executable ?? (process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
}

function authenticatedHeaders(initial?: RequestInit['headers']): Headers {
	const headers = new Headers(initial);
	const environment = getOpenCodeEnvironment();
	const password = environment.OPENCODE_SERVER_PASSWORD;
	if (password) {
		const username = environment.OPENCODE_SERVER_USERNAME || 'opencode';
		headers.set('authorization', `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
	}
	return headers;
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
	return `${getOpenCodeExecutable()} serve --hostname ${OPENCODE_SERVER_HOST} --port ${port}`;
}

function findServerTerminalByPort(port: number): vscode.Terminal | undefined {
	return vscode.window.terminals.find((terminal) => terminal.name === getServerTerminalName(port));
}

function ensureOpenCodeServerTerminal(cwd: string, port: number, output?: vscode.OutputChannel): vscode.Terminal {
	assertRuntimeRunning();
	if (serverTerminal) {
		return serverTerminal;
	}

	const existing = findServerTerminalByPort(port);
	if (existing) {
		serverTerminal = existing;
		return existing;
	}

	let terminal: vscode.Terminal;
	if (runtimeOptions) {
		const writes = new vscode.EventEmitter<string>();
		let child: ChildProcess | undefined;
		let closed = false;
		terminal = vscode.window.createTerminal({
			name: getServerTerminalName(port),
			isTransient: true,
			pty: {
				onDidWrite: writes.event,
				open() {
					if (closed || child || runtimeLifetime.signal.aborted) { return; }
					child = spawn(getOpenCodeExecutable(), ['serve', '--hostname', OPENCODE_SERVER_HOST, '--port', String(port)], {
						cwd, env: getOpenCodeEnvironment(), stdio: ['ignore', 'pipe', 'pipe'],
					});
					managedServerProcess = child;
					// Runtime logs can contain provider errors or asks. Keep this terminal credential-free.
					child.stdout?.on('data', () => undefined);
					child.stderr?.on('data', () => undefined);
					writes.fire(`Office Desk runtime: ${getServerUrl(port)}\r\n`);
					child.on('error', () => writes.fire('Unable to launch OpenCode. Check its configured executable.\r\n'));
					child.on('exit', () => { if (!closed) { writes.fire('Office runtime ended. Reload to reconnect.\r\n'); } });
				},
				handleInput() {},
				close() { closed = true; child?.kill(); writes.dispose(); },
			},
		});
	} else {
		terminal = vscode.window.createTerminal({ name: getServerTerminalName(port), cwd, hideFromUser: false });
	}
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
		const response = await fetch(`${getServerUrl(port)}/global/health`, {
			headers: authenticatedHeaders(),
			signal: AbortSignal.timeout(3000),
		});
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
			assertRuntimeRunning();
			resolvedServerPort = port;
			serverTerminal = terminal;
			output?.appendLine(`[Open Pixel Agents] Reusing window-local OpenCode server port ${port} from terminal "${terminal.name}"`);
			return port;
		}
	}

	for (let offset = 0; offset < OPENCODE_SERVER_PORT_SCAN_LIMIT; offset += 1) {
		const port = OPENCODE_SERVER_PORT + offset;
		if (await isPortAvailable(port)) {
			assertRuntimeRunning();
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
			assertRuntimeRunning();
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
					assertRuntimeRunning();
					resolvedServerPort = port;
					serverTerminal = terminal;
					output?.appendLine(`[Open Pixel Agents] Reusing window-local OpenCode server port ${port} from terminal "${terminal.name}"`);
					return port;
				}
				continue;
			}
			if (await isPortAvailable(port)) {
				assertRuntimeRunning();
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
	const headers = authenticatedHeaders(init?.headers);
	headers.set('content-type', 'application/json');
	const response = await fetch(`${getServerUrl()}${pathname}`, {
		...init,
		headers,
	});
	if (!response.ok) {
		throw new Error(`OpenCode request failed: ${response.status} ${response.statusText}`);
	}
	return response.json() as Promise<T>;
}

async function fetchVoid(pathname: string, init?: RequestInit): Promise<void> {
	const response = await fetch(`${getServerUrl()}${pathname}`, {
		...init,
		headers: authenticatedHeaders(init?.headers),
	});
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
	assertRuntimeRunning();
	// A restored office view can open before its companion finishes activation.
	// Wait for configuration instead of starting an unisolated server first.
	if (!runtimeOptions && vscode.extensions?.getExtension('dxd-dev-team.office-desk')) {
		await Promise.race([
			runtimeConfigurationReady,
			delay(OFFICE_BRIDGE_READY_TIMEOUT_MS, runtimeLifetime.signal).then(() => { throw new Error('Office Desk did not configure its runtime. Open Office Desk to inspect the connection error.'); }),
		]);
	}
	assertRuntimeRunning();
	const port = await resolveOpenCodeServerPortWithPreference(preferredPort, output);
	assertRuntimeRunning();
	const healthy = await isOpenCodeServerHealthy();
	assertRuntimeRunning();
	if (healthy) {
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
			if (!runtimeOptions) { terminal.sendText(getOpenCodeServerCommand(port), true); }
		} catch (error) {
			output?.appendLine(`[Open Pixel Agents] Failed to launch OpenCode server terminal command: ${String(error)}`);
			serverStartingPromise = null;
			throw error;
		}

		output?.appendLine(`[Open Pixel Agents] Waiting for OpenCode server readiness (timeout ${Math.round((SERVER_RETRY_COUNT * SERVER_RETRY_DELAY_MS) / 1000)}s)`);
		for (let i = 0; i < SERVER_RETRY_COUNT; i += 1) {
			assertRuntimeRunning();
			if (await isOpenCodeServerHealthy()) {
				assertRuntimeRunning();
				serverStartingPromise = null;
				output?.appendLine('[Open Pixel Agents] OpenCode server is ready');
				return;
			}
			assertRuntimeRunning();
			await delay(SERVER_RETRY_DELAY_MS, runtimeLifetime.signal);
		}
		serverStartingPromise = null;
		throw new Error('Timed out waiting for OpenCode server to become ready');
	})();
	return serverStartingPromise;
}

export function shutdownOpenCodeRuntime(): Promise<void> {
	runtimeLifetime.abort();
	runtimeShutdownTask ??= (async () => {
		if (!runtimeOptions) { return; }
		await serverStartingPromise?.catch(() => undefined);
		const child = managedServerProcess;
		const terminal = serverTerminal;
		serverTerminal = null;
		resolvedServerPort = null;
		terminal?.dispose();
		if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) { return; }
		await new Promise<void>((resolve, reject) => {
			const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
			const deadline = setTimeout(() => { cleanup(); reject(new Error('The office runtime did not stop. Close this VS Code window before reopening the office.')); }, 5000);
			const cleanup = (): void => { clearTimeout(killTimer); clearTimeout(deadline); child.removeListener('exit', done); };
			const done = (): void => { cleanup(); resolve(); };
			child.once('exit', done);
			child.kill();
		});
		managedServerProcess = undefined;
	})();
	return runtimeShutdownTask;
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
	const quote = (value: string): string => process.platform === 'win32'
		? `"${value.replace(/"/g, '\\"')}"`
		: `'${value.replace(/'/g, "'\\''")}'`;
	const dirPart = cwd ? ` --dir ${quote(cwd)}` : '';
	return `${getOpenCodeExecutable()} attach ${url} --session ${quote(sessionId)}${dirPart}`;
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
					headers: authenticatedHeaders({ accept: 'text/event-stream' }),
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
