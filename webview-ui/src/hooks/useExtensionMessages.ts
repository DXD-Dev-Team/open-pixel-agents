import { useState, useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfficeLayout, ToolActivity } from '../office/types.js'
import { extractToolName } from '../office/toolUtils.js'
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js'
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../office/floorTiles.js'
import { setWallSprites } from '../office/wallTiles.js'
import { setCharacterTemplates } from '../office/sprites/spriteData.js'
import { vscode } from '../vscodeApi.js'
import { playDoneSound, setSoundEnabled } from '../notificationSound.js'

export interface SubagentCharacter {
  id: number
  parentAgentId: number
  parentToolId: string
  sessionId?: string
  label: string
  status?: 'active' | 'waiting' | 'retry' | 'completing'
  completionHint?: string
}

interface RuntimeToolVm {
  id: string
  name: string
  label: string
  state: 'pending' | 'running'
}

interface RuntimeSubagentVm {
  id: string
  sessionId: string
  label: string
  status: 'active' | 'waiting' | 'retry' | 'completing'
  permissionAsked: boolean
  tools: RuntimeToolVm[]
  completionHint?: string
}

interface RuntimeAgentVm {
  agentId: number
  sessionId: string
  status: 'active' | 'waiting' | 'retry'
  permissionAsked: boolean
  tools: RuntimeToolVm[]
  subagents: RuntimeSubagentVm[]
}

export interface FurnitureAsset {
  id: string
  name: string
  label: string
  category: string
  file: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  isDesk: boolean
  canPlaceOnWalls: boolean
  partOfGroup?: boolean
  groupId?: string
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
}

export interface ExtensionMessageState {
  agents: number[]
  selectedAgent: number | null
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  workspaceFolders: WorkspaceFolder[]
  layoutReady: boolean
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> }
}

export interface WorkspaceFolder {
  name: string
  path: string
}

function syncRuntimeAgent(
  os: OfficeState,
  vm: RuntimeAgentVm,
  setAgentTools: Dispatch<SetStateAction<Record<number, ToolActivity[]>>>,
  setAgentStatuses: Dispatch<SetStateAction<Record<number, string>>>,
  setSubagentTools: Dispatch<SetStateAction<Record<number, Record<string, ToolActivity[]>>>>,
  setSubagentCharacters: Dispatch<SetStateAction<SubagentCharacter[]>>,
): void {
  const agentId = vm.agentId
  const agentToolList: ToolActivity[] = vm.tools.map((tool) => ({
    toolId: tool.id,
    status: tool.label,
    done: false,
    permissionWait: vm.permissionAsked,
  }))
  setAgentTools((prev) => ({ ...prev, [agentId]: agentToolList }))
  setAgentStatuses((prev) => ({ ...prev, [agentId]: vm.status }))

  os.setAgentActive(agentId, vm.status !== 'waiting')
  os.setAgentTool(agentId, vm.tools[0] ? vm.tools[0].name : null)
  if (vm.permissionAsked) {
    os.showPermissionBubble(agentId)
  } else {
    os.clearPermissionBubble(agentId)
    if (vm.status === 'waiting') {
      os.showWaitingBubble(agentId)
    }
  }

  const incomingBySessionId = new Map(vm.subagents.filter((sub) => sub.sessionId).map((sub) => [sub.sessionId, sub]))
  for (const [subId, meta] of os.subagentMeta) {
    if (meta.parentAgentId !== agentId) continue
    const existingChar = os.characters.get(subId)
    if (existingChar?.isSubagent && meta.sessionId) {
      const incoming = incomingBySessionId.get(meta.sessionId)
      if (incoming && incoming.id !== meta.parentToolId) {
        os.rekeySubagent(agentId, meta.parentToolId, incoming.id, meta.sessionId)
      }
    }
  }

  const currentSubs = new Set(vm.subagents.map((sub) => sub.id))
  for (const [, meta] of os.subagentMeta) {
    if (meta.parentAgentId !== agentId) continue
    if (!currentSubs.has(meta.parentToolId)) {
      os.removeSubagent(agentId, meta.parentToolId)
    }
  }

  const nextSubagentTools: Record<string, ToolActivity[]> = {}
  const nextCharacters: SubagentCharacter[] = []
  for (const sub of vm.subagents) {
    const subKey = sub.id
    const subId = os.addSubagent(agentId, subKey)
    os.setSubagentSessionId(subId, sub.sessionId || undefined)
    nextCharacters.push({ id: subId, parentAgentId: agentId, parentToolId: subKey, sessionId: sub.sessionId || undefined, label: sub.label, status: sub.status, completionHint: sub.completionHint })
    nextSubagentTools[subKey] = sub.tools.map((tool) => ({
      toolId: tool.id,
      status: tool.label,
      done: false,
      permissionWait: sub.permissionAsked,
    }))
    os.setAgentTool(subId, sub.tools[0] ? sub.tools[0].name : null)
    os.setAgentActive(subId, sub.status === 'active' || sub.status === 'retry')
    if (sub.permissionAsked) {
      os.showPermissionBubble(subId)
    } else {
      os.clearPermissionBubble(subId)
      if (sub.status === 'completing') {
        os.showDoneBubble(subId)
      } else if (sub.status === 'waiting') {
        os.showWaitingBubble(subId)
      }
    }
  }

  setSubagentTools((prev) => ({ ...prev, [agentId]: nextSubagentTools }))
  setSubagentCharacters((prev) => {
    const keep = prev.filter((item) => item.parentAgentId !== agentId)
    return [...keep, ...nextCharacters]
  })
}

