import { memo, useCallback, useEffect, useRef } from 'react'
import type { SideChatPresetKind } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { ConversationScopeProvider } from '../../lib/conversation-scope'
import type {
  SideChatOpenRequest,
  SideChatReferenceInput
} from '../../lib/side-chat-context'
import { SideChatHeader } from './SideChatHeader'
import { SideChatTranscript } from './SideChatTranscript'
import { SideChatComposer } from './SideChatComposer'
import '../../styles/side-chat.css'

export interface SideChatPanelProps {
  active: boolean
  request: SideChatOpenRequest | null
  onClose?: () => void
}

function focusSideComposer(): void {
  requestAnimationFrame(() => {
    window.dispatchEvent(
      new CustomEvent('pi:focus-composer', { detail: { target: 'side' } })
    )
  })
}

export const SideChatPanel = memo(function SideChatPanel({
  active,
  request
}: SideChatPanelProps) {
  const sideSessionKey = useAppStore((state) => state.sideSessionKey)
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
      <ConversationScopeProvider surface="side" sessionKey={sideSessionKey} readOnly>
        <SideChatHeader
          sideSessionKey={sideSessionKey}
          onRunPreset={handleRunPreset}
          onClear={handleClear}
        />
        <SideChatTranscript
          sideSessionKey={sideSessionKey}
          onRunPreset={handleRunPreset}
        />
        <SideChatComposer sideSessionKey={sideSessionKey} />
      </ConversationScopeProvider>
    </div>
  )
})
