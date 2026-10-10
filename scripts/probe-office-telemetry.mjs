import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/runtime/officeTelemetry.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const { OfficeTelemetry, normalizeOfficeMetadata } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const agent = { id: 1, sessionId: 'root', displayName: 'Reviewer', officeMetadata: { name: 'Reviewer', providerKind: 'codex', providerId: 'openai', modelId: 'test-model' } };
const agents = new Map([[1, agent]]);
const telemetry = new OfficeTelemetry(agents);
telemetry.register(agent);
const event = (type, properties) => telemetry.handleEvent({ directory: '/workspace', payload: { type, properties } });
const vm = () => telemetry.decorate({ agentId: 1, sessionId: 'root', status: 'waiting', permissionAsked: false, tools: [], subagents: [{ id: 'child', sessionId: 'child', label: 'task', status: 'active', permissionAsked: false, tools: [] }] });
const label = () => vm().officeLabel;

assert.equal(label().status, 'idle');
assert.equal(label().usageTokens, 0);
assert.equal(label().estimatedCost, undefined);
event('session.status', { sessionID: 'root', status: { type: 'busy' } });
event('message.part.updated', { part: { id: 'tool', sessionID: 'root', type: 'tool', tool: 'read', state: { status: 'running' } } });
assert.equal(label().status, 'reading');
event('permission.asked', { id: 'p1', sessionID: 'root' });
event('permission.asked', { id: 'p2', sessionID: 'root' });
assert.equal(label().status, 'needs input');
assert.equal(label().needsInput, true);
event('permission.replied', { requestID: 'p1', sessionID: 'root' });
assert.equal(label().status, 'needs input');
event('permission.replied', { requestID: 'p2', sessionID: 'root' });
assert.equal(label().status, 'reading');
const beforeUnknown = label();
event('future.unknown', { sessionID: 'root' });
assert.deepEqual(label(), beforeUnknown);
event('server.heartbeat', undefined);
assert.deepEqual(label(), beforeUnknown, 'Heartbeat events without properties must not interrupt SSE.');
console.log('PASS: idle/read/needs-input precedence, simultaneous asks, reply lifecycle, and unknown-event preservation.');

event('session.created', { info: { id: 'child', parentID: 'root', title: 'child task' } });
event('question.asked', { id: 'q1', sessionID: 'child', questions: [{ question: 'Continue?' }] });
assert.equal(label().status, 'needs input');
assert.equal(vm().subagents[0].officeLabel.name, 'Reviewer');
assert.equal(vm().subagents[0].officeLabel.needsInput, true);
assert.equal(vm().subagents[0].officeLabel.usageTokens, 0);
event('question.rejected', { requestID: 'q1', sessionID: 'child' });
assert.equal(label().status, 'reading');
assert.equal(vm().subagents[0].officeLabel.needsInput, false);
console.log('PASS: child questions raise/lower the parent and child hand, inheriting the parent worker name.');

const message = { id: 'm1', sessionID: 'root', role: 'assistant', providerID: 'openai', modelID: 'test-model', time: { created: 1, completed: 2 },
  tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } } };
event('message.updated', { info: message });
event('message.updated', { info: message });
assert.equal(label().usageTokens, 21);
agent.officeMetadata = normalizeOfficeMetadata({ pricing: { providerId: 'openai', modelId: 'test-model', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 } }, agent.officeMetadata);
assert.ok(Math.abs(label().estimatedCost - 0.0000245) < 1e-12);
event('message.updated', { info: { ...message, id: 'm2', modelID: 'another-model', tokens: { ...message.tokens, total: 100 } } });
assert.equal(label().usageTokens, 121);
assert.equal(label().estimatedCost, undefined);
agent.officeMetadata = normalizeOfficeMetadata({ providerKind: 'claude' }, agent.officeMetadata);
assert.equal(label().usageTokens, undefined);
assert.equal(label().estimatedCost, undefined);
console.log('PASS: completed-message deduplication, cumulative tokens, authoritative total, exact-model pricing gate, and Codex-only usage.');

event('session.error', { sessionID: 'root', error: { name: 'ProviderError' } });
assert.equal(label().status, 'failed');
event('session.status', { sessionID: 'root', status: { type: 'busy' } });
assert.equal(label().status, 'reading');
event('question.asked', { id: 'abort-me', sessionID: 'root' });
event('session.idle', { sessionID: 'root' });
assert.equal(label().needsInput, false);
assert.equal(label().status, 'done');
telemetry.updateMetadata(1, { status: 'waiting' });
assert.equal(label().status, 'waiting');
telemetry.updateMetadata(1, { needsInput: true });
assert.equal(label().needsInput, true);
telemetry.updateMetadata(1, { needsInput: false, status: 'idle' });
assert.equal(label().needsInput, false);
assert.equal(label().status, 'idle');
console.log('PASS: failed/start lifecycle, abort idle clears waits, and queue/manual status updates.');

