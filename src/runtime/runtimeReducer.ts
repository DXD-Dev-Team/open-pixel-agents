import { formatToolStatus } from '../toolStatus.js';
import type { AgentState } from '../types.js';
import type { RuntimeGlobalEvent, RuntimeMessage, RuntimePart, RuntimeSessionSnapshot, RuntimeSessionStatus } from './runtimeAdapter.js';
import { COMPLETING_GRACE_MS, type PendingSubtaskRecord, type RuntimeStore, type SessionRuntimeRecord, type ToolRuntimeRecord } from './runtimeState.js';

function getToolId(part: RuntimePart): string {
	return typeof part.callID === 'string' ? part.callID : part.id;
}

function getToolState(part: RuntimePart): string | undefined {
	const state = part.state as Record<string, unknown> | undefined;
	return typeof state?.status === 'string' ? state.status : undefined;
}

function getToolLabel(part: RuntimePart): string {
	const toolName = typeof part.tool === 'string' ? part.tool : 'Tool';
	const state = (part.state as Record<string, unknown> | undefined) || {};
	const input = (state.input as Record<string, unknown> | undefined) || {};
	return formatToolStatus(toolName, input);
}

function isSessionBusy(status?: RuntimeSessionStatus): boolean {
	return status?.type === 'busy';
}

function isSessionRetry(status?: RuntimeSessionStatus): boolean {
	return status?.type === 'retry';
}

function isSessionIdle(status?: RuntimeSessionStatus): boolean {
	return status?.type === 'idle';
}

function getPending(store: RuntimeStore, parentSessionId: string): Map<string, PendingSubtaskRecord> {
	let pending = store.pendingSubtasksByParentSessionId.get(parentSessionId);
	if (!pending) {
		pending = new Map();
		store.pendingSubtasksByParentSessionId.set(parentSessionId, pending);
	}
	return pending;
}

function createRootRecord(agent: AgentState): SessionRuntimeRecord {
	return {
		sessionId: agent.sessionId || `agent-${agent.id}`,
		kind: 'root',
		agentId: agent.id,
		title: `Agent ${agent.id}`,
		permissionAsked: false,
		toolsById: new Map(),
		visible: true,
		hadActivity: false,
	};
}

function setChildVisibility(child: SessionRuntimeRecord, now: number, allowCompleting: boolean): void {
	if (child.permissionAsked || child.toolsById.size > 0 || isSessionBusy(child.rawStatus) || isSessionRetry(child.rawStatus)) {
		child.visible = true;
		child.completingUntil = undefined;
		return;
	}
	if (!child.rawStatus) {
		child.completingUntil = undefined;
		return;
	}
	if (allowCompleting && isSessionIdle(child.rawStatus)) {
		if (!child.completingUntil) {
			child.completingUntil = now + COMPLETING_GRACE_MS;
		}
		child.visible = true;
		return;
	}
	child.visible = false;
	child.completingUntil = undefined;
}

function deriveAgentStatus(root: SessionRuntimeRecord | undefined, children: SessionRuntimeRecord[], now: number): 'active' | 'waiting' | 'retry' {
	if (root?.rawStatus?.type === 'retry') {
		return 'retry';
	}
	const hasWorkingChild = children.some((child) => child.permissionAsked || child.toolsById.size > 0 || isSessionBusy(child.rawStatus) || isSessionRetry(child.rawStatus));
	if (root?.permissionAsked || (root?.toolsById.size || 0) > 0 || isSessionBusy(root?.rawStatus) || hasWorkingChild) {
		return 'active';
	}
	if (isSessionIdle(root?.rawStatus) || children.some((child) => child.visible && child.completingUntil && child.completingUntil > now)) {
		return 'waiting';
	}
	return 'active';
}

function bindPendingSubtask(store: RuntimeStore, parentSessionId: string, title: string, childSessionId: string): void {
	const pending = store.pendingSubtasksByParentSessionId.get(parentSessionId);
	if (!pending || pending.size === 0) {
		return;
	}
	const normalizedTitle = title.trim().toLowerCase();
	let match: PendingSubtaskRecord | undefined;
	for (const item of pending.values()) {
		if (item.boundChildSessionId) {
			continue;
		}
		if (item.description.trim().toLowerCase() === normalizedTitle) {
			match = item;
			break;
		}
	}
	if (!match) {
		const unresolved = [...pending.values()].filter((item) => !item.boundChildSessionId);
		if (unresolved.length === 1) {
			match = unresolved[0];
		}
	}
	if (match) {
		match.boundChildSessionId = childSessionId;
		const child = store.sessionsById.get(childSessionId);
		if (child) {
			child.launchId = match.launchId;
		}
	}
}

function bindChildToPending(store: RuntimeStore, parentSessionId: string, pendingRecord: PendingSubtaskRecord): void {
	if (pendingRecord.boundChildSessionId) {
		return;
	}
	const normalizedTitle = pendingRecord.description.trim().toLowerCase();
	const candidates = [...store.sessionsById.values()].filter((record) =>
		record.kind === 'child' &&
		record.parentSessionId === parentSessionId &&
		!record.launchId,
	);
	let match = candidates.find((record) => record.title.trim().toLowerCase() === normalizedTitle);
	if (!match && candidates.length === 1) {
		match = candidates[0];
	}
	if (match) {
		pendingRecord.boundChildSessionId = match.sessionId;
		match.launchId = pendingRecord.launchId;
	}
}

