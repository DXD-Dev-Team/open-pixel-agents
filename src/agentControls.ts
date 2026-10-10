import type { OfficeAgentAction, OfficeAgentPanelState, OfficeRole, OfficePanelAccount, OfficeManagerScope, OfficeRepository } from './officeBridge.js';
import { OFFICE_AGENT_ACTIONS, OFFICE_MANAGER_MODES, OFFICE_ROLES, OFFICE_STATUS_PRECEDENCE, OFFICE_PANEL_CHAT_LIMIT, OFFICE_PANEL_TEAM_LIMIT, OFFICE_PANEL_TEXT_LIMIT } from './constants.js';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function label(value: unknown, limit = 200): string {
	if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\r\n\0]/.test(value)) {
		throw new Error('The agent controls received an invalid identifier or label.');
	}
	return value.trim();
}
function body(value: unknown, limit = OFFICE_PANEL_TEXT_LIMIT): string {
	return typeof value === 'string' ? value.replace(/\0/g, '').slice(0, limit) : '';
}
export function officeRole(value: unknown): OfficeRole {
	if (value === undefined) { return 'builder'; }
	if (typeof value !== 'string' || !OFFICE_ROLES.includes(value as OfficeRole)) {
		throw new Error('Choose Engineer / Builder, Security Reviewer, Verifier, or Manager.');
	}
	return value as OfficeRole;
}

export function managerScope(value: unknown): OfficeManagerScope {
	if (value === undefined || value === 'all') { return 'all'; }
	const role = officeRole(value);
	if (role === 'manager') { throw new Error('Choose a team role for this manager.'); }
	return role;
}
export function officeRepositories(input: unknown): OfficeRepository[] {
	if (!Array.isArray(input) || input.length > 8) { throw new Error('The office supports up to eight repository areas.'); }
	const repos = input.map(value => { const repo = record(value); return { id: label(repo.id), name: label(repo.name, 100) }; });
	if (new Set(repos.map(repo => repo.id)).size !== repos.length) { throw new Error('Repository identifiers must be unique.'); }
	return repos;
}
function panelAccount(input: unknown): OfficePanelAccount {
	const account = record(input);
	if (!['claude', 'codex', 'grok'].includes(String(account.kind))) { throw new Error('The provider account is invalid.'); }
	return { id: label(account.id), name: label(account.name, 100), kind: account.kind as OfficePanelAccount['kind'], connected: account.connected === true,
		...(account.authType ? { authType: label(account.authType, 50) } : {}), ...(account.loginName ? { loginName: label(account.loginName, 200) } : {}) };
}

/** This transport copies only public controls/chat fields, never credentials. */
export function normalizeAgentPanel(input: unknown): OfficeAgentPanelState {
	const state = record(input);
	const worker = record(state.worker);
	const status = typeof worker.status === 'string' && OFFICE_STATUS_PRECEDENCE.includes(worker.status as OfficeAgentPanelState['worker']['status'])
		? worker.status as OfficeAgentPanelState['worker']['status'] : 'idle';
	const result: OfficeAgentPanelState = {
		worker: { id: label(worker.id), name: label(worker.name, 100), role: officeRole(worker.role), status, started: worker.started === true },
		chat: Array.isArray(state.chat) ? state.chat.slice(-OFFICE_PANEL_CHAT_LIMIT).flatMap(value => {
			const message = record(value);
			if (message.role !== 'user' && message.role !== 'assistant') { return []; }
			return [{ id: label(message.id), role: message.role, text: body(message.text), createdAt: typeof message.createdAt === 'number' && Number.isFinite(message.createdAt) ? message.createdAt : 0 }];
		}) : [], pending: state.pending === true, busy: state.busy === true,
	};
	for (const key of ['modelId', 'accountId', 'repoId', 'repoName'] as const) {
		if (worker[key] !== undefined) { result.worker[key] = label(worker[key]); }
	}
	if (['claude', 'codex', 'grok'].includes(String(worker.providerKind))) { result.worker.providerKind = worker.providerKind as 'claude' | 'codex' | 'grok'; }
	if (state.repositories) { result.repositories = officeRepositories(state.repositories); }
	if (state.account) { result.account = panelAccount(state.account); }
	if (Array.isArray(state.accounts)) { result.accounts = state.accounts.slice(0, OFFICE_PANEL_CHAT_LIMIT).map(panelAccount); }
	if (state.error) { result.error = body(state.error, 2_000); }
	if (Array.isArray(state.attention)) {
		result.attention = state.attention.slice(0, OFFICE_PANEL_CHAT_LIMIT).flatMap(value => {
			const item = record(value);
			return item.kind === 'permission' || item.kind === 'question' ? [{ id: label(item.id), kind: item.kind, ask: body(item.ask, 2_000) }] : [];
		});
	}
	if (state.manager) {
		const manager = record(state.manager);
		if (!OFFICE_MANAGER_MODES.includes(manager.mode as 'auto' | 'human-approval')) { throw new Error('Choose Auto or Human Approval.'); }
		result.manager = { mode: manager.mode as 'auto' | 'human-approval', scopeRole: managerScope(manager.scopeRole),
			repoIds: Array.isArray(manager.repoIds) ? [...new Set(manager.repoIds.slice(0, 8).map(value => label(value)))] : [],
			teamIds: Array.isArray(manager.teamIds) ? [...new Set(manager.teamIds.slice(0, OFFICE_PANEL_TEAM_LIMIT).map(value => label(value)))] : [],
			team: Array.isArray(manager.team) ? manager.team.slice(0, OFFICE_PANEL_TEAM_LIMIT).map(value => {
				const member = record(value); return { id: label(member.id), name: label(member.name, 100), role: officeRole(member.role), ...(member.repoId ? { repoId: label(member.repoId) } : {}), ...(member.repoName ? { repoName: label(member.repoName, 100) } : {}) };
			}) : [], proposals: Array.isArray(manager.proposals) ? manager.proposals.slice(-OFFICE_PANEL_CHAT_LIMIT).map(value => {
				const proposal = record(value);
				const status = ['pending', 'approved', 'rejected', 'running', 'done', 'failed'].includes(String(proposal.status)) ? proposal.status as 'pending' | 'approved' | 'rejected' | 'running' | 'done' | 'failed' : 'pending';
				return { id: label(proposal.id), text: body(proposal.text), status,
					...(proposal.workerId ? { workerId: label(proposal.workerId) } : {}), ...(proposal.workerName ? { workerName: label(proposal.workerName, 100) } : {}), ...(proposal.error ? { error: body(proposal.error, 2_000) } : {}) };
			}) : [], paused: manager.paused === true, triaging: manager.triaging === true, coordinating: manager.coordinating === true, executing: manager.executing === true, ...(manager.error ? { error: body(manager.error, 2_000) } : {}) };
	}
	return result;
}

