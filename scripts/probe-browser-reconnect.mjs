/** Shipped browser UI + real loopback auth/SSE, with fabricated empty host state.
 * No GUI window, native host, credentials, provider calls or persisted user state.
 * The clock advances only inside this fixture to exercise the unchanged 30m TTL. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url); globalThis.require = require;
Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.filter(frame => !String(frame.getFileName()).startsWith('data:')).map(frame => `    at ${frame}`).join('\n')}`;
let playwright;
try { playwright = require(process.env.OFFICE_PLAYWRIGHT_MODULE ?? 'playwright'); }
catch { playwright = require(path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const compile = async (contents, format = 'esm') => (await build({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format, write: false, logLevel: 'silent' })).outputFiles[0].text;
const transportSource = await compile("export * from './webview-ui/src/vscodeApi.ts';", 'cjs');
const source = await compile("export {BrowserOfficeServer} from './src/browserOfficeServer.ts'; export {StandaloneBridge} from '../standalone/src/bridge.ts';");
const { BrowserOfficeServer, StandaloneBridge } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function transportFixture(native = false) {
  let url = new URL('http://127.0.0.1:1/?fixture=transport#office-token=initial-fabricated');
  const window = new EventTarget();
  Object.defineProperty(window, 'location', { get: () => url });
  window.history = { replaceState(_state, _title, value) { url = new URL(value, url); } };
  const calls = [], posted = [];
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, window, document: { documentElement: { dataset: {} } }, crypto: webcrypto,
    URLSearchParams, TextEncoder, TextDecoder, AbortController, MessageEvent, setTimeout: () => 1, clearTimeout() {},
    fetch(target, options) { const response = deferred(); calls.push({ target, options, ...response }); return response.promise; },
    ...(native ? { acquireVsCodeApi: () => ({ postMessage: message => posted.push(message) }) } : {}) });
  vm.runInContext(transportSource, context);
  const hash = value => { url.hash = value; window.dispatchEvent(new Event('hashchange')); };
  return { api: module.exports, calls, posted, hash, url: () => url, window };
}

// Real transport source, deliberately before React's ready handshake.
const queued = transportFixture();
assert.equal(queued.api.officeHost.getSnapshot().hostKind, 'unknown');
assert.equal(queued.url().hash, ''); assert.equal(queued.calls.length, 0);
queued.hash('office-token=queued-fabricated'); assert.equal(queued.url().hash, ''); assert.equal(queued.calls.length, 0);
queued.api.vscode.postMessage({ type: 'webviewReady' }); queued.api.vscode.postMessage({ type: 'webviewReady' });
assert.equal(queued.calls.length, 1); assert.equal(JSON.parse(queued.calls[0].options.body).token, 'queued-fabricated');
queued.hash('unrelated=fragment'); assert.equal(queued.calls.length, 1);
queued.hash('office-token=next-fabricated'); assert.equal(queued.url().hash, ''); assert.equal(queued.calls.length, 2); assert(queued.calls[0].options.signal.aborted);
queued.calls[0].resolve({ status: 200, ok: true, async json() { throw new Error('An old handshake must be ignored before body parsing.'); } });
await tick(); assert.equal(queued.calls.length, 2);
queued.hash(''); assert.equal(queued.calls.length, 2);
const native = transportFixture(true);
assert.equal(native.api.officeHost.getSnapshot().hostKind, 'vscode');
native.api.vscode.postMessage({ type: 'webviewReady' }); assert.equal(native.calls.length, 0); assert.equal(native.posted.length, 1);
console.log('PASS 1: source transport strips/queues launch fragments before readiness, suppresses duplicate handshakes, aborts old epochs, ignores unrelated hashes and preserves native VS Code.');

// An aborted old SSE is allowed to produce one last chunk: it cannot update UI.
const late = transportFixture(); late.api.vscode.postMessage({ type: 'webviewReady' });
late.calls[0].resolve({ status: 200, ok: true, async json() { return { csrf: 'fabricated-csrf' }; } }); await tick();
const read = deferred(); let oldBodyRead = 0;
late.calls[1].resolve({ status: 200, ok: true, body: { getReader: () => ({ read: () => read.promise, async cancel() {}, releaseLock() {} }) } }); await tick();
late.hash('office-token=new-stream-fabricated');
read.resolve({ done: false, value: new TextEncoder().encode('data: {"type":"officeHostCapabilities","hostKind":"vscode","features":{}}\n\ndata: {"type":"officeBrowserReady"}\n\n') });
await tick(); assert.equal(late.api.officeHost.getSnapshot().hostKind, 'unknown'); assert.equal(late.api.officeConnection.getSnapshot().state, 'connecting');
late.calls[2].resolve({ status: 401, ok: false, async json() { oldBodyRead++; } }); await tick();
assert.equal(oldBodyRead, 0); assert.equal(late.api.officeConnection.getSnapshot().state, 'expired');
console.log('PASS 2: delayed old bootstrap frames and old handshake bodies cannot claim readiness or overwrite the replacement session.');

const bridge = new StandaloneBridge({ connection: { url: 'http://127.0.0.1:1' }, client() { throw new Error('The reconnect fixture must never access a runtime.'); } },
  { get: (_key, fallback) => structuredClone(fallback), async update() { throw new Error('The reconnect fixture must not persist state.'); } }, '', '/fabricated/not-accessed');
bridge.setDeskState({ ready: true, setup: { complete: true }, workers: [], accounts: [], repositories: [], attention: [], modelOptions: [] });
const subscriptions = new Set(), dispatches = [], held = deferred();
const server = new BrowserOfficeServer({ assetsDirectory: path.join(root, 'dist/webview'), port: 0,
  connect: async send => { const subscription = bridge.connect(send); subscriptions.add(subscription); return { dispose() { subscriptions.delete(subscription); subscription.dispose(); } }; },
  dispatch: async message => { assert.equal(message.type, 'officeDeskAction'); assert.equal(message.action, 'addAccount'); assert.equal(message.name, 'Fabricated pending profile'); assert.equal(message.apiKey, undefined); dispatches.push(message); await held.promise; return { status: 'completed' }; } });
let browser;
try {
  const initial = new URL((await server.start()).url), origin = initial.origin;
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 760 } });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.reconnectDocument = crypto.randomUUID(); window.reconnectActions = []; window.addEventListener('message', event => { if (event.data?.type === 'officeBrowserActionState') window.reconnectActions.push(event.data); }); });
  let documents = 0; page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
  await page.goto(origin); await page.getByText('Your Office browser session needs a fresh launch link.').waitFor();
  await page.getByRole('button', { name: 'Team · 0', exact: true }).click();
  const unknownText = await page.locator('body').innerText();
  assert(!/VS Code/.test(unknownText)); assert(unknownText.includes('scripts/Open Office.command')); assert(unknownText.includes('npm run office:open'));
  assert.equal(await page.locator('a[href^="vscode:"]').count(), 0);
  const documentId = await page.evaluate(() => window.reconnectDocument);
  console.log('PASS 3: fresh unauthenticated shipped UI gives neutral Office launcher instructions and no VS Code copy or deep link, including its Team drawer.');

  const connected = () => page.getByText('Connected to Office host', { exact: true }).waitFor();
  const navigateHash = async url => { await page.goto(url); await page.waitForFunction(() => location.hash === ''); assert.equal(await page.evaluate(() => window.reconnectDocument), documentId); assert.equal(documents, 1); };
  await navigateHash(initial.href); await connected(); await page.waitForSelector('canvas[data-office-canvas]');
  assert.equal(subscriptions.size, 1);
  console.log('PASS 4: a fresh one-use launch hash restores the same expired document, clears the fragment and bootstraps the actual standalone bridge without reload.');

  // Advancing the fixture clock exercises existing production expiration; no TTL override.
  const clock = Date.now, now = clock(); let afterExpiry;
  try { Date.now = () => now + 31 * 60_000; afterExpiry = (await server.start()).url; } finally { Date.now = clock; }
  await page.getByText(/Open The Office launcher/).first().waitFor();
  const expiredText = await page.locator('body').innerText(); assert(!/VS Code/.test(expiredText));
  assert.equal(await page.locator('a[href^="vscode:"]').count(), 0);
  await navigateHash(afterExpiry); await connected(); assert.equal(subscriptions.size, 1);
  console.log('PASS 5: a learned standalone session expires under the unchanged 30-minute policy and recovers with launcher guidance in the same document.');

  await navigateHash(afterExpiry); await page.getByText(/Open The Office launcher/).first().waitFor();
  assert.equal(await page.getByText('Connected to Office host', { exact: true }).count(), 0);
  for (const button of await page.getByRole('button', { name: '+ Agent', exact: true }).all()) assert.equal(await button.isDisabled(), true);
  await navigateHash((await server.start()).url); await connected();
  console.log('PASS 6: replaying a consumed fragment is rejected even with a valid cookie; a separate fresh capability recovers without weakening authentication.');

  await page.getByRole('button', { name: 'admin', exact: true }).click();
  await page.getByRole('button', { name: '+ Separate account profile', exact: true }).click();
  await page.getByRole('textbox', { name: 'Account name', exact: true }).fill('Fabricated pending profile');
  await page.getByRole('combobox', { name: 'New account sign-in method', exact: true }).selectOption('api');
  await page.getByRole('button', { name: 'Create profile', exact: true }).click();
  await page.waitForFunction(() => window.reconnectActions.some(item => item.action === 'addAccount' && item.state === 'pending'));
  assert.equal(dispatches.length, 1); const pendingId = dispatches[0].requestId;
  await navigateHash((await server.start()).url); await connected();
  assert.equal(dispatches.length, 1);
  let states = await page.evaluate(id => window.reconnectActions.filter(item => item.requestId === id).map(item => item.state), pendingId);
  assert.deepEqual(states, ['pending', 'failed']);
  held.resolve(); await tick();
  // A server-side barrier ensures the old handler has actually settled.
  await page.waitForTimeout(50);
  states = await page.evaluate(id => window.reconnectActions.filter(item => item.requestId === id).map(item => item.state), pendingId);
  assert.deepEqual(states, ['pending', 'failed']); assert.equal(dispatches.length, 1);
  assert.equal(subscriptions.size, 1); assert.deepEqual(errors, []);
  console.log('PASS 7: replacing a session fails its pending action once, never replays it and ignores its delayed HTTP completion; one fresh SSE subscription remains.');
  await context.close();
} finally {
  held.resolve(); await browser?.close(); await server.dispose(); await bridge.dispose();
}
console.log('PASS: 7 browser reconnect groups (source lifecycle + headless shipped UI/real HTTP, fabricated empty standalone state; no real provider inference or native GUI).');
