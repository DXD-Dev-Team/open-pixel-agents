import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { OFFICE_ROLE_LABELS } from '../constants.js'
import { officeConnection, vscode } from '../vscodeApi.js'
import type { BrowserActionState } from '../vscodeApi.js'
import type { OfficeRole } from '../office/types.js'
import { BrowserWorkerForm } from './BrowserWorkerForm.js'
import type { BrowserModelOption } from './BrowserWorkerForm.js'
import './BrowserDesk.css'
interface Worker { id: string; name: string; role: OfficeRole; repoId: string; status: string; accountId?: string; agentId?: number; error?: string; manager?: boolean }
interface DeskState { ready: boolean; setupNeeded?: boolean; login?: { accountId: string; kind: 'browser' | 'device'; instructions?: string }; error?: string; modelOptions?: BrowserModelOption[]; workers: Worker[]; repositories: Array<{ id: string; name: string; readOnly: boolean }>; accounts: Array<{ id: string; name: string; kind: string; connected: boolean; loginName?: string; authType?: string }>; attention: Array<{ id: string; workerName: string; kind: string; ask: string }> }
interface ActionRecord extends BrowserActionState { id?: string; kind?: string; order?: number }
const empty: DeskState = { ready: false, workers: [], repositories: [], accounts: [], attention: [] }
const actionLabels: Record<string, string> = { addAccount: 'Account setup', connectAccount: 'Sign-in', disconnectAccount: 'Account disconnect', removeAccount: 'Account removal', renameAccount: 'Account rename', createWorker: 'Agent creation', createManager: 'Manager creation', editWorker: 'Agent settings', addRepository: 'Repository selection', removeRepository: 'Repository removal', chatWorker: 'Opening chat', startWorker: 'Starting agent', abortWorker: 'Stopping agent', closeWorker: 'Closing session', openAgentChats: 'Opening VS Code chats', send: 'Message', question: 'Question reply' }
const hostDialogs = new Set(['showSetup', 'addAccount', 'connectAccount', 'renameAccount', 'editWorker', 'addRepository', 'question'])
const unconfirmedDialogs = new Set(['showSetup'])
export function BrowserDesk({ openAgent }: { openAgent: (agentId: number) => boolean }) {
  const connection = useSyncExternalStore(officeConnection.subscribe, officeConnection.getSnapshot)
  const [state, setState] = useState<DeskState>(empty)
  const [visible, setVisible] = useState(false)
  const [tab, setTab] = useState('agents')
  const [error, setError] = useState('')
  const [opening, setOpening] = useState<{ workerId: string; requestId?: string; deadline: number } | null>(null)
  const [provider, setProvider] = useState('codex')
  const [actions, setActions] = useState<Record<string, ActionRecord>>({})
  const [addingAccount, setAddingAccount] = useState(false)
  const [creating, setCreating] = useState<'agent' | 'manager' | null>(null)
  const [accountName, setAccountName] = useState('')
  const [accountWorkerId, setAccountWorkerId] = useState<string | undefined>()
  const [newMethod, setNewMethod] = useState<'api' | 'oauth'>('oauth')
  const [accountMethods, setAccountMethods] = useState<Record<string, 'api' | 'oauth'>>({})
  const requestIndex = useRef(0)
  const actionOrder = useRef(0)
  const accepted = useRef(new Set<string>())
  const latestRequest = useRef<string | undefined>(undefined)
  const accountRequest = useRef<string | undefined>(undefined)
  const accountFormRequest = useRef<string | undefined>(undefined)
  const workerFormRequest = useRef<{ requestId: string; kind: 'agent' | 'manager' } | undefined>(undefined)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = event.data
      if (message.type === 'officeDeskState') setState(message.state)
      if (message.type === 'officeBrowserCreateForm') {
        setVisible(true); setTab('agents')
        if (stateRef.current.ready && officeConnection.getSnapshot().connected) setCreating('agent')
        else setError('Office setup is not ready. Reconnect or open Office Desk in VS Code to resolve its connection error.')
      }
      if (message.type === 'officeBrowserBootstrap') { setOpening(null); setError(''); setActions({}); accepted.current.clear(); latestRequest.current = undefined; accountRequest.current = undefined; accountFormRequest.current = undefined; workerFormRequest.current = undefined }
      if (message.type === 'officeBrowserAccountForm' && accountRequest.current) { setVisible(true); setTab('admin'); setError('Account setup is already waiting for VS Code. Complete or cancel that dialog before creating another profile.'); return }
      if (message.type === 'officeBrowserAccountForm' && ['codex', 'claude', 'grok'].includes(message.kind) && typeof message.workerId === 'string') {
        setVisible(true); setTab('admin'); setProvider(message.kind); setAccountName(`${message.kind === 'codex' ? 'Codex' : message.kind === 'claude' ? 'Claude' : 'Grok'} profile ${stateRef.current.accounts.filter(account => account.kind === message.kind).length + 1}`); setNewMethod('oauth'); setAccountWorkerId(message.workerId); setAddingAccount(true); setError('')
      }
      if (message.type === 'officeBrowserActionState' && message.source !== 'agent') {
        const result = message as BrowserActionState
        const wasAccepted = accepted.current.has(result.requestId)
        if (result.action === 'addAccount' && result.state === 'pending') { accountRequest.current = result.requestId; accountFormRequest.current = result.requestId }
        if (['createWorker', 'createManager'].includes(result.action) && result.state === 'pending') workerFormRequest.current = { requestId: result.requestId, kind: result.action === 'createManager' ? 'manager' : 'agent' }
        if (result.requestId === accountRequest.current && result.state !== 'pending') accountRequest.current = undefined
        if (result.state === 'pending') { accepted.current.add(result.requestId); latestRequest.current = result.requestId }
        const order = result.state === 'pending' ? ++actionOrder.current : undefined
        setActions(current => Object.fromEntries([...Object.entries(current).filter(([id, item]) => id !== result.requestId && (item.state === 'pending' || Object.keys(current).length < 16)), [result.requestId, { ...current[result.requestId], ...result, ...(order ? { order } : {}) }]]))
        const ownsFeedback = latestRequest.current === result.requestId
        if (result.state === 'failed' && (ownsFeedback || !wasAccepted)) setError(result.error ?? 'The office action could not be completed.')
        else if (ownsFeedback) setError('')
        if (result.state === 'cancelled' || result.state === 'failed') setOpening(current => current?.requestId === result.requestId ? null : current)
        if (result.action === 'addAccount' && result.state === 'completed' && accountFormRequest.current === result.requestId) { setAddingAccount(false); setAccountName(''); setAccountWorkerId(undefined) }
        if (result.state === 'completed' && workerFormRequest.current?.requestId === result.requestId) { const kind = workerFormRequest.current.kind; setCreating(current => current === kind ? null : current) }
        if (result.state !== 'pending') accepted.current.delete(result.requestId)
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
  useEffect(() => {
    if (!opening) return
    const check = () => {
      const worker = stateRef.current.workers.find(item => item.id === opening.workerId)
      if (!worker) { setOpening(null); setError('This agent was removed. Choose another agent.'); return }
      if (worker.agentId && openAgent(worker.agentId)) { setOpening(null); return }
      if (Date.now() >= opening.deadline) { setOpening(null); setError('The agent has not joined the office yet. Check Office Desk in VS Code, then retry Chat.'); }
    }
    const timer = setInterval(check, 100)
    return () => clearInterval(timer)
  }, [opening, openAgent])
  const send = useCallback((action: string, values: Record<string, unknown> = {}) => {
    if (!connection.connected) { setError('Reconnect to VS Code before using these controls.'); return }
    if (!state.ready) { setError(state.error || 'Office setup is not ready. Open Office Desk in VS Code to resolve its connection error.'); return }
    setError('')
    const requestId = `desk-${Date.now()}-${++requestIndex.current}`
    setActions(current => ({ ...current, [requestId]: { requestId, action, source: 'desk', id: typeof values.id === 'string' ? values.id : undefined, kind: typeof values.kind === 'string' ? values.kind : undefined, state: 'pending' } }))
    vscode.postMessage({ type: 'officeDeskAction', requestId, action, ...values })
    return requestId
  }, [connection.connected, state.ready, state.error])
  const chat = useCallback((worker: Worker) => {
    if (!connection.connected || !state.ready) { send('chatWorker', { id: worker.id }); return }
    if (worker.agentId && openAgent(worker.agentId)) return
    const requestId = worker.agentId ? undefined : send('chatWorker', { id: worker.id })
    setOpening({ workerId: worker.id, requestId, deadline: Date.now() + 12_000 })
  }, [connection.connected, state.ready, openAgent, send])
  const beginAccount = (kind = provider, workerId?: string) => {
    setProvider(kind); setNewMethod('oauth'); setAccountWorkerId(workerId)
    const count = state.accounts.filter(account => account.kind === kind).length
    setAccountName(`${kind === 'codex' ? 'Codex' : kind === 'claude' ? 'Claude' : 'Grok'} profile ${count + 1}`)
    setAddingAccount(true)
  }
  const pending = (action: string, id?: string) => Object.values(actions).some(item => item.state === 'pending' && item.action === action && (id === undefined || item.id === id))
  const ordered = Object.values(actions).filter(item => item.order !== undefined).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  const latest = ordered.filter(item => item.state === 'pending').at(-1) ?? ordered.at(-1)
  const accountPending = (id: string) => Object.values(actions).some(item => item.state === 'pending' && item.id === id && ['connectAccount', 'renameAccount', 'disconnectAccount', 'removeAccount'].includes(item.action))
  const label = latest ? actionLabels[latest.action] ?? 'Office action' : ''
  const feedback = latest?.state === 'pending' ? hostDialogs.has(latest.action) ? `${label}: continue in VS Code. Complete or cancel the dialog there; this browser is waiting for its result.` : `${label}: waiting for VS Code…` : latest?.state === 'cancelled' ? `${label} cancelled. You can retry.` : latest?.state === 'completed' ? unconfirmedDialogs.has(latest.action) ? `${label}: VS Code dialog finished.` : `${label} completed.` : latest?.error
  return <>
    <aside className={`office-browser-connection office-connection-${connection.state}`} role="status"><span className="office-connection-dot" />{connection.message}{!connection.connected && <a href="vscode://dxd-dev-team.office-desk/open-browser">Reconnect in VS Code</a>}</aside>
    {feedback && <aside className={`office-browser-action-feedback office-action-${latest?.state}`} role={latest?.state === 'failed' ? 'alert' : 'status'}>{feedback}</aside>}
    <button className="office-browser-roster-toggle" onClick={() => setVisible(value => !value)} aria-expanded={visible}>Team · {state.workers.length}{state.attention.length ? ` · ${state.attention.length} need input` : ''}</button>
    {visible && <section className="office-browser-desk" aria-label="Office desk">
      <header><h2>Office desk</h2><button aria-label="Close office desk" onClick={() => setVisible(false)}>×</button></header>
      <nav aria-label="Office desk panels">{['agents', 'attention', 'repos', 'admin'].map(value => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{value === 'attention' ? `Attention (${state.attention.length})` : value}</button>)}</nav>
      <p className="office-browser-help">Sign-in and repository selection open secure dialogs in VS Code.</p>
      {state.setupNeeded && <p className="office-browser-help">Complete provider setup in VS Code, or skip and connect accounts later. <button disabled={!connection.connected || !state.ready || pending('showSetup')} onClick={() => send('showSetup')}>Provider setup in VS Code</button></p>}
      {(error || state.error) && <p className="office-browser-error" role="alert">{error || state.error}</p>}
      {!connection.connected && <p className="office-browser-error">Controls are unavailable until the browser reconnects to VS Code.</p>}
      {connection.connected && !state.ready && <p className="office-browser-error">Office setup is not ready. Open Office Desk in VS Code to resolve its connection error.</p>}
      <fieldset disabled={!connection.connected || !state.ready}>
          {creating && <div hidden={tab !== 'agents'}><BrowserWorkerForm key={creating} manager={creating === 'manager'} accounts={state.accounts} repositories={state.repositories} workers={state.workers} models={state.modelOptions ?? []} pending={pending(creating === 'manager' ? 'createManager' : 'createWorker')} onSave={draft => send(creating === 'manager' ? 'createManager' : 'createWorker', { ...draft })} onCancel={() => setCreating(null)} onAddAccount={() => { setTab('admin'); beginAccount() }} /></div>}
        {tab === 'agents' && <><div className="office-browser-actions"><button disabled={pending('createWorker')} onClick={() => setCreating('agent')}>+ Agent</button><button disabled={pending('createManager')} onClick={() => setCreating('manager')}>+ Manager</button><button disabled={pending('openAgentChats')} onClick={() => send('openAgentChats')}>Open chats in VS Code</button></div>
          {state.workers.map(worker => <article key={worker.id}><h3>{worker.name}<span>{worker.status}</span></h3><p>{OFFICE_ROLE_LABELS[worker.role] ?? worker.role} · {state.repositories.find(repo => repo.id === worker.repoId)?.name ?? worker.repoId}</p>{worker.error && <p className="office-browser-error">{worker.error}</p>}<div className="office-browser-actions"><button disabled={opening?.workerId === worker.id} onClick={() => chat(worker)}>{opening?.workerId === worker.id ? 'Starting…' : 'Chat & controls'}</button>{worker.agentId ? <><button onClick={() => send('abortWorker', { id: worker.id })}>Stop</button><button onClick={() => send('closeWorker', { id: worker.id })}>Close session</button></> : <button onClick={() => send('startWorker', { id: worker.id })}>Start</button>}<button onClick={() => send('editWorker', { id: worker.id })}>Edit</button></div></article>)}
          {!state.workers.length && <p>Create an agent in VS Code to claim a computer desk.</p>}</>}
        {tab === 'attention' && <>{state.attention.map(item => <article key={item.id}><h3>{item.workerName}</h3><p>{item.ask}</p><div className="office-browser-actions">{item.kind === 'permission' ? <><button onClick={() => send('permission', { id: item.id, reply: 'once' })}>Allow once</button><button onClick={() => send('permission', { id: item.id, reply: 'reject' })}>Deny</button></> : <><button onClick={() => send('question', { id: item.id })}>Reply in VS Code</button><button onClick={() => send('rejectQuestion', { id: item.id })}>Reject</button></>}</div></article>)}{!state.attention.length && <p>No agents need input.</p>}</>}
        {tab === 'repos' && <><button onClick={() => send('addRepository')}>+ Add repository in VS Code</button>{state.repositories.map(repo => <article key={repo.id}><h3>{repo.name}</h3><p>{repo.readOnly ? 'Read only' : 'Writable'}</p>{repo.id !== 'workspace' && <button onClick={() => send('removeRepository', { id: repo.id })}>Remove repository</button>}</article>)}</>}
        {tab === 'admin' && <><p className="office-browser-help">Separate profiles can use the same provider and model. Each agent uses its assigned profile; existing logins stay connected.</p><div className="office-browser-actions"><select aria-label="New account provider" value={provider} disabled={pending('addAccount')} onChange={event => setProvider(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option><option value="grok">Grok</option></select><button disabled={pending('addAccount')} onClick={() => beginAccount()}>+ Separate account profile</button></div>
          {addingAccount && <form className="office-browser-account-form" onSubmit={event => { event.preventDefault(); const name = accountName.trim(); if (!name || accountName.length > 100 || [...accountName].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) { setError('Enter an account name of 1–100 characters.'); return } send('addAccount', { kind: provider, name, method: provider === 'codex' ? newMethod : 'api', ...(accountWorkerId ? { workerId: accountWorkerId } : {}) }) }}><p>{accountWorkerId ? `New profile will be assigned to ${state.workers.find(worker => worker.id === accountWorkerId)?.name ?? 'this agent'} only.` : 'Create a separate login profile, then choose it for an agent.'}</p><label>Profile name<input aria-label="Account name" autoComplete="off" maxLength={100} value={accountName} disabled={pending('addAccount')} onChange={event => setAccountName(event.target.value)} /></label>{provider === 'codex' && <label>Authentication<select aria-label="New account sign-in method" value={newMethod} disabled={pending('addAccount')} onChange={event => setNewMethod(event.target.value as 'api' | 'oauth')}><option value="oauth">Sign in with ChatGPT</option><option value="api">OpenAI API key in VS Code</option></select></label>}<p>Credentials are entered securely in VS Code after you continue.</p><div className="office-browser-actions"><button type="submit" disabled={pending('addAccount')}>Continue in VS Code</button><button type="button" disabled={pending('addAccount')} onClick={() => { setAddingAccount(false); setAccountWorkerId(undefined) }}>Cancel</button></div></form>}
          {state.login && <p className="office-browser-help" role="status">{state.login.kind === 'browser' ? 'Finish sign-in in your browser.' : 'Finish device sign-in using the code shown in VS Code.'}{state.login.instructions ? ` ${state.login.instructions}` : ''}</p>}
          {state.accounts.map(account => {
            const method = accountMethods[account.id] ?? (account.authType === 'api' ? 'api' : 'oauth')
            const assigned = state.workers.filter(worker => worker.accountId === account.id)
            const locked = accountPending(account.id) || state.login?.accountId === account.id
            return <article key={account.id} data-account-profile={account.id}><h3>{account.name}<span>{account.connected ? 'connected' : 'not connected'}</span></h3><p>Profile · {account.kind}{account.loginName ? ` · Signed in as ${account.loginName}` : ''}</p><p className="office-browser-help">{assigned.length ? `Used by ${assigned.map(worker => worker.name).join(', ')}. Reconnecting updates the login for all ${assigned.length} assigned agent${assigned.length === 1 ? '' : 's'}.` : 'No agents assigned. Choose this profile when creating or editing an agent.'}</p>{account.kind === 'codex' && <label className="office-browser-account-method">Authentication<select aria-label={`Sign-in method for ${account.name}`} value={method} disabled={locked} onChange={event => setAccountMethods(current => ({ ...current, [account.id]: event.target.value as 'api' | 'oauth' }))}><option value="oauth">Sign in with ChatGPT</option><option value="api">OpenAI API key in VS Code</option></select></label>}<div className="office-browser-actions"><button disabled={locked} onClick={() => send('connectAccount', { id: account.id, method: account.kind === 'codex' ? method : 'api' })}>{account.connected ? 'Reconnect in VS Code' : 'Sign in in VS Code'}</button><button disabled={locked} onClick={() => send('renameAccount', { id: account.id })}>Rename profile</button>{account.connected && <button disabled={locked} onClick={() => send('disconnectAccount', { id: account.id })}>Disconnect</button>}<button disabled={locked} onClick={() => send('removeAccount', { id: account.id })}>Remove</button></div></article>
          })}</>}
      </fieldset>
    </section>}
  </>
}
