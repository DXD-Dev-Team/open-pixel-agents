import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isBrowserOffice, officeConnection, officeHost, vscode } from '../vscodeApi.js'
import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js'
import type { OfficeLayout } from '../office/types.js'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
  getLayout: () => OfficeLayout
}

const menuItemBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  padding: '6px 10px',
  fontFamily: 'var(--vscode-font-family)',
  fontSize: 'var(--vscode-font-size)',
  fontWeight: 'var(--vscode-font-weight)',
  color: 'rgba(255, 255, 255, 0.8)',
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  cursor: 'pointer',
  textAlign: 'left',
}

export function SettingsModal({ isOpen, onClose, isDebugMode, onToggleDebugMode, getLayout }: SettingsModalProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled)
  const [feedback, setFeedback] = useState('')
  const [importing, setImporting] = useState(false)
  const [soundPending, setSoundPending] = useState(false)
  const host = useSyncExternalStore(officeHost.subscribe, officeHost.getSnapshot)
  const { connected } = useSyncExternalStore(officeConnection.subscribe, officeConnection.getSnapshot)
  const fileInput = useRef<HTMLInputElement>(null)
  const pendingImport = useRef<{ requestId: string; layout: string; loaded: boolean; completed: boolean } | null>(null)
  const pendingSound = useRef<{ requestId: string; previous: boolean } | null>(null)
  const sharedHost = host.hostKind === 'standalone'
  const localLayoutIo = isBrowserOffice || sharedHost

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = event.data
      if (['officeBrowserBootstrap', 'officeBrowserClosed', 'officeBrowserSessionExpired', 'officeBrowserConnectionError'].includes(message?.type)) {
        if (pendingImport.current) { pendingImport.current = null; setImporting(false); setFeedback('The connection changed before the host confirmed this import. Reconnect and check the current layout before retrying.') }
        if (pendingSound.current) { setSoundEnabled(pendingSound.current.previous); setSoundLocal(pendingSound.current.previous); pendingSound.current = null; setSoundPending(false) }
      }
      if (message?.type === 'settingsLoaded' && typeof message.soundEnabled === 'boolean') {
        setSoundLocal(message.soundEnabled); pendingSound.current = null; setSoundPending(false)
      }
      const pending = pendingImport.current
      if (pending && message?.type === 'layoutLoaded' && JSON.stringify(message.layout) === pending.layout) pending.loaded = true
      if (['officeBrowserActionState', 'officeAgentActionState'].includes(message?.type)) {
        const sound = pendingSound.current
        if (sound && message.requestId === sound.requestId && ['failed', 'cancelled'].includes(message.state)) {
          setSoundEnabled(sound.previous); setSoundLocal(sound.previous)
          pendingSound.current = null; setSoundPending(false); setFeedback(message.error || 'The sound preference was not saved.')
        }
        if (pending && message.requestId === pending.requestId) {
          if (message.state === 'completed') pending.completed = true
          if (['failed', 'cancelled'].includes(message.state)) {
            pendingImport.current = null; setImporting(false); setFeedback(message.error || 'The layout import was not applied.')
          }
        }
      }
      if (pending && pending.loaded && pending.completed && pendingImport.current === pending) {
        pendingImport.current = null; setImporting(false); setFeedback('Layout imported by the Office host.')
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])

  const importFile = async (file?: File) => {
    if (!file) return
    try {
      if (file.size > 1024 * 1024) throw new Error('Choose a layout JSON file smaller than 1 MiB.')
      const layout = JSON.parse(await file.text()) as OfficeLayout
      if (!layout || layout.version !== 1 || !Number.isInteger(layout.cols) || !Number.isInteger(layout.rows) || layout.cols < 1 || layout.rows < 1 || layout.cols > 120 || layout.rows > 120 || !Array.isArray(layout.tiles) || layout.tiles.length !== layout.cols * layout.rows || !Array.isArray(layout.furniture) || layout.furniture.length > 2000) throw new Error('Choose a valid bounded Office layout JSON file.')
      const requestId = `settings-layout-${crypto.randomUUID()}`
      const message = { type: 'saveLayout', requestId, layout }
      if (new TextEncoder().encode(JSON.stringify(message)).byteLength > 512 * 1024) throw new Error('This layout exceeds the Office host’s 512 KiB request limit.')
      pendingImport.current = { requestId, layout: JSON.stringify(layout), loaded: false, completed: false }
      setImporting(true); setFeedback('Waiting for the Office host to validate and apply the layout…')
      vscode.postMessage(message)
    } catch (error) { setFeedback(error instanceof SyntaxError ? 'Choose a valid layout JSON file.' : error instanceof Error ? error.message : 'The layout file could not be read.') }
  }

  const exportLayout = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(getLayout(), null, 2) + '\n'], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'the-office-layout.json'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setFeedback('Layout downloaded.')
  }

  if (!isOpen) return null

  return (
    <>
      {/* Dark backdrop — click to close */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0, 0, 0, 0.5)',
          zIndex: 49,
        }}
      />
      {/* Centered modal */}
      <div
        role="dialog"
        aria-label="Office settings"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 50,
          background: 'var(--pixel-bg)',
          border: '2px solid var(--pixel-border)',
          borderRadius: 0,
          padding: '4px',
          boxShadow: 'var(--pixel-shadow)',
          minWidth: 200,
          fontFamily: 'var(--vscode-font-family)',
          fontSize: 'var(--vscode-font-size)',
          fontWeight: 'var(--vscode-font-weight)',
        }}
      >
        {/* Header with title and X button */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 10px',
            borderBottom: '1px solid var(--pixel-border)',
            marginBottom: '4px',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--vscode-font-family)',
              fontSize: 'var(--vscode-font-size)',
              fontWeight: 'var(--vscode-font-weight)',
              color: 'rgba(255, 255, 255, 0.9)',
            }}
          >
            Settings
          </span>
          <button
            aria-label="Close Office settings"
            onClick={onClose}
            onMouseEnter={() => setHovered('close')}
            onMouseLeave={() => setHovered(null)}
            style={{
              background: hovered === 'close' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
              border: 'none',
              borderRadius: 0,
              color: 'rgba(255, 255, 255, 0.6)',
              fontFamily: 'var(--vscode-font-family)',
              fontSize: 'var(--vscode-font-size)',
              fontWeight: 'var(--vscode-font-weight)',
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            X
          </button>
        </div>
        {/* Menu items */}
        {!isBrowserOffice && !sharedHost && <button
          onClick={() => {
            vscode.postMessage({ type: 'openSessionsFolder' })
            onClose()
          }}
          onMouseEnter={() => setHovered('sessions')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'sessions' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          Open Sessions Folder
        </button>}
        <button
          onClick={() => {
            if (localLayoutIo) exportLayout()
            else { vscode.postMessage({ type: 'exportLayout' }); onClose() }
          }}
          onMouseEnter={() => setHovered('export')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'export' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          Export Layout
        </button>
        {(!isBrowserOffice || sharedHost) && <button
          disabled={importing || (sharedHost && !connected)}
          onClick={() => {
            if (localLayoutIo) { setFeedback(''); fileInput.current?.click() }
            else { vscode.postMessage({ type: 'importLayout' }); onClose() }
          }}
          onMouseEnter={() => setHovered('import')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'import' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          {importing ? 'Importing Layout…' : 'Import Layout'}
        </button>}
        <input ref={fileInput} type="file" accept="application/json,.json" aria-label="Import Office layout JSON" style={{ display: 'none' }} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void importFile(file) }} />
        <button
          disabled={soundPending || (sharedHost && !connected)}
          onClick={() => {
            const newVal = !isSoundEnabled()
            setSoundEnabled(newVal)
            setSoundLocal(newVal)
            const requestId = `settings-sound-${crypto.randomUUID()}`
            if (sharedHost) { pendingSound.current = { requestId, previous: !newVal }; setSoundPending(true) }
            if (!isBrowserOffice || sharedHost) vscode.postMessage({ type: 'setSoundEnabled', requestId, enabled: newVal })
          }}
          onMouseEnter={() => setHovered('sound')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'sound' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          <span style={{ fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size)', fontWeight: 'var(--vscode-font-weight)' }}>{isBrowserOffice && !sharedHost ? 'Sound Notifications (this browser)' : 'Sound Notifications'}</span>
          <span
            style={{
              width: 16,
              height: 16,
              border: '2px solid rgba(255, 255, 255, 0.5)',
              borderRadius: 0,
              background: soundLocal ? 'rgba(90, 140, 255, 0.8)' : 'transparent',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--vscode-font-family)',
              fontSize: '12px',
              fontWeight: 'var(--vscode-font-weight)',
              lineHeight: '12px',
              color: '#fff',
              textAlign: 'center',
              padding: 0,
            }}
          >
            <span
              style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transform: 'translateY(-0.5px)',
              }}
            >
              {soundLocal ? '✓' : ''}
            </span>
          </span>
        </button>
        {feedback && <p role="status" style={{ maxWidth: 320, padding: '6px 10px', color: 'var(--pixel-text)', fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>{feedback}</p>}
        <button
          onClick={onToggleDebugMode}
          onMouseEnter={() => setHovered('debug')}
          onMouseLeave={() => setHovered(null)}
          style={{
            ...menuItemBase,
            background: hovered === 'debug' ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
          }}
        >
          <span style={{ fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size)', fontWeight: 'var(--vscode-font-weight)' }}>Debug View</span>
          {isDebugMode && (
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'rgba(90, 140, 255, 0.8)',
                flexShrink: 0,
              }}
            />
          )}
        </button>
      </div>
    </>
  )
}
