import type { OfficeRole } from '../office/types.js'

export interface BrowserDeskWorker { id: string; name: string; role: OfficeRole; repoId: string; accountId?: string; agentId?: number; status: string; error?: string }

const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const identifier = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined
const roles = new Set(['builder', 'security-reviewer', 'verifier', 'manager'])
const statuses = new Set(['idle', 'working', 'reading', 'waiting', 'needs input', 'done', 'failed'])

/** Browser cards use public fields from host snapshots or legacy flat rosters.
 * Keep the original host snapshot intact for native Desk/mirror consumers. */
export function normalizeDeskWorkers(input: unknown): BrowserDeskWorker[] {
  if (!Array.isArray(input)) return []
  return input.slice(0, 500).flatMap(value => {
    const row = object(value)
    if (!row) return []
    const definition = object(row.definition) ?? row
    const id = identifier(definition.id)
    if (!id) return []
    const accountId = identifier(definition.accountId)
    const agentId = object(row.binding)?.agentId ?? row.agentId
    return [{ id, name: typeof definition.name === 'string' && definition.name.trim() ? definition.name.trim().slice(0, 100) : id,
      role: roles.has(String(definition.role)) ? definition.role as OfficeRole : 'builder',
      repoId: identifier(definition.repoId) ?? 'workspace',
      status: statuses.has(String(row.status)) ? String(row.status) : 'idle',
      ...(accountId ? { accountId } : {}),
      ...(typeof agentId === 'number' && Number.isSafeInteger(agentId) && agentId > 0 ? { agentId } : {}),
      ...(typeof row.error === 'string' && row.error ? { error: row.error.slice(0, 1000) } : {}) }]
  })
}
