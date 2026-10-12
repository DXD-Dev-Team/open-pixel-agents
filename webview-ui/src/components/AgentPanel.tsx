import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { OfficeRole, OfficeStatus } from '../office/types.js'
import { OFFICE_ROLE_LABELS } from '../constants.js'
import './AgentPanel.css'
import { officeConnection, officeHost } from '../vscodeApi.js'
import type { BrowserActionState } from '../vscodeApi.js'

export type AgentActionName = 'open' | 'send' | 'start' | 'restart' | 'stop' | 'close' | 'role' | 'manager-mode' | 'assign-team' | 'approve' | 'reject' | 'attention' | 'sign-in' | 'change-account' | 'add-account' | 'manager-repos' | 'manager-scope' | 'thread-select' | 'thread-new' | 'thread-rename' | 'thread-archive' | 'thread-more' | 'thread-fork' | 'thread-compact' | 'reset-usage' | 'usage-refresh' | 'credit-reset' | 'worker-model' | 'worker-mode'
interface PanelAccount { id: string; name: string; kind: 'claude' | 'codex' | 'grok'; connected: boolean; authType?: string; loginName?: string }
export interface PanelThread { id: string; workerId: string; repoId: string; title: string; kind: 'root' | 'child'; parentThreadId?: string; accountId: string; providerId: string; modelId: string; mode: 'fast' | 'reasoning'; createdAt: number; updatedAt: number; archived: boolean; unavailable?: boolean; recoveredUnknown?: boolean }
export interface AgentPanelState {
  viewId?: string
  worker: { id: string; name: string; role: OfficeRole; status: OfficeStatus; started: boolean; repoId?: string; repoName?: string; providerKind?: string; modelId?: string; accountId?: string; mode?: 'fast' | 'reasoning' }
  modelOptions?: Array<{ id: string; name: string }>
  capabilities?: { threads?: boolean; usageReset?: boolean; threadFork?: boolean; threadCompact?: boolean; creditReset?: boolean }
  threads?: { items: PanelThread[]; selectedId?: string }
  chatThreadId?: string
  chatPage?: { hasMore: boolean; before?: string; older?: boolean }
  accountQuota?: { available: boolean; reason?: string; accountName?: string; limits?: Array<{ id: string; name?: string; usedPercent: number; windowDurationMins: number; resetsAt: number }>; reset?: { availableCount?: number; ticket?: string } }
  usage?: { tokens: number; estimatedCost?: number; resettable: boolean; totalTokens?: number; threadTokens?: number; byRepository?: Array<{ id: string; tokens: number; estimatedCost?: number }> }
  chat: Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: number }>
  pending: boolean
  busy: boolean
  error?: string
  repositories?: Array<{ id: string; name: string }>
  account?: PanelAccount
  accounts?: PanelAccount[]
  attention?: Array<{ id: string; kind: 'permission' | 'question'; ask: string }>
  manager?: { mode: 'auto' | 'human-approval'; scopeRole?: 'all' | 'builder' | 'security-reviewer' | 'verifier'; repoIds?: string[]; teamIds: string[]; team: Array<{ id: string; name: string; role: OfficeRole; repoId?: string; repoName?: string }>; paused?: boolean; triaging?: boolean; coordinating?: boolean; executing?: boolean; error?: string;
    proposals: Array<{ id: string; text: string; workerId?: string; workerName?: string; status: 'pending' | 'approved' | 'rejected' | 'running' | 'done' | 'failed'; error?: string }> }
}
export interface AgentPanelAction { action: AgentActionName; text?: string; role?: OfficeRole; mode?: 'auto' | 'human-approval'; teamIds?: string[]; proposalId?: string; accountId?: string; kind?: 'claude' | 'codex' | 'grok'; repoIds?: string[]; scopeRole?: 'all' | 'builder' | 'security-reviewer' | 'verifier'; threadId?: string; title?: string; before?: string; repoId?: string; resetTicket?: string; confirmed?: boolean; modelId?: string; workerMode?: 'fast' | 'reasoning' }
const roleLabels = OFFICE_ROLE_LABELS
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id))

