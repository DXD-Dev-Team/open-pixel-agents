import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import Module from 'node:module';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Native HTTP only, with a fabricated provider boundary. No GUI, OpenCode,
// vendor inference, credentials, user repositories, or installed profile files.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: { contents: "export { BrowserOfficeServer } from './src/browserOfficeServer';", resolveDir: root },
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', write: false,
});
const compiled = new Module(path.join(root, 'scripts/browser-office-server-fixture.cjs'));
compiled.filename = path.join(root, 'scripts/browser-office-server-fixture.cjs');
compiled.paths = Module._nodeModulePaths(root);
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const { BrowserOfficeServer } = compiled.exports;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The expected HTTP subscription cleanup did not finish.');
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'office-browser-http-'));
  const assetsDirectory = path.join(directory, 'assets');
  await mkdir(path.join(assetsDirectory, 'assets'), { recursive: true });
  await writeFile(path.join(assetsDirectory, 'index.html'), '<!doctype html><title>Local office fixture</title><script src="/assets/app.js"></script>');
  await writeFile(path.join(assetsDirectory, 'assets/app.js'), 'window.localOfficeFixture = true;');
  await writeFile(path.join(directory, 'outside.js'), 'outside-private-fixture');
  await symlink(path.join(directory, 'outside.js'), path.join(assetsDirectory, 'escape.js'));
  await symlink(directory, path.join(assetsDirectory, 'escape-directory'));
  const control = { callbacks: new Set(), connects: 0, disposals: 0, messages: [], connectEntered: deferred(), async connect(send) {
    this.connects++;
    this.callbacks.add(send);
    send({ type: 'bootstrap', connection: this.connects });
    this.connectEntered.resolve();
    if (this.connectGate) await this.connectGate.promise;
    return { dispose: async () => { this.callbacks.delete(send); this.disposals++; } };
  }, emit(message) { for (const send of this.callbacks) send(message); } };
  const server = new BrowserOfficeServer({ assetsDirectory, connect: send => control.connect(send), dispatch: async message => {
    if (message?.type !== 'fixtureAllowed') throw new Error('fabricated-private-dispatch-detail');
    control.messages.push(message);
    return control.dispatchResult;
  } });
  const launch = await server.start();
  const url = new URL(launch.url);
  const origin = url.origin;
  const capability = new URLSearchParams(url.hash.slice(1)).get('office-token');
  t.after(async () => { control.connectGate?.resolve(); await server.dispose(); await rm(directory, { recursive: true, force: true }); });
  async function post(route, body, session, overrides = {}) {
    return fetch(`${origin}${route}`, { method: 'POST', headers: {
      Origin: origin, 'Content-Type': 'application/json', ...(session ? { Cookie: session.cookie, 'X-Office-CSRF': session.csrf } : {}),
      ...overrides,
    }, body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  }
  async function connect(launchToken = capability) {
    const response = await post('/api/connect', { token: launchToken });
    assert.equal(response.status, 200);
    const { csrf } = await response.json();
    const setCookie = response.headers.get('set-cookie');
    assert.equal(typeof csrf, 'string');
    assert(setCookie?.includes('HttpOnly') && setCookie.includes('SameSite=Strict') && setCookie.includes('Path=/'));
    assert(!setCookie.includes('Secure'), 'Plain HTTP loopback must not set an unusable Secure cookie.');
    assert(!setCookie.includes('Domain='));
    return { cookie: setCookie.split(';')[0], csrf, setCookie };
  }
  async function freshSession() {
    const link = new URL((await server.start()).url);
    return connect(new URLSearchParams(link.hash.slice(1)).get('office-token'));
  }
  async function events(session) {
    const abort = new AbortController();
    const response = await fetch(`${origin}/api/events`, { headers: { Cookie: session.cookie, 'X-Office-CSRF': session.csrf }, signal: abort.signal });
    assert.equal(response.status, 200);
    assert(response.headers.get('content-type').startsWith('text/event-stream'));
    const reader = response.body.getReader();
    const decode = new TextDecoder();
    let pending = '';
    return {
      async next(timeoutMs = 3000) {
        const timer = setTimeout(() => abort.abort(), timeoutMs);
        try {
          for (;;) {
            const boundary = pending.indexOf('\n\n');
            if (boundary !== -1) {
              const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
              const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
              if (data) return JSON.parse(data);
              continue;
            }
            const { done, value } = await reader.read();
            if (done) return undefined;
            pending += decode.decode(value, { stream: true });
          }
        } finally { clearTimeout(timer); }
      },
      async close() { abort.abort(); await reader.cancel().catch(() => undefined); },
    };
  }
  return { directory, assetsDirectory, server, control, origin, url, capability, post, connect, freshSession, events };
}
async function raw(origin, target, { method = 'GET', headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}/`, { method, path: target, headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', value => { body += value; });
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('The local HTTP probe timed out.')));
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

test('launch capabilities stay in fragments and public assets enforce CSP and canonical containment', async t => {
  const value = await fixture(t);
  assert.equal(value.url.protocol, 'http:'); assert.equal(value.url.hostname, '127.0.0.1'); assert(Number(value.url.port) > 0);
  assert.equal(value.url.pathname, '/'); assert.equal(value.url.search, ''); assert.equal(value.url.username, ''); assert.equal(value.url.password, '');
  assert(value.capability && value.capability.length >= 40);
  const main = await fetch(value.origin);
  assert.equal(main.status, 200);
  assert((await main.text()).includes('Local office fixture'));
  assert.equal(main.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(main.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(main.headers.get('access-control-allow-origin'), null);
  const csp = main.headers.get('content-security-policy');
  assert(csp.includes("script-src 'self'") && csp.includes("style-src 'self' 'unsafe-inline'") && csp.includes("frame-ancestors 'none'") && !csp.includes('unsafe-eval'));
  const js = await fetch(`${value.origin}/assets/app.js`);
  assert.equal(js.status, 200); assert(js.headers.get('content-type').startsWith('text/javascript'));
  const head = await fetch(value.origin, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const target of ['/../outside.js', '/%2e%2e/outside.js', '/assets/../../outside.js', '/%5c..%5coutside.js', '/escape.js', '/escape-directory/outside.js', '/assets/', '/missing.js', '/index.ts']) {
    const response = await raw(value.origin, target);
    assert([400, 404].includes(response.status), 'Traversal, external aliases, listings, and unsupported assets must not succeed.');
    assert(!response.body.includes('outside-private-fixture'));
  }
});

test('token exchange rejects foreign Origin, hostile Host, non-JSON bodies, and capability replay', async t => {
  const value = await fixture(t);
  assert.equal((await value.post('/api/connect', { token: value.capability }, undefined, { Origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await value.post('/api/connect', { token: value.capability }, undefined, { Origin: 'null' })).status, 403);
  assert.equal((await raw(value.origin, '/api/connect', { method: 'POST', headers: { Host: 'hostile.invalid', Origin: value.origin, 'Content-Type': 'application/json' },
    chunks: [JSON.stringify({ token: value.capability })] })).status, 403);
  assert.equal((await value.post('/api/connect', { token: value.capability }, undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await value.post('/api/connect', '{')).status, 400);
  assert.equal((await value.post('/api/connect', { token: value.capability, extra: true })).status, 400);
  const session = await value.connect();
  assert.equal((await value.post('/api/connect', { token: value.capability }, session)).status, 401, 'Consumed token must not silently resume a cookie.');
  assert.equal((await value.post('/api/connect', { token: 'invalid' }, session)).status, 401);
  const resumed = await value.post('/api/connect', {}, session);
  assert.equal(resumed.status, 200); assert.equal((await resumed.json()).csrf, session.csrf);
  assert.equal((await value.post('/api/connect', {})).status, 401);
});

test('messages and SSE require cookie plus CSRF and dispatch only through the supplied provider boundary', async t => {
  const value = await fixture(t); const session = await value.connect();
  const message = { type: 'fixtureAllowed', text: 'Public office request' };
  assert.equal((await value.post('/api/message', message)).status, 401);
  assert.equal((await value.post('/api/message', message, session, { 'X-Office-CSRF': '' })).status, 403);
  assert.equal((await value.post('/api/message', message, session, { 'X-Office-CSRF': 'é'.repeat(session.csrf.length) })).status, 403);
  assert.equal((await value.post('/api/message', message, session, { Origin: 'https://hostile.invalid' })).status, 403);
  assert.equal((await raw(value.origin, '/api/message', { method: 'POST', headers: { Host: `localhost:${value.url.port}`, Origin: value.origin,
    Cookie: session.cookie, 'X-Office-CSRF': session.csrf, 'Content-Type': 'application/json' }, chunks: [JSON.stringify(message)] })).status, 403);
  assert.equal((await fetch(`${value.origin}/api/events`)).status, 401);
  assert.equal((await fetch(`${value.origin}/api/events`, { headers: { Cookie: session.cookie } })).status, 403);
  assert.equal((await fetch(`${value.origin}/api/events`, { headers: { Cookie: session.cookie, 'X-Office-CSRF': session.csrf, Origin: 'https://hostile.invalid' } })).status, 403);
  assert.deepEqual(value.control.messages, []);
  const accepted = await value.post('/api/message', message, session);
  assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { ok: true, status: 'completed' });
  assert.deepEqual(value.control.messages, [message]);
  const rejected = await value.post('/api/message', { type: 'unapproved' }, session);
  assert.equal(rejected.status, 500); assert(!(await rejected.text()).includes('fabricated-private'));
  assert.equal(accepted.headers.get('cache-control'), 'no-store'); assert.equal(accepted.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${value.origin}/api/connect?token=invalid`, { method: 'POST', headers: { Origin: value.origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
});

test('a fresh launch in the same browser consumes its capability while retaining the existing cookie and CSRF', async t => {
  const value = await fixture(t); const session = await value.connect(); const stream = await value.events(session);
  assert.equal((await stream.next()).type, 'bootstrap');
  const capability = new URLSearchParams(new URL((await value.server.start()).url).hash.slice(1)).get('office-token');
  const reopened = await value.post('/api/connect', { token: capability }, session);
  assert.equal(reopened.status, 200); assert.equal((await reopened.json()).csrf, session.csrf);
  assert.equal(reopened.headers.get('set-cookie'), null, 'Opening another tab must not replace the shared browser cookie.');
  assert.equal((await value.post('/api/connect', { token: capability }, session)).status, 401);
  assert.equal((await value.post('/api/message', { type: 'fixtureAllowed' }, session)).status, 200);
  value.control.emit({ type: 'oldTabStillConnected' });
  assert.deepEqual(await stream.next(), { type: 'oldTabStillConnected' });
  await stream.close();
});

test('SSE bootstraps each stream, fans out messages, and releases disconnected subscriptions before reconnect', async t => {
  const value = await fixture(t); const first = await value.connect(); const second = await value.freshSession();
  const a = await value.events(first); const b = await value.events(second);
  assert.deepEqual(await a.next(), { type: 'bootstrap', connection: 1 });
  assert.deepEqual(await b.next(), { type: 'bootstrap', connection: 2 });
  value.control.emit({ type: 'publicState', text: 'line one\nline two' });
  assert.deepEqual(await a.next(), { type: 'publicState', text: 'line one\nline two' });
  assert.deepEqual(await b.next(), { type: 'publicState', text: 'line one\nline two' });
  await a.close(); await until(() => value.control.disposals === 1);
  assert.equal(value.control.callbacks.size, 1);
  value.control.emit({ type: 'stillConnected' }); assert.deepEqual(await b.next(), { type: 'stillConnected' });
  const restarted = await value.events(first); assert.deepEqual(await restarted.next(), { type: 'bootstrap', connection: 3 });
  await restarted.close(); await b.close(); await until(() => value.control.disposals === 3);
  assert.equal(value.control.callbacks.size, 0);
});

test('late bootstrap resolution after client abort disposes its subscription exactly once', async t => {
  const value = await fixture(t); const session = await value.connect(); value.control.connectGate = deferred();
  const events = await value.events(session); await value.control.connectEntered.promise;
  assert.deepEqual(await events.next(), { type: 'bootstrap', connection: 1 });
  await events.close();
  await value.server.dispose();
  value.control.connectGate.resolve();
  await until(() => value.control.disposals === 1);
  assert.equal(value.control.callbacks.size, 0);
});

test('aborted clients cannot accumulate unbounded pending provider bootstraps', async t => {
  const value = await fixture(t); const session = await value.connect(); value.control.connectGate = deferred();
  for (let index = 0; index < 8; index++) {
    const stream = await value.events(session);
    assert.equal((await stream.next()).connection, index + 1);
    await stream.close();
    // Let the HTTP disconnect reach the server before starting the next client.
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const rejected = await fetch(`${value.origin}/api/events`, { headers: { Cookie: session.cookie, 'X-Office-CSRF': session.csrf } });
  assert.equal(rejected.status, 429);
  assert.equal(value.control.connects, 8, 'Closed HTTP streams must not permit unlimited unresolved provider callbacks.');
  value.control.connectGate.resolve();
  await until(() => value.control.disposals === 8);
  const recovered = await value.events(session);
  assert.equal((await recovered.next()).connection, 9);
  await recovered.close();
  await until(() => value.control.disposals === 9);
});

test('oversized content-length and chunked JSON fail before dispatch while normal-sized requests remain usable', async t => {
  const value = await fixture(t); const session = await value.connect();
  const body = JSON.stringify({ type: 'fixtureAllowed', text: 'x'.repeat(70 * 1024) });
  assert.equal((await value.post('/api/message', body, session)).status, 413);
  const streamed = await raw(value.origin, '/api/message', { method: 'POST',
    headers: { Origin: value.origin, Cookie: session.cookie, 'X-Office-CSRF': session.csrf, 'Content-Type': 'application/json' },
    chunks: [body.slice(0, 50 * 1024), body.slice(50 * 1024)], });
  assert.equal(streamed.status, 413);
  assert.deepEqual(value.control.messages, []);
  assert.equal((await value.post('/api/message', { type: 'fixtureAllowed', text: 'small' }, session)).status, 200);
  assert.equal(value.control.messages.length, 1);
});

test('launch links expire, pending capabilities are bounded, and each start returns a fresh one-use fragment', async t => {
  const value = await fixture(t);
  const tokens = new Set([value.capability]);
  for (let index = 1; index < 8; index++) {
    const link = new URL((await value.server.start()).url);
    assert.equal(link.origin, value.origin);
    tokens.add(new URLSearchParams(link.hash.slice(1)).get('office-token'));
  }
  assert.equal(tokens.size, 8);
  await assert.rejects(value.server.start(), /too many.*launch/i);
  const original = Date.now;
  const now = original();
  Date.now = () => now + 6 * 60_000;
  try {
    assert.equal((await value.post('/api/connect', { token: value.capability })).status, 401);
    const link = new URL((await value.server.start()).url);
    const session = await value.connect(new URLSearchParams(link.hash.slice(1)).get('office-token'));
    assert.equal(typeof session.csrf, 'string');
  } finally { Date.now = original; }
});

test('expired cookies cannot resume or dispatch and a restart cannot accept the previous session', async t => {
  const value = await fixture(t); const session = await value.connect();
  const original = Date.now; const now = original(); Date.now = () => now + 31 * 60_000;
  try {
    assert.equal((await value.post('/api/connect', {}, session)).status, 401);
    assert.equal((await value.post('/api/message', { type: 'fixtureAllowed' }, session)).status, 401);
  } finally { Date.now = original; }
  await value.server.dispose();
  const replacement = new BrowserOfficeServer({ assetsDirectory: value.assetsDirectory, connect: send => value.control.connect(send), dispatch: async () => {} });
  t.after(() => replacement.dispose());
  const origin = new URL((await replacement.start()).url).origin;
  const response = await fetch(`${origin}/api/connect`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: session.cookie }, body: '{}' });
  assert.equal(response.status, 401);
});

test('SSE stream and browser session limits prevent unbounded subscriptions', async t => {
  const value = await fixture(t); const session = await value.connect();
  const a = await value.events(session); const b = await value.events(session);
  assert.equal((await fetch(`${value.origin}/api/events`, { headers: { Cookie: session.cookie, 'X-Office-CSRF': session.csrf } })).status, 429);
  assert.equal(value.control.connects, 2);
  await a.close(); await b.close();
  for (let index = 1; index < 8; index++) await value.freshSession();
  const capability = new URLSearchParams(new URL((await value.server.start()).url).hash.slice(1)).get('office-token');
  assert.equal((await value.post('/api/connect', { token: capability })).status, 429);
});

test('oversized output disconnects its subscriber without forwarding a partial private message', async t => {
  const value = await fixture(t); const session = await value.connect(); const stream = await value.events(session);
  assert.equal((await stream.next()).type, 'bootstrap');
  value.control.emit({ type: 'tooLarge', text: 'x'.repeat(33 * 1024 * 1024) });
  await until(() => value.control.disposals === 1);
  assert.equal(value.control.callbacks.size, 0);
  await stream.close();
});

test('available decoded shipped asset bootstrap messages fit the output bounds', async t => {
  const value = await fixture(t); const session = await value.connect(); const stream = await value.events(session);
  assert.equal((await stream.next()).type, 'bootstrap');
  const assetsBundle = await build({
    stdin: { contents: "export * from './src/assetLoader';", resolveDir: root },
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', write: false, drop: ['console'],
    plugins: [{ name: 'asset-only-vscode-types', setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'asset-fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'asset-fixture' }, () => ({ contents: 'export {};', loader: 'js' }));
    } }],
  });
  const assets = new Module(path.join(root, 'scripts/browser-assets-fixture.cjs'));
  assets.filename = path.join(root, 'scripts/browser-assets-fixture.cjs'); assets.paths = Module._nodeModulePaths(root);
  assets._compile(assetsBundle.outputFiles[0].text, assets.filename);
  const directory = path.join(root, 'dist');
  const characters = await assets.exports.loadCharacterSprites(directory);
  const walls = await assets.exports.loadWallTiles(directory);
  const floors = await assets.exports.loadFloorTiles(directory);
  const furniture = await assets.exports.loadFurnitureAssets(directory);
  assert(characters?.characters.length > 0, 'The shipped character asset fixture must be present.');
  const frames = [
    { type: 'characterSpritesLoaded', characters: characters.characters },
    ...(walls ? [{ type: 'wallTilesLoaded', sprites: walls.sprites }] : []),
    ...(floors ? [{ type: 'floorTilesLoaded', sprites: floors.sprites }] : []),
    ...(furniture ? [{ type: 'furnitureAssetsLoaded', catalog: furniture.catalog, sprites: Object.fromEntries(furniture.sprites) }] : []),
  ];
  // Emit the whole bootstrap burst before reading, just as the provider does.
  for (const frame of frames) value.control.emit(frame);
  for (const frame of frames) assert.deepEqual(await stream.next(), frame);
  assert.equal(value.control.callbacks.size, 1, 'A normal shipped bootstrap must not disconnect as a slow-consumer overflow.');
  console.log(`INFO: shipped decoded asset bootstrap ${frames.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)), 0)} bytes in ${frames.length} frames.`);
  await stream.close();
});

