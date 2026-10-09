import { officeRole, managerScope } from '../agentControls.js';
import type { AgentState } from '../types.js';
import type { OfficeLabel, OfficePricing, OfficeSpeech, OfficeStatus, OfficeWorkerMetadata } from '../officeBridge.js';
import type { RuntimeGlobalEvent, RuntimeMessage, RuntimeSessionSnapshot, RuntimeSessionStatus } from './runtimeAdapter.js';
import type { AgentRuntimeVm, SubagentRuntimeVm } from './runtimeState.js';
import { OFFICE_READING_TOOLS, OFFICE_STATUS_PRECEDENCE, OFFICE_SPEECH_DURATION_MS, OFFICE_SPEECH_MAX_LENGTH } from '../constants.js';

const statusOrder: readonly OfficeStatus[] = OFFICE_STATUS_PRECEDENCE;
const readingTools = new Set<string>(OFFICE_READING_TOOLS);

interface CompletedUsage {
	tokens: number;
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	providerId?: string;
	modelId?: string;
}

interface OfficeSession {
	sessionId: string;
	agentId: number;
	parentId?: string;
	status?: RuntimeSessionStatus;
	manualStatus?: OfficeStatus;
	manualNeedsInput: boolean;
	failed: boolean;
	permissions: Set<string>;
	questions: Set<string>;
	tools: Map<string, string>;
	completed: Map<string, CompletedUsage>;
	messageRoles: Map<string, string>;
	textParts: Map<string, string>;
	speech?: OfficeSpeech;
}

function number(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Copy only the non-secret public metadata fields into persistence. */
export function normalizeOfficeMetadata(input: OfficeWorkerMetadata, previous: OfficeWorkerMetadata = {}): OfficeWorkerMetadata {
	const result: OfficeWorkerMetadata = { ...previous };
	for (const key of ['workerId', 'name', 'providerId', 'modelId', 'accountId', 'repoId', 'repoName'] as const) {
		if (input[key] === undefined) {
			continue;
		}
		const value = input[key];
		if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value)) {
			throw new Error(`Open Pixel Agents: Invalid ${key} metadata.`);
		}
		result[key] = value.trim();
	}
	if (input.role !== undefined) { result.role = officeRole(input.role); }
	if (input.managerRepoIds !== undefined) {
		if (!Array.isArray(input.managerRepoIds) || input.managerRepoIds.length > 8 || input.managerRepoIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200 || /[\r\n\0]/.test(id))) { throw new Error('The manager repository assignments are invalid.'); }
		result.managerRepoIds = [...new Set(input.managerRepoIds)];
	}
	if (input.managerForRole !== undefined) { result.managerForRole = managerScope(input.managerForRole); }
	if (input.providerKind !== undefined) {
		if (!['claude', 'codex', 'grok'].includes(input.providerKind)) {
			throw new Error('Open Pixel Agents: Invalid provider kind.');
		}
		result.providerKind = input.providerKind;
	}
	if (input.status !== undefined) {
		if (!statusOrder.includes(input.status)) {
			throw new Error('Open Pixel Agents: Invalid office status.');
		}
		result.status = input.status;
	}
	if (input.needsInput !== undefined) {
		if (typeof input.needsInput !== 'boolean') {
			throw new Error('Open Pixel Agents: Invalid input-wait metadata.');
		}
		result.needsInput = input.needsInput;
	}
	for (const key of ['usageTokens', 'estimatedCost'] as const) {
		if (input[key] !== undefined) {
			if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0) {
				throw new Error(`Open Pixel Agents: Invalid ${key} metadata.`);
			}
			result[key] = input[key];
		}
	}
	if (input.pricing !== undefined) {
		const p = input.pricing;
		if (!p || typeof p.providerId !== 'string' || typeof p.modelId !== 'string' ||
			![p.input, p.output].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0) ||
			[p.cacheRead, p.cacheWrite].some((value) => value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))) {
			throw new Error('Open Pixel Agents: Invalid catalog pricing.');
		}
		result.pricing = { providerId: p.providerId, modelId: p.modelId, input: p.input, output: p.output,
			...(p.cacheRead === undefined ? {} : { cacheRead: p.cacheRead }),
			...(p.cacheWrite === undefined ? {} : { cacheWrite: p.cacheWrite }) };
	}
	return result;
}