interface Props { agentId: number; name: string; state?: AgentPanelState; error?: string; childName?: string; actionState?: BrowserActionState; draft: string; onDraftChange: (text: string) => void; onAction: (action: AgentPanelAction) => string | undefined; onClose: () => void }

export function AgentPanel({ agentId, name, state, error, childName, actionState, draft, onDraftChange, onAction, onClose }: Props) {
  const host = useSyncExternalStore(officeHost.subscribe, officeHost.getSnapshot)
  const ownerName = host.hostKind === 'standalone' ? 'Office host' : 'VS Code'
  const { connected } = useSyncExternalStore(officeConnection.subscribe, officeConnection.getSnapshot)
  const dialog = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const [accountKind, setAccountKind] = useState<'claude' | 'codex' | 'grok'>('codex')
  const [tab, setTab] = useState<'chat' | 'controls' | 'profile' | 'usage'>('chat')
  useEffect(() => { const receive = (event: MessageEvent) => { if (event.data?.type === 'officeWorkspaceTab' && event.data.workerId === state?.worker.id && event.data.tab === 'controls') setTab('controls') }; window.addEventListener('message', receive); return () => window.removeEventListener('message', receive) }, [state?.worker.id])
  const [search, setSearch] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [threadForm, setThreadForm] = useState<{ kind: 'new' | 'rename'; threadId?: string; title: string; repoId: string; submitted?: boolean; requestId?: string; beforeIds?: string[] } | null>(null)
  const [threadError, setThreadError] = useState('')
  const [creditConfirm, setCreditConfirm] = useState(false)
  const [creditAcknowledged, setCreditAcknowledged] = useState(false)
  const [resetConfirm, setResetConfirm] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [teamDraft, setTeamDraft] = useState<{ agentId: number; ids: string[]; submitted?: boolean } | null>(null)
  const [repoDraft, setRepoDraft] = useState<{ agentId: number; ids: string[]; submitted?: boolean } | null>(null)
  useEffect(() => {
    if (!threadForm?.submitted) return
    const acknowledged = state?.threads?.items.some(item => item.repoId === threadForm.repoId && item.title === threadForm.title.trim() && (threadForm.kind === 'rename' ? item.id === threadForm.threadId : !threadForm.beforeIds?.includes(item.id)))
    if (acknowledged) { const timer = setTimeout(() => setThreadForm(current => current === threadForm ? null : current), 0); return () => clearTimeout(timer) }
  }, [state?.threads, threadForm])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const result = event.data
      if (!['officeBrowserActionState', 'officeAgentActionState'].includes(result?.type) || result.requestId !== threadForm?.requestId || !['failed', 'cancelled'].includes(result.state)) return
      setThreadError(result.error ?? 'Conversation action cancelled. Your draft is kept.')
      setThreadForm(current => current && current.requestId === result.requestId ? { ...current, submitted: false } : current)
    }
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive)
  }, [threadForm?.requestId])
  useEffect(() => {
    if (!threadForm?.requestId || actionState?.requestId !== threadForm.requestId || !['failed', 'cancelled'].includes(actionState.state)) return
    const timer = setTimeout(() => { setThreadError(actionState.error ?? 'Conversation action cancelled. Your draft is kept.'); setThreadForm(current => current?.requestId === actionState.requestId ? { ...current, submitted: false } : current) }, 0)
    return () => clearTimeout(timer)
  }, [actionState, threadForm?.requestId])
  const team = teamDraft?.agentId === agentId ? teamDraft.ids : state?.manager?.teamIds ?? []
  const repos = repoDraft?.agentId === agentId ? repoDraft.ids : state?.manager?.repoIds ?? []
  const teamDirty = !!teamDraft && teamDraft.agentId === agentId && !sameIds(team, state?.manager?.teamIds ?? [])
  const reposDirty = !!repoDraft && repoDraft.agentId === agentId && !sameIds(repos, state?.manager?.repoIds ?? [])
  useEffect(() => {
    // A streamed authoritative panel update acknowledges the saved draft.
    const timer = setTimeout(() => {
      if (teamDraft?.agentId === agentId && teamDraft.submitted && sameIds(teamDraft.ids, state?.manager?.teamIds ?? [])) setTeamDraft(current => current === teamDraft ? null : current)
      if (repoDraft?.agentId === agentId && repoDraft.submitted && sameIds(repoDraft.ids, state?.manager?.repoIds ?? [])) setRepoDraft(current => current === repoDraft ? null : current)
    }, 0)
    return () => clearTimeout(timer)
  }, [agentId, state?.manager?.teamIds, state?.manager?.repoIds, teamDraft, repoDraft])
  useEffect(() => {
    const focus = composer.current ?? dialog.current
    focus?.focus()
    // Opening/switching the dialog owns focus; streamed state updates do not.
  }, [agentId])
  const scrollState = useRef<{ thread?: string; first?: string; height: number; atBottom: boolean; older?: boolean }>({ height: 0, atBottom: true })
  useEffect(() => {
    const view = history.current
    if (!view) return
    const previous = scrollState.current
    const thread = state?.chatThreadId
    const first = state?.chat[0]?.id
    const prepended = thread === previous.thread && first !== previous.first && state?.chat.some(item => item.id === previous.first)
    if (prepended) view.scrollTop += view.scrollHeight - previous.height
    else if (thread !== previous.thread || previous.atBottom || previous.older && !state?.chatPage?.older) view.scrollTop = view.scrollHeight
    scrollState.current = { thread, first, height: view.scrollHeight, atBottom: view.scrollHeight - view.scrollTop - view.clientHeight < 45, older: state?.chatPage?.older }
  }, [state?.chat, state?.chatThreadId, state?.chatPage?.older, tab])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key !== 'Tab' || !dialog.current) return
      const items = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled]),textarea:not([disabled]),input:not([disabled])')]
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
  const submit = () => {
    const text = draft.trim()
    if (!connected || !text || !state || state.busy || state.pending || !state.worker.started || readOnlyThread) return
    onAction({ action: 'send', text, ...(state.chatThreadId ? { threadId: state.chatThreadId } : {}) })
  }
  const saveDraft = onDraftChange
  const threadsEnabled = state?.capabilities?.threads === true || host.features.threads === true
  const selected = state?.threads?.items.find(item => item.id === (state.chatThreadId ?? state.threads?.selectedId))
  const readOnlyThread = !!selected && (selected.archived || selected.unavailable || selected.recoveredUnknown || selected.kind === 'child')
  const filteredThreads = (state?.threads?.items ?? []).filter(item => (showArchived || !item.archived) && `${item.title} ${state?.repositories?.find(repo => repo.id === item.repoId)?.name ?? item.repoId}`.toLowerCase().includes(search.toLowerCase()))
  const threadRepos = [...new Set(filteredThreads.map(item => item.repoId))]
  const manager = state?.manager
  const coordinating = manager?.triaging || manager?.coordinating || manager?.executing
  const configBusy = !!state && (state.busy || state.pending || !!coordinating || actionState?.state === 'pending' && ['assign-team', 'manager-repos', 'role', 'manager-scope', 'manager-mode', 'change-account', 'worker-model', 'worker-mode'].includes(actionState.action))
  const idle = !!state && !configBusy
  const actionLabel = actionState?.action === 'sign-in' ? 'Sign-in' : actionState?.action === 'add-account' ? 'Account setup' : actionState?.action === 'send' ? 'Message' : 'Agent action'
  const actionFeedback = actionState?.state === 'pending' ? ['sign-in', 'add-account', 'attention'].includes(actionState.action) ? `${actionLabel}: continue in VS Code. Complete or cancel the dialog there; this browser is waiting for its result.` : `${actionLabel}: waiting for ${ownerName}…` : actionState?.state === 'cancelled' ? `${actionLabel} cancelled. You can retry.` : actionState?.state === 'completed' ? `${actionLabel} completed.` : actionState?.error
  const lastUser = state?.chat.filter(item => item.role === 'user').at(-1)
  const copyReply = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(id) } catch { setCopied(null) }
  }
  return (
    <div className="office-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className="office-agent-dialog" role="dialog" aria-modal="true" aria-labelledby="office-agent-dialog-title" tabIndex={-1} ref={dialog} data-office-agent-modal={agentId}>
        <header className="office-dialog-header">
          <div><p className="office-dialog-eyebrow">THE OFFICE · AGENT CONTROLS</p><h2 id="office-agent-dialog-title">{state?.worker.name ?? name}</h2></div>
          <button type="button" className="office-dialog-dismiss" aria-label="Close agent controls" onClick={onClose}>×</button>
        </header>
        {actionFeedback && <p className={`office-dialog-action-feedback office-dialog-action-${actionState?.state}`} role={actionState?.state === 'failed' ? 'alert' : 'status'}>{actionFeedback}</p>}
        {childName && <p className="office-dialog-child">Opened from child “{childName}”. These controls belong to its parent worker.</p>}
        {!connected && <p className="office-dialog-error" role="status">Reconnect to {ownerName} to use these controls.</p>}
        {!state ? <p className="office-dialog-loading" role="status">Loading this worker’s conversation…</p> : <fieldset className="office-dialog-runtime" disabled={!connected}>
          <aside className="office-thread-sidebar" aria-label="Repository conversations">
            <div className="office-thread-heading"><strong>Conversations</strong>{threadsEnabled && <button type="button" aria-label="New conversation" disabled={state.busy || state.pending} onClick={() => setThreadForm({ kind: 'new', title: 'New conversation', repoId: state.worker.repoId ?? state.repositories?.[0]?.id ?? 'workspace' })}>+</button>}</div>
            {threadsEnabled ? <><input aria-label="Search conversations" placeholder="Search conversations…" value={search} onChange={event => setSearch(event.target.value)} /><label className="office-thread-archived"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Show archived</label>{threadRepos.map(repoId => <section key={repoId}><h3>{state.repositories?.find(repo => repo.id === repoId)?.name ?? repoId}</h3>{filteredThreads.filter(item => item.repoId === repoId).map(item => <button type="button" className="office-thread-item" key={item.id} aria-current={item.id === state.chatThreadId ? 'page' : undefined} onClick={() => { setTab('chat'); onAction({ action: 'thread-select', threadId: item.id }) }}><span>{item.title}</span><small>{item.recoveredUnknown ? 'Recovered · origin unknown' : item.kind === 'child' ? 'Child · read-only' : item.archived ? 'Archived' : item.unavailable ? 'Unavailable' : 'Conversation'}</small></button>)}</section>)}{!filteredThreads.length && <p className="office-dialog-help">No matching conversations.</p>}</> : <p className="office-dialog-help">Current conversation. Thread history is available when this Office host supports it.</p>}
            <p className="office-dialog-help office-thread-browse-hint">Browsing history does not start an agent or send a message.</p>
          </aside>
          <main className="office-workspace-main">
          <div className="office-dialog-controls">
            <span className={`office-dialog-status office-status-${state.worker.status.replace(' ', '-')}`}>{state.worker.status}</span>
            <label>Role<select aria-label="Worker role" value={state.worker.role} disabled={configBusy} onChange={event => onAction({ action: 'role', role: event.target.value as OfficeRole })}>
              {Object.entries(roleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
            </select></label>
            <div className="office-dialog-lifecycle">
              <button type="button" disabled={state.worker.started && !manager?.paused || state.busy || state.pending || coordinating} onClick={() => onAction({ action: 'start' })}>Start</button>
              <button type="button" disabled={!state.worker.started || !state.busy && !state.pending && !coordinating && (!manager || manager.paused)} onClick={() => onAction({ action: 'stop' })}>Stop</button>
              <button type="button" title="Stop and start this agent, keeping its conversation history." disabled={!state.worker.started || state.pending} onClick={() => onAction({ action: 'restart' })}>Restart</button>
              <button type="button" className="office-dialog-danger" disabled={!state.worker.started} onClick={() => onAction({ action: 'close' })}>Close session</button>
            </div>
          </div>
          <p className="office-dialog-model">{[state.worker.repoName, state.worker.providerKind, state.worker.modelId].filter(Boolean).join(' · ')}</p>
          <nav className="office-workspace-tabs" aria-label="Agent workspace"><button type="button" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>Chat</button><button type="button" aria-selected={tab === 'controls'} onClick={() => setTab('controls')}>Controls</button><button type="button" aria-selected={tab === 'profile'} onClick={() => setTab('profile')}>Profile</button>{(state.usage || state.accountQuota) && <button type="button" aria-selected={tab === 'usage'} onClick={() => setTab('usage')}>Usage</button>}</nav>
          {threadForm && <form className="office-thread-form" aria-label={threadForm.kind === 'new' ? 'New conversation' : 'Rename conversation'} onSubmit={event => { event.preventDefault(); const title = threadForm.title.trim(); if (!title) return; setThreadError(''); const requestId = onAction({ action: threadForm.kind === 'new' ? 'thread-new' : 'thread-rename', title, repoId: threadForm.repoId, threadId: threadForm.threadId }); if (requestId) setThreadForm({ ...threadForm, title, submitted: true, requestId, beforeIds: state.threads?.items.map(item => item.id) ?? [] }) }}><label>Title<input aria-label="Conversation title" maxLength={100} value={threadForm.title} onChange={event => setThreadForm({ ...threadForm, title: event.target.value })} /></label>{threadForm.kind === 'new' && <label>Repository<select aria-label="Conversation repository" value={threadForm.repoId} onChange={event => setThreadForm({ ...threadForm, repoId: event.target.value })}>{state.repositories?.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select></label>}<button type="submit" disabled={!threadForm.title.trim() || threadForm.submitted || state.pending || state.busy}>{threadForm.submitted ? 'Saving…' : 'Save conversation'}</button><button type="button" onClick={() => setThreadForm(null)}>Cancel</button>{threadError && <p className="office-dialog-error" role="alert">{threadError}</p>}</form>}
          {tab === 'profile' && <section className="office-dialog-account" aria-label="Agent account">
            <div><strong>{state.account?.name ?? 'Provider profile'}</strong><span>{state.account?.connected ? 'Connected' : 'Sign-in needed'}</span></div>
            <div><label>Profile<select aria-label="Assigned account" value={state.account?.id ?? ''} disabled={configBusy} onChange={event => onAction({ action: 'change-account', accountId: event.target.value })}><option value="" disabled>Choose a profile</option>{state.accounts?.map(account => <option key={account.id} value={account.id}>{account.name} · {account.kind}{account.connected ? '' : ' · sign-in needed'}</option>)}</select></label><button type="button" disabled={!state.account || configBusy} onClick={() => onAction({ action: 'sign-in' })}>{state.account?.connected ? 'Reconnect' : 'Sign in'}</button></div>
            {state.account && <p className="office-dialog-help">{state.account.loginName ? `Signed in as ${state.account.loginName}. ` : ''}Reconnecting updates every agent sharing this profile; add a separate profile for a different login. Changing profiles starts a separate conversation and keeps earlier conversations in history.</p>}
            <details><summary>Add a separate account profile</summary><div><select aria-label="New account provider" value={accountKind} onChange={event => setAccountKind(event.target.value as 'claude' | 'codex' | 'grok')}><option value="codex">Codex</option><option value="claude">Claude</option><option value="grok">Grok</option></select><button type="button" disabled={configBusy} onClick={() => onAction({ action: 'add-account', kind: accountKind })}>+ Separate account profile</button></div></details>
          </section>}
          {state.attention?.length ? <div className="office-dialog-attention"><strong>Human input needed</strong><p>{state.attention[0].ask}</p><button type="button" onClick={() => onAction({ action: 'attention' })}>Open Attention</button></div> : null}
          {tab === 'controls' && <section className="office-worker-settings" aria-label="Worker settings">{state.modelOptions?.length ? <label>Model<select aria-label="Worker model" value={state.worker.modelId ?? ''} disabled={configBusy} onChange={event => onAction({ action: 'worker-model', modelId: event.target.value })}><option value="" disabled>Choose a model</option>{state.modelOptions.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label> : <p className="office-dialog-help">No eligible models have been provided by this host for the assigned profile.</p>}{state.worker.mode && <label>Mode<select aria-label="Worker mode" value={state.worker.mode} disabled={configBusy} onChange={event => onAction({ action: 'worker-mode', workerMode: event.target.value as 'fast' | 'reasoning' })}><option value="fast">Fast</option><option value="reasoning">Reasoning</option></select></label>}</section>}
          {tab === 'controls' && manager && <section className="office-dialog-manager" aria-label="Manager controls">
            <div className="office-dialog-manager-heading"><h3>{manager.scopeRole && manager.scopeRole !== 'all' ? `${roleLabels[manager.scopeRole]} manager` : 'Office manager'}</h3><label>Mode<select aria-label="Manager mode" value={manager.mode} disabled={configBusy} onChange={event => onAction({ action: 'manager-mode', mode: event.target.value as 'auto' | 'human-approval' })}><option value="human-approval">Human Approval</option><option value="auto">Auto</option></select></label></div>
            <label className="office-manager-scope">Team role<select aria-label="Manager team role" value={manager.scopeRole ?? 'all'} disabled={configBusy} onChange={event => onAction({ action: 'manager-scope', scopeRole: event.target.value as 'all' | 'builder' | 'security-reviewer' | 'verifier' })}><option value="all">All office roles</option>{Object.entries(roleLabels).filter(([role]) => role !== 'manager').map(([role,label]) => <option key={role} value={role}>{label}</option>)}</select></label>
            {manager.paused && <p className="office-dialog-help" role="status">Paused · Start resumes automatic team coordination.</p>}
            <p className="office-dialog-help">{manager.mode === 'auto' ? 'Approved team tasks can run automatically.' : 'Review proposed team tasks before they run.'}</p>
            {state.repositories?.length ? <fieldset><legend>Assigned repositories</legend><div className="office-dialog-team">{state.repositories.map(repo => <label key={repo.id}><input type="checkbox" checked={repos.includes(repo.id)} disabled={configBusy} onChange={event => { const ids = event.target.checked ? [...repos, repo.id] : repos.filter(id => id !== repo.id); setRepoDraft(sameIds(ids, manager.repoIds ?? []) ? null : { agentId, ids }) }} /><span>{repo.name}</span></label>)}</div><button type="button" disabled={!reposDirty || !repos.length || configBusy} onClick={() => { setRepoDraft({ agentId, ids: [...repos], submitted: true }); onAction({ action: 'manager-repos', repoIds: repos }) }}>Save repositories</button></fieldset> : null}
            <fieldset><legend>Team</legend><div className="office-dialog-team">{manager.team.length ? manager.team.map(member => <label key={member.id}><input type="checkbox" checked={team.includes(member.id)} disabled={configBusy} onChange={event => { const ids = event.target.checked ? [...team, member.id] : team.filter(id => id !== member.id); setTeamDraft(sameIds(ids, manager.teamIds) ? null : { agentId, ids }) }} /><span>{member.name}<small>{roleLabels[member.role]}{member.repoName || member.repoId ? ` · ${member.repoName ?? state.repositories?.find(repo => repo.id === member.repoId)?.name ?? member.repoId}` : ''}</small></span></label>) : <p>Add other workers to assign a team.</p>}</div>
              <button type="button" disabled={!teamDirty || configBusy} onClick={() => { setTeamDraft({ agentId, ids: [...team], submitted: true }); onAction({ action: 'assign-team', teamIds: team }) }}>Save team</button></fieldset>
            {manager.triaging && <p role="status">Reviewing the team’s next steps…</p>}
            {manager.error && <p className="office-dialog-error" role="alert">{manager.error}</p>}
            <div className="office-dialog-proposals">{manager.proposals.map(proposal => <article key={proposal.id} data-proposal-id={proposal.id}><div><strong>{proposal.workerName ?? 'Team task'}</strong><span>{proposal.status}</span></div><p>{proposal.text}</p>{proposal.error && <p className="office-dialog-error">{proposal.error}</p>}{proposal.status === 'pending' && <div><button type="button" onClick={() => onAction({ action: 'approve', proposalId: proposal.id })}>Approve</button><button type="button" className="office-dialog-danger" onClick={() => onAction({ action: 'reject', proposalId: proposal.id })}>Reject</button></div>}</article>)}</div>
          </section>}
          {tab === 'usage' && (state.usage || state.accountQuota) && <section className="office-usage-section" aria-label="Agent usage"><h3>Usage for this agent</h3>{state.usage && <><p><strong>{Math.round(state.usage.tokens).toLocaleString()}</strong> tokens{state.usage.estimatedCost !== undefined ? ` · ~$${state.usage.estimatedCost.toFixed(4)}` : ''}</p><p className="office-dialog-help">This is the Office counter, separate from provider limits and billing.</p>{state.usage.threadTokens !== undefined && <p>Selected conversation: {Math.round(state.usage.threadTokens).toLocaleString()} tokens</p>}{state.usage.totalTokens !== undefined && <p className="office-dialog-help">Lifetime recorded usage: {Math.round(state.usage.totalTokens).toLocaleString()} tokens</p>}{state.usage.byRepository?.length ? <ul>{state.usage.byRepository.map(repo => <li key={repo.id}>{state.repositories?.find(item => item.id === repo.id)?.name ?? repo.id}: {Math.round(repo.tokens).toLocaleString()} tokens{repo.estimatedCost !== undefined ? ` · ~$${repo.estimatedCost.toFixed(4)}` : ''}</li>)}</ul> : null}{state.capabilities?.usageReset && state.usage.resettable && <>{!resetConfirm ? <button type="button" onClick={() => setResetConfirm(true)}>Reset local counter</button> : <div><p>Reset this agent’s local usage counter?</p><button type="button" disabled={!idle} onClick={() => { onAction({ action: 'reset-usage' }); setResetConfirm(false) }}>Confirm reset</button><button type="button" onClick={() => setResetConfirm(false)}>Cancel</button></div>}</>}</>}{state.accountQuota && <div className="office-account-quota"><h3>Account limits{state.accountQuota.accountName ? ` · ${state.accountQuota.accountName}` : ''}</h3><button type="button" disabled={state.pending} onClick={() => onAction({ action: 'usage-refresh' })}>Refresh account usage</button>{state.accountQuota.available ? <>{state.accountQuota.limits?.map(limit => <div key={limit.id}><strong>{limit.name ?? limit.id}</strong><p>{limit.usedPercent.toFixed(1)}% used · {Math.max(0, 100 - limit.usedPercent).toFixed(1)}% remaining</p><progress max={100} value={limit.usedPercent} aria-label={`${limit.name ?? limit.id} usage`} /><p className="office-dialog-help">Resets {new Date(limit.resetsAt * 1000).toLocaleString()}</p></div>)}</> : <p className="office-dialog-help">{state.accountQuota.reason ?? 'Account limits are unavailable for this profile.'}</p>}{state.capabilities?.creditReset && state.accountQuota.reset?.ticket && (state.accountQuota.reset.availableCount ?? 0) > 0 && <>{!creditConfirm ? <button type="button" onClick={() => { setCreditAcknowledged(false); setCreditConfirm(true) }}>Use account reset ({state.accountQuota.reset.availableCount} available)</button> : <div className="office-credit-confirm"><p>This uses an available account reset and affects every agent sharing this profile. This is separate from resetting the local token counter.</p><label><input type="checkbox" checked={creditAcknowledged} onChange={event => setCreditAcknowledged(event.target.checked)} />I confirm that I want to use one account reset.</label><button type="button" disabled={!creditAcknowledged || !idle} onClick={() => { onAction({ action: 'credit-reset', resetTicket: state.accountQuota?.reset?.ticket, confirmed: true }); setCreditConfirm(false); setCreditAcknowledged(false) }}>Confirm account reset</button><button type="button" onClick={() => { setCreditConfirm(false); setCreditAcknowledged(false) }}>Cancel</button></div>}</>}</div>}</section>}
          {tab === 'controls' && !manager && <p className="office-dialog-help">Start and Stop control the agent’s active session. Role changes apply to this worker.</p>}
          {tab === 'chat' && <>
          {state.chatPage?.older && state.chatThreadId && <p className="office-history-window" role="status">Browsing earlier history. Return to Latest to follow live replies. <button type="button" onClick={() => onAction({ action: 'thread-select', threadId: state.chatThreadId })}>Latest messages</button></p>}
          {selected?.recoveredUnknown && <p className="office-history-window">Recovered history: its original profile and model are unknown. Fork creates a separate conversation using this worker’s current profile and model.</p>}
          {selected && <div className="office-thread-toolbar"><div><strong>{selected.title}</strong><small>{state.repositories?.find(repo => repo.id === selected.repoId)?.name ?? selected.repoId}{readOnlyThread ? ' · Read-only history' : ''}</small></div><button type="button" disabled={state.pending} onClick={() => setThreadForm({ kind: 'rename', threadId: selected.id, title: selected.title, repoId: selected.repoId })}>Rename</button><button type="button" disabled={selected.archived || state.pending || state.busy} onClick={() => onAction({ action: 'thread-archive', threadId: selected.id })}>Archive</button>{state.capabilities?.threadFork && <button type="button" disabled={state.pending || state.busy || selected.unavailable} onClick={() => onAction({ action: 'thread-fork', threadId: selected.id })}>Fork</button>}{state.capabilities?.threadCompact && <button type="button" disabled={state.pending || state.busy || readOnlyThread} onClick={() => onAction({ action: 'thread-compact', threadId: selected.id })}>Compact</button>}</div>}
          <section className="office-dialog-chat" aria-label="Worker conversation" ref={history} aria-live="polite" onScroll={() => { if (history.current) scrollState.current.atBottom = history.current.scrollHeight - history.current.scrollTop - history.current.clientHeight < 45 }}>
            {state.chatPage?.hasMore && state.chatPage.before && state.chatThreadId && <button type="button" className="office-history-more" disabled={state.pending} onClick={() => onAction({ action: 'thread-more', threadId: state.chatThreadId, before: state.chatPage?.before })}>Load earlier messages</button>}
            {state.chat.length ? state.chat.map(message => <article key={message.id} className={`office-chat-message office-chat-${message.role}`}><strong>{message.role === 'user' ? 'You' : state.worker.name}</strong>{message.role === 'assistant' && <button type="button" className="office-copy-reply" aria-label={`Copy reply ${message.id}`} onClick={() => void copyReply(message.id, message.text)}>{copied === message.id ? 'Copied' : 'Copy'}</button>}<p>{message.text}</p></article>) : <p className="office-dialog-empty">Send a message to begin this worker’s conversation.</p>}
            {(state.busy || state.pending || coordinating) && <p className="office-dialog-chat-progress" role="status">{state.busy || coordinating ? 'Working…' : 'Waiting for the provider…'}</p>}
          </section>
          <form className="office-dialog-composer" onSubmit={event => { event.preventDefault(); submit() }}>
            <label className="office-visually-hidden" htmlFor="office-agent-message">Message this worker</label>
            <textarea id="office-agent-message" ref={composer} rows={3} value={draft} maxLength={20_000} onChange={event => saveDraft(event.target.value)} disabled={readOnlyThread} placeholder={readOnlyThread ? 'This conversation is read-only history.' : state.worker.started ? 'Message this worker…' : 'Start this worker before sending a message.'} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }} />
            <div><span>Enter to send · Shift + Enter for a new line</span>{lastUser && <button type="button" disabled={!idle || !state.worker.started || readOnlyThread} onClick={() => onAction({ action: 'send', text: lastUser.text, threadId: state.chatThreadId })}>Retry last prompt</button>}<button type="submit" disabled={!draft.trim() || !state.worker.started || state.busy || state.pending || readOnlyThread}>Send</button></div>
          </form>
          </>}
          </main>
        </fieldset>}
        {(error || state?.error) && <p className="office-dialog-error" role="alert">{error || state?.error}</p>}
      </div>
    </div>
  )
}
