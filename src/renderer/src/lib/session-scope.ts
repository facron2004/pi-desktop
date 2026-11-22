import type { PiEvent, RuntimeStatus, RuntimeStatusEvent } from '@shared/types'
import type { SessionThread } from '../store/useAppStore'

export interface ScopedPiEvent {
  ownerId: string
  event: PiEvent
}

/**
 * Events from the supervisor already name their runtime.
 * Older callers and tests still emit a bare Pi event; those belong to the
 * conversation on screen, never to whichever session happens to be clicked next.
 */
export function scopeEvent(payload: unknown, viewKey: string): ScopedPiEvent | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as { ownerId?: unknown; event?: unknown; type?: unknown }
  if (typeof record.ownerId === 'string' && record.event && typeof record.event === 'object') {
    return { ownerId: record.ownerId, event: record.event as PiEvent }
  }
  if (typeof record.type === 'string') {
    return { ownerId: viewKey, event: payload as PiEvent }
  }
  return null
}

export function scopeStatus(payload: unknown, viewKey: string): RuntimeStatusEvent | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as { ownerId?: unknown; status?: unknown; phase?: unknown }
  const status = (record.status ?? payload) as Partial<RuntimeStatus>
  if (typeof status.phase !== 'string') return null
  return { ownerId: typeof record.ownerId === 'string' ? record.ownerId : viewKey, status: status as RuntimeStatus }
}

/** A file can have saved history before the sidebar index has caught up. */
export function needsSessionHydration(
  file: string,
  cached?: Pick<SessionThread, 'historyLoaded' | 'items'>
): boolean {
  return !file.startsWith('draft:') && (!cached?.historyLoaded || cached.items.length === 0)
}
