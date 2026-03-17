import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import type {
	OpenCodeGlobalEvent,
	OpenCodeMessageWithParts,
	OpenCodePart,
	OpenCodeSession,
	OpenCodeSessionStatus,
} from './opencodeClient.js';
import {
	cancelPermissionTimer,
	cancelWaitingTimer,
	clearAgentActivity,
	startPermissionTimer,
} from './timerManager.js';
import { formatToolStatus, PERMISSION_EXEMPT_TOOLS } from './toolStatus.js';
import { TOOL_DONE_DELAY_MS } from './constants.js';

type SessionParentMap = Map<string, number>;

interface ReplayChildSession {
	info: OpenCodeSession;
	status?: OpenCodeSessionStatus;
	messages: OpenCodeMessageWithParts[];
}

function getAgentBySessionId(agents: Map<number, AgentState>, sessionId: string): AgentState | undefined {
	for (const agent of agents.values()) {
		if (agent.sessionId === sessionId) {
			return agent;
		}
	}
	return undefined;
}

function postWaiting(webview: vscode.Webview | undefined, agentId: number): void {
	webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'waiting' });
}

function postActive(webview: vscode.Webview | undefined, agentId: number): void {
	webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
}

function startAgentTool(
	agent: AgentState,
	agentId: number,
	toolId: string,
	toolName: string,
	status: string,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	if (agent.activeToolIds.has(toolId)) {
		return;
	}
	agent.activeToolIds.add(toolId);
	agent.activeToolNames.set(toolId, toolName);
	agent.activeToolStatuses.set(toolId, status);
	agent.isWaiting = false;
	postActive(webview, agentId);
	webview?.postMessage({ type: 'agentToolStart', id: agentId, toolId, status });
	if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
		startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
	}
}

function finishAgentTool(
	agent: AgentState,
	agentId: number,
	toolId: string,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const toolName = agent.activeToolNames.get(toolId);
	if (toolName === 'Task') {
		agent.activeSubagentToolIds.delete(toolId);
		agent.activeSubagentToolNames.delete(toolId);
		webview?.postMessage({ type: 'subagentClear', id: agentId, parentToolId: toolId });
	}
	agent.activeToolIds.delete(toolId);
	agent.activeToolNames.delete(toolId);
	agent.activeToolStatuses.delete(toolId);
	cancelPermissionTimer(agentId, permissionTimers);
	setTimeout(() => {
		webview?.postMessage({ type: 'agentToolDone', id: agentId, toolId });
	}, TOOL_DONE_DELAY_MS);
}

function startSubagentTool(
	agent: AgentState,
	agentId: number,
	parentToolId: string,
	toolId: string,
	toolName: string,
	status: string,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	let subTools = agent.activeSubagentToolIds.get(parentToolId);
	if (!subTools) {
		subTools = new Set();
		agent.activeSubagentToolIds.set(parentToolId, subTools);
	}
	if (subTools.has(toolId)) {
		return;
	}
	subTools.add(toolId);
	let subNames = agent.activeSubagentToolNames.get(parentToolId);
	if (!subNames) {
		subNames = new Map();
		agent.activeSubagentToolNames.set(parentToolId, subNames);
	}
	subNames.set(toolId, toolName);
	webview?.postMessage({ type: 'subagentToolStart', id: agentId, parentToolId, toolId, status });
	if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
		startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
	}
}

function finishSubagentTool(
	agent: AgentState,
	agentId: number,
	parentToolId: string,
	toolId: string,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	agent.activeSubagentToolIds.get(parentToolId)?.delete(toolId);
	agent.activeSubagentToolNames.get(parentToolId)?.delete(toolId);
	cancelPermissionTimer(agentId, permissionTimers);
	setTimeout(() => {
		webview?.postMessage({ type: 'subagentToolDone', id: agentId, parentToolId, toolId });
	}, TOOL_DONE_DELAY_MS);
}

function applySessionStatus(
	agent: AgentState,
	agentId: number,
	status: OpenCodeSessionStatus,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	cancelWaitingTimer(agentId, waitingTimers);
	if (status.type === 'idle') {
		agent.isWaiting = true;
		cancelPermissionTimer(agentId, permissionTimers);
		postWaiting(webview, agentId);
		return;
	}
	agent.isWaiting = false;
	postActive(webview, agentId);
}

