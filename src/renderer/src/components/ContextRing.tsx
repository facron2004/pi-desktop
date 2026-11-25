import { memo, useMemo, useRef } from 'react'
import { resolveSavedModel } from '@shared/provider-models'
import { isSideSessionKey } from '@shared/side-chat'
import { useAppStore } from '../store/useAppStore'
import { useSessionViewSlice } from '../lib/conversation-scope'
import { contextReading } from '../lib/context-reading'
import { formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'
import { ContextPanel } from './ContextPanel'

/**
 * How full the context window is, as a ring plus its percentage.
 *
 * The arc is the reading and the number beside it says the same thing in
 * digits; one colour, the foreground of the control, so the length is what is
 * seen — there is no amber or red state to decode. The reading itself comes
 * from `lib/context-reading.ts`, so a conversation with no live process still
 * shows the transcript's estimate instead of an empty arc at 0%.
 */
export const ContextRing = memo(function ContextRing({
  sessionKey: explicitSessionKey
}: {
  sessionKey?: string
} = {}) {
  const slice = useSessionViewSlice(explicitSessionKey)
  const resolvedKey = explicitSessionKey ?? slice.sessionKey
  const isSide = Boolean(resolvedKey && isSideSessionKey(resolvedKey))
  const showContextUsage = useAppStore((state) => state.settings.showContextUsage !== false)
  const stats = slice.stats
  const items = slice.items
  const itemsRef = useRef(items)
  itemsRef.current = items
  const itemCount = items.length
  const lastAssistantUsage = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (item.kind === 'assistant' && item.usage) return item.usage
    }
    return undefined
  }, [items])
  const lastCompletedAssistant = useMemo(
    () => items.findLast((item) => item.kind === 'assistant' && !item.streaming),
    [items]
  )
  const piState = slice.piState
  const mainModels = useAppStore((state) => state.models)
  const models = slice.models.length > 0 ? slice.models : mainModels
  const catalogModels = useAppStore((state) => state.catalogModels)
  const sideOverride = useAppStore((state) =>
    resolvedKey ? state.sideModelOverrides?.[resolvedKey] : undefined
  )
  const mainLiveModel = useAppStore((state) => state.piState?.model)
  const savedModel = useAppStore((state) => state.settings.model)
  const savedProvider = useAppStore((state) => state.settings.provider)
  const t = useT()

  const fallbackModel = useMemo(() => {
    const pool = models.length ? models : catalogModels
    if (isSide) {
      if (sideOverride) {
        const resolved = resolveSavedModel(sideOverride.spec, sideOverride.provider, pool)
        if (resolved) return resolved
      }
      if (mainLiveModel?.id && mainLiveModel.provider) return mainLiveModel
    }
    return resolveSavedModel(savedModel, savedProvider, pool)
  }, [isSide, sideOverride, mainLiveModel, savedModel, savedProvider, models, catalogModels])

  // Pi's own `contextWindow` outranks the saved model: the reading mixes Pi's
  // `percent` with the window, so a stale saved model would print a
  // percentage that does not match the tokens and window beside it.
  const reportedWindow = stats?.contextUsage?.contextWindow
  const modelWindow = reportedWindow ? undefined : fallbackModel

  const liveModel = piState?.model
  // Recompute only when usage/completed-message/stat/model inputs change rather
  // than re-scanning the transcript on every streamed text delta frame.
  const reading = useMemo(
    () =>
      showContextUsage
        ? contextReading({
            stats,
            items: itemsRef.current,
            model: liveModel,
            fallbackModel: modelWindow
          })
        : null,
    [showContextUsage, stats, itemCount, lastAssistantUsage, lastCompletedAssistant, liveModel, modelWindow]
  )

  if (!showContextUsage || !reading) return null

  const percent = reading.percent
  // The arc and the label both need the percentage; without one there is
  // nothing to draw and the label is a dash, never a fake 0%.
  const known = percent !== null
  const clamped = known ? Math.max(0, Math.min(100, percent)) : 0
  const percentText = known ? `${Math.round(percent)}%` : '—'

  const title = known
    ? `${t('Context window')}: ${formatTokens(reading.tokens)} / ${formatTokens(
        reading.contextWindow
      )} (${Math.round(percent)}%)`
    : t('Waiting for Pi statistics')

  return (
    <Popover
      placement="top"
      align="right"
      width={290}
      className="context-popover"
      renderTrigger={({ open, toggle }) => (
        <button
          type="button"
          className="context-ring"
          data-empty={known ? undefined : 'true'}
          data-active={open}
          aria-expanded={open}
          aria-label={known ? `${t('Session details')} · ${percentText}` : t('Session details')}
          title={title}
          onClick={toggle}
        >
          <span className="context-ring__svg" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
              <circle className="context-ring__track" cx="10" cy="10" r="7.6" />
              <circle
                className="context-ring__value"
                cx="10"
                cy="10"
                r="7.6"
                // Circumference of r=7.6 is ~47.75; the dash offset is what
                // paints the arc, and the rotation starts it at twelve.
                strokeDasharray="47.75"
                strokeDashoffset={47.75 * (1 - clamped / 100)}
              />
            </svg>
          </span>
          <span className="context-ring__label">{percentText}</span>
        </button>
      )}
    >
      {() => <ContextPanel sessionKey={resolvedKey} />}
    </Popover>
  )
})