function usage(info: Record<string, unknown>): CompletedUsage {
	const tokens = object(info.tokens);
	const cache = object(tokens.cache);
	const input = number(tokens.input);
	const output = number(tokens.output);
	const reasoning = number(tokens.reasoning);
	const cacheRead = number(cache.read);
	const cacheWrite = number(cache.write);
	return {
		tokens: typeof tokens.total === 'number' && Number.isFinite(tokens.total) && tokens.total >= 0
			? tokens.total : input + output + reasoning + cacheRead + cacheWrite,
		input, output, reasoning, cacheRead, cacheWrite,
		providerId: text(info.providerID), modelId: text(info.modelID),
	};
}

function cost(items: CompletedUsage[], pricing: OfficePricing): number | undefined {
	let total = 0;
	for (const item of items) {
		if (item.providerId !== pricing.providerId || item.modelId !== pricing.modelId ||
			(item.cacheRead > 0 && pricing.cacheRead === undefined) || (item.cacheWrite > 0 && pricing.cacheWrite === undefined)) {
			return undefined;
		}
		total += (item.input * pricing.input + (item.output + item.reasoning) * pricing.output +
			item.cacheRead * (pricing.cacheRead ?? 0) + item.cacheWrite * (pricing.cacheWrite ?? 0)) / 1_000_000;
	}
	return total;
}

export class OfficeTelemetry {
	private readonly sessions = new Map<string, OfficeSession>();

	constructor(private readonly agents: Map<number, AgentState>) {}

	owner(sessionId: string): number | undefined {
		return this.sessions.get(sessionId)?.agentId;
	}

	private create(agentId: number, sessionId: string, parentId?: string): OfficeSession {
		const record: OfficeSession = { sessionId, agentId, parentId, failed: false, manualNeedsInput: false,
			permissions: new Set(), questions: new Set(), tools: new Map(), completed: new Map(), messageRoles: new Map(), textParts: new Map() };
		this.sessions.set(sessionId, record);
		return record;
	}

	register(agent: AgentState): void {
		if (agent.sessionId && !this.sessions.has(agent.sessionId)) {
			const record = this.create(agent.id, agent.sessionId);
			record.manualStatus = agent.officeMetadata?.status;
			record.manualNeedsInput = agent.officeMetadata?.needsInput ?? false;
		}
	}

	remove(agentId: number): void {
		for (const [id, record] of this.sessions) {
			if (record.agentId === agentId) {
				this.sessions.delete(id);
			}
		}
	}

	updateMetadata(agentId: number, patch: OfficeWorkerMetadata): void {
		for (const record of this.sessions.values()) {
			if (record.agentId !== agentId) {
				continue;
			}
			if (!record.parentId && patch.status !== undefined) {
				record.manualStatus = patch.status;
			}
			if (patch.needsInput === false) {
				record.permissions.clear();
				record.questions.clear();
				record.manualNeedsInput = false;
				if (record.manualStatus === 'needs input') {
					record.manualStatus = undefined;
				}
			} else if (!record.parentId && patch.needsInput === true) {
				record.manualNeedsInput = true;
			}
		}
	}

	private replay(record: OfficeSession, messages: RuntimeMessage[]): void {
		record.completed.clear();
		record.tools.clear();
		for (const message of messages) {
			this.reduceMessage(record, message.info as unknown as Record<string, unknown>);
			for (const part of message.parts) {
				this.reducePart(record, part as unknown as Record<string, unknown>, false);
			}
		}
	}

	hydrate(agent: AgentState, snapshot: RuntimeSessionSnapshot): void {
		this.register(agent);
		if (!agent.sessionId) {
			return;
		}
		const root = this.sessions.get(agent.sessionId)!;
		root.status = snapshot.status;
		this.replay(root, snapshot.messages);
		for (const child of snapshot.children) {
			const record = this.sessions.get(child.info.id) ?? this.create(agent.id, child.info.id, agent.sessionId);
			record.status = child.status;
			this.replay(record, child.messages);
		}
	}

	private reduceMessage(record: OfficeSession, info: Record<string, unknown>): void {
		if (typeof info.id === 'string' && typeof info.role === 'string') {
			record.messageRoles.set(info.id, info.role);
		}
		if (info.role !== 'assistant') {
			return;
		}
		const completed = object(info.time).completed;
		if (typeof completed === 'number' && typeof info.id === 'string') {
			record.completed.set(info.id, usage(info));
			if (!info.error) {
				record.failed = false;
			}
		}
		if (info.error) {
			record.failed = !text(object(info.error).name)?.toLowerCase().includes('abort');
		}
	}