function handleToolPart(
	agent: AgentState,
	agentId: number,
	part: Record<string, unknown>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
	parentToolId?: string,
): void {
	const toolName = typeof part.tool === 'string' ? part.tool : 'Tool';
	const state = part.state as Record<string, unknown> | undefined;
	const status = typeof state?.status === 'string' ? state.status : 'pending';
	const input = (state?.input as Record<string, unknown> | undefined) || {};
	const toolId = typeof part.callID === 'string' ? part.callID : typeof part.id === 'string' ? part.id : `${toolName}-${Date.now()}`;
	cancelWaitingTimer(agentId, waitingTimers);
	if (!parentToolId) {
		if (status === 'pending' || status === 'running') {
			startAgentTool(agent, agentId, toolId, toolName, formatToolStatus(toolName, input), permissionTimers, agents, webview);
		} else {
			finishAgentTool(agent, agentId, toolId, permissionTimers, webview);
		}
		return;
	}
	if (status === 'pending' || status === 'running') {
		startSubagentTool(agent, agentId, parentToolId, toolId, toolName, formatToolStatus(toolName, input), permissionTimers, agents, webview);
	} else {
		finishSubagentTool(agent, agentId, parentToolId, toolId, permissionTimers, webview);
	}
}

function replayPart(
	agent: AgentState,
	agentId: number,
	part: OpenCodePart,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
	parentToolId?: string,
): void {
	if (part.type === 'tool') {
		handleToolPart(agent, agentId, part as Record<string, unknown>, permissionTimers, waitingTimers, agents, webview, parentToolId);
		return;
	}
	if (!parentToolId && part.type === 'subtask') {
		const taskId = typeof part.id === 'string' ? part.id : `subtask-${Date.now()}`;
		const description = typeof part.description === 'string' && part.description ? part.description : 'OpenCode subtask';
		startAgentTool(agent, agentId, taskId, 'Task', `Subtask: ${description}`, permissionTimers, agents, webview);
		return;
	}
	if (part.type === 'text' || part.type === 'reasoning' || part.type === 'step-start') {
		cancelWaitingTimer(agentId, waitingTimers);
		agent.isWaiting = false;
		postActive(webview, agentId);
		return;
	}
	if (parentToolId && part.type === 'step-finish') {
		webview?.postMessage({ type: 'subagentClear', id: agentId, parentToolId });
	}
}

export function replayOpenCodeSessionState(
	agent: AgentState,
	agents: Map<number, AgentState>,
	sessionParents: SessionParentMap,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	status: OpenCodeSessionStatus | undefined,
	messages: OpenCodeMessageWithParts[],
	children: ReplayChildSession[],
): void {
	clearAgentActivity(agent, agent.id, permissionTimers, webview);
	if (status) {
		applySessionStatus(agent, agent.id, status, waitingTimers, permissionTimers, webview);
	}

	for (const message of messages) {
		for (const part of message.parts) {
			replayPart(agent, agent.id, part, permissionTimers, waitingTimers, agents, webview);
		}
	}

	for (const child of children) {
		sessionParents.set(child.info.id, agent.id);
		const parentToolId = child.info.id;
		const title = child.info.title || 'OpenCode subtask';
		startAgentTool(agent, agent.id, parentToolId, 'Task', `Subtask: ${title}`, permissionTimers, agents, webview);
		for (const message of child.messages) {
			for (const part of message.parts) {
				replayPart(agent, agent.id, part, permissionTimers, waitingTimers, agents, webview, parentToolId);
			}
		}
		if (!child.status || child.status.type === 'idle') {
			finishAgentTool(agent, agent.id, parentToolId, permissionTimers, webview);
		}
	}

	if (!status || status.type !== 'idle') {
		postActive(webview, agent.id);
	}
}