function reducePart(record: SessionRuntimeRecord, store: RuntimeStore, part: RuntimePart, now: number, allowCompleting: boolean): void {
	if (part.type === 'tool') {
		const status = getToolState(part);
		const toolId = getToolId(part);
		if (status === 'pending' || status === 'running') {
			const toolName = typeof part.tool === 'string' ? part.tool : 'Tool';
			const tool: ToolRuntimeRecord = {
				toolId,
				toolName,
				label: getToolLabel(part),
				state: status,
			};
			record.toolsById.set(toolId, tool);
		} else {
			record.toolsById.delete(toolId);
		}
		if (record.kind === 'child') {
			setChildVisibility(record, now, allowCompleting);
		}
		return;
	}
	if (record.kind === 'root' && part.type === 'subtask') {
		const pending = getPending(store, record.sessionId);
		const pendingRecord = {
			launchId: part.id,
			parentSessionId: record.sessionId,
			description: typeof part.description === 'string' && part.description ? part.description : 'OpenCode subtask',
		};
		pending.set(part.id, pendingRecord);
		bindChildToPending(store, record.sessionId, pendingRecord);
		return;
	}
	if (part.type === 'text' || part.type === 'reasoning' || part.type === 'step-start') {
		record.hadActivity = true;
	}
	if (record.kind === 'child') {
		setChildVisibility(record, now, allowCompleting);
	}
}

function reduceMessages(record: SessionRuntimeRecord, store: RuntimeStore, messages: RuntimeMessage[], now: number, allowCompleting: boolean): void {
	for (const message of messages) {
		for (const part of message.parts) {
			reducePart(record, store, part, now, allowCompleting);
		}
	}
}

export function registerRuntimeAgent(store: RuntimeStore, agent: AgentState): void {
	if (!agent.sessionId) {
		return;
	}
	store.rootSessionToAgentId.set(agent.sessionId, agent.id);
	store.agentsById.set(agent.id, {
		agentId: agent.id,
		rootSessionId: agent.sessionId,
		terminalName: agent.terminalRef.name,
		projectDir: agent.projectDir,
		displayStatus: 'active',
		permissionAsked: false,
		rootToolIds: [],
		childSessionIds: [],
	});
	store.sessionsById.set(agent.sessionId, createRootRecord(agent));
}

export function unregisterRuntimeAgent(store: RuntimeStore, agentId: number): void {
	const agent = store.agentsById.get(agentId);
	if (!agent) {
		return;
	}
	store.agentsById.delete(agentId);
	store.rootSessionToAgentId.delete(agent.rootSessionId);
	store.sessionsById.delete(agent.rootSessionId);
	store.pendingSubtasksByParentSessionId.delete(agent.rootSessionId);
	for (const [sessionId, record] of store.sessionsById) {
		if (record.agentId === agentId && record.kind === 'child') {
			store.sessionsById.delete(sessionId);
		}
	}
	store.snapshotsByAgentId.delete(agentId);
}

export function replaceAgentSnapshot(store: RuntimeStore, agent: AgentState, snapshot: RuntimeSessionSnapshot, now = Date.now()): void {
	if (!agent.sessionId) {
		return;
	}
	store.snapshotsByAgentId.set(agent.id, snapshot);
	for (const [sessionId, record] of store.sessionsById) {
		if (record.agentId === agent.id && record.kind === 'child') {
			store.sessionsById.delete(sessionId);
		}
	}
	store.pendingSubtasksByParentSessionId.delete(agent.sessionId);
	registerRuntimeAgent(store, agent);
	const root = createRootRecord(agent);
	root.title = `Agent ${agent.id}`;
	root.rawStatus = snapshot.status;
	root.permissionAsked = false;
	root.visible = true;
	root.hadActivity = false;
	reduceMessages(root, store, snapshot.messages, now, false);
	store.sessionsById.set(root.sessionId, root);
	const childIds: string[] = [];
	for (const child of snapshot.children) {
		const record: SessionRuntimeRecord = {
			sessionId: child.info.id,
			kind: 'child',
			agentId: agent.id,
			parentSessionId: agent.sessionId,
			launchId: undefined,
			title: child.info.title || 'OpenCode subtask',
			rawStatus: child.status,
			permissionAsked: false,
			toolsById: new Map(),
			visible: false,
			hadActivity: false,
		};
		reduceMessages(record, store, child.messages, now, false);
		setChildVisibility(record, now, false);
		store.sessionsById.set(record.sessionId, record);
		childIds.push(record.sessionId);
		bindPendingSubtask(store, agent.sessionId, record.title, record.sessionId);
	}
	store.pendingSubtasksByParentSessionId.delete(agent.sessionId);
	const agentRecord = store.agentsById.get(agent.id);
	if (!agentRecord) {
		return;
	}
	agentRecord.rawStatus = snapshot.status;
	agentRecord.permissionAsked = root.permissionAsked;
	agentRecord.rootToolIds = [...root.toolsById.keys()];
	agentRecord.childSessionIds = childIds;
	const children = childIds.map((id) => store.sessionsById.get(id)).filter((item): item is SessionRuntimeRecord => Boolean(item));
	agentRecord.displayStatus = deriveAgentStatus(root, children, now);
}

