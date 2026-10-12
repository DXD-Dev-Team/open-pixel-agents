import type { OfficeLabel } from '../types.js'

/** Public action descriptions only. Never render reasoning or tool arguments. */
export function activitySummary(label: OfficeLabel, tool: string | null, connected = true): string {
  if (!connected) return 'Disconnected · reconnect to continue'
  if (label.needsInput) return 'Waiting for your answer'
  if (label.status === 'failed') return 'Task failed · open chat for details'
  if (label.role === 'manager' && label.managerPaused) return 'Paused · ready for manual chat'
  if (label.status === 'working') {
    const name = tool?.toLowerCase()
    if (['bash', 'shell', 'terminal'].includes(name ?? '')) return 'Running a command…'
    if (['edit', 'write', 'apply_patch', 'patch'].includes(name ?? '')) return 'Updating files…'
    if (['task', 'subtask'].includes(name ?? '')) return 'Coordinating a subtask…'
    if (['webfetch', 'websearch'].includes(name ?? '')) return 'Checking public sources…'
    return 'Thinking…'
  }
  if (label.status === 'reading') return 'Reading files…'
  if (label.status === 'waiting') return 'Waiting for the provider…'
  return label.status === 'done' ? 'Finished · ready for the next task' : 'Idle · ready for a task'
}