export function processOpenCodeEvent(
	event: OpenCodeGlobalEvent,
	agents: Map<number, AgentState>,
	sessionParents: SessionParentMap,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const payload = event.payload;
	if (!payload || typeof payload.type !== 'string') {
		return;
	}

	if (payload.type === 'session.created') {
		const info = payload.properties.info as Record<string, unknown> | undefined;
		const childSessionId = typeof info?.id === 'string' ? info.id : undefined;
		const parentSessionId = typeof info?.parentID === 'string' ? info.parentID : undefined;
		if (!childSessionId || !parentSessionId) {
			return;
		}
		const infoTitle = info?.title;
		const parentAgent = getAgentBySessionId(agents, parentSessionId);
		if (!parentAgent) {
			return;
		}
		sessionParents.set(childSessionId, parentAgent.id);
		const title = typeof infoTitle === 'string' && infoTitle ? infoTitle : 'OpenCode subtask';
		startAgentTool(
			parentAgent,
			parentAgent.id,
			childSessionId,
			'Task',
			`Subtask: ${title}`,
			permissionTimers,
			agents,
			webview,
		);
		return;
	}

	if (payload.type === 'session.idle') {
		const sessionId = typeof payload.properties.sessionID === 'string' ? payload.properties.sessionID : undefined;
		if (!sessionId) {
			return;
		}
		const directAgent = getAgentBySessionId(agents, sessionId);
		if (directAgent) {
			applySessionStatus(directAgent, directAgent.id, { type: 'idle' }, waitingTimers, permissionTimers, webview);
			return;
		}
		const parentAgentId = sessionParents.get(sessionId);
		if (parentAgentId === undefined) {
			return;
		}
		const parentAgent = agents.get(parentAgentId);
		if (!parentAgent) {
			return;
		}
		finishAgentTool(parentAgent, parentAgentId, sessionId, permissionTimers, webview);
		return;
	}

	if (payload.type === 'session.status') {
		const sessionId = typeof payload.properties.sessionID === 'string' ? payload.properties.sessionID : undefined;
		const status = payload.properties.status as OpenCodeSessionStatus | undefined;
		if (!sessionId || !status) {
			return;
		}
		const directAgent = getAgentBySessionId(agents, sessionId);
		if (directAgent) {
			applySessionStatus(directAgent, directAgent.id, status, waitingTimers, permissionTimers, webview);
		}
		return;
	}

	if (payload.type === 'permission.asked') {
		const sessionId = typeof payload.properties.sessionID === 'string' ? payload.properties.sessionID : undefined;
		if (!sessionId) {
			return;
		}
		const directAgent = getAgentBySessionId(agents, sessionId);
		if (directAgent) {
			directAgent.permissionSent = true;
			webview?.postMessage({ type: 'agentToolPermission', id: directAgent.id });
			return;
		}
		const parentAgentId = sessionParents.get(sessionId);
		if (parentAgentId !== undefined) {
			webview?.postMessage({ type: 'subagentToolPermission', id: parentAgentId, parentToolId: sessionId });
		}
		return;
	}

	if (payload.type === 'permission.replied') {
		const sessionId = typeof payload.properties.sessionID === 'string' ? payload.properties.sessionID : undefined;
		if (!sessionId) {
			return;
		}
		const directAgent = getAgentBySessionId(agents, sessionId);
		if (directAgent) {
			directAgent.permissionSent = false;
			webview?.postMessage({ type: 'agentToolPermissionClear', id: directAgent.id });
		}
		return;
	}

	if (payload.type !== 'message.part.updated') {
		return;
	}

	const part = payload.properties.part as Record<string, unknown> | undefined;
	if (!part || typeof part.sessionID !== 'string' || typeof part.type !== 'string') {
		return;
	}

	const directAgent = getAgentBySessionId(agents, part.sessionID);
	if (directAgent) {
		if (part.type === 'tool') {
			handleToolPart(directAgent, directAgent.id, part, permissionTimers, waitingTimers, agents, webview);
			return;
		}
		if (part.type === 'subtask') {
			const parentToolId = typeof part.id === 'string' ? part.id : `subtask-${Date.now()}`;
			startAgentTool(
				directAgent,
				directAgent.id,
				parentToolId,
				'Task',
				`Subtask: ${typeof part.description === 'string' && part.description ? part.description : 'OpenCode subtask'}`,
				permissionTimers,
				agents,
				webview,
			);
			return;
		}
		if (part.type === 'text' || part.type === 'reasoning' || part.type === 'step-start') {
			cancelWaitingTimer(directAgent.id, waitingTimers);
			directAgent.isWaiting = false;
			postActive(webview, directAgent.id);
		}
		return;
	}

	const parentAgentId = sessionParents.get(part.sessionID);
	if (parentAgentId === undefined) {
		return;
	}
	const parentAgent = agents.get(parentAgentId);
	if (!parentAgent) {
		return;
	}
	if (part.type === 'tool') {
		handleToolPart(parentAgent, parentAgentId, part, permissionTimers, waitingTimers, agents, webview, part.sessionID);
		return;
	}
	if (part.type === 'text' || part.type === 'reasoning' || part.type === 'step-start') {
		cancelWaitingTimer(parentAgentId, waitingTimers);
		postActive(webview, parentAgentId);
		return;
	}
	if (part.type === 'step-finish') {
		webview?.postMessage({ type: 'subagentClear', id: parentAgentId, parentToolId: part.sessionID });
		return;
	}
}
