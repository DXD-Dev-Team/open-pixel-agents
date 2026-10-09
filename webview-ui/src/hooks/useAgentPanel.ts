import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentPanelAction, AgentPanelState } from '../components/AgentPanel.js'
import type { OfficeState } from '../office/engine/officeState.js'
import { vscode } from '../vscodeApi.js'

interface PanelTarget { agentId: number; name: string; childName?: string }

/** Conversation state and drafts outlive the dialog, including streaming updates. */
export function useAgentPanel(getOfficeState: () => OfficeState) {
  const [target, setTarget] = useState<PanelTarget | null>(null)
  const [states, setStates] = useState<Record<number, AgentPanelState>>({})
  const [errors, setErrors] = useState<Record<number, string>>({})
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const requestIndex = useRef(0)
  const submissions = useRef(new Map<number, { text: string; previousIds: Set<string> }>())
  const postAction = useCallback((agentId: number, action: AgentPanelAction) => {
    const requestId = `office-${Date.now()}-${++requestIndex.current}`
    vscode.postMessage({ type: 'officeAgentAction', agentId, requestId, ...action })
    setErrors(current => ({ ...current, [agentId]: '' }))
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
      if (message.type === 'officeAgentPanelOpen') open(message.agentId, false)
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
      if (message.type === 'officeAgentActionError') setErrors(current => ({ ...current, [message.agentId]: String(message.error ?? 'The action could not be completed.') }))
      if (message.type === 'agentClosed') {
        setTarget(current => current?.agentId === message.id ? null : current)
        setStates(current => { const next = { ...current }; delete next[message.id]; return next })
        submissions.current.delete(message.id)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [open])
  const action = useCallback((input: AgentPanelAction) => {
    if (!target) return
    if (input.action === 'send' && input.text) submissions.current.set(target.agentId, { text: input.text.trim(), previousIds: new Set(states[target.agentId]?.chat.map(item => item.id)) })
    postAction(target.agentId, input)
  }, [target, states, postAction])
  const close = useCallback(() => setTarget(null), [])
  const setDraft = useCallback((text: string) => {
    if (target) setDrafts(current => ({ ...current, [target.agentId]: text }))
  }, [target])
  return { target, state: target ? states[target.agentId] : undefined, error: target ? errors[target.agentId] : undefined,
    draft: target ? drafts[target.agentId] ?? '' : '', setDraft, open, action, close }
}
