import { memo, useCallback, useEffect, useRef } from 'react'
import type { SideChatPresetKind } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { ConversationScopeProvider } from '../../lib/conversation-scope'
import type {
  SideChatOpenRequest,
  SideChatReferenceInput
} from '../../lib/side-chat-context'
import { SideChatHeader } from './SideChatHeader'
import { SideChatEmptyState } from './SideChatEmptyState'
import { SideChatRefChip } from './SideChatRefChip'
import { Thread } from '../Thread'
import { Composer } from '../Composer'
import '../../styles/side-chat.css'

export interface SideChatPanelProps {
  active: boolean
  request: SideChatOpenRequest | null
  onClose?: () => void
}

/** One frozen list for the common "no reference attached" case. */
const EMPTY_REFERENCES: never[] = []

function focusSideComposer(): void {
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent('pi:focus-composer', { detail: { target: 'side' } })
    )
  })
}

/** A side chat has no swarm: the chip that would open it is not drawn there. */
const ignore = (): void => undefined

export const SideChatPanel = memo(function SideChatPanel({
  active,
  request
}: SideChatPanelProps) {
  const sideSessionKey = useAppStore((state) => state.sideSessionKey)
  const hasItems = useAppStore((state) => {
    const key = state.sideSessionKey
    if (!key) return false
    const thread = state.threads[key]
    return Boolean(thread && thread.items.length > 0)
  })
  const references = useAppStore((state) => {
    const key = state.sideSessionKey
    return (key ? state.sideQuotes[key] : undefined) ?? EMPTY_REFERENCES
  })
  const removeSideReference = useAppStore((state) => state.removeSideReference)
  const ensureSideChatForActiveMain = useAppStore(
    (state) => state.ensureSideChatForActiveMain
  )
  const clearActiveSideChat = useAppStore((state) => state.clearActiveSideChat)
  const attachSideReference = useAppStore((state) => state.attachSideReference)
  const runSidePreset = useAppStore((state) => state.runSidePreset)
  const sendSidePrompt = useAppStore((state) => state.sendSidePrompt)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)

  const handledSeqRef = useRef(0)

  // Ensure the bound Side Chat slot is resolved whenever the panel becomes active.
  useEffect(() => {
    if (!active) return
    void ensureSideChatForActiveMain()
  }, [active, ensureSideChatForActiveMain])

  // Process contextual / command open requests (`Ask Side Chat`, `/side <q>`, presets).
  useEffect(() => {
    if (!active || !request || request.seq === handledSeqRef.current) return
    handledSeqRef.current = request.seq

    let cancelled = false
    void (async () => {
      const resolvedKey =
        (await ensureSideChatForActiveMain()) || useAppStore.getState().sideSessionKey
      if (cancelled) return

      if (request.reference) {
        attachSideReference(request.reference as SideChatReferenceInput, resolvedKey)
      }

      if (request.preset) {
        const autoSend = request.autoSubmit !== false
        await runSidePreset(request.preset, {
          stepText: request.stepText,
          autoSend
        })
        if (!autoSend || request.focus) focusSideComposer()
        return
      }

      if (request.prompt?.trim()) {
        const cleanPrompt = request.prompt.trim()
        if (request.autoSubmit) {
          await sendSidePrompt(cleanPrompt)
          if (request.focus) focusSideComposer()
          return
        }
        if (resolvedKey) {
          insertIntoComposer(cleanPrompt, 'append', resolvedKey)
        }
        focusSideComposer()
        return
      }

      if (request.focus || request.reference) {
        focusSideComposer()
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    active,
    attachSideReference,
    ensureSideChatForActiveMain,
    insertIntoComposer,
    request,
    runSidePreset,
    sendSidePrompt
  ])

  const handleRunPreset = useCallback(
    (preset: SideChatPresetKind, options?: { autoSend?: boolean }) => {
      const autoSend = options?.autoSend !== false
      void runSidePreset(preset, { autoSend }).then(() => {
        if (!autoSend) focusSideComposer()
      })
    },
    [runSidePreset]
  )

  const handleClear = useCallback(() => {
    void clearActiveSideChat().then(() => {
      focusSideComposer()
    })
  }, [clearActiveSideChat])

  return (
    <div
      data-conversation-surface="side"
      className="side-chat"
      data-active={active || undefined}
    >
      {/* The side chat is a parallel conversation, not a second kind of chat:
          it reads with the main conversation's own transcript and writes with
          its own composer, so the two panes cannot drift apart again. The
          scope is what makes those components render the side session — the
          header above them stays because Clear and the review presets have no
          equivalent in the main chat. */}
      <ConversationScopeProvider surface="side" sessionKey={sideSessionKey}>
        <SideChatHeader
          sideSessionKey={sideSessionKey}
          onRunPreset={handleRunPreset}
          onClear={handleClear}
        />
        {hasItems ? <Thread /> : <SideChatEmptyState onSelectPreset={handleRunPreset} />}
        {references.length > 0 ? (
          <div className="side-chat__refs side-chat__refs-tray">
            {references.map((reference) => (
              <SideChatRefChip
                key={reference.id}
                reference={reference}
                onRemove={(id) => removeSideReference(id, sideSessionKey ?? undefined)}
              />
            ))}
          </div>
        ) : null}
        <Composer onOpenSwarm={ignore} />
      </ConversationScopeProvider>
    </div>
  )
})
