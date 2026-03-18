import type { RuntimeSessionSnapshot, RuntimeSessionStatus } from './runtimeAdapter.js';

export const COMPLETING_GRACE_MS = 3000;

export interface ToolRuntimeRecord {
	toolId: string;
	toolName: string;
	label: string;
	state: 'pending' | 'running';
}

export interface PendingSubtaskRecord {
	launchId: string;
	parentSessionId: string;
	description: string;
	boundChildSessionId?: string;
}

export interface SessionRuntimeRecord {
	sessionId: string;
	kind: 'root' | 'child';
	agentId: number;
	parentSessionId?: string;
	launchId?: string;
	title: string;
	rawStatus?: RuntimeSessionStatus;
	permissionAsked: boolean;
	toolsById: Map<string, ToolRuntimeRecord>;
	visible: boolean;
	completingUntil?: number;
	hadActivity: boolean;
}

export interface AgentRuntimeRecord {
	agentId: number;
	rootSessionId: string;
	terminalName: string;
	projectDir: string;
	rawStatus?: RuntimeSessionStatus;
	displayStatus: 'active' | 'waiting' | 'retry';
	permissionAsked: boolean;
	rootToolIds: string[];
	childSessionIds: string[];
}

export interface RuntimeStore {
	phase: 'cold' | 'hydrating' | 'live';
	agentsById: Map<number, AgentRuntimeRecord>;
	rootSessionToAgentId: Map<string, number>;
	sessionsById: Map<string, SessionRuntimeRecord>;
	pendingSubtasksByParentSessionId: Map<string, Map<string, PendingSubtaskRecord>>;
	snapshotsByAgentId: Map<number, RuntimeSessionSnapshot>;
}

export interface ToolVm {
	id: string;
	name: string;
	label: string;
	state: 'pending' | 'running';
}

export interface SubagentRuntimeVm {
	id: string;
	sessionId: string;
	label: string;
	status: 'active' | 'waiting' | 'retry' | 'completing';
	permissionAsked: boolean;
	tools: ToolVm[];
	completionHint?: string;
}

export interface AgentRuntimeVm {
	agentId: number;
	sessionId: string;
	status: 'active' | 'waiting' | 'retry';
	permissionAsked: boolean;
	tools: ToolVm[];
	subagents: SubagentRuntimeVm[];
}

export function createRuntimeStore(): RuntimeStore {
	return {
		phase: 'cold',
		agentsById: new Map(),
		rootSessionToAgentId: new Map(),
		sessionsById: new Map(),
		pendingSubtasksByParentSessionId: new Map(),
		snapshotsByAgentId: new Map(),
	};
}
