/** Source/API fixture; no VS Code window or provider inference. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
globalThis.require=createRequire(import.meta.url);
const event=set=>listener=>{set.add(listener);return{dispose(){set.delete(listener);}};};
class EventEmitter{listeners=new Set();event=event(this.listeners);fire(value){for(const fn of this.listeners)fn(value);}dispose(){this.listeners.clear();}}
globalThis.__controlsVscode={EventEmitter,window:{terminals:[],createOutputChannel:()=>({appendLine(){},dispose(){}}),onDidChangeActiveTerminal:event(new Set()),onDidCloseTerminal:event(new Set())},workspace:{workspaceFolders:[],getConfiguration:()=>({get:()=>undefined})},commands:{executeCommand:async()=>undefined},Uri:{joinPath:(root,...parts)=>({fsPath:path.join(root.fsPath,...parts)})}};
const bundle=await build({stdin:{contents:"export * from './src/agentControls.ts';export {PixelAgentsViewProvider} from './src/PixelAgentsViewProvider.ts';export {createOpenCodeSession,getOpenCodeSession,getOpenCodeSessionMessages,getOpenCodeSessionChildren,getOpenCodeSessionStatuses,deleteOpenCodeSession} from './src/opencodeClient.ts';export {OfficeState,effectiveSeatRole} from './webview-ui/src/office/engine/officeState.ts';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',plugins:[{name:'vscode',setup(b){b.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'probe'}));b.onLoad({filter:/.*/,namespace:'probe'},()=>({loader:'js',contents:'export const {EventEmitter,window,workspace,commands,Uri}=globalThis.__controlsVscode;'}));}}]});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const{normalizeAgentPanel,normalizeAgentAction,OfficeState,PixelAgentsViewProvider,effectiveSeatRole}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const input={worker:{id:'worker',name:'Builder',role:'builder',status:'idle',started:true,token:'fixture-private'},chat:[{id:'a',role:'assistant',text:'<script>plain text only</script>',createdAt:1},{id:'secret',role:'system',text:'private'}],account:{id:'account',name:'Account',kind:'codex',connected:true,accessToken:'fixture-private'},accounts:[],pending:false,busy:false,privateKey:'fixture-private',manager:{mode:'human-approval',paused:true,coordinating:true,executing:true,teamIds:['worker'],team:[{id:'worker',name:'Builder',role:'builder'}],proposals:[{id:'proposal',text:'Build it',status:'running'}]}};
const normalized=normalizeAgentPanel(input);
assert.equal(normalized.chat.length,1);assert.equal(normalized.chat[0].text,input.chat[0].text);assert(!JSON.stringify(normalized).includes('fixture-private'));assert(normalized.manager.paused&&normalized.manager.coordinating&&normalized.manager.executing);assert.equal(normalized.manager.proposals[0].status,'running');
assert.throws(()=>normalizeAgentPanel({...input,worker:{...input.worker,role:'system-admin'}}));
assert.deepEqual(normalizeAgentAction({agentId:1,requestId:'request-1',action:'assign-team',teamIds:['a','a']}).teamIds,['a']);assert.equal(normalizeAgentAction({agentId:1,requestId:'account',action:'change-account',accountId:'safe'}).accountId,'safe');
for(const bad of[{agentId:-1,action:'send',text:'x'},{agentId:1,action:'execute'},{agentId:1,action:'role',role:'admin'},{agentId:1,action:'change-account'},{agentId:1,action:'role'},{agentId:1,action:'manager-scope'},{agentId:1,action:'send',text:'\0\0'}])assert.throws(()=>normalizeAgentAction({requestId:'invalid',...bad}));
console.log('PASS: controls copy public fields only and reject unknown actions/roles/accounts.');
const office=new OfficeState();assert.deepEqual(Object.fromEntries(['builder','security-reviewer','verifier','manager'].map(role=>[role,[...office.seats.values()].filter(seat=>seat.role===role).length])),{builder:6,'security-reviewer':2,verifier:2,manager:2});
for(let id=1;id<=6;id++){const requestId=100+id;assert(office.reserveComputerDesk(requestId,'builder'));office.addAgent(id,0,0,undefined,true,true,requestId,'builder');}
assert.equal(office.reserveComputerDesk(200,'builder'),null);
const original=office.characters.get(1).seatId;const next=office.reserveComputerDesk(201,'security-reviewer',1);assert(next);assert(office.applyRoleSeat(1,201,'security-reviewer'));assert(office.seats.get(original).assigned);office.finishRoleSeat(201,false);assert.equal(office.characters.get(1).seatId,original);assert.equal(office.characters.get(1).officeLabel.role,'builder');assert.equal(office.seats.get(next).assigned,false);
assert(office.reserveComputerDesk(202,'security-reviewer',1));assert(office.applyRoleSeat(1,202,'security-reviewer'));office.finishRoleSeat(202,true);assert.equal(office.seats.get(original).assigned,false);assert.equal(office.applyRoleSeat(999,888,'manager'),false);
assert.equal(effectiveSeatRole({role:'manager',managerForRole:'builder'}),'builder');assert(office.reserveComputerDesk(203,'builder'));office.addAgent(7,0,0,undefined,true,true,203,'manager','builder');assert.equal(office.seats.get(office.characters.get(7).seatId).role,'builder');
console.log('PASS: role capacity fits six legacy builders; scoped managers sit with their team; role moves commit or compensate.');
let failPersist=false,rejectApply=false;const messages=new Set(),sent=[];const state={get:(_key,fallback)=>fallback,update:async()=>undefined};
const provider=new PixelAgentsViewProvider({extensionUri:{fsPath:process.cwd()},subscriptions:[],workspaceState:state,globalState:state},{});
const view={show(){},onDidDispose:event(new Set()),webview:{html:'',options:{},asWebviewUri:uri=>uri.fsPath,onDidReceiveMessage:event(messages),postMessage(message){sent.push(message);if(message.type==='officeSeatCapacityRequest')for(const receive of messages)void receive({type:'officeSeatCapacity',requestId:message.requestId,seatId:'role-chair'});if(message.type==='officeRoleSeatApply')assert.equal(provider.agents.get(1).officeMetadata.role,'builder');if(message.type==='officeRoleSeatApply')for(const receive of messages)void receive({type:'officeRoleSeatApplied',requestId:message.requestId,applied:!rejectApply});}}};
provider.resolveWebviewView(view);provider.ensureReady=async()=>undefined;const updates=[];provider.runtimeController={updateMetadata:(_id,patch)=>updates.push(patch),dispose(){}};provider.persistAgents=async()=>undefined;provider.persistAgentMetadata=async()=>{if(failPersist){failPersist=false;throw new Error('Fixture storage rejection');}};
provider.agents.set(1,{id:1,readOnly:true,sessionId:'session',serverPort:4100,displayName:'Worker',projectDir:'/private/tmp',terminalRef:{name:'Worker',dispose(){}},officeMetadata:{role:'builder',name:'Worker'}});
failPersist=true;await assert.rejects(provider.setManagedMetadata(1,{role:'security-reviewer'}),/Fixture storage/);assert.equal(provider.agents.get(1).officeMetadata.role,'builder');assert.equal(updates.length,0);assert(!sent.some(message=>message.type==='officeRoleSeatApply'));
rejectApply=true;await assert.rejects(provider.setManagedMetadata(1,{role:'security-reviewer'}),/no longer available/);assert.equal(provider.agents.get(1).officeMetadata.role,'builder');assert(sent.some(message=>message.type==='officeRoleSeatFinish'&&message.commit===false));assert.equal(updates.length,0);
rejectApply=false;await provider.setManagedMetadata(1,{role:'security-reviewer'});assert.equal(provider.agents.get(1).officeMetadata.role,'security-reviewer');assert.equal(updates.length,1);assert(sent.some(message=>message.type==='officeRoleSeatFinish'&&message.commit===true));
await provider.setAgentPanelState(1,input);assert(!JSON.stringify(provider.panelStates.get(1)).includes('fixture-private'));let actions=0;provider.bridgeEvents.event(event=>{if(event.type==='agent-action')actions++;});
for(const receive of messages)await receive({type:'officeAgentAction',agentId:999,requestId:'unmanaged',action:'open'});assert.equal(actions,0);for(const receive of messages)await receive({type:'officeAgentAction',agentId:1,requestId:'managed',action:'open'});assert.equal(actions,1);provider.agents.clear();provider.dispose();
console.log('PASS: failed persist/apply retains old metadata; valid apply publishes once; unmanaged controls cannot emit actions.');

