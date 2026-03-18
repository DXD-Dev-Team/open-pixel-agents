import { useState, useEffect, useRef } from 'react'
import {
  ZOOM_LEVEL_FADE_DELAY_MS,
  ZOOM_LEVEL_HIDE_DELAY_MS,
  ZOOM_LEVEL_FADE_DURATION_SEC,
} from '../constants.js'

interface ZoomControlsProps {
  zoom: number
}

export function ZoomControls({ zoom }: ZoomControlsProps) {
  const [showLevel, setShowLevel] = useState(false)
  const [fadeOut, setFadeOut] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevZoomRef = useRef(zoom)

  // Show zoom level briefly when zoom changes
  useEffect(() => {
    if (zoom === prevZoomRef.current) return
    prevZoomRef.current = zoom

    // Clear existing timers
    if (timerRef.current) clearTimeout(timerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)

    setShowLevel(true)
    setFadeOut(false)

    // Start fade after delay
    fadeTimerRef.current = setTimeout(() => {
      setFadeOut(true)
    }, ZOOM_LEVEL_FADE_DELAY_MS)

    // Hide completely after delay
    timerRef.current = setTimeout(() => {
      setShowLevel(false)
      setFadeOut(false)
    }, ZOOM_LEVEL_HIDE_DELAY_MS)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    }
  }, [zoom])

  return (
    <>
      {/* Zoom level indicator at top-center */}
      {showLevel && (
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 'var(--pixel-controls-z)',
            background: 'var(--pixel-bg)',
            border: '2px solid var(--pixel-border)',
            borderRadius: 0,
            padding: '4px 12px',
            boxShadow: 'var(--pixel-shadow)',
            fontFamily: 'var(--vscode-font-family)',
            fontSize: 'var(--vscode-font-size)',
            fontWeight: 'var(--vscode-font-weight)',
            color: 'var(--pixel-text)',
            userSelect: 'none',
            opacity: fadeOut ? 0 : 1,
            transition: `opacity ${ZOOM_LEVEL_FADE_DURATION_SEC}s ease-out`,
            pointerEvents: 'none',
          }}
        >
          {zoom}x
        </div>
      )}
    </>
  )
}