test('dispose revokes sessions, closes SSE and sockets, and prevents restarting the closed instance', async t => {
  const value = await fixture(t); const session = await value.connect(); const stream = await value.events(session);
  assert.equal((await stream.next()).type, 'bootstrap');
  const first = value.server.dispose(); assert.equal(value.server.dispose(), first);
  await first;
  await until(() => value.control.disposals === 1);
  await stream.close();
  await assert.rejects(value.server.start(), /closed/i);
  await assert.rejects(fetch(value.origin, { signal: AbortSignal.timeout(1000) }));
});

test('failed asset startup and disposal before startup never expose a listener', async t => {
  const value = await fixture(t);
  const failed = new BrowserOfficeServer({ assetsDirectory: path.join(value.directory, 'missing'), connect: async () => ({ dispose() {} }), dispatch: async () => {} });
  await assert.rejects(failed.start()); await failed.dispose();
  const closed = new BrowserOfficeServer({ assetsDirectory: value.assetsDirectory, connect: async () => ({ dispose() {} }), dispatch: async () => {} });
  await closed.dispose(); await assert.rejects(closed.start(), /closed/i);
});

test('a failed asset startup can retry successfully after assets become available', async t => {
  const value = await fixture(t); const assetsDirectory = path.join(value.directory, 'retry-assets');
  const retry = new BrowserOfficeServer({ assetsDirectory, connect: async () => ({ dispose() {} }), dispatch: async () => {} });
  t.after(() => retry.dispose());
  const attempts = await Promise.allSettled([retry.start(), retry.start()]);
  assert(attempts.every(attempt => attempt.status === 'rejected'));
  await mkdir(assetsDirectory); await writeFile(path.join(assetsDirectory, 'index.html'), '<title>Recovered local office</title>');
  const first = new URL((await retry.start()).url); const second = new URL((await retry.start()).url);
  assert.equal(first.origin, second.origin); assert.notEqual(first.hash, second.hash);
  assert((await (await fetch(first.origin)).text()).includes('Recovered local office'));
  await retry.dispose(); await assert.rejects(fetch(first.origin));
});