	private speak(record: OfficeSession, key: string, value: string, source: OfficeSpeech['source']): void {
		if (record.textParts.get(key) === value) { return; }
		record.textParts.set(key, value);
		// Canvas text is plain text. Hide common credential-shaped substrings and
		// control characters before producing a short, ephemeral public excerpt.
		const safe = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ')
			.replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]')
			.replace(/\b(?:sk-|ghp_|github_pat_)[a-zA-Z0-9_-]{16,}/g, '[redacted]').trim();
		if (!safe) { return; }
		const excerpt = safe.length > OFFICE_SPEECH_MAX_LENGTH ? `${safe.slice(0, OFFICE_SPEECH_MAX_LENGTH - 1)}…` : safe;
		record.speech = { text: excerpt, expiresAt: Date.now() + OFFICE_SPEECH_DURATION_MS, source };
	}

	nextSpeechExpiry(now = Date.now()): number | undefined {
		const times = [...this.sessions.values()].flatMap(record => record.speech && record.speech.expiresAt > now ? [record.speech.expiresAt] : []);
		return times.length ? Math.min(...times) : undefined;
	}

	expireSpeech(now = Date.now()): number[] {
		const changed = new Set<number>();
		for (const record of this.sessions.values()) {
			if (record.speech && record.speech.expiresAt <= now) {
				record.speech = undefined;
				changed.add(record.agentId);
			}
		}
		return [...changed];
	}

	private reducePart(record: OfficeSession, part: Record<string, unknown>, live = true): void {
		if (live && part.type === 'text' && record.messageRoles.get(text(part.messageID) ?? '') === 'assistant' && typeof part.text === 'string') {
			this.speak(record, text(part.id) ?? 'text', part.text, 'assistant');
		}
		if (part.type !== 'tool') {
			return;
		}
		const state = object(part.state);
		const id = text(part.callID) ?? text(part.id);
		if (!id) {
			return;
		}
		if (live && part.tool === 'task' && typeof object(state.input).prompt === 'string') {
			this.speak(record, `task:${id}`, object(state.input).prompt as string, 'task');
		}
		if (state.status === 'pending' || state.status === 'running') {
			record.tools.set(id, text(part.tool) ?? 'tool');
		} else {
			record.tools.delete(id);
		}
	}

	handleEvent(event: RuntimeGlobalEvent): number | undefined {
		const payload = event.payload;
		if (!payload) {
			return undefined;
		}
		const props = payload.properties ?? {};
		const info = object(props.info);
		if (payload.type === 'session.created') {
			const parent = this.sessions.get(text(info.parentID) ?? '');
			const id = text(info.id);
			if (parent && id) {
				this.create(parent.agentId, id, parent.sessionId);
				return parent.agentId;
			}
			return undefined;
		}
		const part = object(props.part);
		const sessionId = text(props.sessionID) ?? text(info.sessionID) ?? text(part.sessionID) ??
			(payload.type === 'session.deleted' ? text(info.id) : undefined);
		const record = this.sessions.get(sessionId ?? '');
		if (!record) {
			return undefined;
		}
		if (payload.type === 'session.status' || payload.type === 'session.idle') {
			record.status = payload.type === 'session.idle' ? { type: 'idle' } : props.status as RuntimeSessionStatus;
			// A late runtime idle event must not overwrite the companion turn/queue state.
			if (!this.agents.get(record.agentId)?.readOnly) { record.manualStatus = undefined; }
			if (record.status?.type === 'busy') {
				record.failed = false;
			} else if (record.status?.type === 'idle') {
				record.permissions.clear();
				record.questions.clear();
				record.manualNeedsInput = false;
				record.tools.clear();
			}
		} else if (payload.type === 'permission.asked' || payload.type === 'question.asked') {
			const id = text(props.id) ?? text(props.requestID) ?? record.sessionId;
			(payload.type === 'permission.asked' ? record.permissions : record.questions).add(id);
		} else if (['permission.replied', 'question.replied', 'question.rejected'].includes(payload.type)) {
			const requests = payload.type === 'permission.replied' ? record.permissions : record.questions;
			const id = text(props.requestID) ?? text(props.id);
			if (id) {
				requests.delete(id);
			} else {
				requests.clear();
			}
			if (!record.permissions.size && !record.questions.size) {
				record.manualNeedsInput = false;
				if (record.manualStatus === 'needs input') {
					record.manualStatus = undefined;
				}
			}
		} else if (payload.type === 'session.error') {
			record.failed = !text(object(props.error).name)?.toLowerCase().includes('abort');
			record.permissions.clear();
			record.questions.clear();
			record.manualNeedsInput = false;
			record.manualStatus = undefined;
		} else if (payload.type === 'message.updated') {
			this.reduceMessage(record, info);
		} else if (payload.type === 'message.part.updated') {
			this.reducePart(record, part);
		} else if (payload.type === 'message.part.delta' && props.field === 'text') {
			const id = text(props.partID);
			if (id && record.messageRoles.get(text(props.messageID) ?? '') === 'assistant' && typeof props.delta === 'string') {
				this.speak(record, id, (record.textParts.get(id) ?? '') + props.delta, 'assistant');
			}
		} else if (payload.type === 'session.deleted') {
			this.sessions.delete(record.sessionId);
		} else {
			return undefined;
		}
		return record.agentId;
	}

	private status(record: OfficeSession): OfficeStatus {
		if (record.permissions.size || record.questions.size || record.manualNeedsInput || record.manualStatus === 'needs input') {
			return 'needs input';
		}
		if (record.failed || record.manualStatus === 'failed') {
			return 'failed';
		}
		if (this.agents.get(record.agentId)?.readOnly && record.manualStatus && !['working', 'reading'].includes(record.manualStatus)) {
			return record.manualStatus;
		}
		if (record.tools.size) {
			return [...record.tools.values()].every((tool) => readingTools.has(tool.toLowerCase())) ? 'reading' : 'working';
		}
		if (record.status?.type === 'busy') {
			return 'working';
		}
		if (record.status?.type === 'retry') {
			return 'waiting';
		}
		if (record.manualStatus) {
			return record.manualStatus;
		}
		return record.completed.size ? 'done' : 'idle';
	}

	private label(record: OfficeSession, currentChildren?: Set<string>): OfficeLabel {
		const agent = this.agents.get(record.agentId);
		const metadata = agent?.officeMetadata ?? {};
		const statuses = [this.status(record)];
		if (currentChildren) {
			for (const child of this.sessions.values()) {
				if (child.agentId === record.agentId && child.parentId && (currentChildren.has(child.sessionId) || child.permissions.size || child.questions.size || child.tools.size || child.status?.type === 'busy' || child.status?.type === 'retry')) {
					statuses.push(this.status(child));
				}
			}
		}
		const status = statuses.sort((a, b) => statusOrder.indexOf(a) - statusOrder.indexOf(b))[0];
		const label: OfficeLabel = { name: metadata.name ?? agent?.displayName ?? `Agent ${record.agentId}`,
			status, role: metadata.role ?? 'builder', managerForRole: metadata.managerForRole, repoId: metadata.repoId, repoName: metadata.repoName, managerRepoIds: metadata.managerRepoIds, providerKind: metadata.providerKind, needsInput: status === 'needs input', managed: agent?.readOnly === true };
		if (record.speech && record.speech.expiresAt > Date.now()) { label.speech = { ...record.speech }; }
		if (metadata.providerKind === 'codex') {
			const items = [...record.completed.values()];
			label.usageTokens = Math.max(items.reduce((total, item) => total + item.tokens, 0), record.parentId ? 0 : metadata.usageTokens ?? 0);
			if (metadata.pricing && metadata.pricing.providerId === metadata.providerId && metadata.pricing.modelId === metadata.modelId) {
				const calculated = cost(items, metadata.pricing);
				if (calculated !== undefined) {
					label.estimatedCost = Math.max(calculated, record.parentId ? 0 : metadata.estimatedCost ?? 0);
				}
			}
		}
		return label;
	}

	decorate(vm: AgentRuntimeVm): AgentRuntimeVm {
		const root = this.sessions.get(vm.sessionId);
		if (!root) {
			return vm;
		}
		vm.officeLabel = this.label(root, new Set(vm.subagents.map(child => child.sessionId)));
		for (const child of vm.subagents) {
			const record = this.sessions.get(child.sessionId);
			child.officeLabel = record ? this.label(record) : { ...vm.officeLabel, status: 'working', needsInput: false, speech: undefined,
				...(vm.officeLabel.providerKind === 'codex' ? { usageTokens: 0, estimatedCost: undefined } : {}) };
		}
		// Keep blocked children visible even when a status snapshot has no active
		// tools. Questions are independent events, not ordinary tool calls.
		for (const record of this.sessions.values()) {
			if (record.agentId !== vm.agentId || !record.parentId || vm.subagents.some((sub) => sub.sessionId === record.sessionId) || (this.status(record) !== 'needs input' && !(record.speech && record.speech.expiresAt > Date.now()))) {
				continue;
			}
			const child: SubagentRuntimeVm = { id: record.sessionId, sessionId: record.sessionId, label: vm.officeLabel.name,
				status: this.status(record) === 'done' ? 'completing' : 'active', permissionAsked: record.permissions.size > 0, tools: [], officeLabel: this.label(record) };
			vm.subagents.push(child);
		}
		return vm;
	}
}
