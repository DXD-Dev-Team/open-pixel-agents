import type { RuntimeStore } from './runtimeState.js';
import type { AgentRuntimeVm, SubagentRuntimeVm, ToolRuntimeRecord, ToolVm } from './runtimeState.js';

function projectTools(tools: Iterable<ToolRuntimeRecord>): ToolVm[] {
	return [...tools]
		.map((tool) => ({
			id: tool.toolId,
			name: tool.toolName,
			label: tool.label,
			state: tool.state,
		}))
		.sort((a, b) => a.label.localeCompare(b.label));
}

export function projectAgentVm(store: RuntimeStore, agentId: number, now = Date.now()): AgentRuntimeVm | undefined {
	const agent = store.agentsById.get(agentId);
	if (!agent) {
		return undefined;
	}
	const root = store.sessionsById.get(agent.rootSessionId);
	const tools = root ? projectTools(root.toolsById.values()) : [];
	const subagents: SubagentRuntimeVm[] = [];
	for (const sessionId of agent.childSessionIds) {
		const child = store.sessionsById.get(sessionId);
		if (!child || !child.visible) {
			continue;
		}
		const completing = Boolean(child.completingUntil && child.completingUntil > now);
		const status = completing
			? 'completing'
			: child.rawStatus?.type === 'retry'
				? 'retry'
				: child.permissionAsked || child.toolsById.size > 0 || child.rawStatus?.type === 'busy'
					? 'active'
					: 'waiting';
		subagents.push({
			id: child.launchId || sessionId,
			sessionId,
			label: child.title,
			status,
			permissionAsked: child.permissionAsked,
			tools: projectTools(child.toolsById.values()),
			completionHint: completing ? 'Done' : undefined,
		});
	}
	const pending = store.pendingSubtasksByParentSessionId.get(agent.rootSessionId);
	if (pending) {
		for (const item of pending.values()) {
			if (item.boundChildSessionId) {
				continue;
			}
			subagents.push({
				id: item.launchId,
				sessionId: '',
				label: item.description,
				status: 'active',
				permissionAsked: false,
				tools: [],
			});
		}
	}
	return {
		agentId,
		sessionId: agent.rootSessionId,
		status: agent.displayStatus,
		permissionAsked: agent.permissionAsked,
		tools,
		subagents,
	};
}

export function projectRuntimeSnapshot(store: RuntimeStore, now = Date.now()): AgentRuntimeVm[] {
	return [...store.agentsById.keys()]
		.sort((a, b) => a - b)
		.map((agentId) => projectAgentVm(store, agentId, now))
		.filter((item): item is AgentRuntimeVm => Boolean(item));
}