const metadata = normalizeOfficeMetadata({ name: 'Safe', apiKey: 'must-not-persist', credentials: { access: 'must-not-persist' } });
assert.deepEqual(metadata, { name: 'Safe' });
assert.throws(() => normalizeOfficeMetadata({ usageTokens: NaN }));
assert.throws(() => normalizeOfficeMetadata({ status: 'unsupported' }));
assert.throws(() => normalizeOfficeMetadata({ pricing: { providerId: 'openai', modelId: 'test-model', input: -1, output: 0 } }));
const replay = new OfficeTelemetry(agents);
replay.hydrate(agent, { sessionId: 'root', status: { type: 'idle' }, messages: [{ info: message, parts: [] }], children: [] });
agent.officeMetadata = normalizeOfficeMetadata({ providerKind: 'codex' }, agent.officeMetadata);
assert.equal(replay.decorate({ agentId: 1, sessionId: 'root', status: 'waiting', permissionAsked: false, tools: [], subagents: [] }).officeLabel.usageTokens, 21);
console.log('PASS: metadata whitelist rejects secrets/invalid values, and restore rebuilds session usage from history.');

agent.readOnly = true;
telemetry.updateMetadata(1, { status: 'done' });
event('session.idle', { sessionID: 'root' });
assert.equal(label().status, 'done', 'A late SSE idle must preserve the companion completed-turn status.');
event('message.updated', { info: { id: 'user-text', sessionID: 'root', role: 'user' } });
event('message.part.updated', { part: { id: 'user-part', messageID: 'user-text', sessionID: 'root', type: 'text', text: 'Never echo the user prompt.' } });
assert.equal(label().speech, undefined);
event('message.updated', { info: { id: 'spoken-root', sessionID: 'root', role: 'assistant' } });
event('message.part.delta', { sessionID: 'root', messageID: 'spoken-root', partID: 'root-text', field: 'text', delta: 'Real root ' });
event('message.part.delta', { sessionID: 'root', messageID: 'spoken-root', partID: 'root-text', field: 'text', delta: 'reply.' });
assert.equal(label().speech.text, 'Real root reply.');
assert.equal(vm().subagents[0].officeLabel.speech, undefined, 'Root speech cannot be copied above its child.');
event('message.updated', { info: { id: 'spoken-child', sessionID: 'child', role: 'assistant' } });
event('message.part.updated', { part: { id: 'child-text', messageID: 'spoken-child', sessionID: 'child', type: 'text', text: 'Real child reply.' } });
assert.equal(vm().subagents[0].officeLabel.speech.text, 'Real child reply.');
assert.equal(label().speech.text, 'Real root reply.');
event('message.part.updated', { part: { id: 'delegation', sessionID: 'root', type: 'tool', tool: 'task', state: { status: 'running', input: { prompt: 'Inspect the repository. Bearer fabricated-secret' } } } });
assert.equal(label().speech.source, 'task');
assert.equal(label().speech.text, 'Inspect the repository. Bearer [redacted]');
telemetry.expireSpeech(Date.now() + 10_000);
assert.equal(label().speech, undefined);
assert.equal(vm().subagents[0].officeLabel.speech, undefined);
assert.equal(label().name, 'Reviewer', 'Speech expiry must preserve the permanent worker label.');
assert.equal(label().managed, true);
console.log('PASS: late idle preserves managed completion; real root/child text and task prompts speak only over their own session, redact credentials, and expire.');

event('message.part.updated', { part: { id: 'delegation', sessionID: 'root', type: 'tool', tool: 'task', state: { status: 'completed' } } });
event('session.error', { sessionID: 'child', error: { name: 'ProviderError' } });
event('session.idle', { sessionID: 'child' });
const retired = () => telemetry.decorate({ agentId: 1, sessionId: 'root', status: 'waiting', permissionAsked: false, tools: [], subagents: [] });
assert.equal(retired().officeLabel.status, 'done', 'A retired failed child must not pin a completed parent as failed.');
event('question.asked', { sessionID: 'child', id: 'still-pending' });
assert.equal(retired().officeLabel.status, 'needs input', 'An unresolved child request still takes precedence even when its character was retired.');
event('question.replied', { sessionID: 'child', requestID: 'still-pending' });
assert.equal(retired().officeLabel.status, 'done');
console.log('PASS: retired child failures stop affecting parent status; actual unresolved child requests remain visible.');

const managedAgent = { id: 2, sessionId: 'managed-root', readOnly: true, displayName: 'Current worker',
  officeMetadata: { workerId: 'worker-current', providerKind: 'codex', status: 'idle', needsInput: false } };
const managedTelemetry = new OfficeTelemetry(new Map([[2, managedAgent]]));
const oldError = { id: 'old-invalid-model', sessionID: 'managed-root', role: 'assistant',
  time: { created: 1, completed: 2 }, error: { name: 'ModelNotFoundError' }, tokens: { input: 3, output: 2 } };