test('a failed loopback listen releases its failed server before a subsequent retry binds', async t => {
  const value = await fixture(t); const servers = [];
  const failedBundle = new Module(path.join(root, 'scripts/browser-office-listen-retry.cjs'));
  failedBundle.filename = failedBundle.id; failedBundle.paths = Module._nodeModulePaths(root);
  const nativeRequire = failedBundle.require.bind(failedBundle);
  failedBundle.require = id => {
    if (id !== 'node:http') return nativeRequire(id);
    const http = nativeRequire(id);
    return { ...http, createServer(...args) {
      const server = http.createServer(...args); const listen = server.listen.bind(server); const first = servers.length === 0;
      servers.push(server);
      server.listen = (port, host, callback) => listen(first ? Number(value.url.port) : port, host, callback);
      return server;
    } };
  };
  failedBundle._compile(bundle.outputFiles[0].text, failedBundle.filename);
  const retry = new failedBundle.exports.BrowserOfficeServer({ assetsDirectory: value.assetsDirectory,
    connect: async () => ({ dispose() {} }), dispatch: async () => {} });
  t.after(() => retry.dispose());
  const attempts = await Promise.allSettled([retry.start(), retry.start()]);
  assert(attempts.every(attempt => attempt.status === 'rejected' && attempt.reason.code === 'EADDRINUSE'));
  assert.equal(servers.length, 1, 'Concurrent launches must share one initial listener attempt.');
  assert.equal(servers[0].listening, false);
  const recovered = new URL((await retry.start()).url);
  assert.equal(recovered.hostname, '127.0.0.1'); assert.notEqual(recovered.port, value.url.port);
  assert.equal((await fetch(recovered.origin)).status, 200);
  assert.equal(servers.length, 2);
  await retry.dispose(); assert(servers.every(server => !server.listening));
  await assert.rejects(fetch(recovered.origin));
});

