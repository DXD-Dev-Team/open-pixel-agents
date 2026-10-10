import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentPanelAction, AgentPanelState } from '../components/AgentPanel.js'
import type { OfficeState } from '../office/engine/officeState.js'
import { isBrowserOffice, officeConnection, vscode } from '../vscodeApi.js'
import type { BrowserActionState } from '../vscodeApi.js'

interface PanelTarget { agentId: number; name: string; childName?: string }

/** Conversation state and drafts outlive the dialog, including streaming updates. */
export function useAgentPanel(getOfficeState: () => OfficeState) {
  const [target, setTarget] = useState<PanelTarget | null>(null)
  const [states, setStates] = useState<Record<number, AgentPanelState>>({})
  const [errors, setErrors] = useState<Record<number, string>>({})
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [actionStates, setActionStates] = useState<Record<number, BrowserActionState>>({})
  const requests = useRef(new Map<string, number>())
  const latestRequests = useRef(new Map<number, string>())
  const pendingRequests = useRef(new Set<string>())
  const requestIndex = useRef(0)
  const submissions = useRef(new Map<number, { text: string; previousIds: Set<string> }>())
  const postAction = useCallback((agentId: number, action: AgentPanelAction) => {
    if (isBrowserOffice && !officeConnection.getSnapshot().connected) { setErrors(current => ({ ...current, [agentId]: 'Reconnect to VS Code before using agent controls.' })); return }
    const requestId = `office-${Date.now()}-${++requestIndex.current}`
    if (isBrowserOffice) requests.current.set(requestId, agentId)
    setErrors(current => ({ ...current, [agentId]: '' }))
    vscode.postMessage({ type: 'officeAgentAction', agentId, requestId, ...action })
  }, [])
  const open = useCallback((id: number, request = true) => {
    const os = getOfficeState()
    const child = os.subagentMeta.get(id)
    const agentId = child?.parentAgentId ?? id
    const character = os.characters.get(agentId)
    if (!character?.officeLabel.managed) return false
    setTarget({ agentId, name: character.officeLabel.name, ...(child ? { childName: os.characters.get(id)?.officeLabel.name ?? 'Child session' } : {}) })
    if (request) postAction(agentId, { action: 'open' })
    return true
  }, [getOfficeState, postAction])
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data
      if (message.type === 'officeBrowserBootstrap' && isBrowserOffice) {
        setStates({}); setErrors({}); setActionStates({}); submissions.current.clear(); requests.current.clear(); latestRequests.current.clear(); pendingRequests.current.clear()
      }
      if (message.type === 'officeBrowserActionState' && isBrowserOffice) {
        const result = message as BrowserActionState
        const agentId = requests.current.get(result.requestId)
        if (agentId !== undefined) {
          if (result.state === 'pending') { latestRequests.current.set(agentId, result.requestId); pendingRequests.current.add(result.requestId) }
          const latest = latestRequests.current.get(agentId)
          const accepted = pendingRequests.current.has(result.requestId)
          // Stop can finish before an older Send settles. Only the user's most
          // recent accepted action owns feedback. An immediate duplicate error
          // cannot take ownership from the dialog already awaiting VS Code.
          if (latest === result.requestId || result.state === 'failed' && !pendingRequests.current.has(result.requestId) && !pendingRequests.current.has(latest ?? '')) setActionStates(current => ({ ...current, [agentId]: result }))
          if (result.state === 'failed' && (latest === result.requestId || !accepted)) setErrors(current => ({ ...current, [agentId]: result.error ?? 'The action could not be completed.' }))
          if (latest === result.requestId && (result.state === 'completed' || result.state === 'cancelled')) setErrors(current => ({ ...current, [agentId]: '' }))
          if (result.state !== 'pending') { requests.current.delete(result.requestId); pendingRequests.current.delete(result.requestId) }
        }
      }
      if (message.type === 'existingAgents' && isBrowserOffice) {
        const ids = new Set<number>(message.agents)
        setTarget(current => current && !ids.has(current.agentId) ? null : current)
      }
      if (message.type === 'officeAgentPanelOpen' && !isBrowserOffice) open(message.agentId, false)
      if (message.type === 'officeAgentPanel') {
        const agentId = message.agentId as number
        const state = message.state as AgentPanelState
        setStates(current => ({ ...current, [agentId]: state }))
        setErrors(current => ({ ...current, [agentId]: '' }))
        const submitted = submissions.current.get(agentId)
        // Clear a draft only once the native transcript acknowledges acceptance.
        // Failed requests leave the user's text available to edit or retry.
        if (submitted && state.chat.some(item => item.role === 'user' && item.text.trim() === submitted.text && !submitted.previousIds.has(item.id))) {
          setDrafts(current => current[agentId]?.trim() === submitted.text ? { ...current, [agentId]: '' } : current)
          submissions.current.delete(agentId)
        }
      }
      // Browser request failures already pass through the correlated result
      // above. A delayed failed Send must not overwrite a newer successful Stop.
      if (message.type === 'officeAgentActionError' && (!isBrowserOffice || !message.requestId)) setErrors(current => ({ ...current, [message.agentId]: String(message.error ?? 'The action could not be completed.') }))
      if (message.type === 'agentClosed') {
        setTarget(current => current?.agentId === message.id ? null : current)
        setStates(current => { const next = { ...current }; delete next[message.id]; return next })
        submissions.current.delete(message.id)
        latestRequests.current.delete(message.id)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [open])
  const action = useCallback((input: AgentPanelAction) => {
    if (!target) return
    if (isBrowserOffice && input.action === 'add-account') {
      const workerId = states[target.agentId]?.worker.id
      if (!workerId) return
      setTarget(null)
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'officeBrowserAccountForm', kind: input.kind, workerId } }))
      return
    }
    if (input.action === 'send' && input.text) submissions.current.set(target.agentId, { text: input.text.trim(), previousIds: new Set(states[target.agentId]?.chat.map(item => item.id)) })
    postAction(target.agentId, input)
  }, [target, states, postAction])
  const close = useCallback(() => setTarget(null), [])
  const setDraft = useCallback((text: string) => {
    if (target) setDrafts(current => ({ ...current, [target.agentId]: text }))
  }, [target])
  return { target, state: target ? states[target.agentId] : undefined, error: target ? errors[target.agentId] : undefined,
    actionState: target ? actionStates[target.agentId] : undefined, draft: target ? drafts[target.agentId] ?? '' : '', setDraft, open, action, close }
}
