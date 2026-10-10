import { useState } from 'react'
import { OFFICE_ROLE_LABELS } from '../constants.js'
import type { OfficeRole } from '../office/types.js'

export interface BrowserModelOption { repoId: string; accountId: string; modelId: string; name: string }
interface Account { id: string; name: string; kind: string; connected: boolean }
interface Repository { id: string; name: string; readOnly: boolean }
interface Worker { id: string; name: string; role: OfficeRole; repoId: string }
export interface BrowserWorkerDraft {
  accountId: string; modelId: string; repoId: string; role: OfficeRole; mode: 'fast' | 'reasoning'; name?: string
  manager?: { mode: 'auto' | 'human-approval'; scopeRole: 'all' | 'builder' | 'security-reviewer' | 'verifier'; repoIds: string[]; teamIds: string[] }
}

/** Public configuration only. Credentials and repository paths stay in VS Code. */
export function BrowserWorkerForm({ manager, accounts, repositories, workers, models, pending, onSave, onCancel, onAddAccount }: {
  manager: boolean; accounts: Account[]; repositories: Repository[]; workers: Worker[]; models: BrowserModelOption[]; pending: boolean
  onSave: (draft: BrowserWorkerDraft) => void; onCancel: () => void; onAddAccount: () => void
}) {
  const [accountId, setAccountId] = useState(accounts.find(account => account.connected)?.id ?? accounts[0]?.id ?? '')
  const [repoId, setRepoId] = useState(repositories[0]?.id ?? '')
  const [modelId, setModelId] = useState('')
  const [role, setRole] = useState<OfficeRole>(manager ? 'manager' : 'builder')
  const [mode, setMode] = useState<'fast' | 'reasoning'>('fast')
  const [name, setName] = useState('')
  const [managerMode, setManagerMode] = useState<'auto' | 'human-approval'>('human-approval')
  const [scopeRole, setScopeRole] = useState<'all' | 'builder' | 'security-reviewer' | 'verifier'>('all')
  const [repoIds, setRepoIds] = useState<string[]>(repositories[0] ? [repositories[0].id] : [])
  const [teamIds, setTeamIds] = useState<string[]>([])
  const [error, setError] = useState('')
  const options = models.filter(model => model.repoId === repoId && model.accountId === accountId)
  const selected = options.find(model => model.modelId === modelId) ?? options[0]
  const selectedAccount = accounts.find(account => account.id === accountId)
  const candidates = workers.filter(worker => worker.role !== 'manager' && (scopeRole === 'all' || worker.role === scopeRole) && repoIds.includes(worker.repoId))
  return <form className="office-browser-worker-form" aria-label={manager ? 'New manager' : 'New agent'} onSubmit={event => {
    event.preventDefault()
    if (!selectedAccount || !selected || !repositories.some(repo => repo.id === repoId)) { setError('Choose a profile, repository and available model.'); return }
    if (name.length > 100 || [...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) { setError('Use a name of at most 100 characters without control characters.'); return }
    if (manager && !repoIds.includes(repoId)) { setError('Include the manager’s home repository in its assigned repositories.'); return }
    setError('')
    onSave({ accountId, modelId: selected.modelId, repoId, role, mode, ...(name.trim() ? { name: name.trim() } : {}), ...(manager ? { manager: { mode: managerMode, scopeRole, repoIds, teamIds: teamIds.filter(id => candidates.some(worker => worker.id === id)) } } : {}) })
  }}>
    <h3>{manager ? 'New manager' : 'New agent'}</h3>
    <label>Profile<select aria-label="New agent profile" value={accountId} disabled={pending} onChange={event => { setAccountId(event.target.value); setModelId('') }}><option value="" disabled>Choose a profile</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.kind}{account.connected ? '' : ' · sign-in needed'}</option>)}</select></label>
    <button type="button" disabled={pending} onClick={onAddAccount}>+ Separate account profile</button>
    <label>Repository<select aria-label="New agent repository" value={repoId} disabled={pending} onChange={event => { setRepoId(event.target.value); setModelId('') }}><option value="" disabled>Choose a repository</option>{repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.name}{repo.readOnly ? ' · read only' : ''}</option>)}</select></label>
    <label>Model<select aria-label="New agent model" value={selected?.modelId ?? ''} disabled={pending || !options.length} onChange={event => setModelId(event.target.value)}>{!options.length && <option value="">No models available for this profile</option>}{options.map(model => <option key={model.modelId} value={model.modelId}>{model.name}</option>)}</select></label>
    {selectedAccount && !selectedAccount.connected && <p className="office-browser-help">This profile needs sign-in. You can create its agent now and connect the profile before sending a prompt.</p>}
    {!options.length && <p className="office-browser-help">If models are missing, run The Office: Refresh Desk in VS Code.</p>}
    {!manager && <label>Role<select aria-label="New agent role" value={role} disabled={pending} onChange={event => setRole(event.target.value as OfficeRole)}>{Object.entries(OFFICE_ROLE_LABELS).filter(([value]) => value !== 'manager').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
    <label>Thinking<select aria-label="New agent thinking" value={mode} disabled={pending} onChange={event => setMode(event.target.value as 'fast' | 'reasoning')}><option value="fast">Fast</option><option value="reasoning">Reasoning</option></select></label>
    <label>Name (optional)<input aria-label="New agent name" value={name} maxLength={100} disabled={pending} onChange={event => setName(event.target.value)} placeholder="Use the signed-in identity or model name" /></label>
    {manager && <><label>Coordination<select aria-label="New manager mode" value={managerMode} disabled={pending} onChange={event => setManagerMode(event.target.value as 'auto' | 'human-approval')}><option value="human-approval">Human Approval</option><option value="auto">Auto</option></select></label><label>Team role<select aria-label="New manager scope" value={scopeRole} disabled={pending} onChange={event => setScopeRole(event.target.value as typeof scopeRole)}><option value="all">All roles</option>{Object.entries(OFFICE_ROLE_LABELS).filter(([value]) => value !== 'manager').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <fieldset><legend>Assigned repositories</legend>{repositories.map(repo => <label key={repo.id} className="office-browser-checkbox"><input type="checkbox" disabled={pending} checked={repoIds.includes(repo.id)} onChange={event => setRepoIds(current => event.target.checked ? [...current, repo.id] : current.filter(id => id !== repo.id))} />{repo.name}</label>)}</fieldset>
      <fieldset><legend>Team</legend>{candidates.map(worker => <label key={worker.id} className="office-browser-checkbox"><input type="checkbox" disabled={pending} checked={teamIds.includes(worker.id)} onChange={event => setTeamIds(current => event.target.checked ? [...current, worker.id] : current.filter(id => id !== worker.id))} />{worker.name}<small>{OFFICE_ROLE_LABELS[worker.role]} · {repositories.find(repo => repo.id === worker.repoId)?.name ?? worker.repoId}</small></label>)}{!candidates.length && <p className="office-browser-help">No matching workers yet. Assign a team later from the manager’s controls.</p>}</fieldset>
    </>}
    {error && <p className="office-browser-error" role="alert">{error}</p>}
    <div className="office-browser-actions"><button type="submit" disabled={pending || !selectedAccount || !selected}>Create {manager ? 'manager' : 'agent'}</button><button type="button" disabled={pending} onClick={onCancel}>Cancel</button></div>
  </form>
}
