import type * as vscode from 'vscode';

export interface RuntimeSession {
	id: string;
	title: string;
	directory: string;
	parentID?: string;
	projectID?: string;
	workspaceID?: string;
}

export interface RuntimeSessionStatus {
	type: 'idle' | 'busy' | 'retry';
	attempt?: number;
	message?: string;
	next?: number;
}

export interface RuntimeMessageInfo {
	id: string;
	sessionID: string;
	role: 'user' | 'assistant';
	time: { created: number; completed?: number };
	parentID?: string;
	error?: unknown;
}

export interface RuntimePart {
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

export interface RuntimeMessage {
	info: RuntimeMessageInfo;
	parts: RuntimePart[];
}

export interface RuntimeGlobalEvent {
	directory: string;
	payload: {
		type: string;
		properties: Record<string, unknown>;
	};
}

export interface RuntimeChildSnapshot {
	info: RuntimeSession;
	status?: RuntimeSessionStatus;
	messages: RuntimeMessage[];
}

export interface RuntimeSessionSnapshot {
	sessionId: string;
	status?: RuntimeSessionStatus;
	messages: RuntimeMessage[];
	children: RuntimeChildSnapshot[];
}

export interface RuntimeAdapter {
	readonly id: string;
	ensureServer(cwd: string, output?: vscode.OutputChannel, preferredPort?: number): Promise<void>;
	getServerPort(): number | null;
	createSession(title?: string): Promise<RuntimeSession>;
	getSession(sessionId: string): Promise<RuntimeSession>;
	deleteSession(sessionId: string): Promise<void>;
	buildAttachCommand(sessionId: string, cwd?: string): string;
	subscribeToEvents(
		onEvent: (event: RuntimeGlobalEvent) => void,
		onError?: (error: unknown) => void,
	): { dispose(): void };
	getSessionStatuses(): Promise<Record<string, RuntimeSessionStatus>>;
	getSessionMessages(sessionId: string): Promise<RuntimeMessage[]>;
	getSessionChildren(sessionId: string): Promise<RuntimeSession[]>;
	getSessionSnapshot(sessionId: string): Promise<RuntimeSessionSnapshot>;
	getPendingInputEvents?(): Promise<RuntimeGlobalEvent[]>;
}
