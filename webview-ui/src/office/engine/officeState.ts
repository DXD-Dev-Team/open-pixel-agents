import { TILE_SIZE, MATRIX_EFFECT_DURATION, CharacterState, Direction } from '../types.js'
import {
  PALETTE_COUNT,
  HUE_SHIFT_MIN_DEG,
  HUE_SHIFT_RANGE_DEG,
  WAITING_BUBBLE_DURATION_SEC,
  DONE_BUBBLE_DURATION_SEC,
  DISMISS_BUBBLE_FAST_FADE_SEC,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  AUTO_ON_FACING_DEPTH,
  AUTO_ON_SIDE_DEPTH,
  CHARACTER_SITTING_OFFSET_PX,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
} from '../../constants.js'
import type { Character, Seat, FurnitureInstance, TileType as TileTypeVal, OfficeLayout, PlacedFurniture, OfficeLabel } from '../types.js'
import { createCharacter, updateCharacter } from './characters.js'
import { matrixEffectSeeds } from './matrixEffect.js'
import { isWalkable, getWalkableTiles, findPath } from '../layout/tileMap.js'
import {
  createDefaultLayout,
  layoutToTileMap,
  layoutToFurnitureInstances,
  layoutToSeats,
  getBlockedTiles,
} from '../layout/layoutSerializer.js'
import { getCatalogEntry, getOnStateType } from '../layout/furnitureCatalog.js'

export class OfficeState {
  layout: OfficeLayout
  tileMap: TileTypeVal[][]
  seats: Map<string, Seat>
  blockedTiles: Set<string>
  furniture: FurnitureInstance[]
  walkableTiles: Array<{ col: number; row: number }>
  characters: Map<number, Character> = new Map()
  selectedAgentId: number | null = null
  cameraFollowId: number | null = null
  hoveredAgentId: number | null = null
  hoveredTile: { col: number; row: number } | null = null
  /** Maps "parentId:toolId" → sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map()
  /** Reverse lookup: sub-agent character ID → parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string; sessionId?: string }> = new Map()
  private nextSubagentId = -1
  private readonly deskReservations = new Map<number, string>()

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout()
    this.tileMap = layoutToTileMap(this.layout)
    this.seats = layoutToSeats(this.layout.furniture)
    this.blockedTiles = getBlockedTiles(this.layout.furniture)
    this.furniture = layoutToFurnitureInstances(this.layout.furniture)
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles)
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up */
  rebuildFromLayout(layout: OfficeLayout, shift?: { col: number; row: number }): void {
    this.layout = layout
    this.tileMap = layoutToTileMap(layout)
    this.seats = layoutToSeats(layout.furniture)
    this.blockedTiles = getBlockedTiles(layout.furniture)
    this.rebuildFurnitureInstances()
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles)

