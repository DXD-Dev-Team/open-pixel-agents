import { useState, useEffect } from 'react'
import type { ToolActivity } from '../types.js'
import type { OfficeState } from '../engine/officeState.js'
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js'
import { TILE_SIZE } from '../types.js'

interface ToolOverlayProps {
  officeState: OfficeState
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  subagentCharacters: SubagentCharacter[]
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  onCloseAgent: (id: number) => void
}

/** The persistent canvas bubble owns all status text. Keep only the close control. */
export function ToolOverlay({ officeState, agents, containerRef, zoom, panRef, onCloseAgent }: ToolOverlayProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const el = containerRef.current
  const selectedId = officeState.selectedAgentId
  if (!el || selectedId === null || !agents.includes(selectedId)) return null
  const ch = officeState.characters.get(selectedId)
  if (!ch || ch.isSubagent) return null
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const layout = officeState.getLayout()
  const offsetX = Math.floor((rect.width * dpr - layout.cols * TILE_SIZE * zoom) / 2) + Math.round(panRef.current.x)
  const offsetY = Math.floor((rect.height * dpr - layout.rows * TILE_SIZE * zoom) / 2) + Math.round(panRef.current.y)
  return (
    <button
      title={`Close ${ch.officeLabel.name}`}
      aria-label={`Close ${ch.officeLabel.name}`}
      onClick={(event) => { event.stopPropagation(); onCloseAgent(selectedId) }}
      style={{ position: 'absolute', left: (offsetX + (ch.x + 10) * zoom) / dpr, top: (offsetY + (ch.y - 8) * zoom) / dpr,
        background: 'var(--pixel-bg)', border: '1px solid var(--pixel-border)', color: 'var(--pixel-close-text)',
        cursor: 'pointer', padding: '0 4px', fontSize: 16, lineHeight: 1.2, zIndex: 'var(--pixel-overlay-selected-z)' }}
    >×</button>
  )
}
