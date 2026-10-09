import { useEffect, useRef, useState } from 'react'
import type { OfficeRole, OfficeStatus } from '../office/types.js'
import { OFFICE_ROLE_LABELS } from '../constants.js'
import './AgentPanel.css'

export type AgentActionName = 'open' | 'send' | 'start' | 'stop' | 'close' | 'role' | 'manager-mode' | 'assign-team' | 'approve' | 'reject' | 'attention' | 'sign-in' | 'change-account' | 'add-account' | 'manager-repos' | 'manager-scope'
interface PanelAccount { id: string; name: string; kind: 'claude' | 'codex' | 'grok'; connected: boolean; authType?: string; loginName?: string }
export interface AgentPanelState {
  worker: { id: string; name: string; role: OfficeRole; status: OfficeStatus; started: boolean; repoId?: string; repoName?: string; providerKind?: string; modelId?: string; accountId?: string }
  chat: Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: number }>
  pending: boolean
  busy: boolean
  error?: string
  repositories?: Array<{ id: string; name: string }>
  account?: PanelAccount
  accounts?: PanelAccount[]
  attention?: Array<{ id: string; kind: 'permission' | 'question'; ask: string }>
  manager?: { mode: 'auto' | 'human-approval'; scopeRole?: 'all' | 'builder' | 'security-reviewer' | 'verifier'; repoIds?: string[]; teamIds: string[]; team: Array<{ id: string; name: string; role: OfficeRole }>; paused?: boolean; triaging?: boolean; coordinating?: boolean; executing?: boolean; error?: string;
    proposals: Array<{ id: string; text: string; workerId?: string; workerName?: string; status: 'pending' | 'approved' | 'rejected' | 'running' | 'done' | 'failed'; error?: string }> }
}
export interface AgentPanelAction { action: AgentActionName; text?: string; role?: OfficeRole; mode?: 'auto' | 'human-approval'; teamIds?: string[]; proposalId?: string; accountId?: string; kind?: 'claude' | 'codex' | 'grok'; repoIds?: string[]; scopeRole?: 'all' | 'builder' | 'security-reviewer' | 'verifier' }
const roleLabels = OFFICE_ROLE_LABELS

interface Props { agentId: number; name: string; state?: AgentPanelState; error?: string; childName?: string; draft: string; onDraftChange: (text: string) => void; onAction: (action: AgentPanelAction) => void; onClose: () => void }

