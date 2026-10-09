import { useState, useSyncExternalStore } from 'react'
import { SettingsModal } from './SettingsModal.js'
import type { WorkspaceFolder } from '../hooks/useExtensionMessages.js'
import { isBrowserOffice, officeConnection, vscode } from '../vscodeApi.js'

interface BottomToolbarProps {
  isEditMode: boolean
  onOpenAgentSession: () => void
  workspaceFolders: WorkspaceFolder[]
  onToggleEditMode: () => void
  isDebugMode: boolean
  onToggleDebugMode: () => void
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 10,
  left: 10,
  zIndex: 'var(--pixel-controls-z)',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  borderRadius: 0,
  padding: '4px 6px',
  boxShadow: 'var(--pixel-shadow)',
}

const btnBase: React.CSSProperties = {
  padding: '5px 10px',
  fontFamily: 'var(--vscode-font-family)',
  fontSize: 'var(--vscode-font-size)',
  fontWeight: 'var(--vscode-font-weight)',
  lineHeight: 1.4,
  color: 'var(--pixel-text)',
  background: 'var(--pixel-btn-bg)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
}

const btnActive: React.CSSProperties = {
  ...btnBase,
  background: 'var(--pixel-active-bg)',
  border: '2px solid var(--pixel-accent)',
}


export function BottomToolbar({
  isEditMode,
  onOpenAgentSession,
  workspaceFolders,
  onToggleEditMode,
  isDebugMode,
  onToggleDebugMode,
}: BottomToolbarProps) {
  const { connected } = useSyncExternalStore(officeConnection.subscribe, officeConnection.getSnapshot)
  const [hovered, setHovered] = useState<string | null>(null)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false)

  const handleOpenClick = () => {
    if (workspaceFolders.length > 1) {
      setIsFolderPickerOpen((prev) => !prev)
      return
    }
    onOpenAgentSession()
  }

  const handleSelectFolder = (folderPath: string) => {
    vscode.postMessage({ type: 'openAgentSession', folderPath })
    setIsFolderPickerOpen(false)
  }

  return (
    <div style={panelStyle}>
      <div style={{ position: 'relative' }}>
        <button
        disabled={isBrowserOffice && !connected}
        title={isBrowserOffice ? 'Complete agent setup in VS Code' : undefined}
        onClick={handleOpenClick}
        onMouseEnter={() => setHovered('agent')}
        onMouseLeave={() => setHovered(null)}
        style={{
          ...btnBase,
          padding: '5px 12px',
          background:
            hovered === 'agent'
              ? 'var(--pixel-agent-hover-bg)'
              : 'var(--pixel-agent-bg)',
          border: '2px solid var(--pixel-agent-border)',
          color: 'var(--pixel-agent-text)',
        }}
      >
        + Agent
      </button>
        {isFolderPickerOpen && workspaceFolders.length > 1 && (
          <div
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 4px)',
              left: 0,
              minWidth: 220,
              background: 'var(--pixel-bg)',
              border: '2px solid var(--pixel-border)',
              boxShadow: 'var(--pixel-shadow)',
              zIndex: 'var(--pixel-controls-z)',
              display: 'flex',
              flexDirection: 'column',
              padding: 4,
              gap: 4,
            }}
          >
            {workspaceFolders.map((folder) => (
              <button
                key={folder.path}
                onClick={() => handleSelectFolder(folder.path)}
                style={{ ...btnBase, textAlign: 'left' }}
                title={folder.path}
              >
                {folder.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {!isBrowserOffice && <button
        onClick={onToggleEditMode}
        onMouseEnter={() => setHovered('edit')}
        onMouseLeave={() => setHovered(null)}
        style={
          isEditMode
            ? { ...btnActive }
            : {
                ...btnBase,
                background: hovered === 'edit' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
              }
        }
        title="Edit office layout"
      >
        Layout
      </button>}
      {!isBrowserOffice && <div style={{ position: 'relative' }}>
        <button
          onClick={() => setIsSettingsOpen((v) => !v)}
          onMouseEnter={() => setHovered('settings')}
          onMouseLeave={() => setHovered(null)}
          style={
            isSettingsOpen
              ? { ...btnActive }
              : {
                  ...btnBase,
                  background: hovered === 'settings' ? 'var(--pixel-btn-hover-bg)' : btnBase.background,
                }
          }
          title="Settings"
        >
          Settings
        </button>
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          isDebugMode={isDebugMode}
          onToggleDebugMode={onToggleDebugMode}
        />
      </div>}
    </div>
  )
}
