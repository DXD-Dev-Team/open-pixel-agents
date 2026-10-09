import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { OFFICE_ROLE_LABELS } from '../constants.js'
import { officeConnection, vscode } from '../vscodeApi.js'
import type { BrowserActionState } from '../vscodeApi.js'
import type { OfficeRole } from '../office/types.js'
import './BrowserDesk.css'
interface Worker { id: string; name: string; role: OfficeRole; repoId: string; status: string; agentId?: number; error?: string; manager?: boolean }
interface DeskState { ready: boolean; setupNeeded?: boolean; error?: string; workers: Worker[]; repositories: Array<{ id: string; name: string; readOnly: boolean }>; accounts: Array<{ id: string; name: string; kind: string; connected: boolean; loginName?: string; authType?: string }>; attention: Array<{ id: string; workerName: string; kind: string; ask: string }> }
interface ActionRecord extends BrowserActionState { id?: string; kind?: string }
const empty: DeskState = { ready: false, workers: [], repositories: [], accounts: [], attention: [] }
const actionLabels: Record<string, string> = { addAccount: 'Account setup', connectAccount: 'Sign-in', disconnectAccount: 'Account disconnect', removeAccount: 'Account removal', renameAccount: 'Account rename', createWorker: 'Agent creation', createManager: 'Manager creation', editWorker: 'Agent settings', addRepository: 'Repository selection', removeRepository: 'Repository removal', chatWorker: 'Opening chat', startWorker: 'Starting agent', abortWorker: 'Stopping agent', closeWorker: 'Closing session', openAgentChats: 'Opening VS Code chats', send: 'Message', question: 'Question reply' }
const hostDialogs = new Set(['addAccount', 'connectAccount', 'renameAccount', 'createWorker', 'createManager', 'editWorker', 'addRepository', 'question'])
const unconfirmedDialogs = new Set(['createWorker', 'createManager', 'editWorker', 'addRepository', 'question'])
export function BrowserDesk({ openAgent }: { openAgent: (agentId: number) => boolean }) {
  const connection = useSyncExternalStore(officeConnection.subscribe, officeConnection.getSnapshot)
  const [state, setState] = useState<DeskState>(empty)
  const [visible, setVisible] = useState(false)
  const [tab, setTab] = useState('agents')
  const [error, setError] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [provider, setProvider] = useState('codex')
  const [actions, setActions] = useState<Record<string, ActionRecord>>({})
  const [addingAccount, setAddingAccount] = useState(false)
  const [accountName, setAccountName] = useState('')
  const [newMethod, setNewMethod] = useState<'api' | 'oauth'>('oauth')
  const [accountMethods, setAccountMethods] = useState<Record<string, 'api' | 'oauth'>>({})
  const requestIndex = useRef(0)
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data.type === 'officeDeskState') setState(event.data.state)
      if (event.data.type === 'officeBrowserActionError') { setError(String(event.data.error)); setOpening(null) }
      if (event.data.type === 'officeBrowserActionState') {
        const result = event.data as BrowserActionState
        setActions(current => Object.fromEntries([...Object.entries(current).filter(([id, item]) => id !== result.requestId && (item.state === 'pending' || Object.keys(current).length < 16)), [result.requestId, { ...current[result.requestId], ...result }]]))
        if (result.state !== 'failed') setError('')
        if (result.state === 'cancelled' || result.state === 'failed') setOpening(null)
        if (result.action === 'addAccount' && result.state === 'completed') { setAddingAccount(false); setAccountName('') }
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])
  useEffect(() => {
    if (!opening) return
    const worker = state.workers.find(item => item.id === opening)
    if (worker?.agentId) {
      const timer = setTimeout(() => { if (openAgent(worker.agentId!)) setOpening(null) }, 100)
      return () => clearTimeout(timer)
    }
  }, [opening, state.workers, openAgent])
  const send = useCallback((action: string, values: Record<string, string> = {}) => {
    if (!connection.connected) { setError('Reconnect to VS Code before using these controls.'); return }
    if (!state.ready) { setError(state.error || 'Office setup is not ready. Open Office Desk in VS Code to resolve its connection error.'); return }
    setError('')
    const requestId = `desk-${Date.now()}-${++requestIndex.current}`
    setActions(current => ({ ...current, [requestId]: { requestId, action, id: values.id, kind: values.kind, state: 'pending' } }))
    vscode.postMessage({ type: 'officeDeskAction', requestId, action, ...values })
  }, [connection.connected, state.ready, state.error])
  const chat = (worker: Worker) => {
    if (!connection.connected) { setError('Reconnect to VS Code before opening chat.'); return }
    if (worker.agentId) { if (!openAgent(worker.agentId)) setError('This agent is still joining the office. Wait for its character, then try Chat again.'); return }
    setOpening(worker.id); send('chatWorker', { id: worker.id })
  }
  const pending = (action: string, id?: string) => Object.values(actions).some(item => item.state === 'pending' && item.action === action && (id === undefined || item.id === id))
  const latest = Object.values(actions).filter(item => item.state === 'pending').at(-1) ?? Object.values(actions).at(-1)
  const label = latest ? actionLabels[latest.action] ?? 'Office action' : ''
  const feedback = latest?.state === 'pending' ? hostDialogs.has(latest.action) ? `${label}: continue in VS Code. Complete or cancel the dialog there; this browser is waiting for its result.` : `${label}: waiting for VS Code…` : latest?.state === 'cancelled' ? `${label} cancelled. You can retry.` : latest?.state === 'completed' ? unconfirmedDialogs.has(latest.action) ? `${label}: VS Code dialog finished.` : `${label} completed.` : latest?.error
  return <>
    <aside className={`office-browser-connection office-connection-${connection.state}`} role="status"><span className="office-connection-dot" />{connection.message}</aside>
    {feedback && <aside className={`office-browser-action-feedback office-action-${latest?.state}`} role={latest?.state === 'failed' ? 'alert' : 'status'}>{feedback}</aside>}
    <button className="office-browser-roster-toggle" onClick={() => setVisible(value => !value)} aria-expanded={visible}>Team · {state.workers.length}{state.attention.length ? ` · ${state.attention.length} need input` : ''}</button>
    {visible && <section className="office-browser-desk" aria-label="Office desk">
      <header><h2>Office desk</h2><button aria-label="Close office desk" onClick={() => setVisible(false)}>×</button></header>
      <nav aria-label="Office desk panels">{['agents', 'attention', 'repos', 'admin'].map(value => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{value === 'attention' ? `Attention (${state.attention.length})` : value}</button>)}</nav>
      <p className="office-browser-help">Creation, sign-in and repository setup open secure dialogs in VS Code.</p>
      {state.setupNeeded && <p className="office-browser-help">Complete provider setup in VS Code, or skip and connect accounts later.</p>}
      {(error || state.error) && <p className="office-browser-error" role="alert">{error || state.error}</p>}
      {!connection.connected && <p className="office-browser-error">Controls are unavailable until the browser reconnects to VS Code.</p>}
      {connection.connected && !state.ready && <p className="office-browser-error">Office setup is not ready. Open Office Desk in VS Code to resolve its connection error.</p>}
      <fieldset disabled={!connection.connected || !state.ready}>
        {tab === 'agents' && <><div className="office-browser-actions"><button disabled={pending('createWorker')} onClick={() => send('createWorker')}>+ Agent</button><button disabled={pending('createManager')} onClick={() => send('createManager')}>+ Manager</button><button disabled={pending('openAgentChats')} onClick={() => send('openAgentChats')}>Open chats in VS Code</button></div>
          {state.workers.map(worker => <article key={worker.id}><h3>{worker.name}<span>{worker.status}</span></h3><p>{OFFICE_ROLE_LABELS[worker.role] ?? worker.role} · {state.repositories.find(repo => repo.id === worker.repoId)?.name ?? worker.repoId}</p>{worker.error && <p className="office-browser-error">{worker.error}</p>}<div className="office-browser-actions"><button onClick={() => chat(worker)}>{opening === worker.id ? 'Starting…' : 'Chat & controls'}</button>{worker.agentId ? <><button onClick={() => send('abortWorker', { id: worker.id })}>Stop</button><button onClick={() => send('closeWorker', { id: worker.id })}>Close session</button></> : <button onClick={() => send('startWorker', { id: worker.id })}>Start</button>}<button onClick={() => send('editWorker', { id: worker.id })}>Edit</button></div></article>)}
          {!state.workers.length && <p>Create an agent in VS Code to claim a computer desk.</p>}</>}
        {tab === 'attention' && <>{state.attention.map(item => <article key={item.id}><h3>{item.workerName}</h3><p>{item.ask}</p><div className="office-browser-actions">{item.kind === 'permission' ? <><button onClick={() => send('permission', { id: item.id, reply: 'once' })}>Allow once</button><button onClick={() => send('permission', { id: item.id, reply: 'reject' })}>Deny</button></> : <><button onClick={() => send('question', { id: item.id })}>Reply in VS Code</button><button onClick={() => send('rejectQuestion', { id: item.id })}>Reject</button></>}</div></article>)}{!state.attention.length && <p>No agents need input.</p>}</>}
        {tab === 'repos' && <><button onClick={() => send('addRepository')}>+ Add repository in VS Code</button>{state.repositories.map(repo => <article key={repo.id}><h3>{repo.name}</h3><p>{repo.readOnly ? 'Read only' : 'Writable'}</p>{repo.id !== 'workspace' && <button onClick={() => send('removeRepository', { id: repo.id })}>Remove repository</button>}</article>)}</>}
        {tab === 'admin' && <><div className="office-browser-actions"><select aria-label="New account provider" value={provider} disabled={pending('addAccount')} onChange={event => setProvider(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option><option value="grok">Grok</option></select><button disabled={pending('addAccount')} onClick={() => { setAddingAccount(true); if (!accountName) setAccountName(provider === 'codex' ? 'ChatGPT / Codex' : provider === 'claude' ? 'Claude' : 'Grok') }}>+ Account</button></div>
          {addingAccount && <form className="office-browser-account-form" onSubmit={event => { event.preventDefault(); const name = accountName.trim(); if (!name || accountName.length > 100 || [...accountName].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) { setError('Enter an account name of 1–100 characters.'); return } send('addAccount', { kind: provider, name, method: provider === 'codex' ? newMethod : 'api' }) }}><label>Account name<input aria-label="Account name" autoComplete="off" maxLength={100} value={accountName} disabled={pending('addAccount')} onChange={event => setAccountName(event.target.value)} /></label>{provider === 'codex' && <label>Authentication<select aria-label="New account sign-in method" value={newMethod} disabled={pending('addAccount')} onChange={event => setNewMethod(event.target.value as 'api' | 'oauth')}><option value="oauth">Sign in with ChatGPT</option><option value="api">OpenAI API key in VS Code</option></select></label>}<p>Credentials are entered securely in VS Code after you continue.</p><div className="office-browser-actions"><button type="submit" disabled={pending('addAccount')}>Continue in VS Code</button><button type="button" disabled={pending('addAccount')} onClick={() => setAddingAccount(false)}>Cancel</button></div></form>}
          {state.accounts.map(account => { const method = accountMethods[account.id] ?? (account.authType === 'api' ? 'api' : 'oauth'); return <article key={account.id}><h3>{account.loginName ?? account.name}<span>{account.connected ? 'connected' : 'not connected'}</span></h3><p>{account.name} · {account.kind}</p>{account.kind === 'codex' && <label className="office-browser-account-method">Authentication<select aria-label={`Sign-in method for ${account.name}`} value={method} disabled={pending('connectAccount', account.id)} onChange={event => setAccountMethods(current => ({ ...current, [account.id]: event.target.value as 'api' | 'oauth' }))}><option value="oauth">Sign in with ChatGPT</option><option value="api">OpenAI API key in VS Code</option></select></label>}<div className="office-browser-actions"><button disabled={pending('connectAccount', account.id)} onClick={() => send('connectAccount', { id: account.id, method: account.kind === 'codex' ? method : 'api' })}>{account.connected ? 'Reconnect in VS Code' : 'Sign in in VS Code'}</button>{account.connected && <button disabled={pending('disconnectAccount', account.id)} onClick={() => send('disconnectAccount', { id: account.id })}>Disconnect</button>}<button disabled={pending('removeAccount', account.id)} onClick={() => send('removeAccount', { id: account.id })}>Remove</button></div></article> })}</>}
      </fieldset>
    </section>}
  </>
}
