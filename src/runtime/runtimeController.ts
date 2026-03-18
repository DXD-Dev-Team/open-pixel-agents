import type * as vscode from 'vscode';
import type { AgentState } from '../types.js';
import type { RuntimeAdapter, RuntimeGlobalEvent } from './runtimeAdapter.js';
import { applyRuntimeEvent, expireCompletions, registerRuntimeAgent, replaceAgentSnapshot, unregisterRuntimeAgent } from './runtimeReducer.js';
import { projectAgentVm, projectRuntimeSnapshot } from './runtimeProjector.js';
import { createRuntimeStore } from './runtimeState.js';

export class RuntimeController {
	private readonly store = createRuntimeStore();
	private completionTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly runtime: RuntimeAdapter,
		private readonly agents: Map<number, AgentState>,
		private readonly webview: () => vscode.Webview | undefined,
	) {}

	registerAgent(agent: AgentState): void {
		registerRuntimeAgent(this.store, agent);
	}

	removeAgent(agentId: number): void {
		unregisterRuntimeAgent(this.store, agentId);
	}

	async hydrateAll(): Promise<void> {
		this.store.phase = 'hydrating';
		const agents = [...this.agents.values()].filter((agent) => agent.sessionId);
		await Promise.all(agents.map(async (agent) => {
			if (!agent.sessionId) {
				return;
			}
			const snapshot = await this.runtime.getSessionSnapshot(agent.sessionId);
			replaceAgentSnapshot(this.store, agent, snapshot);
		}));
		this.store.phase = 'live';
		this.postSnapshot();
		this.armCompletionTimer();
	}

	handleEvent(event: RuntimeGlobalEvent): void {
		const changed = applyRuntimeEvent(this.store, event);
		for (const agentId of changed) {
			this.postAgent(agentId);
		}
		this.armCompletionTimer();
	}

	postSnapshot(): void {
		this.webview()?.postMessage({
			type: 'runtimeSnapshot',
			protocolVersion: 2,
			agents: projectRuntimeSnapshot(this.store),
		});
	}

	private postAgent(agentId: number): void {
		const agent = projectAgentVm(this.store, agentId);
		if (!agent) {
			return;
		}
		this.webview()?.postMessage({
			type: 'agentRuntimeReplace',
			protocolVersion: 2,
			agent,
		});
	}

	private armCompletionTimer(): void {
		if (this.completionTimer) {
			clearTimeout(this.completionTimer);
			this.completionTimer = null;
		}
		let nextAt = Infinity;
		const now = Date.now();
		for (const record of this.store.sessionsById.values()) {
			if (!record.completingUntil || record.completingUntil <= now) {
				continue;
			}
			nextAt = Math.min(nextAt, record.completingUntil);
		}
		if (!Number.isFinite(nextAt)) {
			return;
		}
		this.completionTimer = setTimeout(() => {
			const changed = expireCompletions(this.store);
			for (const agentId of changed) {
				this.postAgent(agentId);
			}
			this.armCompletionTimer();
		}, Math.max(1, nextAt - now));
	}

	dispose(): void {
		if (this.completionTimer) {
			clearTimeout(this.completionTimer);
			this.completionTimer = null;
		}
	}
}
