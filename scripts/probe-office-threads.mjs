/** Native attach and remote-view protocol fixture. No VS Code, OpenCode, TUI,
 * provider, credentials or global user state is accessed. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp,mkdir,realpath,rm,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
globalThis.require=createRequire(import.meta.url);
Error.prepareStackTrace=(error,frames)=>`${error.name}: ${error.message}\n${frames.filter(frame=>!String(frame.getFileName()).startsWith('data:')).map(frame=>`    at ${frame}`).join('\n')}`;
class EventEmitter { listeners=new Set();event=listener=>{this.listeners.add(listener);return{dispose:()=>this.listeners.delete(listener)}};fire(value){for(const listener of this.listeners)listener(value)}dispose(){this.listeners.clear()} }
let remoteDirectory,remoteReady;const commands=[];const terminals=[];
globalThis.__officeThreadsVscode={EventEmitter,extensions:{getExtension:()=>remoteDirectory===undefined?undefined:{activate:async()=>({standaloneDirectory:remoteDirectory,ready:remoteReady})}},
  window:{terminals,createOutputChannel:()=>({appendLine(){},dispose(){}}),onDidChangeActiveTerminal:()=>({dispose(){}}),onDidCloseTerminal:()=>({dispose(){}}),createTerminal:options=>{const terminal={name:options.name,disposed:false,show(){},dispose(){this.disposed=true;options.pty?.close?.();}};terminals.push(terminal);return terminal;}},
  commands:{executeCommand:async(...args)=>{commands.push(args);return{status:'completed'}}},workspace:{workspaceFolders:[],getConfiguration:()=>({get:()=>undefined})},Uri:{file:fsPath=>({fsPath}),joinPath:(uri,...parts)=>({fsPath:path.join(uri.fsPath,...parts)})}};
const bundle=await build({stdin:{contents:"export {PixelAgentsViewProvider} from './src/PixelAgentsViewProvider.ts';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',plugins:[{name:'vscode',setup(builder){builder.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:'export const {EventEmitter,extensions,window,workspace,commands,Uri}=globalThis.__officeThreadsVscode;'}));builder.onResolve({filter:/^\.\/layoutPersistence\.js$/},()=>({path:'layout',namespace:'layout-fixture'}));builder.onLoad({filter:/.*/,namespace:'layout-fixture'},()=>({loader:'js',contents:'export function readLayoutFromFile(){return globalThis.__officeThreadsLayout??null;} export function writeLayoutToFile(){throw new Error("Fixture must not write global layouts");} export function watchLayoutFile(){throw new Error("Fixture must not watch global layouts");} export function migrateAndLoadLayout(context,defaultLayout){return context.workspaceState.get("office-pixel-agents.layout",defaultLayout);}' }));}}]});
const{PixelAgentsViewProvider}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const directory=await realpath(await mkdtemp(path.join(tmpdir(),'office-native-threads-'))),repoA=path.join(directory,'repo-a'),repoB=path.join(directory,'repo-b');await mkdir(repoA);await mkdir(repoB);
await mkdir(path.join(directory,'dist','webview'),{recursive:true});await writeFile(path.join(directory,'dist','webview','index.html'),'<html>Fixture</html>');
const sessions=new Map([['first',{id:'first',directory:repoA}],['second',{id:'second',directory:repoA}],['secondary',{id:'secondary',directory:repoB}],['child',{id:'child',directory:repoA,parentID:'first'}]]),gets=[];
const runtime={getServerPort:()=>4000,getSession:async(id,cwd)=>{gets.push({id,cwd});const session=sessions.get(id);if(!session)throw new Error('Missing fixture conversation');return session},createSession:()=>assert.fail('Attach never creates a session'),deleteSession:()=>assert.fail('Attach/detach never deletes a session'),ensureServer:()=>assert.fail('Fixture never starts a runtime')};
const values=new Map();let failPersist=false;
const state={get:(key,fallback)=>values.get(key)??fallback,update:async(key,value)=>{if(failPersist){failPersist=false;throw new Error('Fixture persistence rejection')}values.set(key,structuredClone(value));}};
const context={extensionUri:{fsPath:directory},subscriptions:[],workspaceState:state,globalState:state};
const messages=[];const view={show(){},onDidDispose:()=>({dispose(){}}),webview:{postMessage:message=>{messages.push(structuredClone(message));return Promise.resolve(true)},asWebviewUri:uri=>uri.fsPath,onDidReceiveMessage:()=>({dispose(){}})}};
const provider=new PixelAgentsViewProvider(context,runtime);provider.webviewView=view;provider.ensureReady=async()=>{};provider.reserveComputerDesk=async()=> 'fixture-chair';
provider.runtimeController={removeAgent(){},registerAgent(){},hydrateAll:async()=>{},dispose(){}};
const metadata={workerId:'worker',name:'Manager',role:'manager',managerForRole:'builder',repoId:'home'};
try{
  values.set('office-pixel-agents.layout',{version:1,fixture:'workspace fallback'});values.set('office-pixel-agents.agentSeats',{'7':{palette:3,seatId:'custom-chair'}});
  const firstExport=provider.exportOfficeLayout();assert.equal(firstExport.layout.fixture,'workspace fallback');assert.equal(firstExport.seats['7'].palette,3);firstExport.seats['7'].palette=5;assert.equal(values.get('office-pixel-agents.agentSeats')['7'].palette,3);
  globalThis.__officeThreadsLayout={version:1,fixture:'saved layout file'};assert.equal(provider.exportOfficeLayout().layout.fixture,'saved layout file');delete globalThis.__officeThreadsLayout;
  values.delete('office-pixel-agents.layout');values.delete('office-pixel-agents.agentSeats');assert.deepEqual(provider.exportOfficeLayout(),{layout:null,seats:{}});
  console.log('PASS: private layout export reads own persisted layout/seats, returns an isolated clone, and requires no runtime or renderer handshake.');
  const first=await provider.attachManagedAgent({sessionId:'first',cwd:repoA,displayName:'Manager',metadata});assert.equal(first.agentId,1);assert.equal(first.sessionId,'first');assert.equal(gets.at(-1).cwd,repoA);
  const firstTerminal=provider.agents.get(1).terminalRef;
  const second=await provider.attachManagedAgent({sessionId:'second',cwd:repoA,displayName:'Manager',metadata});assert.equal(second.agentId,1);assert.equal(provider.agents.size,1);assert(firstTerminal.disposed);assert(!messages.some(message=>message.type==='agentClosed'));
  const secondary=await provider.attachManagedAgent({sessionId:'secondary',cwd:repoB,displayName:'Manager',metadata:{...metadata,activeRepoId:'secondary'}});assert.equal(secondary.agentId,1);assert.equal(secondary.cwd,repoB);assert.equal(secondary.metadata.repoId,'home');
  console.log('PASS: attach validates native directory, keeps one character across conversations/repositories, and never creates/deletes native sessions.');
  const before=provider.agents.get(1),persisted=JSON.stringify(values);
  for(const input of [{sessionId:'missing',cwd:repoB},{sessionId:'first',cwd:repoB},{sessionId:'child',cwd:repoA}])await assert.rejects(provider.attachManagedAgent({...input,displayName:'Manager',metadata}),/Missing|repository/);
  failPersist=true;await assert.rejects(provider.attachManagedAgent({sessionId:'second',cwd:repoA,displayName:'Manager',metadata}),/persistence/);
  assert.equal(provider.agents.get(1),before);assert(!before.terminalRef.disposed);assert.equal(JSON.stringify(values),persisted);assert(terminals.at(-1).disposed);
  console.log('PASS: missing/wrong-repo/child conversations and persistence failure retain the old binding, UI and terminal; speculative terminal is disposed.');
  await provider.detachManagedAgent(1,'second');assert.equal(provider.agents.get(1),before);assert(!before.terminalRef.disposed,'Stale detach cannot remove a newer attachment using the same character ID.');
  await provider.detachManagedAgent(1,'secondary');assert.equal(provider.agents.size,0);assert(before.terminalRef.disposed);assert(messages.some(message=>message.type==='agentClosed'&&message.id===1));assert(sessions.has('first')&&sessions.has('second')&&sessions.has('secondary'));
  console.log('PASS: detach frees terminal/UI/binding while retaining all conversation history.');
  remoteDirectory=directory;const remoteMessages=[];const remoteCalls=[];let disposed=0;
  const remote=new PixelAgentsViewProvider(context,new Proxy({}, {get:(_target,key)=>()=>assert.fail(`Mirror cannot call local runtime ${String(key)}`)}));remote.webviewView={...view,webview:{...view.webview,postMessage:message=>{remoteMessages.push(structuredClone(message));return Promise.resolve(true)}}};
  remote.connectStandalone=async selected=>{assert.equal(selected,directory);return{metadata:{workspaceRoot:repoA,url:'http://127.0.0.1:18084'},request:async(method,params)=>{remoteCalls.push({method,params});if(method==='subscribe'){remote.standaloneMessage({type:'layoutLoaded',layout:null});return{ok:true}}if(method==='bootstrap')return[{type:'officeHostCapabilities',standalone:true,hostOwnsSeats:true},{type:'layoutLoaded',layout:null}];if(method==='openBrowser')return{url:'http://127.0.0.1:18084/#office-token=FABRICATED-FIXTURE'};return[]},dispose:()=>{disposed++}}};
  await remote.handleMessage({type:'webviewReady'});assert.deepEqual(remoteCalls.map(call=>call.method),['subscribe']);assert.equal(remoteMessages[0].type,'officeHostCapabilities');assert.equal(remoteMessages.filter(message=>message.type==='layoutLoaded').length,1);
  assert.throws(()=>remote.exportOfficeLayout(),/standalone Office owns/);
  await remote.handleMessage({type:'webviewReady'});assert.deepEqual(remoteCalls.map(call=>call.method),['subscribe','bootstrap']);assert.equal(remoteMessages.filter(message=>message.type==='layoutLoaded').length,2);
  remote.standaloneMessage({type:'rawCredential',key:'DO-NOT-PUBLISH'});assert(!JSON.stringify(remoteMessages).includes('DO-NOT-PUBLISH'));
  await remote.handleMessage({type:'saveAgentSeats',seats:{forged:true}});await remote.handleMessage({type:'officeSeatCapacity',requestId:1,seatId:'forged'});assert.equal(remoteCalls.length,2);
  await remote.handleMessage({type:'saveLayout',layout:{fixture:true}});assert.equal(remoteCalls.at(-1).method,'dispatch');assert.equal(remoteCalls.at(-1).params.type,'saveLayout');
  await remote.handleMessage({type:'officeAgentAction',agentId:1,requestId:'fixture-request',action:'stop'});assert.equal(commands.at(-1)[0],'office-desk.browserAgentAction');assert.deepEqual(remoteMessages.filter(message=>message.type==='officeAgentActionState').map(message=>message.state),['pending','completed']);
  assert.equal(await remote.openBrowserOffice(),'http://127.0.0.1:18084/#office-token=FABRICATED-FIXTURE');assert.equal(remote.browserServer,undefined);
  await assert.rejects(remote.getServerConnection(),/standalone Office owns/);await assert.rejects(remote.closeManagedAgent(1),/standalone Office controls/);
  remote.dispose();assert.equal(disposed,1);
  let readyResolve;remoteReady=new Promise(resolve=>{readyResolve=resolve;});let readyConnections=0;
  const gated=new PixelAgentsViewProvider(context,new Proxy({}, {get:(_target,key)=>()=>assert.fail(`Pending Desk mirror cannot call local runtime ${String(key)}`)}));gated.webviewView=view;
  gated.connectStandalone=async()=>{readyConnections++;return{metadata:{workspaceRoot:repoA,url:'http://127.0.0.1:18084'},request:async()=>({subscribed:true}),dispose(){}}};
  const readyBoot=gated.bootstrapWebview();await new Promise(resolve=>setTimeout(resolve,0));assert(gated.isStandaloneMirror);assert.equal(readyConnections,0);
  readyResolve();await readyBoot;assert.equal(readyConnections,1);gated.dispose();
  let readyReject;remoteReady=new Promise((_resolve,reject)=>{readyReject=reject;});
  const failedDesk=new PixelAgentsViewProvider(context,new Proxy({}, {get:(_target,key)=>()=>assert.fail(`Failed Desk mirror cannot call local runtime ${String(key)}`)}));failedDesk.webviewView=view;
  failedDesk.connectStandalone=async()=>assert.fail('Failed Desk initialization must not expose actions through a second client');
  const failedBoot=failedDesk.bootstrapWebview();await new Promise(resolve=>setTimeout(resolve,0));readyReject(new Error('Fixture Desk commands failed'));await assert.rejects(failedBoot,/standalone Office could not connect/);assert(failedDesk.isStandaloneMirror);failedDesk.dispose();remoteReady=undefined;
  console.log('PASS: mirror waits for Desk command readiness and fails closed on rejected Desk initialization before connecting or exposing actions.');
  remoteDirectory=directory;const unavailable=new PixelAgentsViewProvider(context,new Proxy({}, {get:(_target,key)=>()=>assert.fail(`Failed mirror cannot fall back to local runtime ${String(key)}`)}));unavailable.webviewView=view;
  unavailable.connectStandalone=async()=>{throw new Error('Fabricated disconnected IPC')};
  await assert.rejects(unavailable.bootstrapWebview(),/standalone Office could not connect/);assert(unavailable.isStandaloneMirror);unavailable.dispose();
  console.log('PASS: remote boot subscribes once, renderer reload replays once, seats remain host-owned, actions are awaited, and no local runtime/browser server starts.');
}finally{provider.agents.clear();provider.dispose();remoteReady=undefined;delete globalThis.__officeThreadsVscode;delete globalThis.__officeThreadsLayout;await rm(directory,{recursive:true,force:true});}
