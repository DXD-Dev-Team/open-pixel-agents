/** Pure VS Code API harness: verifies listener ownership without opening a window. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { createRequire } from 'node:module';
globalThis.require = createRequire(import.meta.url);
const active = new Set(); const closed = new Set();
const event = set => listener => { set.add(listener); return { dispose() { set.delete(listener); } }; };
class EventEmitter {
  listeners = new Set(); event = event(this.listeners);
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
globalThis.__officeViewVscode = {
  EventEmitter,
  window: { terminals: [], createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    onDidChangeActiveTerminal: event(active), onDidCloseTerminal: event(closed) },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) },
  commands: { executeCommand: async () => undefined },
  Uri: { joinPath: (root, ...parts) => ({ fsPath: path.join(root.fsPath, ...parts) }) },
};
const bundle = await build({ entryPoints: ['src/PixelAgentsViewProvider.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
  plugins: [{ name: 'vscode-harness', setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'probe' }));
    builder.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({ loader: 'js', contents: 'export const {EventEmitter,window,workspace,commands,Uri}=globalThis.__officeViewVscode;' }));
  } }] });
const { PixelAgentsViewProvider } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const state = { get: (_key, fallback) => fallback, update: async () => undefined };
const provider = new PixelAgentsViewProvider({ extensionUri: { fsPath: process.cwd() }, subscriptions: [], workspaceState: state, globalState: state }, {});
function view() {
  const disposed = new Set(); const messages = new Set();
  return { disposed, messages, onDidDispose: event(disposed), webview: { options: {}, html: '', asWebviewUri: uri => uri.fsPath,
    onDidReceiveMessage: event(messages), postMessage() {} } };
}
const first = view(); const second = view();
provider.resolveWebviewView(first);
assert.equal(active.size, 1); assert.equal(closed.size, 1); assert.equal(first.messages.size, 1);
provider.resolveWebviewView(second);
assert.equal(first.messages.size, 0); assert.equal(active.size, 1); assert.equal(closed.size, 1);
let removals = 0; const terminal = { name: 'Existing worker' };
provider.agents.set(1, { id: 1, terminalRef: terminal });
provider.removeAgentUi = () => { removals++; };
for (const listener of closed) listener(terminal);
assert.equal(removals, 1, 'A terminal close must be handled once after view recreation.');
for (const listener of first.disposed) listener();
assert.equal(closed.size, 1, 'Disposal of the older view must not remove current listeners.');
for (const listener of second.disposed) listener();
assert.equal(active.size, 0); assert.equal(closed.size, 0); assert.equal(second.messages.size, 0);
provider.agents.clear(); provider.dispose();
console.log('PASS: view recreation and disposal keep one terminal/message listener; a close is handled once and all listeners are released.');