const managedSnapshot = { sessionId: 'managed-root', status: { type: 'idle' }, messages: [{ info: oldError,
  parts: [{ id: 'old-read', sessionID: 'managed-root', type: 'tool', tool: 'read', state: { status: 'running' } }] }],
  children: [{ info: { id: 'old-child', parentID: 'managed-root' }, status: { type: 'idle' },
    messages: [{ info: { ...oldError, id: 'old-child-error', sessionID: 'old-child' }, parts: [] }] }] };
const managedVm = () => managedTelemetry.decorate({ agentId: 2, sessionId: 'managed-root', status: 'waiting', permissionAsked: false, tools: [],
  subagents: [{ id: 'old-child', sessionId: 'old-child', label: 'Old child', status: 'waiting', permissionAsked: false, tools: [] }] });
const managedEvent = (type, properties) => managedTelemetry.handleEvent({ directory: '/workspace', payload: { type, properties } });
managedTelemetry.hydrate(managedAgent, managedSnapshot);
assert.equal(managedVm().officeLabel.status, 'idle', 'A restored invalid-model failure must not override the current managed idle snapshot.');
assert.equal(managedVm().officeLabel.usageTokens, 5, 'Historical usage is retained while historical failure status is superseded.');
assert.equal(managedVm().subagents[0].officeLabel.status, 'failed', 'Child session detail is retained without pinning its authoritative parent as failed.');
managedTelemetry.updateMetadata(2, { status: 'working' });
assert.equal(managedVm().officeLabel.status, 'working', 'A current active turn remains working even when history contains an error and unfinished reading tool.');
managedEvent('message.part.updated', { part: { id: 'current-read', sessionID: 'managed-root', type: 'tool', tool: 'read', state: { status: 'running' } } });
assert.equal(managedVm().officeLabel.status, 'working', 'Live raw tool work must await the companion current-turn status rather than override it.');
managedTelemetry.updateMetadata(2, { status: 'reading' });
assert.equal(managedVm().officeLabel.status, 'reading');
managedEvent('session.idle', { sessionID: 'managed-root' });
assert.equal(managedVm().officeLabel.status, 'reading', 'Late raw idle cannot end the authoritative current reading turn.');
managedEvent('session.error', { sessionID: 'managed-root', error: { name: 'ProviderError' } });
managedTelemetry.updateMetadata(2, { status: 'failed' });
managedEvent('message.updated', { info: { ...oldError, id: 'older-success', error: undefined } });
assert.equal(managedVm().officeLabel.status, 'failed', 'A current authoritative failure is not erased by older successful message telemetry.');
managedTelemetry.updateMetadata(2, { status: 'idle', needsInput: false });
assert.equal(managedVm().officeLabel.status, 'idle', 'Stop/recovery to idle supersedes the last live error.');
managedTelemetry.hydrate(managedAgent, managedSnapshot);
assert.equal(managedVm().officeLabel.status, 'idle', 'A subsequent hydration cannot bring back the superseded historical failure.');
managedTelemetry.updateMetadata(2, { status: 'waiting' });
managedEvent('session.status', { sessionID: 'managed-root', status: { type: 'busy' } });
assert.equal(managedVm().officeLabel.status, 'waiting', 'A queued worker is not reactivated by a late raw busy frame.');
managedEvent('question.asked', { sessionID: 'old-child', id: 'current-ask' });
assert.equal(managedVm().officeLabel.status, 'needs input', 'An actual unresolved child request still raises the managed parent hand.');
managedTelemetry.updateMetadata(2, { status: 'idle', needsInput: false });
assert.equal(managedVm().officeLabel.status, 'idle');

const standaloneAgent = { id: 3, sessionId: 'standalone-root' };
const standaloneTelemetry = new OfficeTelemetry(new Map([[3, standaloneAgent]]));
standaloneTelemetry.hydrate(standaloneAgent, { ...managedSnapshot, sessionId: 'standalone-root', children: [],
  messages: [{ info: { ...oldError, sessionID: 'standalone-root' }, parts: [] }] });
assert.equal(standaloneTelemetry.decorate({ agentId: 3, sessionId: 'standalone-root', status: 'waiting', permissionAsked: false, tools: [], subagents: [] }).officeLabel.status, 'failed');
const unownedStatusAgent = { id: 4, sessionId: 'no-companion-status', readOnly: true };
const unownedStatusTelemetry = new OfficeTelemetry(new Map([[4, unownedStatusAgent]]));
unownedStatusTelemetry.register(unownedStatusAgent);
unownedStatusTelemetry.handleEvent({ directory: '/workspace', payload: { type: 'session.error', properties: { sessionID: 'no-companion-status', error: { name: 'ProviderError' } } } });
assert.equal(unownedStatusTelemetry.decorate({ agentId: 4, sessionId: 'no-companion-status', status: 'waiting', permissionAsked: false, tools: [], subagents: [] }).officeLabel.status, 'failed');
console.log('PASS: authoritative managed statuses supersede old root/child failures across restore and Stop, preserve real current work/failure and pending asks, and retain standalone fallback/usage.');
