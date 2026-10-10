/** Provider lifecycle/protocol regression. No VS Code process, browser, session,
 * watcher, runtime, terminal, layout file or provider inference is started. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.require = createRequire(import.meta.url);
Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.filter(frame => !String(frame.getFileName()).startsWith('data:')).map(frame => `    at ${frame}`).join('\n')}`;
class EventEmitter { listeners = new Set(); event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; fire(value) { for (const listener of this.listeners) listener(value); } dispose() { this.listeners.clear(); } }
const terminalListeners = new Set();
const terminalEvent = listener => { terminalListeners.add(listener); return { dispose: () => terminalListeners.delete(listener) }; };
let focused = 0;
globalThis.__nativeReloadVscode = {
  EventEmitter, window: { terminals: [], createOutputChannel: () => ({ appendLine() {}, dispose() {} }), onDidChangeActiveTerminal: terminalEvent, onDidCloseTerminal: terminalEvent },
  workspace: { workspaceFolders: [{ name: 'Fixture A', uri: { fsPath: '/fabricated/a' } }, { name: 'Fixture B', uri: { fsPath: '/fabricated/b' } }] },
  commands: { executeCommand: async () => { focused++; } }, Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }) },
};
const compiled = await build({ stdin: { contents: "export {PixelAgentsViewProvider} from './src/PixelAgentsViewProvider.ts';", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent', plugins: [{ name: 'vscode', setup(builder) { builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' })); builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: 'export const {EventEmitter,window,workspace,commands,Uri}=globalThis.__nativeReloadVscode;' })); } }] });
const { PixelAgentsViewProvider } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function view() {
  const messages = [], listeners = new Set(), disposal = new Set();
  return { messages, listeners, show() {}, onDidDispose(listener) { disposal.add(listener); return { dispose: () => disposal.delete(listener) }; }, close() { for (const listener of disposal) listener(); },
    webview: { asWebviewUri: uri => `fixture:${uri.fsPath}`, onDidReceiveMessage(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }, postMessage(message) { messages.push(structuredClone(message)); return Promise.resolve(true); } } };
}
const values = new Map([['office-pixel-agents.agentSeats', { 1: { seatId: 'chair-a', palette: 2 } }], ['office-pixel-agents.soundEnabled', false]]);
const state = { get: (key, fallback) => values.get(key) ?? fallback, update: async () => assert.fail('Replay must not persist anything.') };
const runtime = new Proxy({}, { get: (_target, method) => () => assert.fail(`Replay must not call runtime ${String(method)}.`) });
const sandbox = await mkdtemp(path.join(tmpdir(), 'office-native-reload-'));
await mkdir(path.join(sandbox, 'dist', 'webview'), { recursive: true });
await writeFile(path.join(sandbox, 'dist', 'webview', 'index.html'), '<!doctype html><html><body>Reload lifecycle fixture</body></html>');
const provider = new PixelAgentsViewProvider({ extensionUri: { fsPath: sandbox }, subscriptions: [], workspaceState: state, globalState: state }, runtime);
let bootstrapCalls = 0, release;
const gate = new Promise(resolve => { release = resolve; });
const agent = id => ({ id, sessionId: `fixture-${id}`, projectDir: '/fabricated/a', readOnly: true, terminalRef: { name: `Fixture ${id}`, dispose() {} }, activeToolIds: new Set(), activeToolStatuses: new Map(), activeToolNames: new Map(), activeSubagentToolIds: new Map(), activeSubagentToolNames: new Map(), isWaiting: true, permissionSent: false, hadToolsInTurn: false, officeMetadata: { workerId: `worker-${id}`, name: `Fixture ${id}`, role: 'builder', repoId: 'repo-a', status: 'idle' } });
provider.runtimeController = { postSnapshot() { provider.webview.postMessage({ type: 'runtimeSnapshot', protocolVersion: 2, agents: [...provider.agents.values()].map(value => ({ agentId: value.id, officeLabel: value.officeMetadata })) }); }, dispose() {} };
provider.bootstrapWebview = async () => {
  bootstrapCalls++; await gate;
  provider.agents.set(1, agent(1)); provider.repositories = [{ id: 'repo-a', name: 'Fixture A' }];
  for (const type of ['characterSpritesLoaded', 'floorTilesLoaded', 'wallTilesLoaded', 'furnitureAssetsLoaded', 'layoutLoaded']) provider.webview.postMessage({ type, fixture: true });
};
try {
  const old = view(); provider.resolveWebviewView(old);
  const first = provider.handleMessage({ type: 'webviewReady' });
  assert.equal(bootstrapCalls, 1); old.close();
  const replacement = view(); provider.resolveWebviewView(replacement);
  const second = provider.handleMessage({ type: 'webviewReady' });
  const duplicate = provider.handleMessage({ type: 'webviewReady' });
  assert.equal(bootstrapCalls, 1); release(); await Promise.all([first, second, duplicate]);
  assert.equal(bootstrapCalls, 1); assert.equal(provider.initialized, true); assert.equal(terminalListeners.size, 2); assert.equal(old.messages.length, 0);
  assert.equal(replacement.messages.filter(message => message.type === 'layoutLoaded').length, 2); // Initial completion + one coalesced replay.
  assert(replacement.messages.some(message => message.type === 'existingAgents' && message.agents.includes(1)));
  console.log('PASS: disposal/replacement and duplicate handshakes during initial bootstrap share one backend initialization and one latest-renderer replay.');
  replacement.messages.length = 0;
  provider.agents.set(2, agent(2));
  provider.panelStates.set(2, { worker: { id: 'worker-2', name: 'Fixture 2', role: 'builder', status: 'idle', started: true }, chat: [], busy: false, pending: false });
  values.set('office-pixel-agents.agentSeats', { 2: { seatId: 'chair-b', palette: 4 } });
  const mirrored = []; provider.browserListeners.add(message => mirrored.push(message));
  await provider.handleMessage({ type: 'webviewReady' });
  const types = replacement.messages.map(message => message.type);
  assert.deepEqual(types.filter(type => ['characterSpritesLoaded', 'floorTilesLoaded', 'wallTilesLoaded', 'furnitureAssetsLoaded', 'layoutLoaded'].includes(type)), ['characterSpritesLoaded', 'floorTilesLoaded', 'wallTilesLoaded', 'furnitureAssetsLoaded', 'layoutLoaded']);
  const roster = replacement.messages.find(message => message.type === 'existingAgents');
  assert.deepEqual(roster.agents, [1, 2]); assert.equal(roster.agentMeta[2].seatId, 'chair-b');
  assert(types.indexOf('existingAgents') < types.indexOf('layoutLoaded')); assert(types.indexOf('layoutLoaded') < types.indexOf('runtimeSnapshot'));
  assert(types.includes('settingsLoaded')); assert(types.includes('workspaceFolders')); assert(types.includes('officeRepositories')); assert(types.includes('officeAgentPanel'));
  assert.deepEqual(mirrored.map(message => message.type), ['runtimeSnapshot']); assert.equal(bootstrapCalls, 1);
  console.log('PASS: completed renderer reload replays ordered assets/layout plus current roster/seats/settings/repos/runtime/panels without browser modal or layout replay.');
  replacement.close(); const recreated = view(); provider.resolveWebviewView(recreated);
  await provider.handleMessage({ type: 'webviewReady' }); await provider.ready;
  assert.equal(bootstrapCalls, 1); assert.equal(terminalListeners.size, 2); assert(recreated.messages.some(message => message.type === 'layoutLoaded'));
  // A stale handshake awaiting the settled promise cannot target the old view.
  recreated.messages.length = 0;
  const stale = provider.handleMessage({ type: 'webviewReady' }); recreated.close();
  const latest = view(); provider.resolveWebviewView(latest); await provider.handleMessage({ type: 'webviewReady' }); await stale;
  assert.equal(recreated.messages.length, 0); assert(latest.messages.some(message => message.type === 'layoutLoaded')); assert.equal(bootstrapCalls, 1); assert.equal(focused, 0);
  console.log('PASS: recreated views reuse initialized sessions/listeners; obsolete handshakes send nothing to stale views; no runtime, persistence or focus side effects.');
} finally { provider.agents.clear(); provider.browserListeners.clear(); provider.dispose(); delete globalThis.__nativeReloadVscode; await rm(sandbox, { recursive: true, force: true }); }
