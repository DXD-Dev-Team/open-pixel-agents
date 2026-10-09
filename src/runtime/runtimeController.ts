import type * as vscode from 'vscode';
import type { AgentState } from '../types.js';
import type { RuntimeAdapter, RuntimeGlobalEvent } from './runtimeAdapter.js';
import { applyRuntimeEvent, expireCompletions, registerRuntimeAgent, replaceAgentSnapshot, unregisterRuntimeAgent } from './runtimeReducer.js';
import { projectAgentVm, projectRuntimeSnapshot } from './runtimeProjector.js';
import { createRuntimeStore } from './runtimeState.js';
import { OfficeTelemetry } from './officeTelemetry.js';
import type { OfficeWorkerMetadata } from '../officeBridge.js';

export class RuntimeController {
	private readonly store = createRuntimeStore();
	private completionTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly office: OfficeTelemetry;

	constructor(
		private readonly runtime: RuntimeAdapter,
		private readonly agents: Map<number, AgentState>,
		private readonly webview: () => vscode.Webview | undefined,
	) {
		this.office = new OfficeTelemetry(agents);
	}

	registerAgent(agent: AgentState): void {
		registerRuntimeAgent(this.store, agent);
		this.office.register(agent);
	}

	removeAgent(agentId: number): void {
		unregisterRuntimeAgent(this.store, agentId);
		this.office.remove(agentId);
	}

	updateMetadata(agentId: number, patch: OfficeWorkerMetadata): void {
		this.office.updateMetadata(agentId, patch);
		this.postAgent(agentId);
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
			this.office.hydrate(agent, snapshot);
		}));
		if (this.runtime.getPendingInputEvents) {
			for (const event of await this.runtime.getPendingInputEvents()) {
				applyRuntimeEvent(this.store, event);
				this.office.handleEvent(event);
			}
		}
		this.store.phase = 'live';
		this.postSnapshot();
		this.armCompletionTimer();
	}

	handleEvent(event: RuntimeGlobalEvent): { agentId: number; sessionId: string } | undefined {
		const props = event.payload?.properties ?? {};
		const info = props.info as Record<string, unknown> | undefined;
		const part = props.part as Record<string, unknown> | undefined;
		const sessionId = typeof props.sessionID === 'string' ? props.sessionID
			: typeof info?.sessionID === 'string' ? info.sessionID
				: typeof part?.sessionID === 'string' ? part.sessionID
					: event.payload?.type.startsWith('session.') && typeof info?.id === 'string' ? info.id : undefined;
		const previousOwner = sessionId ? this.office.owner(sessionId) : undefined;
		const changed = new Set(applyRuntimeEvent(this.store, event));
		const officeAgent = this.office.handleEvent(event);
		if (officeAgent !== undefined) {
			changed.add(officeAgent);
		}
		for (const agentId of changed) {
			this.postAgent(agentId);
		}
		this.armCompletionTimer();
		const agentId = officeAgent ?? previousOwner;
		return agentId !== undefined && sessionId ? { agentId, sessionId } : undefined;
	}

	postSnapshot(): void {
		this.webview()?.postMessage({
			type: 'runtimeSnapshot',
			protocolVersion: 2,
			agents: projectRuntimeSnapshot(this.store).map((agent) => this.office.decorate(agent)),
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
			agent: this.office.decorate(agent),
		});
	}

	private armCompletionTimer(): void {
		if (this.completionTimer) {
			clearTimeout(this.completionTimer);
			this.completionTimer = null;
		}
		let nextAt = this.office.nextSpeechExpiry() ?? Infinity;
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
			const changed = new Set([...expireCompletions(this.store), ...this.office.expireSpeech()]);
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