function updateAgentDerived(store: RuntimeStore, agentId: number, now: number): void {
	const agent = store.agentsById.get(agentId);
	if (!agent) {
		return;
	}
	const root = store.sessionsById.get(agent.rootSessionId);
	const children = agent.childSessionIds
		.map((sessionId) => store.sessionsById.get(sessionId))
		.filter((item): item is SessionRuntimeRecord => Boolean(item));
	agent.permissionAsked = Boolean(root?.permissionAsked);
	agent.rawStatus = root?.rawStatus;
	agent.rootToolIds = root ? [...root.toolsById.keys()] : [];
	agent.displayStatus = deriveAgentStatus(root, children, now);
}

export function expireCompletions(store: RuntimeStore, now = Date.now()): number[] {
	const changed = new Set<number>();
	for (const record of store.sessionsById.values()) {
		if (record.kind !== 'child' || !record.completingUntil || record.completingUntil > now) {
			continue;
		}
		record.completingUntil = undefined;
		record.visible = false;
		changed.add(record.agentId);
	}
	for (const agentId of changed) {
		updateAgentDerived(store, agentId, now);
	}
	return [...changed];
}

export function applyRuntimeEvent(store: RuntimeStore, event: RuntimeGlobalEvent, now = Date.now()): number[] {
	const payload = event.payload;
	if (!payload || typeof payload.type !== 'string') {
		return [];
	}
	const changed = new Set<number>();
	if (payload.type === 'session.created') {
		const info = payload.properties.info as Record<string, unknown> | undefined;
		const childSessionId = typeof info?.id === 'string' ? info.id : undefined;
		const parentSessionId = typeof info?.parentID === 'string' ? info.parentID : undefined;
		if (!childSessionId || !parentSessionId) {
			return [];
		}
		const agentId = store.rootSessionToAgentId.get(parentSessionId);
		if (agentId === undefined) {
			return [];
		}
		const title = typeof info?.title === 'string' && info.title ? info.title : 'OpenCode subtask';
		const record = store.sessionsById.get(childSessionId) || {
			sessionId: childSessionId,
			kind: 'child' as const,
			agentId,
			parentSessionId,
			launchId: undefined,
			title,
			permissionAsked: false,
			toolsById: new Map(),
			visible: true,
			hadActivity: false,
		};
		record.agentId = agentId;
		record.parentSessionId = parentSessionId;
		record.title = title;
		record.visible = true;
		store.sessionsById.set(childSessionId, record);
		const agent = store.agentsById.get(agentId);
		if (agent && !agent.childSessionIds.includes(childSessionId)) {
			agent.childSessionIds.push(childSessionId);
		}
		bindPendingSubtask(store, parentSessionId, title, childSessionId);
		updateAgentDerived(store, agentId, now);
		changed.add(agentId);
		return [...changed];
	}
	if (payload.type === 'session.status' || payload.type === 'session.idle') {
		const sessionId = typeof payload.properties.sessionID === 'string' ? payload.properties.sessionID : undefined;
		if (!sessionId) {
			return [];
		}
		const record = store.sessionsById.get(sessionId);
		if (!record) {
			return [];
		}
		record.rawStatus = payload.type === 'session.idle'
			? { type: 'idle' }
			: payload.properties.status as RuntimeSessionStatus | undefined;
		if (record.kind === 'child') {
			setChildVisibility(record, now, true);
		}
		updateAgentDerived(store, record.agentId, now);
		changed.add(record.agentId);
		return [...changed];
	}
	if (payload.type === 'permission.asked' || payload.type === 'permission.replied') {
		const sessionId = typeof payload.properties.sessionID === 'string' ? payload.properties.sessionID : undefined;
		if (!sessionId) {
			return [];
		}
		const record = store.sessionsById.get(sessionId);
		if (!record) {
			return [];
		}
		record.permissionAsked = payload.type === 'permission.asked';
		if (record.kind === 'child') {
			setChildVisibility(record, now, true);
		}
		updateAgentDerived(store, record.agentId, now);
		changed.add(record.agentId);
		return [...changed];
	}
	if (payload.type !== 'message.part.updated') {
		return [];
	}
	const part = payload.properties.part as RuntimePart | undefined;
	if (!part || typeof part.sessionID !== 'string' || typeof part.type !== 'string') {
		return [];
	}
	const record = store.sessionsById.get(part.sessionID);
	if (!record) {
		return [];
	}
	reducePart(record, store, part, now, true);
	updateAgentDerived(store, record.agentId, now);
	changed.add(record.agentId);
	return [...changed];
}