export function normalizeAgentAction(input: unknown): OfficeAgentAction {
	const message = record(input);
	if (!Number.isInteger(message.agentId) || (message.agentId as number) < 1 || !OFFICE_AGENT_ACTIONS.includes(message.action as OfficeAgentAction['action'])) {
		throw new Error('The agent action is invalid.');
	}
	const requestId = label(message.requestId, 128);
	if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) { throw new Error('The agent action identifier is invalid.'); }
	const action: OfficeAgentAction = { type: 'agent-action', agentId: message.agentId as number, requestId, action: message.action as OfficeAgentAction['action'] };
	if (action.action === 'send') {
		if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > OFFICE_PANEL_TEXT_LIMIT) { throw new Error('Write a message of at most 20,000 characters.'); }
		action.text = message.text.replace(/\0/g, '').trim();
		if (!action.text) { throw new Error('Write a message before sending.'); }
	}
	if (action.action === 'role') {
		if (message.role === undefined) { throw new Error('Choose a supported office role.'); }
		action.role = officeRole(message.role);
	}
	if (action.action === 'manager-mode') {
		if (!OFFICE_MANAGER_MODES.includes(message.mode as 'auto' | 'human-approval')) { throw new Error('Choose Auto or Human Approval.'); }
		action.mode = message.mode as 'auto' | 'human-approval';
	}
	if (action.action === 'assign-team') {
		if (!Array.isArray(message.teamIds) || message.teamIds.length > OFFICE_PANEL_TEAM_LIMIT) { throw new Error('The manager team is invalid.'); }
		action.teamIds = [...new Set(message.teamIds.map(value => label(value)))];
	}
	if (action.action === 'manager-scope') {
		if (message.scopeRole === undefined) { throw new Error('Choose a manager team role.'); }
		action.scopeRole = managerScope(message.scopeRole);
	}
	if (action.action === 'manager-repos') {
		if (!Array.isArray(message.repoIds) || !message.repoIds.length || message.repoIds.length > 8) { throw new Error('The manager repositories are invalid.'); }
		action.repoIds = [...new Set(message.repoIds.map(value => label(value)))];
	}
	if (action.action === 'change-account') { action.accountId = label(message.accountId); }
	if (action.action === 'add-account') {
		if (!['claude', 'codex', 'grok'].includes(String(message.kind))) { throw new Error('Choose Claude, Codex, or Grok.'); }
		action.kind = message.kind as OfficeAgentAction['kind'];
	}
	if (action.action === 'approve' || action.action === 'reject') { action.proposalId = label(message.proposalId); }
	return action;
}