const byRepo=new OfficeState();byRepo.configureRepositories([{id:'repo-a',name:'Repository A'},{id:'repo-b',name:'Repository B'}]);
assert.equal(byRepo.availableComputerDesks(),24);
for(let id=1;id<=6;id++){assert(byRepo.reserveComputerDesk(400+id,'builder',undefined,'repo-a'));byRepo.addAgent(id,0,0,undefined,true,true,400+id,'builder',undefined,'repo-a');}
assert.equal(byRepo.reserveComputerDesk(500,'builder',undefined,'repo-a'),null);assert(byRepo.reserveComputerDesk(501,'builder',undefined,'repo-b'));
byRepo.addAgent(7,0,0,undefined,true,true,501,'builder',undefined,'repo-b');assert.equal(byRepo.seats.get(byRepo.characters.get(7).seatId).repoId,'repo-b');
const custom=new OfficeState({...byRepo.getLayout(),officeDefault:false});const before=JSON.stringify(custom.getLayout());custom.configureRepositories([{id:'repo-a',name:'Renamed A'}]);assert.equal(JSON.stringify(custom.getLayout()),before,'Roster updates must preserve valid user layouts.');
console.log('PASS: each repository owns role capacity; a full Build area never borrows another repo desk; custom layouts are preserved.');
const oldFetch=globalThis.fetch;const calls=[];
try{globalThis.fetch=async(url,options)=>{calls.push({url,options});return{ok:true,json:async()=>({})};};
for(const cwd of ['/private/tmp/Repo A','/private/tmp/Repo B']){
 await api.createOpenCodeSession('Fixture',cwd);await api.getOpenCodeSession('root',cwd);await api.getOpenCodeSessionStatuses(cwd);await api.getOpenCodeSessionMessages('root',cwd);await api.getOpenCodeSessionChildren('root',cwd);await api.deleteOpenCodeSession('root',cwd);
 assert(calls.slice(-6).every(call=>new Headers(call.options.headers).get('x-opencode-directory')===encodeURIComponent(cwd)));
}
}finally{globalThis.fetch=oldFetch;}
assert.equal(calls.length,12);
console.log('PASS: create/read/status/history/children/delete route to the exact repository directory, including paths with spaces.');
