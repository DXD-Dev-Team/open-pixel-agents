/** Actual shipped React/canvas + loopback HTTP/SSE with simulated VS Code/worker
 * state. Headless only: no native VS Code window, real credentials or provider. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const fork = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url); globalThis.require = require;
let playwright;
try { playwright = require(process.env.OFFICE_PLAYWRIGHT_MODULE ?? 'playwright'); }
catch { playwright = require(path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const event = set => listener => { set.add(listener); return { dispose() { set.delete(listener); } }; };
class EventEmitter { listeners = new Set(); event = event(this.listeners); fire(value) { for (const listener of this.listeners) listener(value); } dispose() { this.listeners.clear(); } }
const commands = [], native = [];
globalThis.__browserProbeVscode = { EventEmitter, window: { terminals: [], createOutputChannel: () => ({ appendLine() {}, dispose() {} }) }, workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) }, commands: { executeCommand: async (...args) => { commands.push(args); } }, Uri: { joinPath: (root, ...parts) => ({ fsPath: path.join(root.fsPath, ...parts) }) } };
const bundled = await build({ stdin: { contents: "export {PixelAgentsViewProvider,browserDeskState,browserDeskAction} from './src/PixelAgentsViewProvider.ts'; export {createRepositoryLayout} from './webview-ui/src/office/layout/layoutSerializer.ts'; export {loadCharacterSprites,sendCharacterSpritesToWebview} from './src/assetLoader.ts';", resolveDir: fork, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent', plugins: [{ name: 'vscode', setup(builder) { builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' })); builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: 'export const {EventEmitter,window,workspace,commands,Uri}=globalThis.__browserProbeVscode;' })); } }] });
const { PixelAgentsViewProvider, browserDeskState, browserDeskAction, createRepositoryLayout, loadCharacterSprites, sendCharacterSpritesToWebview } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const rows = [{ id: 'repo-a', name: 'Fixture Repository A', readOnly: false }];
const layout = createRepositoryLayout(rows);
const seatMeta = { 1: { seatId: 'chair-0-0', palette: 0, hueShift: 0 }, 2: { seatId: 'chair-2-0', palette: 1, hueShift: 0 }, 3: { seatId: 'chair-2-1', palette: 2, hueShift: 0 } };
const values = new Map([['office-pixel-agents.agentSeats', seatMeta]]);
const state = { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => { values.set(key, structuredClone(value)); } };
const provider = new PixelAgentsViewProvider({ extensionUri: { fsPath: fork }, subscriptions: [], workspaceState: state, globalState: state }, {});
provider.ensureReady = async () => undefined;
provider.webviewView = { webview: { postMessage(message) { native.push(message); return Promise.resolve(true); } } };
const roles = ['builder', 'security-reviewer', 'verifier'];
const snapshot = () => [...provider.agents.values()].map(agent => ({ agentId: agent.id, sessionId: agent.sessionId, status: 'waiting', permissionAsked: false, tools: [], subagents: [], officeLabel: { ...agent.officeMetadata, managed: true, needsInput: false } }));
provider.runtimeController = { postSnapshot() { provider.webview.postMessage({ type: 'runtimeSnapshot', protocolVersion: 2, agents: snapshot() }); }, dispose() {} };
for (let id = 1; id <= 3; id++) provider.agents.set(id, { id, sessionId: `fixture-session-${id}`, readOnly: true, activeToolStatuses: new Map(), isWaiting: true, serverPort: 1, projectDir: '/fabricated/never-accessed', terminalRef: { name: `Fixture ${id}`, dispose() {} }, officeMetadata: { workerId: `worker-${id}`, name: `Fixture ${id}`, role: roles[id - 1], repoId: 'repo-a', repoName: rows[0].name, status: 'idle', providerKind: 'codex', usageTokens: 0 } });
provider.webview.postMessage({ type: 'settingsLoaded', soundEnabled: false });
const characters = await loadCharacterSprites(path.join(fork, 'dist')); assert(characters); sendCharacterSpritesToWebview(provider.webview, characters);
provider.webview.postMessage({ type: 'officeRepositories', repositories: rows, requestId: 0 });
provider.webview.postMessage({ type: 'layoutLoaded', layout });
const desk = { ready: true, setup: { complete: false }, accounts: [{ id: 'account-a', name: 'Fixture account', kind: 'codex', authType: 'oauth', connected: true, loginName: 'Fixture User', access: 'DO-NOT-EXPORT' }], repositories: [{ ...rows[0], path: '/DO-NOT-EXPORT' }], workers: [...provider.agents.values()].map(agent => ({ definition: { id: agent.officeMetadata.workerId, name: agent.officeMetadata.name, role: agent.officeMetadata.role, repoId: 'repo-a', accountId: 'account-a', providerId: 'openai', modelId: 'fixture-model', key: 'DO-NOT-EXPORT' }, status: 'idle', binding: { agentId: agent.id, url: 'http://DO-NOT-EXPORT', cwd: '/DO-NOT-EXPORT' } })), attention: [{ id: 'fixture-permission', workerId: 'worker-1', workerName: 'Fixture 1', kind: 'permission', ask: 'Fixture asks permission to read a file.' }] };
desk.workers.push({ definition: { id: 'worker-closed', name: 'Closed fixture', role: 'manager', repoId: 'repo-a', manager: { paused: true } }, status: 'idle' });
provider.setDeskState(desk);
assert(!JSON.stringify(browserDeskState(desk)).includes('DO-NOT-EXPORT'));
assert.deepEqual(browserDeskAction({ type: 'officeDeskAction', action: 'createWorker', command: 'evil', token: 'DO-NOT-EXPORT' }), { action: 'createWorker', browser: true });
for (const type of ['saveLayout', 'saveAgentSeats', 'officeRepositoriesApplied', 'officeSeatCapacity', 'officeRoleSeatApplied', 'officeSnapshot', 'officeSnapshotReady', 'webviewReady', 'executeCommand']) await assert.rejects(provider.handleBrowserMessage({ type, requestId: 9, command: 'evil' }));
await assert.rejects(provider.handleBrowserMessage({ type: 'officeAgentAction', action: 'send', agentId: 999, requestId: 'missing', text: 'Fixture' }));
let finishClose;
provider.browserServer = { dispose: () => new Promise(resolve => { finishClose = resolve; }) };
const firstClose = provider.disposeBrowserOffice(), secondClose = provider.disposeBrowserOffice();
let closed = false; void secondClose.then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
finishClose(); await Promise.all([firstClose, secondClose]); assert.equal(closed, true);
console.log('PASS: provider browser actions exclude native authority, arbitrary commands, unmanaged agents and private fields.');
const panels = new Map();
for (let id = 1; id <= 3; id++) { const panel = { worker: { id: `worker-${id}`, name: `Fixture ${id}`, role: roles[id - 1], status: 'idle', started: true }, chat: [{ id: `chat-${id}`, role: 'assistant', text: `Fixture conversation ${id}`, createdAt: 1 }], pending: false, busy: false, accounts: desk.accounts, account: desk.accounts[0] }; panels.set(id, panel); await provider.setAgentPanelState(id, panel); }
// Fixed host command simulation: each browser may open a chat without opening a
// dialog in the other screen. OpenCode inference is deliberately absent.
globalThis.__browserProbeVscode.commands.executeCommand = async (...args) => {
  commands.push(args);
  if (args[0] === 'office-desk.browserAction' && args[1].action === 'chatWorker') {
    const id = Number(args[1].id.replace('worker-', '')); if (panels.has(id)) await provider.setAgentPanelState(id, panels.get(id));
  }
};
let starts = 0;
provider.bridgeEvents.event(action => { if (action.action === 'start') starts++; if (action.action === 'send') { const panel = panels.get(action.agentId); panel.chat.push({ id: `accepted-${Date.now()}`, role: 'user', text: action.text, createdAt: Date.now() }); void provider.setAgentPanelState(action.agentId, panel); } });
const output = path.join(fork, '..', 'spike', 'results'); await mkdir(output, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1180, height: 680 }, deviceScaleFactor: 2 });
  const page = await context.newPage(); page.setDefaultTimeout(8000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  const url = await provider.openBrowserOffice();
  await page.goto(url); await page.waitForSelector('canvas[data-office-canvas]');
  assert.equal(await page.title(), 'The Office');
  await page.getByText('Connected to VS Code · Layout is managed in VS Code').waitFor();
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.getByRole('button', { name: 'Layout', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).count(), 0);
  await page.getByRole('button', { name: /Team · 4/ }).click();
  await page.getByRole('heading', { name: /Closed fixture/ }).waitFor();
  await page.getByRole('button', { name: 'Chat & controls', exact: true }).last().click();
  await page.waitForFunction(() => document.querySelector('.office-browser-desk')?.textContent.includes('Starting…'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert(commands.some(([, action]) => action?.action === 'chatWorker' && action.id === 'worker-closed'));
  assert(!commands.some(([, action]) => action?.action === 'startWorker' && action.id === 'worker-closed'));
  await page.getByRole('button', { name: 'Open chats in VS Code', exact: true }).click();
  await new Promise(resolve => setTimeout(resolve, 100)); assert(commands.some(([, action]) => action?.action === 'openAgentChats'));
  await page.getByText('Complete provider setup in VS Code, or skip and connect accounts later.').waitFor();
  await page.getByRole('button', { name: 'Close office desk', exact: true }).click();
  await page.locator('canvas[data-office-canvas]').click({ position: { x: (1180 - layout.cols * 16) / 2 + 3.5 * 16, y: (680 - layout.rows * 16) / 2 + 6.5 * 16 - 8 } });
  await page.getByRole('dialog').waitFor(); await page.getByText('Fixture conversation 1').waitFor();
  assert(commands.some(([name, action]) => name === 'office-desk.browserAction' && action.action === 'chatWorker' && action.id === 'worker-1' && action.browser));
  const second = await context.newPage(); second.setDefaultTimeout(8000); second.on('pageerror', error => errors.push(error.message)); await second.goto(await provider.openBrowserOffice()); await second.waitForSelector('canvas[data-office-canvas]');
  await second.getByText('Connected to VS Code · Layout is managed in VS Code').waitFor();
  assert.equal(await second.getByRole('dialog').count(), 0);
  await provider.openAgentPanel(2); await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await second.getByRole('dialog').count(), 0); assert.equal(await page.getByRole('heading', { name: 'Fixture 1', exact: true }).count(), 1);
  await second.getByRole('button', { name: /Team · 4/ }).click();
  await second.getByRole('button', { name: 'Chat & controls', exact: true }).first().click(); await second.getByRole('dialog').waitFor();
  await page.getByRole('textbox', { name: 'Message this worker' }).fill('Headless browser chat fixture'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.office-dialog-chat').getByText('Headless browser chat fixture', { exact: true }).waitFor();
  await second.locator('.office-dialog-chat').getByText('Headless browser chat fixture', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#office-agent-message')?.value === '');
  assert.equal(await page.getByRole('textbox', { name: 'Message this worker' }).inputValue(), '');
  const nativeView = provider.webviewView; provider.webviewView = undefined;
  panels.get(1).chat.push({ id: 'native-view-disposed', role: 'assistant', text: 'Live update while native view is disposed', createdAt: 2 });
  await provider.setAgentPanelState(1, panels.get(1)); provider.runtimeController.postSnapshot();
  await page.getByText('Live update while native view is disposed', { exact: true }).waitFor(); provider.webviewView = nativeView;
  await page.getByRole('button', { name: 'Close agent controls', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'office_browser_ready.png') });
  console.log('PASS: real loopback capability/cookie/CSRF transport bootstraps shipped canvas and shared chat, with local modals and bounded public roster.');
  // Native authority cannot be resolved by the browser even through its HTTP endpoint.
  const blocked = await page.evaluate(async () => { const handshake = await fetch('/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); const { csrf } = await handshake.json(); return (await fetch('/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Office-CSRF': csrf }, body: JSON.stringify({ type: 'officeSeatCapacity', requestId: 9, seatId: 'forged' }) })).status; }); assert.equal(blocked, 500);
  await page.reload(); await page.waitForSelector('canvas[data-office-canvas]'); await page.getByText('Connected to VS Code · Layout is managed in VS Code').waitFor();
  assert.equal(provider.browserListeners.size, 2);
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await page.getByText('Connected to VS Code · Layout is managed in VS Code').waitFor();
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(provider.browserListeners.size, 2);
  console.log('PASS: refresh and bfcache restore re-bootstrap without duplicate streams; HTTP native ACK injection is refused.');
  await second.close();
  await page.getByRole('button', { name: /Team · 4/ }).click();
  await page.getByRole('button', { name: 'Chat & controls', exact: true }).first().click(); await page.getByRole('dialog').waitFor();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await new Promise(resolve => setTimeout(resolve, 100));
  provider.agents.delete(1); provider.panelStates.delete(1); desk.workers = desk.workers.filter(worker => worker.definition.id !== 'worker-1'); provider.setDeskState(desk);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.getByText('Connected to VS Code · Layout is managed in VS Code').waitFor();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.getByRole('button', { name: /Team · 3/ }).waitFor();
  await page.setViewportSize({ width: 390, height: 780 });
  await page.getByRole('button', { name: 'Chat & controls', exact: true }).first().click(); await page.getByRole('dialog').waitFor();
  await page.screenshot({ path: path.join(output, 'office_browser_mobile.png') });
  assert(await page.getByRole('dialog').evaluate(node => node.getBoundingClientRect().width <= window.innerWidth));
  const expired = await context.newPage(); expired.setDefaultTimeout(8000);
  await expired.goto(new URL('/#office-token=invalid-fixture-token', url).href);
  await expired.getByText('Open Browser Office from VS Code to begin a new session.').waitFor();
  await expired.getByText('Reopen Browser Office from VS Code to reconnect.').waitFor();
  assert.equal(new URL(expired.url()).hash, ''); assert.equal(provider.browserListeners.size, 1); await expired.close();
  await provider.disposeBrowserOffice(); await page.getByText(/connection lost|Reopen Browser Office/).first().waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Start', exact: true }).last().click({ force: true }).catch(() => undefined); assert.equal(starts, 0);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'browser-office-report.json'), JSON.stringify({ result: 'passed', evidence: 'headless production React/canvas + real loopback HTTP/SSE; simulated VS Code/worker state', nativeVSCodeE2E: false, realProviderInference: false, groups: 4, lifecycle: ['native-view-disposal fanout', 'shared shutdown await', 'reconnect deleted-target reconciliation', 'paused-manager Chat route'] }, null, 2) + '\n');
  console.log('PASS: narrow viewport keeps modal in screen and disconnect disables agent commands.');
} finally { await browser.close(); await provider.disposeBrowserOffice(); provider.agents.clear(); provider.dispose(); delete globalThis.__browserProbeVscode; }