export function AgentPanel({ agentId, name, state, error, childName, draft, onDraftChange, onAction, onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const history = useRef<HTMLDivElement>(null)
  const [accountKind, setAccountKind] = useState<'claude' | 'codex' | 'grok'>('codex')
  const [copied, setCopied] = useState<string | null>(null)
  const [teamDraft, setTeamDraft] = useState<{ agentId: number; ids: string[] } | null>(null)
  const [repoDraft, setRepoDraft] = useState<{ agentId: number; ids: string[] } | null>(null)
  const teamDirty = teamDraft?.agentId === agentId
  const reposDirty = repoDraft?.agentId === agentId
  const team = teamDirty ? teamDraft.ids : state?.manager?.teamIds ?? []
  const repos = reposDirty ? repoDraft.ids : state?.manager?.repoIds ?? []
  useEffect(() => {
    const focus = composer.current ?? dialog.current
    focus?.focus()
    // Opening/switching the dialog owns focus; streamed state updates do not.
  }, [agentId])
  useEffect(() => { if (history.current) history.current.scrollTop = history.current.scrollHeight }, [state?.chat])
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
    if (!text || !state || state.busy || state.pending || !state.worker.started) return
    onAction({ action: 'send', text })
  }
  const saveDraft = onDraftChange
  const manager = state?.manager
  const coordinating = manager?.triaging || manager?.coordinating || manager?.executing
  const idle = !!state && !state.busy && !state.pending && !coordinating
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
        {childName && <p className="office-dialog-child">Opened from child “{childName}”. These controls belong to its parent worker.</p>}
        {!state ? <p className="office-dialog-loading" role="status">Loading this worker’s conversation…</p> : <>
          <div className="office-dialog-controls">
            <span className={`office-dialog-status office-status-${state.worker.status.replace(' ', '-')}`}>{state.worker.status}</span>
            <label>Role<select aria-label="Worker role" value={state.worker.role} disabled={state.busy || state.pending} onChange={event => onAction({ action: 'role', role: event.target.value as OfficeRole })}>
              {Object.entries(roleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
            </select></label>
            <div className="office-dialog-lifecycle">
              <button type="button" disabled={state.worker.started && !manager?.paused || state.busy || state.pending || coordinating} onClick={() => onAction({ action: 'start' })}>Start</button>
              <button type="button" disabled={!state.worker.started || !state.busy && !state.pending && !coordinating && (!manager || manager.paused)} onClick={() => onAction({ action: 'stop' })}>Stop</button>
              <button type="button" className="office-dialog-danger" disabled={!state.worker.started} onClick={() => onAction({ action: 'close' })}>Close session</button>
            </div>
          </div>
          <p className="office-dialog-model">{[state.worker.repoName, state.worker.providerKind, state.worker.modelId].filter(Boolean).join(' · ')}</p>
          <section className="office-dialog-account" aria-label="Agent account">
            <div><strong>{state.account?.loginName ?? state.account?.name ?? 'Provider account'}</strong><span>{state.account?.connected ? 'Connected' : 'Sign-in needed'}</span></div>
            <div><label>Account<select aria-label="Assigned account" value={state.account?.id ?? ''} disabled={state.busy || state.pending} onChange={event => onAction({ action: 'change-account', accountId: event.target.value })}><option value="" disabled>Choose an account</option>{state.accounts?.map(account => <option key={account.id} value={account.id}>{account.name} · {account.kind}{account.connected ? '' : ' · sign-in needed'}</option>)}</select></label><button type="button" disabled={!state.account || state.busy || state.pending} onClick={() => onAction({ action: 'sign-in' })}>{state.account?.connected ? 'Reconnect' : 'Sign in'}</button></div>
            <details><summary>Add another provider account</summary><div><select aria-label="New account provider" value={accountKind} onChange={event => setAccountKind(event.target.value as 'claude' | 'codex' | 'grok')}><option value="codex">Codex</option><option value="claude">Claude</option><option value="grok">Grok</option></select><button type="button" onClick={() => onAction({ action: 'add-account', kind: accountKind })}>Add account</button></div></details>
          </section>
          {state.attention?.length ? <div className="office-dialog-attention"><strong>Human input needed</strong><p>{state.attention[0].ask}</p><button type="button" onClick={() => onAction({ action: 'attention' })}>Open Attention</button></div> : null}
          {manager && <section className="office-dialog-manager" aria-label="Manager controls">
            <div className="office-dialog-manager-heading"><h3>{manager.scopeRole && manager.scopeRole !== 'all' ? `${roleLabels[manager.scopeRole]} manager` : 'Office manager'}</h3><label>Mode<select aria-label="Manager mode" value={manager.mode} disabled={manager.triaging} onChange={event => onAction({ action: 'manager-mode', mode: event.target.value as 'auto' | 'human-approval' })}><option value="human-approval">Human Approval</option><option value="auto">Auto</option></select></label></div>
            <label className="office-manager-scope">Team role<select aria-label="Manager team role" value={manager.scopeRole ?? 'all'} disabled={state.busy || state.pending || coordinating} onChange={event => onAction({ action: 'manager-scope', scopeRole: event.target.value as 'all' | 'builder' | 'security-reviewer' | 'verifier' })}><option value="all">All office roles</option>{Object.entries(roleLabels).filter(([role]) => role !== 'manager').map(([role,label]) => <option key={role} value={role}>{label}</option>)}</select></label>
            {manager.paused && <p className="office-dialog-help" role="status">Paused · Start resumes automatic team coordination.</p>}
            <p className="office-dialog-help">{manager.mode === 'auto' ? 'Approved team tasks can run automatically.' : 'Review proposed team tasks before they run.'}</p>
            {state.repositories?.length ? <fieldset><legend>Assigned repositories</legend><div className="office-dialog-team">{state.repositories.map(repo => <label key={repo.id}><input type="checkbox" checked={repos.includes(repo.id)} disabled={manager.triaging} onChange={event => { setRepoDraft({ agentId, ids: event.target.checked ? [...repos, repo.id] : repos.filter(id => id !== repo.id) }) }} /><span>{repo.name}</span></label>)}</div><button type="button" disabled={!reposDirty || !repos.length || manager.triaging} onClick={() => { onAction({ action: 'manager-repos', repoIds: repos }); setRepoDraft(null) }}>Save repositories</button></fieldset> : null}
            <fieldset><legend>Team</legend><div className="office-dialog-team">{manager.team.length ? manager.team.map(member => <label key={member.id}><input type="checkbox" checked={team.includes(member.id)} disabled={manager.triaging} onChange={event => { setTeamDraft({ agentId, ids: event.target.checked ? [...team, member.id] : team.filter(id => id !== member.id) }) }} /><span>{member.name}<small>{roleLabels[member.role]}</small></span></label>) : <p>Add other workers to assign a team.</p>}</div>
              <button type="button" disabled={!teamDirty || manager.triaging} onClick={() => { onAction({ action: 'assign-team', teamIds: team }); setTeamDraft(null) }}>Save team</button></fieldset>
            {manager.triaging && <p role="status">Reviewing the team’s next steps…</p>}
            {manager.error && <p className="office-dialog-error" role="alert">{manager.error}</p>}
            <div className="office-dialog-proposals">{manager.proposals.map(proposal => <article key={proposal.id} data-proposal-id={proposal.id}><div><strong>{proposal.workerName ?? 'Team task'}</strong><span>{proposal.status}</span></div><p>{proposal.text}</p>{proposal.error && <p className="office-dialog-error">{proposal.error}</p>}{proposal.status === 'pending' && <div><button type="button" onClick={() => onAction({ action: 'approve', proposalId: proposal.id })}>Approve</button><button type="button" className="office-dialog-danger" onClick={() => onAction({ action: 'reject', proposalId: proposal.id })}>Reject</button></div>}</article>)}</div>
          </section>}
          <section className="office-dialog-chat" aria-label="Worker conversation" ref={history} aria-live="polite">
            {state.chat.length ? state.chat.map(message => <article key={message.id} className={`office-chat-message office-chat-${message.role}`}><strong>{message.role === 'user' ? 'You' : state.worker.name}</strong>{message.role === 'assistant' && <button type="button" className="office-copy-reply" aria-label={`Copy reply ${message.id}`} onClick={() => void copyReply(message.id, message.text)}>{copied === message.id ? 'Copied' : 'Copy'}</button>}<p>{message.text}</p></article>) : <p className="office-dialog-empty">Send a message to begin this worker’s conversation.</p>}
            {(state.busy || state.pending || coordinating) && <p className="office-dialog-chat-progress" role="status">{state.busy || coordinating ? 'Working…' : 'Waiting for the provider…'}</p>}
          </section>
          <form className="office-dialog-composer" onSubmit={event => { event.preventDefault(); submit() }}>
            <label className="office-visually-hidden" htmlFor="office-agent-message">Message this worker</label>
            <textarea id="office-agent-message" ref={composer} rows={3} value={draft} maxLength={20_000} onChange={event => saveDraft(event.target.value)} placeholder={state.worker.started ? 'Message this worker…' : 'Start this worker before sending a message.'} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }} />
            <div><span>Enter to send · Shift + Enter for a new line</span>{lastUser && <button type="button" disabled={!idle || !state.worker.started} onClick={() => onAction({ action: 'send', text: lastUser.text })}>Retry last prompt</button>}<button type="submit" disabled={!draft.trim() || !state.worker.started || state.busy || state.pending}>Send</button></div>
          </form>
        </>}
        {(error || state?.error) && <p className="office-dialog-error" role="alert">{error || state?.error}</p>}
      </div>
    </div>
  )
}