function saveAgentSeats(os: OfficeState): void {
  const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {}
  for (const ch of os.characters.values()) {
    if (ch.isSubagent) continue
    seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId }
  }
  vscode.postMessage({ type: 'saveAgentSeats', seats })
}

export function useExtensionMessages(
  getOfficeState: () => OfficeState,
  onLayoutLoaded?: (layout: OfficeLayout) => void,
  isEditDirty?: () => boolean,
): ExtensionMessageState {
  const [agents, setAgents] = useState<number[]>([])
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null)
  const [agentTools, setAgentTools] = useState<Record<number, ToolActivity[]>>({})
  const [agentStatuses, setAgentStatuses] = useState<Record<number, string>>({})
  const [subagentTools, setSubagentTools] = useState<Record<number, Record<string, ToolActivity[]>>>({})
  const [subagentCharacters, setSubagentCharacters] = useState<SubagentCharacter[]>([])
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([])
  const [layoutReady, setLayoutReady] = useState(false)
  const [loadedAssets, setLoadedAssets] = useState<{ catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined>()

  // Track whether initial layout has been loaded (ref to avoid re-render)
  const layoutReadyRef = useRef(false)
  const runtimeV2Ref = useRef(false)

  useEffect(() => {
    // Buffer agents from existingAgents until layout is loaded
    let pendingAgents: Array<{ id: number; palette?: number; hueShift?: number; seatId?: string }> = []
    let pendingRuntime: RuntimeAgentVm[] | null = null

    const handler = (e: MessageEvent) => {
      const msg = e.data
      const os = getOfficeState()

      if (msg.type === 'layoutLoaded') {
        // Skip external layout updates while editor has unsaved changes
        if (layoutReadyRef.current && isEditDirty?.()) {
          console.log('[Webview] Skipping external layout update — editor has unsaved changes')
          return
        }
        const rawLayout = msg.layout as OfficeLayout | null
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null
        if (layout) {
          os.rebuildFromLayout(layout)
          onLayoutLoaded?.(layout)
        } else {
          // Default layout — snapshot whatever OfficeState built
          onLayoutLoaded?.(os.getLayout())
        }
        // Add buffered agents now that layout (and seats) are correct
        for (const p of pendingAgents) {
          os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true)
        }
        pendingAgents = []
        layoutReadyRef.current = true
        setLayoutReady(true)
        if (os.characters.size > 0) {
          saveAgentSeats(os)
        }
        if (pendingRuntime) {
          for (const agent of pendingRuntime) {
            syncRuntimeAgent(os, agent, setAgentTools, setAgentStatuses, setSubagentTools, setSubagentCharacters)
          }
          pendingRuntime = null
        }
      } else if (msg.type === 'agentCreated') {
        const id = msg.id as number
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]))
        setSelectedAgent(id)
        os.addAgent(id)
        saveAgentSeats(os)
      } else if (msg.type === 'agentClosed') {
        const id = msg.id as number
        setAgents((prev) => prev.filter((a) => a !== id))
        setSelectedAgent((prev) => (prev === id ? null : prev))
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.removeAgent(id)
      } else if (msg.type === 'existingAgents') {
        const incoming = msg.agents as number[]
        const meta = (msg.agentMeta || {}) as Record<number, { palette?: number; hueShift?: number; seatId?: string }>
        // Buffer agents — they'll be added in layoutLoaded after seats are built
        for (const id of incoming) {
          const m = meta[id]
          pendingAgents.push({ id, palette: m?.palette, hueShift: m?.hueShift, seatId: m?.seatId })
        }
        setAgents((prev) => {
          const ids = new Set(prev)
          const merged = [...prev]
          for (const id of incoming) {
            if (!ids.has(id)) {
              merged.push(id)
            }
          }
          return merged.sort((a, b) => a - b)
        })
      } else if (msg.type === 'workspaceFolders') {
        setWorkspaceFolders((msg.folders as WorkspaceFolder[]) || [])
      } else if (msg.type === 'runtimeSnapshot') {
        runtimeV2Ref.current = true
        const incoming = (msg.agents as RuntimeAgentVm[]) || []
        if (!layoutReadyRef.current) {
          pendingRuntime = incoming
          return
        }
        for (const agent of incoming) {
          syncRuntimeAgent(os, agent, setAgentTools, setAgentStatuses, setSubagentTools, setSubagentCharacters)
        }
      } else if (msg.type === 'agentRuntimeReplace') {
        runtimeV2Ref.current = true
        const agent = msg.agent as RuntimeAgentVm
        if (!layoutReadyRef.current) {
          pendingRuntime = pendingRuntime || []
          pendingRuntime = [...pendingRuntime.filter((item) => item.agentId !== agent.agentId), agent]
          return
        }
        syncRuntimeAgent(os, agent, setAgentTools, setAgentStatuses, setSubagentTools, setSubagentCharacters)
      } else if (msg.type === 'agentToolStart') {
        if (runtimeV2Ref.current) return
        const id = msg.id as number
        const toolId = msg.toolId as string
        const status = msg.status as string
        setAgentTools((prev) => {
          const list = prev[id] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: [...list, { toolId, status, done: false }] }
        })
        const toolName = extractToolName(status)
        os.setAgentTool(id, toolName)
        os.setAgentActive(id, true)
        os.clearPermissionBubble(id)
        // Create sub-agent character for Task tool subtasks
        if (status.startsWith('Subtask:')) {
          const label = status.slice('Subtask:'.length).trim()
          const subId = os.addSubagent(id, toolId)
          setSubagentCharacters((prev) => {
            if (prev.some((s) => s.id === subId)) return prev
            return [...prev, { id: subId, parentAgentId: id, parentToolId: toolId, label, status: 'active' }]
          })
        }
      } else if (msg.type === 'agentToolDone') {
        if (runtimeV2Ref.current) return
        const id = msg.id as number
        const toolId = msg.toolId as string
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)),
          }
        })
      } else if (msg.type === 'agentToolsClear') {
        if (runtimeV2Ref.current) return
        const id = msg.id as number
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.setAgentTool(id, null)
        os.clearPermissionBubble(id)
      } else if (msg.type === 'agentSelected') {
        const id = msg.id as number
        setSelectedAgent(id)
      } else if (msg.type === 'agentStatus') {
        if (runtimeV2Ref.current) return
        const id = msg.id as number
        const status = msg.status as string
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          }
          return { ...prev, [id]: status }
        })
        os.setAgentActive(id, status === 'active')
        if (status === 'waiting') {
          os.showWaitingBubble(id)
          playDoneSound()
        }
      } else if (msg.type === 'agentToolPermission') {
        if (runtimeV2Ref.current) return
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })),
          }
        })
        os.showPermissionBubble(id)
      } else if (msg.type === 'subagentToolPermission') {
        if (runtimeV2Ref.current) return
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        // Show permission bubble on the sub-agent character
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          os.showPermissionBubble(subId)
        }
      } else if (msg.type === 'agentToolPermissionClear') {
        if (runtimeV2Ref.current) return
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          const hasPermission = list.some((t) => t.permissionWait)
          if (!hasPermission) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
          }
        })
        os.clearPermissionBubble(id)
        // Also clear permission bubbles on all sub-agent characters of this parent
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) {
            os.clearPermissionBubble(subId)
          }
        }
      } else if (msg.type === 'subagentToolStart') {
        if (runtimeV2Ref.current) return
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        const status = msg.status as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id] || {}
          const list = agentSubs[parentToolId] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] } }
        })
        // Update sub-agent character's tool and active state
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          const subToolName = extractToolName(status)
          os.setAgentTool(subId, subToolName)
          os.setAgentActive(subId, true)
        }
      } else if (msg.type === 'subagentToolDone') {
        if (runtimeV2Ref.current) return
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs) return prev
          const list = agentSubs[parentToolId]
          if (!list) return prev
          return {
            ...prev,
            [id]: { ...agentSubs, [parentToolId]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)) },
          }
        })
      } else if (msg.type === 'subagentClear') {
        if (runtimeV2Ref.current) return
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs || !(parentToolId in agentSubs)) return prev
          const next = { ...agentSubs }
          delete next[parentToolId]
          if (Object.keys(next).length === 0) {
            const outer = { ...prev }
            delete outer[id]
            return outer
          }
          return { ...prev, [id]: next }
        })
        // Remove sub-agent character
        os.removeSubagent(id, parentToolId)
        setSubagentCharacters((prev) => prev.filter((s) => !(s.parentAgentId === id && s.parentToolId === parentToolId)))
      } else if (msg.type === 'characterSpritesLoaded') {
        const characters = msg.characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>
        console.log(`[Webview] Received ${characters.length} pre-colored character sprites`)
        setCharacterTemplates(characters)
      } else if (msg.type === 'floorTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} floor tile patterns`)
        setFloorSprites(sprites)
      } else if (msg.type === 'wallTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} wall tile sprites`)
        setWallSprites(sprites)
      } else if (msg.type === 'settingsLoaded') {
        const soundOn = msg.soundEnabled as boolean
        setSoundEnabled(soundOn)
      } else if (msg.type === 'furnitureAssetsLoaded') {
        try {
          const catalog = msg.catalog as FurnitureAsset[]
          const sprites = msg.sprites as Record<string, string[][]>
          console.log(`📦 Webview: Loaded ${catalog.length} furniture assets`)
          // Build dynamic catalog immediately so getCatalogEntry() works when layoutLoaded arrives next
          buildDynamicCatalog({ catalog, sprites })
          setLoadedAssets({ catalog, sprites })
        } catch (err) {
          console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err)
        }
      }
    }
    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'webviewReady' })
    return () => window.removeEventListener('message', handler)
  }, [getOfficeState])

  return { agents, selectedAgent, agentTools, agentStatuses, subagentTools, subagentCharacters, workspaceFolders, layoutReady, loadedAssets }
}