test('message responses preserve only explicit completed or cancelled status and never dispatch output', async t => {
  const value = await fixture(t); const session = await value.connect();
  const privateData = 'FABRICATED-PRIVATE-RETURN-DETAIL';
  for (const [result, expected] of [
    [{ status: 'completed', credential: privateData }, 'completed'],
    [{ status: 'cancelled', detail: privateData }, 'cancelled'],
    [{ status: 'unknown', error: privateData }, 'completed'],
    [{ status: 5, password: privateData }, 'completed'],
    [undefined, 'completed'], [null, 'completed'], ['cancelled', 'completed'],
    [[{ status: 'cancelled' }], 'completed'], [Object.create({ status: 'cancelled' }), 'completed'],
  ]) {
    value.control.dispatchResult = result;
    const response = await value.post('/api/message', { type: 'fixtureAllowed' }, session);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, status: expected });
  }
});

test('SSE readiness is an explicit provider frame after its complete bootstrap, never just HTTP success', async t => {
  const value = await fixture(t); const session = await value.connect(); const ready = deferred();
  value.control.connect = async send => {
    value.control.callbacks.add(send); send({ type: 'officeBrowserBootstrap' }); await ready.promise;
    send({ type: 'officeDeskState', state: { ready: true } }); send({ type: 'officeBrowserReady' });
    return { dispose() { value.control.callbacks.delete(send); value.control.disposals++; } };
  };
  t.after(() => ready.resolve());
  const stream = await value.events(session);
  assert.deepEqual(await stream.next(), { type: 'officeBrowserBootstrap' });
  let completed = false; const waiting = stream.next().then(frame => { completed = true; return frame; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
  ready.resolve();
  assert.deepEqual(await waiting, { type: 'officeDeskState', state: { ready: true } });
  assert.deepEqual(await stream.next(), { type: 'officeBrowserReady' });
  await stream.close(); await until(() => value.control.disposals === 1);
});

test('bootstrap rejection sends a fixed safe connection error before ending SSE', async t => {
  const value = await fixture(t); const session = await value.connect();
  value.control.connect = async send => { send({ type: 'officeBrowserBootstrap' }); throw new Error('FABRICATED-PRIVATE-BOOTSTRAP-DETAIL'); };
  const stream = await value.events(session);
  assert.deepEqual(await stream.next(), { type: 'officeBrowserBootstrap' });
  assert.deepEqual(await stream.next(), { type: 'officeBrowserConnectionError', error: 'The browser office could not initialize. Reopen it from VS Code.' });
  assert.equal(await stream.next(), undefined);
  await stream.close();
});

test('bootstrap timeout sends the safe connection error and disposes a late provider subscription', async t => {
  const value = await fixture(t); const session = await value.connect(); value.control.connectGate = deferred();
  const stream = await value.events(session); assert.equal((await stream.next()).type, 'bootstrap');
  assert.deepEqual(await stream.next(12_000), { type: 'officeBrowserConnectionError', error: 'The browser office could not initialize. Reopen it from VS Code.' });
  assert.equal(await stream.next(), undefined);
  value.control.connectGate.resolve(); await until(() => value.control.disposals === 1);
  assert.equal(value.control.callbacks.size, 0); await stream.close();
});
