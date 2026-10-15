import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentPanelAction, AgentPanelState } from '../components/AgentPanel.js'
import type { OfficeState } from '../office/engine/officeState.js'
import { isBrowserOffice, officeConnection, officeHost, officeViewId, vscode } from '../vscodeApi.js'
import type { BrowserActionState } from '../vscodeApi.js'

interface PanelTarget { agentId: number; name: string; childName?: string }

/** Conversation state and drafts outlive the dialog, including streaming updates. */
export function useAgentPanel(getOfficeState: () => OfficeState) {
  const [target, setTarget] = useState<PanelTarget | null>(null)
  const [states, setStates] = useState<Record<number, AgentPanelState>>({})
  const [errors, setErrors] = useState<Record<number, string>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [actionStates, setActionStates] = useState<Record<number, BrowserActionState>>({})
  const selectedThreads = useRef(new Map<number, string>())
  const threadPanels = useRef(new Map<string, AgentPanelState>())
  const selectionRequests = useRef(new Map<string, { agentId: number; wanted: string; previous?: string }>())
  const requests = useRef(new Map<string, number>())
  const latestRequests = useRef(new Map<number, string>())
  const pendingRequests = useRef(new Set<string>())
  const requestIndex = useRef(0)
  const submissions = useRef(new Map<string, { text: string; previousIds: Set<string>; agentId: number }>())
  const postAction = useCallback((agentId: number, action: AgentPanelAction, beforePost?: (requestId: string) => void) => {
    if (isBrowserOffice && !officeConnection.getSnapshot().connected) { setErrors(current => ({ ...current, [agentId]: `Reconnect to ${officeHost.getSnapshot().hostKind === 'standalone' ? 'Office host' : 'VS Code'} before using agent controls.` })); return }
    const requestId = `office-${Date.now()}-${++requestIndex.current}`
    requests.current.set(requestId, agentId)
    setErrors(current => ({ ...current, [agentId]: '' }))
    beforePost?.(requestId)
    vscode.postMessage({ type: 'officeAgentAction', agentId, requestId, viewId: officeViewId, ...action })
    return requestId
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
      if (message.type === 'officeAgentPanel' && (message.viewId ?? message.state?.viewId) && (message.viewId ?? message.state?.viewId) !== officeViewId) return
      if (message.type === 'officeBrowserBootstrap' && isBrowserOffice) {
        setStates({}); setErrors({}); setActionStates({}); submissions.current.clear(); requests.current.clear(); latestRequests.current.clear(); pendingRequests.current.clear()
      }
      if ((message.type === 'officeBrowserActionState' && isBrowserOffice || message.type === 'officeAgentActionState' && !isBrowserOffice)) {
        const result = message as BrowserActionState
        const selection = selectionRequests.current.get(result.requestId)
        if (selection && ['failed', 'cancelled'].includes(result.state) && selectedThreads.current.get(selection.agentId) === selection.wanted) {
          if (selection.previous) selectedThreads.current.set(selection.agentId, selection.previous); else selectedThreads.current.delete(selection.agentId)
          setStates(current => { const old = current[selection.agentId]; const restored = selection.previous && old ? threadPanels.current.get(`${old.worker.id}:${selection.previous}`) : undefined; return restored ? { ...current, [selection.agentId]: restored } : old ? { ...current, [selection.agentId]: { ...old, pending: false } } : current })
        }
        if (result.state !== 'pending') selectionRequests.current.delete(result.requestId)
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
        if (state.chatThreadId) { threadPanels.current.set(`${state.worker.id}:${state.chatThreadId}`, state); if (threadPanels.current.size > 16) threadPanels.current.delete(threadPanels.current.keys().next().value!) }
        const wanted = selectedThreads.current.get(agentId)
        if (!wanted && state.chatThreadId) selectedThreads.current.set(agentId, state.chatThreadId)
        setStates(current => {
          const old = current[agentId]
          if (wanted && state.chatThreadId && wanted !== state.chatThreadId) {
            const cached = threadPanels.current.get(`${state.worker.id}:${wanted}`) ?? old
            return { ...current, [agentId]: { ...state, chatThreadId: wanted, chat: cached?.chatThreadId === wanted ? cached.chat : [], chatPage: cached?.chatThreadId === wanted ? cached.chatPage : undefined, threads: state.threads ? { ...state.threads, selectedId: wanted } : undefined } }
          }
          return { ...current, [agentId]: state }
        })
        setErrors(current => ({ ...current, [agentId]: '' }))
        const key = `${state.worker.id}:${state.chatThreadId ?? 'current'}`
        const submitted = submissions.current.get(key)
        // Clear a draft only once the native transcript acknowledges acceptance.
        // Failed requests leave the user's text available to edit or retry.
        if (submitted && state.chat.some(item => item.role === 'user' && item.text.trim() === submitted.text && !submitted.previousIds.has(item.id))) {
          setDrafts(current => current[key]?.trim() === submitted.text ? { ...current, [key]: '' } : current)
          submissions.current.delete(key)
        }
      }
      // Browser request failures already pass through the correlated result
      // above. A delayed failed Send must not overwrite a newer successful Stop.
      if (message.type === 'officeAgentActionError' && !message.requestId) setErrors(current => ({ ...current, [message.agentId]: String(message.error ?? 'The action could not be completed.') }))
      if (message.type === 'agentClosed') {
        setTarget(current => current?.agentId === message.id ? null : current)
        setStates(current => { const next = { ...current }; delete next[message.id]; return next })
        for (const [key, item] of submissions.current) if (item.agentId === message.id) submissions.current.delete(key)
        latestRequests.current.delete(message.id)
        selectedThreads.current.delete(message.id)
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [open])
  const action = useCallback((input: AgentPanelAction) => {
    if (!target) return
    if (isBrowserOffice && officeHost.getSnapshot().hostKind === 'standalone' && input.action === 'sign-in') {
      const accountId = states[target.agentId]?.account?.id
      if (!accountId) return
      setTarget(null); window.dispatchEvent(new MessageEvent('message', { data: { type: 'officeBrowserProfileSignIn', accountId } })); return
    }
    if (isBrowserOffice && input.action === 'add-account') {
      const workerId = states[target.agentId]?.worker.id
      if (!workerId) return
      setTarget(null)
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'officeBrowserAccountForm', kind: input.kind, workerId } }))
      return
    }
    const selectedState = states[target.agentId]
    if (input.action === 'thread-select' && input.threadId) {
      const previous = selectedThreads.current.get(target.agentId) ?? selectedState?.chatThreadId
      selectedThreads.current.set(target.agentId, input.threadId)
      const cached = selectedState && threadPanels.current.get(`${selectedState.worker.id}:${input.threadId}`)
      setStates(current => selectedState ? { ...current, [target.agentId]: { ...(cached ?? selectedState), chatThreadId: input.threadId, chat: cached?.chat ?? [], chatPage: cached?.chatPage, pending: !cached, threads: selectedState.threads ? { ...selectedState.threads, selectedId: input.threadId } : undefined } } : current)
      const wanted = input.threadId
      const requestId = postAction(target.agentId, input, id => selectionRequests.current.set(id, { agentId: target.agentId, wanted, previous }))
      return requestId
    }
    const key = `${selectedState?.worker.id ?? `agent-${target.agentId}`}:${selectedState?.chatThreadId ?? 'current'}`
    if (input.action === 'send' && input.text) submissions.current.set(key, { agentId: target.agentId, text: input.text.trim(), previousIds: new Set(states[target.agentId]?.chat.map(item => item.id)) })
    return postAction(target.agentId, input)
  }, [target, states, postAction])
  const close = useCallback(() => setTarget(null), [])
  const setDraft = useCallback((text: string) => {
    if (target) { const state = states[target.agentId]; const key = `${state?.worker.id ?? `agent-${target.agentId}`}:${state?.chatThreadId ?? 'current'}`; setDrafts(current => ({ ...current, [key]: text })) }
  }, [target, states])
  const currentState = target ? states[target.agentId] : undefined
  const currentKey = target ? `${currentState?.worker.id ?? `agent-${target.agentId}`}:${currentState?.chatThreadId ?? 'current'}` : ''
  return { target, state: target ? states[target.agentId] : undefined, error: target ? errors[target.agentId] : undefined,
    actionState: target ? actionStates[target.agentId] : undefined, draft: drafts[currentKey] ?? '', setDraft, open, action, close }
}
