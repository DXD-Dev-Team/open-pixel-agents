import type * as vscode from 'vscode';
import {
	createOpenCodeSession,
	deleteOpenCodeSession,
	ensureOpenCodeServer,
	getCurrentOpenCodeServerPort,
	getOpenCodeAttachCommand,
	getOpenCodeSession,
	getOpenCodeSessionChildren,
	getOpenCodeSessionMessages,
	getOpenCodeSessionStatuses,
	subscribeToOpenCodeEvents,
} from '../opencodeClient.js';
import type {
	RuntimeAdapter,
	RuntimeGlobalEvent,
	RuntimeMessage,
	RuntimeSession,
	RuntimeSessionSnapshot,
	RuntimeSessionStatus,
} from './runtimeAdapter.js';

export class OpenCodeRuntimeAdapter implements RuntimeAdapter {
	readonly id = 'opencode';

	async ensureServer(cwd: string, output?: vscode.OutputChannel, preferredPort?: number): Promise<void> {
		await ensureOpenCodeServer(cwd, output, preferredPort);
	}

	getServerPort(): number | null {
		return getCurrentOpenCodeServerPort();
	}

	async createSession(title?: string): Promise<RuntimeSession> {
		return createOpenCodeSession(title);
	}

	async getSession(sessionId: string): Promise<RuntimeSession> {
		return getOpenCodeSession(sessionId);
	}

	async deleteSession(sessionId: string): Promise<void> {
		await deleteOpenCodeSession(sessionId);
	}

	buildAttachCommand(sessionId: string, cwd?: string): string {
		return getOpenCodeAttachCommand(sessionId, cwd);
	}

	subscribeToEvents(
		onEvent: (event: RuntimeGlobalEvent) => void,
		onError?: (error: unknown) => void,
	): { dispose(): void } {
		return subscribeToOpenCodeEvents(onEvent, onError);
	}

	async getSessionStatuses(): Promise<Record<string, RuntimeSessionStatus>> {
		return getOpenCodeSessionStatuses();
	}

	async getSessionMessages(sessionId: string): Promise<RuntimeMessage[]> {
		return getOpenCodeSessionMessages(sessionId);
	}

	async getSessionChildren(sessionId: string): Promise<RuntimeSession[]> {
		return getOpenCodeSessionChildren(sessionId);
	}

	async getSessionSnapshot(sessionId: string): Promise<RuntimeSessionSnapshot> {
		const statuses = await this.getSessionStatuses();
		const [messages, childSessions] = await Promise.all([
			this.getSessionMessages(sessionId),
			this.getSessionChildren(sessionId),
		]);
		const children = await Promise.all(childSessions.map(async (child) => ({
			info: child,
			status: statuses[child.id],
			messages: await this.getSessionMessages(child.id),
		})));
		return {
			sessionId,
			status: statuses[sessionId],
			messages,
			children,
		};
	}
}
