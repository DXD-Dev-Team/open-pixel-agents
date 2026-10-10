declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }

export const isBrowserOffice = typeof acquireVsCodeApi !== 'function'
export interface OfficeConnection { connected: boolean; state: 'connecting' | 'connected' | 'disconnected' | 'expired'; message: string }
export interface BrowserActionState { requestId: string; action: string; source?: 'agent' | 'desk' | 'create'; state: 'pending' | 'completed' | 'cancelled' | 'failed'; error?: string }
let connection: OfficeConnection = { connected: !isBrowserOffice, state: isBrowserOffice ? 'connecting' : 'connected', message: isBrowserOffice ? 'Connecting to VS Code…' : '' }
const listeners = new Set<() => void>()
export const officeConnection = { subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, getSnapshot: () => connection }
function status(state: OfficeConnection['state'], message: string) {
  connection = { connected: state === 'connected', state, message }
  for (const listener of listeners) listener()
}
function emit(message: unknown) { window.dispatchEvent(new MessageEvent('message', { data: message })) }

function browserApi(): { postMessage(msg: unknown): void } {
  document.documentElement.dataset.officeBrowser = 'true'
  let csrf: string | undefined
  let token = new URLSearchParams(window.location.hash.slice(1)).get('office-token') ?? undefined
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search)
  let ended = false
  let ready = false
  let controller: AbortController | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let epoch = 0
  let requestIndex = 0
  const actions = new Map<string, { message: Record<string, unknown>; requestId: string; action: string }>()
  const actionState = (message: Record<string, unknown>, requestId: string, action: string, state: BrowserActionState['state'], error?: string) => emit({ type: 'officeBrowserActionState', requestId, action, source: message.type === 'officeAgentAction' ? 'agent' : message.type === 'officeDeskAction' ? 'desk' : 'create', state, ...(error ? { error } : {}) })
  const actionError = (message: Record<string, unknown>, requestId: string, action: string, error: string) => {
    actionState(message, requestId, action, 'failed', error)
    if (message.type === 'officeAgentAction') emit({ type: 'officeAgentActionError', requestId, agentId: message.agentId, error })
  }
  const failActions = () => {
    for (const operation of actions.values()) actionError(operation.message, operation.requestId, operation.action, 'The connection changed before VS Code confirmed this action. Check VS Code before retrying.')
    actions.clear()
  }
  const connect = async () => {
    const current = ++epoch
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    status('connecting', 'Connecting to VS Code…')
    try {
      const capability = token; token = undefined
      const handshake = await fetch('/api/connect', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(capability !== undefined ? { token: capability } : {}), signal })
      if (ended || current !== epoch) return
      if (handshake.status === 401 || handshake.status === 403) { status('expired', 'Reopen Browser Office from VS Code to reconnect.'); return }
      if (!handshake.ok) throw new Error('Connection unavailable.')
      const session = await handshake.json() as { csrf?: unknown }
      if (ended || current !== epoch) return
      if (typeof session.csrf !== 'string' || !session.csrf || session.csrf.length > 256) throw new Error('Invalid office session.')
      csrf = session.csrf
      const response = await fetch('/api/events', { credentials: 'same-origin', headers: { 'X-Office-CSRF': csrf }, signal })
      if (ended || current !== epoch) return
      if (response.status === 401 || response.status === 403) { status('expired', 'Reopen Browser Office from VS Code to reconnect.'); return }
      if (!response.ok || !response.body) throw new Error('Connection unavailable.')
      if (ended || current !== epoch) return
      status('connecting', 'Preparing the shared office in VS Code…')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          if (ended || current !== epoch) return
          pending += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
          if (pending.length > 34_000_000) throw new Error('Invalid office stream.')
          let boundary: number
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2)
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
            if (data) {
              const message = JSON.parse(data) as { type?: string }
              emit(message)
              if (message.type === 'officeBrowserReady') status('connected', 'Connected to VS Code · Layout is managed in VS Code')
              if (message.type === 'officeBrowserConnectionError') {
                failActions(); csrf = undefined; epoch++; controller?.abort()
                status('disconnected', 'The VS Code office could not initialize. Open Office Desk in VS Code, then reopen Browser Office.'); return
              }
              if (message.type === 'officeBrowserSessionExpired' || message.type === 'officeBrowserClosed') {
                failActions(); csrf = undefined; epoch++; controller?.abort()
                status('expired', 'Reopen Browser Office from VS Code to reconnect.'); return
              }
            }
          }
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
      throw new Error('Connection ended.')
    } catch {
      if (ended || current !== epoch || signal.aborted) return
      failActions()
      csrf = undefined
      status('disconnected', 'VS Code connection lost. Reconnecting…')
      retry = setTimeout(() => { void connect() }, 1500)
    }
  }
  window.addEventListener('pagehide', () => { ended = true; epoch++; clearTimeout(retry); controller?.abort(); csrf = undefined; failActions(); status('disconnected', 'Reconnect to VS Code before using these controls.') })
  window.addEventListener('pageshow', event => { if (event.persisted && ready) { ended = false; void connect() } })
  return { postMessage(input) {
    if (!input || typeof input !== 'object') return
    let message = input as Record<string, unknown>
    // The renderer signals readiness only after registering its message handlers.
    // StrictMode's duplicate effects must not open duplicate event streams.
    if (message.type === 'webviewReady') { if (!ready) { ready = true; void connect() } return }
    if (message.type === 'closeAgent') message = { type: 'officeAgentAction', action: 'close', agentId: message.id, requestId: `browser-close-${Date.now()}` }
    if (!['officeAgentAction', 'officeDeskAction', 'openAgentSession'].includes(String(message.type))) return
    const action = message.type === 'openAgentSession' ? 'createWorker' : typeof message.action === 'string' ? message.action : 'unknown'
    const requestId = typeof message.requestId === 'string' ? message.requestId : `browser-${Date.now()}-${++requestIndex}`
    message = { ...message, requestId }
    if (!connection.connected || !csrf) { actionError(message, requestId, action, 'Reconnect to VS Code before using these controls.'); return }
    const body = JSON.stringify(message)
    if (new TextEncoder().encode(body).byteLength > 64 * 1024) {
      const error = 'This message is too large. Shorten it to fit the office’s 64 KiB request limit.'
      actionError(message, requestId, action, error); return
    }
    const key = JSON.stringify([message.type, action, message.id ?? message.agentId ?? '', message.kind ?? ''])
    if (actions.has(key)) { actionError(message, requestId, action, 'This action is already waiting for VS Code. Complete or cancel its existing dialog first.'); return }
    if (actions.size >= 32) { actionError(message, requestId, action, 'Too many actions are waiting for VS Code. Complete or cancel a pending action first.'); return }
    const operation = { message, requestId, action }; actions.set(key, operation); actionState(message, requestId, action, 'pending')
    const current = epoch
    void fetch('/api/message', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Office-CSRF': csrf }, body, signal: controller?.signal }).then(async response => {
      if (current !== epoch || ended || actions.get(key) !== operation) return
      const body = await response.json().catch(() => ({})) as { status?: unknown; error?: unknown }
      if (current !== epoch || ended || actions.get(key) !== operation) return
      actions.delete(key)
      if (!response.ok) {
        const expired = response.status === 401 || response.status === 403
        if (expired) { failActions(); csrf = undefined; epoch++; controller?.abort(); status('expired', 'Reopen Browser Office from VS Code to reconnect.') }
        const error = typeof body.error === 'string' ? body.error.slice(0, 1000) : 'The office action could not be completed.'
        actionError(message, requestId, action, error)
      } else if (body.status === 'completed' || body.status === 'cancelled') actionState(message, requestId, action, body.status)
      else actionError(message, requestId, action, 'VS Code did not confirm the action outcome. Update Office Desk and reopen Browser Office before retrying.')
    }).catch(() => {
      if (current === epoch && !ended && actions.get(key) === operation) {
        actions.delete(key); actionError(message, requestId, action, 'VS Code did not confirm the action. Check its pending dialogs and connection before retrying.')
      }
    })
  } }
}

export const vscode = isBrowserOffice ? browserApi() : acquireVsCodeApi()