    // Shift character positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of this.characters.values()) {
        ch.tileCol += shift.col
        ch.tileRow += shift.row
        ch.x += shift.col * TILE_SIZE
        ch.y += shift.row * TILE_SIZE
        // Clear path since tile coords changed
        ch.path = []
        ch.moveProgress = 0
      }
    }

    // Reassign characters to new seats, preserving existing assignments when possible
    for (const seat of this.seats.values()) {
      seat.assigned = false
    }

    // First pass: try to keep characters at their existing seats
    for (const ch of this.characters.values()) {
      if (ch.seatId && this.seats.has(ch.seatId) && (!ch.officeLabel.managed || this.seats.get(ch.seatId)?.computerDeskId)) {
        const seat = this.seats.get(ch.seatId)!
        if (!seat.assigned) {
          seat.assigned = true
          // Snap character to seat position
          ch.tileCol = seat.seatCol
          ch.tileRow = seat.seatRow
          const cx = seat.seatCol * TILE_SIZE + TILE_SIZE / 2
          const cy = seat.seatRow * TILE_SIZE + TILE_SIZE / 2
          ch.x = cx
          ch.y = cy
          ch.dir = seat.facingDir
          continue
        }
      }
      ch.seatId = null // will be reassigned below
    }

    // Second pass: assign remaining characters to free seats
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue
      const seatId = this.findFreeSeat(ch.officeLabel.managed)
      if (seatId) {
        this.seats.get(seatId)!.assigned = true
        ch.seatId = seatId
        const seat = this.seats.get(seatId)!
        ch.tileCol = seat.seatCol
        ch.tileRow = seat.seatRow
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2
        ch.dir = seat.facingDir
      }
    }

    // Relocate any characters that ended up outside bounds or on non-walkable tiles
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue // seated characters are fine
      if (ch.tileCol < 0 || ch.tileCol >= layout.cols || ch.tileRow < 0 || ch.tileRow >= layout.rows) {
        this.relocateCharacterToWalkable(ch)
      }
    }
  }

  /** Move a character to a random walkable tile */
  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) return
    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
    ch.tileCol = spawn.col
    ch.tileRow = spawn.row
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2
    ch.path = []
    ch.moveProgress = 0
  }

  getLayout(): OfficeLayout {
    return this.layout
  }

  /** Get the blocked-tile key for a character's own seat, or null */
  private ownSeatKey(ch: Character): string | null {
    if (!ch.seatId) return null
    const seat = this.seats.get(ch.seatId)
    if (!seat) return null
    return `${seat.seatCol},${seat.seatRow}`
  }

  /** Temporarily unblock a character's own seat, run fn, then re-block */
  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    const key = this.ownSeatKey(ch)
    if (key) this.blockedTiles.delete(key)
    const result = fn()
    if (key) this.blockedTiles.add(key)
    return result
  }

  availableComputerDesks(): number {
    const occupied = new Set([...this.seats.values()].filter(seat => seat.assigned && seat.computerDeskId).map(seat => seat.computerDeskId))
    return new Set([...this.seats.values()].filter(seat => !seat.assigned && seat.computerDeskId && !occupied.has(seat.computerDeskId)).map(seat => seat.computerDeskId)).size
  }

  reserveComputerDesk(requestId: number): string | null {
    const seatId = this.findFreeSeat(true)
    if (seatId) {
      this.seats.get(seatId)!.assigned = true
      this.deskReservations.set(requestId, seatId)
    }
    return seatId
  }

  releaseComputerDesk(requestId: number): void {
    const seatId = this.deskReservations.get(requestId)
    if (seatId) {
      const seat = this.seats.get(seatId)
      if (seat) seat.assigned = false
      this.deskReservations.delete(requestId)
    }
  }

  private findFreeSeat(computerOnly = false): string | null {
    const freeWorkSeats: string[] = []
    const freeOtherSeats: string[] = []
    const occupied = new Set([...this.seats.values()].filter(seat => seat.assigned && seat.computerDeskId).map(seat => seat.computerDeskId))
    for (const [uid, seat] of this.seats) {
      if (seat.assigned) continue
      if (computerOnly && (!seat.computerDeskId || occupied.has(seat.computerDeskId))) continue
      if (seat.isWorkSeat) freeWorkSeats.push(uid)
      else freeOtherSeats.push(uid)
    }
    const pool = freeWorkSeats.length > 0 ? freeWorkSeats : freeOtherSeats
    if (pool.length === 0) return null
    return pool[Math.floor(Math.random() * pool.length)]
  }

  private getEntranceTile(): { col: number; row: number } {
    if (this.walkableTiles.length === 0) {
      return { col: 1, row: 1 }
    }
    const layout = this.getLayout()
    const targetCol = Math.floor(layout.cols / 2)
    const targetRow = layout.rows - 1
    const edgeTiles = this.walkableTiles.filter((tile) =>
      tile.row === targetRow || tile.col === 0 || tile.col === layout.cols - 1 || tile.row === 0,
    )
    const candidates = edgeTiles.length > 0 ? edgeTiles : this.walkableTiles
    let best = candidates[0]
    let bestScore = Number.POSITIVE_INFINITY
    for (const tile of candidates) {
      const bottomPenalty = tile.row === targetRow ? 0 : 4
      const score = Math.abs(tile.col - targetCol) + Math.abs(tile.row - targetRow) + bottomPenalty
      if (score < bestScore) {
        best = tile
        bestScore = score
      }
    }
    return best
  }

  private placeCharacterAtTile(ch: Character, col: number, row: number): void {
    ch.tileCol = col
    ch.tileRow = row
    ch.x = col * TILE_SIZE + TILE_SIZE / 2
    ch.y = row * TILE_SIZE + TILE_SIZE / 2
    ch.path = []
    ch.moveProgress = 0
  }

  private startWalkingToTile(ch: Character, targetCol: number, targetRow: number): boolean {
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, targetCol, targetRow, this.tileMap, this.blockedTiles)
    )
    if (path.length === 0) {
      return false
    }
    ch.path = path
    ch.moveProgress = 0
    ch.state = CharacterState.WALK
    ch.frame = 0
    ch.frameTimer = 0
    if (path[0]) {
      const dc = path[0].col - ch.tileCol
      if (dc > 0) ch.dir = Direction.RIGHT
      else if (dc < 0) ch.dir = Direction.LEFT
      else if (path[0].row > ch.tileRow) ch.dir = Direction.DOWN
      else if (path[0].row < ch.tileRow) ch.dir = Direction.UP
    }
    return true
  }

  private beginExit(ch: Character): void {
    const exit = this.getEntranceTile()
    if (!this.startWalkingToTile(ch, exit.col, exit.row)) {
      ch.matrixEffect = 'despawn'
      ch.matrixEffectTimer = 0
      ch.matrixEffectSeeds = matrixEffectSeeds()
    }
    ch.exiting = true
    ch.isActive = false
  }

  /**
   * Pick a diverse palette for a new agent based on currently active agents.
   * First 6 agents each get a unique skin (random order). Beyond 6, skins
   * repeat in balanced rounds with a random hue shift (≥45°).
   */
  private pickDiversePalette(): { palette: number; hueShift: number } {
    // Count how many non-sub-agents use each base palette (0-5)
    const counts = new Array(PALETTE_COUNT).fill(0) as number[]
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue
      counts[ch.palette]++
    }
    const minCount = Math.min(...counts)
    // Available = palettes at the minimum count (least used)
    const available: number[] = []
    for (let i = 0; i < PALETTE_COUNT; i++) {
      if (counts[i] === minCount) available.push(i)
    }
    const palette = available[Math.floor(Math.random() * available.length)]
    // First round (minCount === 0): no hue shift. Subsequent rounds: random ≥45°.
    let hueShift = 0
    if (minCount > 0) {
      hueShift = HUE_SHIFT_MIN_DEG + Math.floor(Math.random() * HUE_SHIFT_RANGE_DEG)
    }
    return { palette, hueShift }
  }

  addAgent(id: number, preferredPalette?: number, preferredHueShift?: number, preferredSeatId?: string, skipSpawnEffect?: boolean, managed = false, reservationId?: number): void {
    if (this.characters.has(id)) return
    if (reservationId !== undefined) {
      preferredSeatId = this.deskReservations.get(reservationId) ?? preferredSeatId
      this.releaseComputerDesk(reservationId)
    }

    let palette: number
    let hueShift: number
    if (preferredPalette !== undefined) {
      palette = preferredPalette
      hueShift = preferredHueShift ?? 0
    } else {
      const pick = this.pickDiversePalette()
      palette = pick.palette
      hueShift = pick.hueShift
    }

    // Try preferred seat first, then any free seat
    let seatId: string | null = null
    if (preferredSeatId && this.seats.has(preferredSeatId)) {
      const seat = this.seats.get(preferredSeatId)!
      if (!seat.assigned && (!managed || !!seat.computerDeskId)) {
        seatId = preferredSeatId
      }
    }
    if (!seatId) {
      seatId = this.findFreeSeat(managed)
    }

    let ch: Character
    if (seatId) {
      const seat = this.seats.get(seatId)!
      seat.assigned = true
      ch = createCharacter(id, palette, seatId, seat, hueShift)
    } else {
      // No seats — spawn at random walkable tile
      const spawn = this.walkableTiles.length > 0
        ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
        : { col: 1, row: 1 }
      ch = createCharacter(id, palette, null, null, hueShift)
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2
      ch.tileCol = spawn.col
      ch.tileRow = spawn.row
    }

    ch.officeLabel.managed = managed
    if (!skipSpawnEffect) {
      const entrance = this.getEntranceTile()
      this.placeCharacterAtTile(ch, entrance.col, entrance.row)
      let targetCol = ch.tileCol
      let targetRow = ch.tileRow
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId)
        if (seat) {
          targetCol = seat.seatCol
          targetRow = seat.seatRow
        }
      }
      if (!this.startWalkingToTile(ch, targetCol, targetRow) && ch.seatId) {
        const seat = this.seats.get(ch.seatId)
        if (seat) {
          this.placeCharacterAtTile(ch, seat.seatCol, seat.seatRow)
        }
      }
    }
    this.characters.set(id, ch)
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id)
    if (!ch) return
    if (ch.matrixEffect === 'despawn') return // already despawning
    // Free seat and clear selection immediately
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId)
      if (seat) seat.assigned = false
    }
    if (this.selectedAgentId === id) this.selectedAgentId = null
    if (this.cameraFollowId === id) this.cameraFollowId = null
    // Start despawn animation instead of immediate delete
    ch.matrixEffect = 'despawn'
    ch.matrixEffectTimer = 0
    ch.matrixEffectSeeds = matrixEffectSeeds()
    ch.bubbleType = null
  }

  /** Find seat uid at a given tile position, or null */
  getSeatAtTile(col: number, row: number): string | null {
    for (const [uid, seat] of this.seats) {
      if (seat.seatCol === col && seat.seatRow === row) return uid
    }
    return null
  }

  /** Reassign an agent from their current seat to a new seat */
  reassignSeat(agentId: number, seatId: string): void {
    const ch = this.characters.get(agentId)
    if (!ch) return
    // Unassign old seat
    if (ch.seatId) {
      const old = this.seats.get(ch.seatId)
      if (old) old.assigned = false
    }
    // Assign new seat
    const seat = this.seats.get(seatId)
    if (!seat || seat.assigned) return
    seat.assigned = true
    ch.seatId = seatId
    // Pathfind to new seat (unblock own seat tile for this query)
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles)
    )
    if (path.length > 0) {
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
    } else {
      // Already at seat or no path — sit down
      ch.state = CharacterState.TYPE
      ch.dir = seat.facingDir
      ch.frame = 0
      ch.frameTimer = 0
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC
      }
    }
  }

  /** Send an agent back to their currently assigned seat */
  sendToSeat(agentId: number): void {
    const ch = this.characters.get(agentId)
    if (!ch || !ch.seatId) return
    const seat = this.seats.get(ch.seatId)
    if (!seat) return
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles)
    )
    if (path.length > 0) {
      ch.path = path
      ch.moveProgress = 0
      ch.state = CharacterState.WALK
      ch.frame = 0
      ch.frameTimer = 0
    } else {
      // Already at seat — sit down
      ch.state = CharacterState.TYPE
      ch.dir = seat.facingDir
      ch.frame = 0
      ch.frameTimer = 0
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC
      }
    }
  }

  /** Walk an agent to an arbitrary walkable tile (right-click command) */
  walkToTile(agentId: number, col: number, row: number): boolean {
    const ch = this.characters.get(agentId)
    if (!ch || ch.isSubagent) return false
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) {
      // Also allow walking to own seat tile (blocked for others but not self)
      const key = this.ownSeatKey(ch)
      if (!key || key !== `${col},${row}`) return false
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles)
    )
    if (path.length === 0) return false
    ch.path = path
    ch.moveProgress = 0
    ch.state = CharacterState.WALK
    ch.frame = 0
    ch.frameTimer = 0
    return true
  }

  private immediateRemoveSubagentByKey(key: string): void {
    const id = this.subagentIdMap.get(key)
    if (id === undefined) return
    const ch = this.characters.get(id)
    if (ch?.seatId) {
      const seat = this.seats.get(ch.seatId)
      if (seat) seat.assigned = false
    }
    this.characters.delete(id)
    this.subagentIdMap.delete(key)
    this.subagentMeta.delete(id)
    if (this.selectedAgentId === id) this.selectedAgentId = null
    if (this.cameraFollowId === id) this.cameraFollowId = null
  }

  setSubagentSessionId(id: number, sessionId: string | undefined): void {
    const meta = this.subagentMeta.get(id)
    if (meta) {
      meta.sessionId = sessionId
    }
  }

  rekeySubagent(parentAgentId: number, oldParentToolId: string, newParentToolId: string, sessionId?: string): number | null {
    const oldKey = `${parentAgentId}:${oldParentToolId}`
    const newKey = `${parentAgentId}:${newParentToolId}`
    if (oldKey === newKey) return this.subagentIdMap.get(oldKey) ?? null
    const id = this.subagentIdMap.get(oldKey)
    if (id === undefined) return null
    this.subagentIdMap.delete(oldKey)
    this.subagentIdMap.set(newKey, id)
    const meta = this.subagentMeta.get(id)
    if (meta) {
      meta.parentToolId = newParentToolId
      meta.sessionId = sessionId
    }
    return id
  }

  /** Create a sub-agent character with a parent-derived but distinct appearance. Returns the sub-agent ID. */
  addSubagent(parentAgentId: number, parentToolId: string): number | null {
    const key = `${parentAgentId}:${parentToolId}`
    if (this.subagentIdMap.has(key)) return this.subagentIdMap.get(key)!

    const id = this.nextSubagentId--
    const parentCh = this.characters.get(parentAgentId)
    const palette = parentCh ? parentCh.palette : 0
    const baseHue = parentCh ? parentCh.hueShift : 0
    let hash = 0
    for (let i = 0; i < parentToolId.length; i++) {
      hash = ((hash * 31) + parentToolId.charCodeAt(i)) % 360
    }
    const derivedOffset = 45 + (hash % 180)
    const hueShift = (baseHue + derivedOffset) % 360

    const bestSeatId = this.findFreeSeat(parentCh?.officeLabel.managed)
    if (parentCh?.officeLabel.managed && !bestSeatId) return null

    let ch: Character
    if (bestSeatId) {
      const seat = this.seats.get(bestSeatId)!
      seat.assigned = true
      ch = createCharacter(id, palette, bestSeatId, seat, hueShift)
    } else {
      // No seats — spawn at a walkable tile
      const spawn = this.walkableTiles.length > 0
        ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
        : { col: 1, row: 1 }
      ch = createCharacter(id, palette, null, null, hueShift)
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2
      ch.tileCol = spawn.col
      ch.tileRow = spawn.row
    }
    ch.isSubagent = true
    ch.parentAgentId = parentAgentId
    if (parentCh) ch.officeLabel = { ...parentCh.officeLabel, status: 'working', needsInput: false, speech: undefined,
      ...(parentCh.officeLabel.providerKind === 'codex' ? { usageTokens: 0, estimatedCost: undefined } : {}) }

    const entrance = this.getEntranceTile()
    this.placeCharacterAtTile(ch, entrance.col, entrance.row)
    let targetCol = ch.tileCol
    let targetRow = ch.tileRow
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId)
      if (seat) {
        targetCol = seat.seatCol
        targetRow = seat.seatRow
      }
    }
    if (!this.startWalkingToTile(ch, targetCol, targetRow)) {
      if (bestSeatId) {
        const seat = this.seats.get(bestSeatId)
        if (seat) {
          this.placeCharacterAtTile(ch, seat.seatCol, seat.seatRow)
        }
      }
    }
    this.characters.set(id, ch)

    this.subagentIdMap.set(key, id)
    this.subagentMeta.set(id, { parentAgentId, parentToolId })
    return id
  }

  /** Remove a specific sub-agent character and free its seat */
  removeSubagent(parentAgentId: number, parentToolId: string, immediate = false): void {
    const key = `${parentAgentId}:${parentToolId}`
    if (immediate) {
      this.immediateRemoveSubagentByKey(key)
      return
    }
    const id = this.subagentIdMap.get(key)
    if (id === undefined) return

    const ch = this.characters.get(id)
    if (ch) {
      if (ch.matrixEffect === 'despawn') {
        // Already despawning — just clean up maps
        this.subagentIdMap.delete(key)
        this.subagentMeta.delete(id)
        return
      }
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId)
        if (seat) seat.assigned = false
      }
      ch.currentTool = null
      ch.path = []
      ch.moveProgress = 0
      ch.exitDelayTimer = DONE_BUBBLE_DURATION_SEC
      this.showDoneBubble(id)
    }
    // Clean up tracking maps immediately so keys don't collide
    this.subagentIdMap.delete(key)
    this.subagentMeta.delete(id)
    if (this.selectedAgentId === id) this.selectedAgentId = null
    if (this.cameraFollowId === id) this.cameraFollowId = null
  }

  /** Remove all sub-agents belonging to a parent agent */
  removeAllSubagents(parentAgentId: number): void {
    const toRemove: string[] = []
    for (const [key, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id)
      if (meta && meta.parentAgentId === parentAgentId) {
        const ch = this.characters.get(id)
        if (ch) {
          if (ch.matrixEffect === 'despawn') {
            // Already despawning — just clean up maps
            this.subagentMeta.delete(id)
            toRemove.push(key)
            continue
          }
          if (ch.seatId) {
            const seat = this.seats.get(ch.seatId)
            if (seat) seat.assigned = false
          }
          ch.currentTool = null
          ch.path = []
          ch.moveProgress = 0
          ch.exitDelayTimer = DONE_BUBBLE_DURATION_SEC
          this.showDoneBubble(id)
        }
        this.subagentMeta.delete(id)
        if (this.selectedAgentId === id) this.selectedAgentId = null
        if (this.cameraFollowId === id) this.cameraFollowId = null
        toRemove.push(key)
      }
    }
    for (const key of toRemove) {
      this.subagentIdMap.delete(key)
    }
  }

  /** Look up the sub-agent character ID for a given parent+toolId, or null */
  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.subagentIdMap.get(`${parentAgentId}:${parentToolId}`) ?? null
  }

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.isActive = active
      if (!active && !ch.officeLabel.managed) {
        // Sentinel -1: signals turn just ended, skip next seat rest timer.
        // Prevents the WALK handler from setting a 2-4 min rest on arrival.
        ch.seatTimer = -1
        ch.path = []
        ch.moveProgress = 0
      }
      this.rebuildFurnitureInstances()
    }
  }

  /** Rebuild furniture instances with auto-state applied (active agents turn electronics ON) */
  private rebuildFurnitureInstances(): void {
    // Collect tiles where active agents face desks
    const autoOnTiles = new Set<string>()
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId) continue
      const seat = this.seats.get(ch.seatId)
      if (!seat) continue
      // Find the desk tile(s) the agent faces from their seat
      const dCol = seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0
      const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0
      // Check tiles in the facing direction (desk could be 1-3 tiles deep)
      for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
        const tileCol = seat.seatCol + dCol * d
        const tileRow = seat.seatRow + dRow * d
        autoOnTiles.add(`${tileCol},${tileRow}`)
      }
      // Also check tiles to the sides of the facing direction (desks can be wide)
      for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
        const baseCol = seat.seatCol + dCol * d
        const baseRow = seat.seatRow + dRow * d
        if (dCol !== 0) {
          // Facing left/right: check tiles above and below
          autoOnTiles.add(`${baseCol},${baseRow - 1}`)
          autoOnTiles.add(`${baseCol},${baseRow + 1}`)
        } else {
          // Facing up/down: check tiles left and right
          autoOnTiles.add(`${baseCol - 1},${baseRow}`)
          autoOnTiles.add(`${baseCol + 1},${baseRow}`)
        }
      }
    }

    if (autoOnTiles.size === 0) {
      this.furniture = layoutToFurnitureInstances(this.layout.furniture)
      return
    }

    // Build modified furniture list with auto-state applied
    const modifiedFurniture: PlacedFurniture[] = this.layout.furniture.map((item) => {
      const entry = getCatalogEntry(item.type)
      if (!entry) return item
      // Check if any tile of this furniture overlaps an auto-on tile
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          if (autoOnTiles.has(`${item.col + dc},${item.row + dr}`)) {
            const onType = getOnStateType(item.type)
            if (onType !== item.type) {
              return { ...item, type: onType }
            }
            return item
          }
        }
      }
      return item
    })

    this.furniture = layoutToFurnitureInstances(modifiedFurniture)
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.currentTool = tool
    }
  }

  setOfficeLabel(id: number, label: OfficeLabel): void {
    const ch = this.characters.get(id)
    if (!ch) return
    ch.officeLabel = { ...label }
    if (label.managed && !this.seats.get(ch.seatId ?? '')?.computerDeskId) {
      const previous = this.seats.get(ch.seatId ?? '')
      if (previous) previous.assigned = false
      const seatId = this.findFreeSeat(true)
      ch.seatId = seatId
      const seat = seatId ? this.seats.get(seatId) : undefined
      if (seat) {
        seat.assigned = true
        if (!this.startWalkingToTile(ch, seat.seatCol, seat.seatRow)) this.placeCharacterAtTile(ch, seat.seatCol, seat.seatRow)
      }
    }
  }

  showPermissionBubble(id: number): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.bubbleType = 'permission'
      ch.bubbleTimer = 0
    }
  }

  clearPermissionBubble(id: number): void {
    const ch = this.characters.get(id)
    if (ch && ch.bubbleType === 'permission') {
      ch.bubbleType = null
      ch.bubbleTimer = 0
    }
  }

  showWaitingBubble(id: number): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.bubbleType = 'waiting'
      ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC
    }
  }

  showDoneBubble(id: number): void {
    const ch = this.characters.get(id)
    if (ch) {
      ch.bubbleType = 'done'
      ch.bubbleTimer = DONE_BUBBLE_DURATION_SEC
    }
  }

  /** Dismiss bubble on click — permission: instant, waiting: quick fade */
  dismissBubble(id: number): void {
    const ch = this.characters.get(id)
    if (!ch || !ch.bubbleType) return
    if (ch.bubbleType === 'permission') {
      ch.bubbleType = null
      ch.bubbleTimer = 0
    } else if (ch.bubbleType === 'waiting' || ch.bubbleType === 'done') {
      // Trigger immediate fade (0.3s remaining)
      ch.bubbleTimer = Math.min(ch.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC)
    }
  }

  update(dt: number): void {
    const toDelete: number[] = []
    for (const ch of this.characters.values()) {
      // Handle matrix effect animation
      if (ch.matrixEffect) {
        ch.matrixEffectTimer += dt
        if (ch.matrixEffectTimer >= MATRIX_EFFECT_DURATION) {
          if (ch.matrixEffect === 'spawn') {
            // Spawn complete — clear effect, resume normal FSM
            ch.matrixEffect = null
            ch.matrixEffectTimer = 0
            ch.matrixEffectSeeds = []
          } else {
            // Despawn complete — mark for deletion
            toDelete.push(ch.id)
          }
        }
        continue // skip normal FSM while effect is active
      }

      if (ch.exitDelayTimer > 0) {
        ch.exitDelayTimer -= dt
        if (ch.exitDelayTimer <= 0) {
          ch.exitDelayTimer = 0
          this.beginExit(ch)
        }
      }

      if (ch.exitDelayTimer > 0) {
        if (ch.bubbleType === 'waiting' || ch.bubbleType === 'done') {
          ch.bubbleTimer -= dt
          if (ch.bubbleTimer <= 0) {
            ch.bubbleType = null
            ch.bubbleTimer = 0
          }
        }
        continue
      }

      // Temporarily unblock own seat so character can pathfind to it
      this.withOwnSeatUnblocked(ch, () =>
        updateCharacter(ch, dt, this.walkableTiles, this.seats, this.tileMap, this.blockedTiles)
      )

      if (ch.exiting && ch.path.length === 0 && ch.state !== CharacterState.WALK) {
        toDelete.push(ch.id)
        continue
      }

      // Tick bubble timer for waiting bubbles
      if (ch.bubbleType === 'waiting' || ch.bubbleType === 'done') {
        ch.bubbleTimer -= dt
        if (ch.bubbleTimer <= 0) {
          ch.bubbleType = null
          ch.bubbleTimer = 0
        }
      }
    }
    // Remove characters that finished despawn
    for (const id of toDelete) {
      this.characters.delete(id)
    }
  }

  getCharacters(): Character[] {
    return Array.from(this.characters.values())
  }

  /** Get character at pixel position (for hit testing). Returns id or null. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = this.getCharacters().sort((a, b) => b.y - a.y)
    for (const ch of chars) {
      // Skip characters that are despawning
      if (ch.matrixEffect === 'despawn') continue
      // Character sprite is 16x24, anchored bottom-center
      // Apply sitting offset to match visual position
      const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
      const anchorY = ch.y + sittingOffset
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH
      const top = anchorY - CHARACTER_HIT_HEIGHT
      const bottom = anchorY
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id
      }
    }
    return null
  }
}
