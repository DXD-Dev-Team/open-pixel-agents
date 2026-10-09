import { useEffect, useState, useSyncExternalStore } from 'react'
import { OFFICE_ROLE_LABELS } from '../constants.js'
import { officeConnection, vscode } from '../vscodeApi.js'
import type { OfficeRole } from '../office/types.js'
import './BrowserDesk.css'
interface Worker { id: string; name: string; role: OfficeRole; repoId: string; status: string; agentId?: number; error?: string; manager?: boolean }
interface DeskState { ready: boolean; setupNeeded?: boolean; error?: string; workers: Worker[]; repositories: Array<{ id: string; name: string; readOnly: boolean }>; accounts: Array<{ id: string; name: string; kind: string; connected: boolean; loginName?: string }>; attention: Array<{ id: string; workerName: string; kind: string; ask: string }> }
const empty: DeskState = { ready: false, workers: [], repositories: [], accounts: [], attention: [] }
export function BrowserDesk({ openAgent }: { openAgent: (agentId: number) => boolean }) {
  const connection = useSyncExternalStore(officeConnection.subscribe, officeConnection.getSnapshot)
  const [state, setState] = useState<DeskState>(empty)
  const [visible, setVisible] = useState(false)
  const [tab, setTab] = useState('agents')
  const [error, setError] = useState('')
  const [opening, setOpening] = useState<string | null>(null)
  const [provider, setProvider] = useState('codex')
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data.type === 'officeDeskState') setState(event.data.state)
      if (event.data.type === 'officeBrowserActionError') { setError(String(event.data.error)); setOpening(null) }
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
  const send = (action: string, values: Record<string, string> = {}) => {
    if (!connection.connected) return
    setError('')
    vscode.postMessage({ type: 'officeDeskAction', action, ...values })
  }
  const chat = (worker: Worker) => {
    if (!connection.connected) return
    if (worker.agentId) { openAgent(worker.agentId); return }
    setOpening(worker.id); send('chatWorker', { id: worker.id })
  }
  return <>
    <aside className={`office-browser-connection office-connection-${connection.state}`} role="status"><span className="office-connection-dot" />{connection.message}</aside>
    <button className="office-browser-roster-toggle" onClick={() => setVisible(value => !value)} aria-expanded={visible}>Team · {state.workers.length}{state.attention.length ? ` · ${state.attention.length} need input` : ''}</button>
    {visible && <section className="office-browser-desk" aria-label="Office desk">
      <header><h2>Office desk</h2><button aria-label="Close office desk" onClick={() => setVisible(false)}>×</button></header>
      <nav aria-label="Office desk panels">{['agents', 'attention', 'repos', 'admin'].map(value => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{value === 'attention' ? `Attention (${state.attention.length})` : value}</button>)}</nav>
      <p className="office-browser-help">Creation, sign-in and repository setup open secure dialogs in VS Code.</p>
      {state.setupNeeded && <p className="office-browser-help">Complete provider setup in VS Code, or skip and connect accounts later.</p>}
      {(error || state.error) && <p className="office-browser-error" role="alert">{error || state.error}</p>}
      <fieldset disabled={!connection.connected || !state.ready}>
        {tab === 'agents' && <><div className="office-browser-actions"><button onClick={() => send('createWorker')}>+ Agent</button><button onClick={() => send('createManager')}>+ Manager</button><button onClick={() => send('openAgentChats')}>Open chats in VS Code</button></div>
          {state.workers.map(worker => <article key={worker.id}><h3>{worker.name}<span>{worker.status}</span></h3><p>{OFFICE_ROLE_LABELS[worker.role] ?? worker.role} · {state.repositories.find(repo => repo.id === worker.repoId)?.name ?? worker.repoId}</p>{worker.error && <p className="office-browser-error">{worker.error}</p>}<div className="office-browser-actions"><button onClick={() => chat(worker)}>{opening === worker.id ? 'Starting…' : 'Chat & controls'}</button>{worker.agentId ? <><button onClick={() => send('abortWorker', { id: worker.id })}>Stop</button><button onClick={() => send('closeWorker', { id: worker.id })}>Close session</button></> : <button onClick={() => send('startWorker', { id: worker.id })}>Start</button>}<button onClick={() => send('editWorker', { id: worker.id })}>Edit</button></div></article>)}
          {!state.workers.length && <p>Create an agent in VS Code to claim a computer desk.</p>}</>}
        {tab === 'attention' && <>{state.attention.map(item => <article key={item.id}><h3>{item.workerName}</h3><p>{item.ask}</p><div className="office-browser-actions">{item.kind === 'permission' ? <><button onClick={() => send('permission', { id: item.id, reply: 'once' })}>Allow once</button><button onClick={() => send('permission', { id: item.id, reply: 'reject' })}>Deny</button></> : <><button onClick={() => send('question', { id: item.id })}>Reply in VS Code</button><button onClick={() => send('rejectQuestion', { id: item.id })}>Reject</button></>}</div></article>)}{!state.attention.length && <p>No agents need input.</p>}</>}
        {tab === 'repos' && <><button onClick={() => send('addRepository')}>+ Add repository in VS Code</button>{state.repositories.map(repo => <article key={repo.id}><h3>{repo.name}</h3><p>{repo.readOnly ? 'Read only' : 'Writable'}</p>{repo.id !== 'workspace' && <button onClick={() => send('removeRepository', { id: repo.id })}>Remove repository</button>}</article>)}</>}
        {tab === 'admin' && <><div className="office-browser-actions"><select aria-label="New account provider" value={provider} onChange={event => setProvider(event.target.value)}><option value="codex">Codex</option><option value="claude">Claude</option><option value="grok">Grok</option></select><button onClick={() => send('addAccount', { kind: provider })}>+ Account in VS Code</button></div>{state.accounts.map(account => <article key={account.id}><h3>{account.loginName ?? account.name}<span>{account.connected ? 'connected' : 'not connected'}</span></h3><p>{account.name} · {account.kind}</p><div className="office-browser-actions"><button onClick={() => send('connectAccount', { id: account.id })}>{account.connected ? 'Reconnect in VS Code' : 'Sign in in VS Code'}</button>{account.connected && <button onClick={() => send('disconnectAccount', { id: account.id })}>Disconnect</button>}<button onClick={() => send('removeAccount', { id: account.id })}>Remove</button></div></article>)}</>}
      </fieldset>
    </section>}
  </>
}
