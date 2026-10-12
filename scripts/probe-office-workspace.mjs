/** Production React/canvas and authenticated loopback transport with fabricated
 * host/thread/account state. Headless only; no native window, inference, real
 * credentials, repository mutation or provider authentication. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url); globalThis.require = require;
Error.prepareStackTrace = (error, frames) => `${error.name}: ${error.message}\n${frames.filter(frame => !String(frame.getFileName()).startsWith('data:')).map(frame => `    at ${frame}`).join('\n')}`;
const { PNG } = require('pngjs');
let playwright;
try { playwright = require(process.env.OFFICE_PLAYWRIGHT_MODULE ?? 'playwright'); }
catch { playwright = require(path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')); }
const compiled = await build({ stdin: { contents: "export {BrowserOfficeServer} from './src/browserOfficeServer.ts';export {createRepositoryLayout,layoutToSeats} from './webview-ui/src/office/layout/layoutSerializer.ts';export {getCharacterSprites,setCharacterTemplates,CHARACTER_PALETTES} from './webview-ui/src/office/sprites/spriteData.ts';export {repositoryColor} from './webview-ui/src/office/sprites/repoAppearance.ts';export {activitySummary} from './webview-ui/src/office/engine/activitySummary.ts';export {normalizeAgentPanel,normalizeAgentAction} from './src/agentControls.ts';", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const repos = [{ id: 'repo-a', name: 'Office' }, { id: 'repo-b', name: 'Sandbox' }];
assert.equal(api.repositoryColor('repo-a'), api.repositoryColor('repo-a'));
assert.notEqual(api.repositoryColor('repo-a'), api.repositoryColor('repo-b'));
// Template material labels preserve every non-shirt pixel.
for (let index = 0; index < 6; index++) {
  const before = api.getCharacterSprites(index), after = api.getCharacterSprites(index, 0, api.repositoryColor('repo-a'));
  for (const kind of ['walk', 'typing', 'reading']) for (const direction of [0, 1, 2, 3]) for (let frame = 0; frame < before[kind][direction].length; frame++) {
    for (let y = 0; y < before[kind][direction][frame].length; y++) for (let x = 0; x < before[kind][direction][frame][y].length; x++) {
      const pixel = before[kind][direction][frame][y][x];
      if (pixel !== api.CHARACTER_PALETTES[index].shirt) assert.equal(after[kind][direction][frame][y][x], pixel);
    }
  }
}
const characters = [];
for (let index = 0; index < 6; index++) {
  const png = PNG.sync.read(await readFile(path.join(root, `dist/assets/characters/char_${index}.png`)));
  const character = {};
  for (const [direction, row] of [['down', 0], ['up', 1], ['right', 2]]) character[direction] = Array.from({ length: 7 }, (_, frame) => Array.from({ length: 32 }, (_, y) => Array.from({ length: 16 }, (_, x) => {
    const i = ((row * 32 + y) * png.width + frame * 16 + x) * 4;
    return png.data[i + 3] < 128 ? '' : `#${[0, 1, 2].map(offset => png.data[i + offset].toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  })));
  characters.push(character);
}
api.setCharacterTemplates(characters);
const protectedColors = ['#E9A384', '#C5896E', '#FFCC99', '#FBBF97', '#FFD8B2', '#E29878', '#865E4C', '#5F4132', '#B67352', '#FFA77C', '#FCD6C4', '#E1AA91', '#32191D', '#B18649', '#8F6439', '#7E4B29', '#181616', '#B0A6A3', '#2F160F', '#0E0E0E', '#FFFFFF'];
for (let index = 0; index < 6; index++) {
  const before = api.getCharacterSprites(index), after = api.getCharacterSprites(index, 0, api.repositoryColor('repo-a'));
  let changed = 0;
  for (const kind of ['walk', 'typing', 'reading']) for (const direction of [0, 1, 2, 3]) for (let frame = 0; frame < before[kind][direction].length; frame++) {
    for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) {
      const pixel = before[kind][direction][frame][y][x], tinted = after[kind][direction][frame][y][x];
      if (protectedColors.includes(pixel) || !pixel) assert.equal(tinted, pixel, `Protected material changed: character ${index}/${kind}/${direction}/${frame}/${x},${y}`);
      if (pixel !== tinted) changed++;
      if (index === 0 && kind === 'walk' && direction === 0 && frame === 0 && y >= 24) assert.equal(tinted, pixel, 'Shared blue trousers must retain their original color.');
    }
  }
  assert(changed > 30, `Character ${index} must visibly wear a repo shirt.`);
}
for (const status of ['working', 'reading', 'waiting', 'idle', 'done', 'failed', 'needs input']) {
  const summary = api.activitySummary({ status, needsInput: status === 'needs input' }, 'bash --token private-reasoning');
  assert(!summary.includes('token') && !summary.includes('private-reasoning'));
}
assert.equal(api.activitySummary({ status: 'idle', role: 'manager', managerPaused: true }, null), 'Paused · ready for manual chat');
assert(api.activitySummary({ status: 'working' }, 'bash').startsWith('Running a command'));
assert(api.activitySummary({ status: 'idle' }, null, false).startsWith('Disconnected'));
console.log('PASS: stable repo shirt colors preserve template and shipped PNG skin/hair/eyes/transparent pixels and trousers across every pose; public activity summaries never expose commands or reasoning.');

const layout = api.createRepositoryLayout(repos), seats = api.layoutToSeats(layout.furniture, layout.zones);
const roles = ['builder', 'security-reviewer', 'manager', 'builder', 'verifier', 'manager'];
const agentMeta = {}, vms = [];
for (let id = 1; id <= 6; id++) {
  const repo = repos[id <= 3 ? 0 : 1], role = roles[id - 1];
  const seat = [...seats.values()].find(value => !value.assigned && value.repoId === repo.id && value.role === role);
  assert(seat); seat.assigned = true; agentMeta[id] = { seatId: seat.uid, palette: id - 1, hueShift: 0 };
  vms.push({ agentId: id, sessionId: `fixture-${id}`, status: 'waiting', permissionAsked: false, tools: [], subagents: [], officeLabel: { name: `Agent ${id}`, managed: true, role, repoId: repo.id, repoName: repo.name, providerKind: 'codex', usageTokens: 0, needsInput: false, status: id === 1 ? 'working' : 'idle', ...(id === 3 ? { managerPaused: true } : {}), ...(id === 6 ? { activeRepoId: 'repo-a', activeRepoName: 'Office', managerRepoIds: repos.map(repo => repo.id) } : {}) } });
}
const thread = (id, repoId, extra = {}) => ({ id, workerId: 'worker-1', repoId, title: id === 'root-a' ? 'Office implementation' : id === 'root-b' ? 'Sandbox review' : id, kind: 'root', accountId: 'profile', providerId: 'openai', modelId: 'fixture-model', mode: 'fast', createdAt: 1, updatedAt: 2, archived: false, ...extra });
const threads = [thread('root-a', 'repo-a'), thread('root-b', 'repo-b'), thread('archived-a', 'repo-a', { archived: true }), thread('child-a', 'repo-a', { kind: 'child', parentThreadId: 'root-a' })];
const olderThreads = new Set();
const chats = new Map(threads.map(item => [item.id, [{ id: `reply-${item.id}`, role: 'assistant', text: `Conversation content for ${item.id}`, createdAt: 1 }]]));
let selected = 'root-a', usage = 1234, hostKind = 'vscode', apiCalls = 0, resetsAvailable = 1, firstSetup = false, releaseLayout;
const calls = [], deskCalls = [], settingsCalls = [], sinks = new Set();
const accounts = [{ id: 'profile', name: 'Workspace profile', kind: 'codex', authType: 'oauth', connected: true }, { id: 'api-profile', name: 'Fabricated API profile', kind: 'grok', authType: 'api', connected: false }];
const panel = (threadId = selected) => ({ worker: { id: 'worker-1', name: 'Agent 1', role: 'builder', status: 'idle', started: true, repoId: 'repo-a', repoName: 'Office', accountId: 'profile', mode: 'fast', modelId: 'fixture-model' }, modelOptions: [{ id: 'fixture-model', name: 'Fixture model' }, { id: 'second-model', name: 'Second fixture model' }], account: accounts[0], accounts, repositories: repos, capabilities: { threads: true, usageReset: true, threadFork: true, threadCompact: true, creditReset: true }, accountQuota: { available: true, accountName: 'Workspace profile', limits: [{ id: 'five-hour', name: 'Five-hour window', usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }], reset: { availableCount: resetsAvailable, ...(resetsAvailable ? { ticket: 'fixture-reset-ticket' } : {}) } }, threads: { items: threads, selectedId: threadId }, chatThreadId: threadId, chatPage: { older: olderThreads.has(threadId), hasMore: !(chats.get(threadId)?.some(item => item.id === `earlier-${threadId}`)), before: `reply-${threadId}` }, chat: chats.get(threadId) ?? [], usage: { tokens: usage, totalTokens: 4321, threadTokens: 25, byRepository: [{ id: 'repo-a', tokens: 25 }, { id: 'repo-b', tokens: 5 }], estimatedCost: .01, resettable: true }, pending: false, busy: false });
const desk = () => ({ ready: true, setup: { complete: !firstSetup }, accounts: firstSetup ? [] : accounts, workers: vms.map(item => ({ id: `worker-${item.agentId}`, name: item.officeLabel.name, role: item.officeLabel.role, repoId: item.officeLabel.repoId, agentId: item.agentId, accountId: 'profile', status: item.officeLabel.status })), repositories: repos.map(repo => ({ ...repo, readOnly: false })), attention: [], modelOptions: [] });
const host = () => ({ type: 'officeHostCapabilities', hostKind, seatAuthority: 'host', features: { threads: true, usage: true, secureBrowserCredentials: hostKind === 'standalone' } });
const send = message => { for (const sink of sinks) sink(message); };
const publish = (threadId = selected) => send({ type: 'officeAgentPanel', agentId: 1, state: panel(threadId) });
const publicPanel = api.normalizeAgentPanel({ ...panel(), credentials: 'private-fixture-secret', threads: { items: [{ ...threads[0], sessionId: 'private-runtime-session', auth: 'private-fixture-secret' }] } });
assert(!JSON.stringify(publicPanel).includes('private-fixture-secret') && !JSON.stringify(publicPanel).includes('private-runtime-session'));
assert.throws(() => api.normalizeAgentAction({ agentId: 1, requestId: 'fixture', action: 'credit-reset', resetTicket: 'ticket', confirmed: false }));
const server = new api.BrowserOfficeServer({ assetsDirectory: path.join(root, 'dist/webview'), port: 0, connect: async sink => {
  sinks.add(sink); sink(host()); sink({ type: 'officeBrowserBootstrap' }); sink({ type: 'settingsLoaded', soundEnabled: false }); sink({ type: 'characterSpritesLoaded', characters }); sink({ type: 'officeRepositories', repositories: repos, requestId: 0 }); sink({ type: 'existingAgents', agents: [1, 2, 3, 4, 5, 6], agentMeta }); sink({ type: 'layoutLoaded', layout }); sink({ type: 'runtimeSnapshot', protocolVersion: 2, agents: vms }); sink({ type: 'officeAgentSeats', seats: agentMeta }); sink({ type: 'officeAgentPanel', agentId: 1, state: panel() }); sink({ type: 'officeDeskState', state: desk() }); sink({ type: 'officeBrowserReady' }); return { dispose: () => sinks.delete(sink) };
}, dispatch: async message => {
  if (message.type === 'setSoundEnabled') { assert.equal(hostKind, 'standalone'); assert.equal(typeof message.enabled, 'boolean'); settingsCalls.push(message); send({ type: 'settingsLoaded', soundEnabled: message.enabled }); return { status: 'completed' }; }
  if (message.type === 'saveLayout') { assert.equal(hostKind, 'standalone'); settingsCalls.push(message); await new Promise(resolve => { releaseLayout = resolve; }); send({ type: 'layoutLoaded', layout: message.layout }); return { status: 'completed' }; }
  if (message.type === 'officeAgentAction') {
    const action = api.normalizeAgentAction(message); assert.equal(action.agentId, 1); calls.push(action);
    if (action.action === 'thread-select') { assert(threads.some(item => item.id === action.threadId)); selected = action.threadId; olderThreads.delete(action.threadId); }
    if (action.action === 'thread-new' && action.title === 'Rejected draft') throw new Error('Fabricated host rejects this draft.');
    if (action.action === 'thread-new') { const item = thread(`new-${threads.length}`, action.repoId, { title: action.title }); threads.push(item); chats.set(item.id, []); selected = item.id; }
    if (action.action === 'thread-rename') threads.find(item => item.id === action.threadId).title = action.title;
    if (action.action === 'thread-archive') threads.find(item => item.id === action.threadId).archived = true;
    if (action.action === 'thread-more') { olderThreads.add(action.threadId); chats.get(action.threadId).unshift({ id: `earlier-${action.threadId}`, role: 'user', text: 'Earlier message from this repository thread', createdAt: 0 }); }
    if (action.action === 'send') { assert(threads.some(item => item.id === action.threadId && !item.archived && item.kind === 'root')); chats.get(action.threadId).push({ id: `accepted-${calls.length}`, role: 'user', text: action.text, createdAt: 3 }); selected = action.threadId; }
    if (action.action === 'reset-usage') usage = 0;
    if (action.action === 'credit-reset') { assert.equal(action.confirmed, true); assert.equal(action.resetTicket, 'fixture-reset-ticket'); assert.equal(resetsAvailable, 1); resetsAvailable = 0; }
    publish(); return { status: 'completed' };
  }
  assert.equal(message.type, 'officeDeskAction'); deskCalls.push({ ...message, apiKey: message.apiKey ? '[fabricated key omitted]' : undefined });
  if (message.action === 'addRepository') { assert.equal(message.path, '/fabricated/no-access/fixture-repo'); assert.equal(message.name, 'Added fixture repository'); assert.equal(message.readOnly, true); }
  if (message.action === 'question') { assert.deepEqual(message.answers, [['Proceed'], ['Read source', 'Run tests']]); send({ type: 'officeDeskState', state: desk() }); }
  if (message.action === 'account-save-api') { assert.equal(hostKind, 'standalone'); assert.equal(message.id, 'api-profile'); assert.equal(message.apiKey, 'fabricated-fixture-only'); apiCalls++; accounts[1].connected = true; send({ type: 'officeDeskState', state: desk() }); }
  if (message.action === 'signInAccount') send({ type: 'officeDeskState', state: { ...desk(), login: { accountId: 'profile', kind: 'browser', verificationUrl: 'https://auth.openai.com/oauth/authorize?fixture=not-a-real-login', instructions: 'Use a private window to choose a separate login.' } } });
  if (message.action === 'finishSetup') { firstSetup = false; send({ type: 'officeDeskState', state: desk() }); }
  if (message.action === 'cancelLogin') send({ type: 'officeDeskState', state: desk() });
  return { status: 'completed' };
} });
const output = path.join(root, '../spike/results'); await mkdir(output, { recursive: true });
let browser;
try {
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage(); await page.addInitScript(() => { window.officeCanvasText = []; const paint = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function(text, x, y, width) { if (this.canvas.dataset.officeCanvas !== undefined) { window.officeCanvasText.push({ text, x, y }); if (window.officeCanvasText.length > 10000) window.officeCanvasText.splice(0, 5000) } return width === undefined ? paint.call(this, text, x, y) : paint.call(this, text, x, y, width) } }); page.setDefaultTimeout(8000); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto((await server.start()).url); await page.getByText('Connected to VS Code · Layout is managed in VS Code').waitFor(); await page.waitForSelector('canvas[data-office-canvas]');
  await page.waitForFunction(() => window.officeCanvasText.some(item => item.text === 'Thinking…') && window.officeCanvasText.some(item => item.text === 'Paused · ready for manual chat'));
  const drawn = await page.evaluate(() => window.officeCanvasText);
  for (const desk of layout.furniture.filter(item => item.type === 'desk')) {
    const name = desk.col < 32 ? 'Office' : 'Sandbox', x = (1440 - layout.cols * 16) / 2 + desk.col * 16 + 16, y = (1000 - layout.rows * 16) / 2 + desk.row * 16 + 32 + 19;
    assert(drawn.some(item => item.text === name && item.x === x && item.y === y), `Missing actual computer desk nameplate ${desk.uid}`);
  }
  await page.screenshot({ path: path.join(output, 'office_workspace_desks.png') });
  const custom = { ...layout, officeDefault: false, furniture: layout.furniture.map(item => ['desk-0-0', 'computer-0-0', 'chair-0-0'].includes(item.uid) ? { ...item, col: item.col + 1 } : item) };
  await page.evaluate(() => { window.officeCanvasText = [] }); send({ type: 'layoutLoaded', layout: custom });
  await page.waitForFunction(({ x, y }) => window.officeCanvasText.some(item => item.text === 'Office' && item.x === x && item.y === y), { x: (1440 - layout.cols * 16) / 2 + 4 * 16, y: (1000 - layout.rows * 16) / 2 + 4 * 16 + 32 + 19 });
  await page.screenshot({ path: path.join(output, 'office_workspace_custom_desks.png') }); send({ type: 'layoutLoaded', layout });
  await page.getByRole('button', { name: /Team · 6/ }).click(); await page.getByRole('button', { name: 'Chat & controls', exact: true }).first().click(); await page.getByRole('dialog').waitFor();
  const bounds = await page.getByRole('dialog').boundingBox(); assert(bounds.width > 1200 && bounds.height > 800); assert(Math.abs(bounds.x + bounds.width / 2 - 720) < 3);
  await page.getByText('Conversation content for root-a', { exact: true }).waitFor(); const composer = page.getByRole('textbox', { name: 'Message this worker' }); await composer.fill('Office draft');
  await page.getByRole('button', { name: /Sandbox review/ }).click(); await page.getByText('Conversation content for root-b', { exact: true }).waitFor(); assert.equal(await composer.inputValue(), ''); await composer.fill('Sandbox draft');
  await page.getByRole('button', { name: /Office implementation/ }).click(); await page.getByText('Conversation content for root-a', { exact: true }).waitFor(); assert.equal(await composer.inputValue(), 'Office draft');
  assert(/^[a-f0-9-]{36}$/i.test(calls[0].viewId));
  assert(!calls.some(call => ['send', 'start'].includes(call.action)), 'Browsing must never execute a worker.');
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click(); await page.getByText('Earlier message from this repository thread', { exact: true }).waitFor(); await page.getByText(/Browsing earlier history/).waitFor(); await page.getByRole('button', { name: 'Latest messages', exact: true }).click(); await page.getByText(/Browsing earlier history/).waitFor({ state: 'detached' });
  await page.getByRole('textbox', { name: 'Search conversations' }).fill('Sandbox'); assert.equal(await page.getByRole('button', { name: /Office implementation/ }).count(), 0); await page.getByRole('textbox', { name: 'Search conversations' }).fill('');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click(); await page.getByRole('textbox', { name: 'Conversation title' }).fill('Rejected draft'); await page.getByRole('button', { name: 'Save conversation', exact: true }).click(); await page.getByRole('form', { name: 'New conversation', exact: true }).getByText('The office request failed.', { exact: true }).waitFor(); assert.equal(await page.getByRole('textbox', { name: 'Conversation title' }).inputValue(), 'Rejected draft'); assert.equal(await page.getByRole('button', { name: 'Save conversation', exact: true }).isEnabled(), true); await page.getByRole('textbox', { name: 'Conversation title' }).fill('New Sandbox task'); await page.getByRole('combobox', { name: 'Conversation repository' }).selectOption('repo-b'); await page.getByRole('button', { name: 'Save conversation', exact: true }).click(); await page.getByRole('button', { name: /New Sandbox task/ }).waitFor(); assert.equal(await page.getByRole('form', { name: 'New conversation', exact: true }).count(), 0);
  await page.getByRole('button', { name: /Sandbox review/ }).click(); await page.getByRole('button', { name: 'Rename', exact: true }).click(); await page.getByRole('textbox', { name: 'Conversation title' }).fill('Renamed Sandbox review'); await page.getByRole('button', { name: 'Save conversation', exact: true }).click(); await page.getByRole('button', { name: /Renamed Sandbox review/ }).waitFor();
  await page.getByRole('button', { name: 'Archive', exact: true }).click(); await page.getByText(/Read-only history/).waitFor(); assert(await composer.isDisabled());
  await page.getByRole('button', { name: /child-a/ }).click(); await page.getByText(/Read-only history/).waitFor(); assert(await composer.isDisabled());
  await page.getByRole('button', { name: /Office implementation/ }).click(); assert.equal(await composer.inputValue(), 'Office draft'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await page.locator('.office-dialog-chat').getByText('Office draft', { exact: true }).waitFor(); await page.waitForFunction(() => document.querySelector('#office-agent-message').value === '');
  assert(calls.some(call => call.action === 'send' && call.threadId === 'root-a'));
  await page.getByRole('button', { name: 'Usage', exact: true }).click(); await page.getByText('Selected conversation: 25 tokens', { exact: true }).waitFor(); await page.getByText('Lifetime recorded usage: 4,321 tokens', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Reset local counter', exact: true }).click(); await page.getByRole('button', { name: 'Confirm reset', exact: true }).click(); await page.getByText('0', { exact: true }).waitFor();
  await page.getByText('25.0% used · 75.0% remaining', { exact: true }).waitFor(); await page.getByRole('button', { name: 'Use account reset (1 available)', exact: true }).click(); assert.equal(await page.getByRole('button', { name: 'Confirm account reset', exact: true }).isDisabled(), true); assert.equal(calls.filter(item => item.action === 'credit-reset').length, 0); await page.getByRole('checkbox', { name: 'I confirm that I want to use one account reset.', exact: true }).check(); await page.getByRole('button', { name: 'Confirm account reset', exact: true }).click(); await page.getByRole('button', { name: 'Use account reset (1 available)', exact: true }).waitFor({ state: 'detached' }); assert.equal(calls.filter(item => item.action === 'credit-reset' && item.confirmed).length, 1);
  await page.getByRole('button', { name: 'Controls', exact: true }).click(); await page.getByRole('combobox', { name: 'Worker model', exact: true }).selectOption('second-model'); await page.getByRole('combobox', { name: 'Worker mode', exact: true }).selectOption('reasoning'); assert(calls.some(item => item.action === 'worker-model' && item.modelId === 'second-model')); assert(calls.some(item => item.action === 'worker-mode' && item.workerMode === 'reasoning'));
  await page.getByRole('button', { name: 'Chat', exact: true }).click(); await page.screenshot({ path: path.join(output, 'office_workspace_chat.png') });
  console.log('PASS: centered large workspace groups threads by repository; search/new/rename/archive/history paging work; history browsing does not execute; child/archive history is read-only; drafts stay separate and only acknowledged Send clears them; local usage reset is capability-gated and account resets require a distinct explicit human confirmation.');

  const other = await context.newPage(); other.setDefaultTimeout(8000); await other.goto((await server.start()).url); await other.getByRole('button', { name: /Team · 6/ }).click(); await other.getByRole('button', { name: 'Chat & controls', exact: true }).first().click(); await other.getByRole('button', { name: /New Sandbox task/ }).click(); await other.getByText('Send a message to begin this worker’s conversation.').waitFor();
  assert(await page.getByText('Conversation content for root-a', { exact: true }).count()); publish('root-a'); await page.getByText('Conversation content for root-a', { exact: true }).waitFor(); assert(await other.getByText('Send a message to begin this worker’s conversation.').count());
  const otherView = calls.at(-1).viewId; assert.notEqual(otherView, calls[0].viewId); send({ type: 'officeAgentPanel', agentId: 1, viewId: otherView, state: { ...panel('root-a'), chat: [{ id: 'foreign', role: 'assistant', text: 'Foreign view must be ignored', createdAt: 1 }] } }); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(await page.getByText('Foreign view must be ignored', { exact: true }).count(), 0);
  await other.close(); console.log('PASS: different browser views retain local selected conversations when another thread snapshot is broadcast.');

  await page.getByRole('button', { name: 'Close agent controls', exact: true }).click(); hostKind = 'standalone'; send(host()); send({ type: 'officeBrowserReady' }); await page.getByText('Connected to Office host', { exact: true }).waitFor(); await page.getByRole('button', { name: 'admin', exact: true }).click();
  const profile = page.locator('[data-account-profile="api-profile"]'); await profile.getByRole('button', { name: 'Sign in', exact: true }).click(); assert.equal(apiCalls, 0); const key = page.getByRole('textbox', { name: 'API key', exact: true }); assert.equal(await key.getAttribute('type'), 'password'); await key.fill('fabricated-fixture-only'); await page.getByRole('form', { name: 'API key connection' }).getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(apiCalls, 0);
  await profile.getByRole('button', { name: 'Sign in', exact: true }).click(); assert.equal(await key.inputValue(), ''); await key.fill('fabricated-fixture-only'); await page.getByRole('form', { name: 'API key connection' }).getByRole('button', { name: 'Connect profile', exact: true }).click(); await page.getByRole('form', { name: 'API key connection' }).waitFor({ state: 'detached' }); assert.equal(apiCalls, 1);
  assert.equal(await page.evaluate(() => `${JSON.stringify(localStorage)}${JSON.stringify(sessionStorage)}`.includes('fabricated-fixture-only')), false);
  await page.locator('[data-account-profile="profile"]').getByRole('button', { name: 'Reconnect profile', exact: true }).click(); await page.getByRole('link', { name: 'Open sign-in page', exact: true }).waitFor(); const href = await page.getByRole('link', { name: 'Open sign-in page', exact: true }).getAttribute('href'); assert(href.startsWith('https://auth.openai.com/oauth/authorize')); await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  await page.getByRole('link', { name: 'Open sign-in page', exact: true }).waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(output, 'office_workspace_profiles.png') });
  await page.getByRole('button', { name: 'repos', exact: true }).click(); await page.getByRole('button', { name: '+ Add repository', exact: true }).click(); await page.getByRole('textbox', { name: 'Repository folder', exact: true }).fill('/fabricated/no-access/fixture-repo'); await page.getByRole('textbox', { name: 'Repository display name', exact: true }).fill('Added fixture repository'); await page.getByRole('checkbox', { name: 'Read-only repository', exact: true }).check(); assert.equal(deskCalls.filter(item => item.action === 'addRepository').length, 0); await page.getByRole('button', { name: 'Add repository', exact: true }).click(); await page.getByRole('form', { name: 'Add repository', exact: true }).waitFor({ state: 'detached' }); assert.equal(deskCalls.filter(item => item.action === 'addRepository').length, 1);
  send({ type: 'officeDeskState', state: { ...desk(), attention: [{ id: 'fixture-question', workerName: 'Agent 1', kind: 'question', ask: 'Choose how to continue.', questions: [{ header: 'Continue', question: 'Proceed?', options: [{ label: 'Proceed' }, { label: 'Stop' }] }, { header: 'Checks', question: 'Which checks?', multiple: true, options: [{ label: 'Read source', description: 'Read only' }, { label: 'Run tests' }] }] }] } });
  await page.getByRole('button', { name: /Attention/ }).click(); await page.getByRole('button', { name: 'Reply', exact: true }).click(); await page.getByRole('radio', { name: 'Proceed', exact: true }).check(); await page.getByRole('checkbox', { name: /Read source/ }).check(); await page.getByRole('checkbox', { name: 'Run tests', exact: true }).check(); assert.equal(deskCalls.filter(item => item.action === 'question').length, 0); await page.getByRole('button', { name: 'Send answers', exact: true }).click(); await page.getByText('No agents need input.', { exact: true }).waitFor(); assert.equal(deskCalls.filter(item => item.action === 'question').length, 1);
  console.log('PASS: standalone repository and multi-question forms wait for explicit submission, preserve read-only choice and structured answers, and use only the fabricated host dispatch.');
  send({ type: 'officeBrowserApiForm', accountId: 'api-profile' }); await page.getByRole('form', { name: 'API key connection', exact: true }).waitFor(); assert.equal(await page.getByRole('textbox', { name: 'API key', exact: true }).inputValue(), ''); await page.getByRole('form', { name: 'API key connection', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(apiCalls, 1);
  send({ type: 'officeDeskState', state: { ...desk(), login: { accountId: 'profile', kind: 'browser', instructions: 'Fabricated pending flow' } } }); send({ type: 'officeAccountLoginError', accountId: 'profile', error: 'Fabricated sign-in cancelled' }); await page.getByText('Fabricated sign-in cancelled', { exact: true }).waitFor(); assert.equal(await page.locator('[data-account-profile="profile"]').getByRole('button', { name: 'Reconnect profile', exact: true }).isEnabled(), true);
  firstSetup = true; const setupPage = await context.newPage(); setupPage.setDefaultTimeout(8000); await setupPage.goto((await server.start()).url); await setupPage.getByRole('heading', { name: 'Office desk', exact: true }).waitFor(); await setupPage.getByRole('textbox', { name: 'Account name', exact: true }).waitFor(); assert.equal(await setupPage.getByRole('textbox', { name: 'Account name', exact: true }).inputValue(), 'Codex profile 1'); assert.equal(apiCalls, 1); await setupPage.getByRole('button', { name: 'Skip for now', exact: true }).click(); await setupPage.getByRole('textbox', { name: 'Account name', exact: true }).waitFor({ state: 'detached' }); await setupPage.close();
  console.log('PASS: first-use standalone setup opens without starting auth, explicit Skip finishes it, account login errors release the card and agent-requested API forms stay empty until manual input.');
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); const settings = page.getByRole('dialog', { name: 'Office settings', exact: true }); await settings.waitFor(); assert.equal(await settings.getByRole('button', { name: 'Open Sessions Folder', exact: true }).count(), 0);
  const downloadLayout = async () => { const waiting = page.waitForEvent('download'); await settings.getByRole('button', { name: 'Export Layout', exact: true }).click(); const download = await waiting; assert.equal(download.suggestedFilename(), 'the-office-layout.json'); return JSON.parse(await readFile(await download.path(), 'utf8')); };
  const exported = await downloadLayout(); assert.equal(exported.cols, layout.cols); assert.equal(exported.rows, layout.rows); assert.equal(exported.furniture.length, layout.furniture.length);
  const input = settings.getByLabel('Import Office layout JSON', { exact: true }); await input.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1}') }); await settings.getByText('Choose a valid bounded Office layout JSON file.', { exact: true }).waitFor(); assert.equal(settingsCalls.length, 0);
  const imported = { ...exported, officeDefault: false, zones: exported.zones.map((zone, index) => index ? zone : { ...zone, label: 'Imported Build' }) };
  await input.setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) }); await settings.getByRole('button', { name: 'Importing Layout…', exact: true }).waitFor(); for (let attempt = 0; !releaseLayout && attempt < 80; attempt++) await new Promise(resolve => setTimeout(resolve, 10)); assert(releaseLayout); assert.deepEqual(await downloadLayout(), exported, 'Import must not apply before host validation/acknowledgment.'); releaseLayout(); await settings.getByText('Layout imported by the Office host.', { exact: true }).waitFor(); assert.deepEqual(await downloadLayout(), imported);
  await settings.getByRole('button', { name: 'Sound Notifications', exact: true }).click(); await settings.getByRole('button', { name: /Sound Notifications/ }).waitFor({ state: 'visible' }); for (let attempt = 0; !settingsCalls.some(message => message.type === 'setSoundEnabled') && attempt < 80; attempt++) await new Promise(resolve => setTimeout(resolve, 10)); assert(settingsCalls.some(message => message.type === 'setSoundEnabled' && typeof message.enabled === 'boolean')); assert.equal(settingsCalls.filter(message => message.type === 'saveLayout').length, 1); await settings.getByRole('button', { name: 'Close Office settings', exact: true }).click();
  console.log('PASS: Settings downloads current local layout, rejects invalid files without dispatch, applies imports only after authenticated host validation/replay/acknowledgment, hides native-only folders, and posts persisted sound preferences.');
  assert.deepEqual(errors, []); console.log('PASS: standalone capabilities enable manual masked API key entry only for the chosen profile, cancel/ack clear it, no browser storage receives it, OAuth shows only an allowlisted public authorization link; no real authentication occurs.');
  await page.setViewportSize({ width: 430, height: 850 }); await page.getByRole('button', { name: 'agents', exact: true }).click(); await page.getByRole('button', { name: 'Chat & controls', exact: true }).first().click(); const mobile = await page.getByRole('dialog').boundingBox(); assert(mobile.width <= 430); await page.screenshot({ path: path.join(output, 'office_workspace_mobile.png') });
  await writeFile(path.join(output, 'office-workspace-report.json'), JSON.stringify({ result: 'passed', groups: 8, evidence: 'headless production React/canvas and real authenticated loopback HTTP/SSE; simulated host/thread/account data', realProviderInference: false, realAuthentication: false, nativeVSCodeE2E: false, shirtMaterialPreservation: true, everyComputerDeskNameplate: true, customDeskGeometry: true, failedThreadDraftRetained: true, repoThreads: true, perThreadDrafts: true, localViewSelection: true, perViewUuidRouting: true, accountResetHumanConfirmation: true, manualMaskedProfileEntry: true, publicOAuthLink: true, inlineRepositoryAndQuestionForms: true, workerModelAndModeControls: true, responsiveWorkspace: true, firstUseSetup: true, loginErrorRecovery: true, localLayoutExport: true, hostConfirmedLayoutImport: true, persistedSoundPreference: true }, null, 2) + '\n');
  console.log('PASS: narrow viewport keeps the workspace and pinned composer inside the screen.');
} finally { await browser?.close(); await server.dispose(); }
