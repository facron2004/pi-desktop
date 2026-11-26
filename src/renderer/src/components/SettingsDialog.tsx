import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PiCliUpgradeProgress } from '@shared/types'
import {
  Archive,
  Bot,
  Brain,
  Cpu,
  Gauge,
  Info,
  Keyboard,
  MessageSquare,
  Palette,
  Search,
  SlidersHorizontal,
  Smartphone,
  UserRound,
  X
} from 'lucide-react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'
import { searchSettings, type SettingsSearchResult } from '../lib/settings-search'
import type { SettingsPage } from '../lib/settings-pages'
import { SETTINGS_PAGE_LABELS } from '../lib/settings-pages'
import { FeatureLoading } from './FeatureLoading'
import {
  checkForAppUpdates,
  noteAppUpdateCheck
} from '../lib/app-update'
import '../styles/appearance.css'

const AboutSettings = lazy(() => import('./settings/AboutSettings').then((m) => ({ default: m.AboutSettings })))
const AgentSettings = lazy(() => import('./settings/AgentSettings').then((m) => ({ default: m.AgentSettings })))
const AppearanceSettings = lazy(() => import('./settings/AppearanceSettings').then((m) => ({ default: m.AppearanceSettings })))
const GeneralSettings = lazy(() => import('./settings/GeneralSettings').then((m) => ({ default: m.GeneralSettings })))
const PersonalizationSettings = lazy(() => import('./settings/PersonalizationSettings').then((m) => ({ default: m.PersonalizationSettings })))
const ShortcutsSettings = lazy(() => import('./settings/ShortcutsSettings').then((m) => ({ default: m.ShortcutsSettings })))
const UsageSettings = lazy(() => import('./settings/UsageSettings').then((m) => ({ default: m.UsageSettings })))
const MemorySettings = lazy(() => import('./MemorySettings').then((m) => ({ default: m.MemorySettings })))
const ArchivedSessionsSettings = lazy(() => import('./ArchivedSessionsSettings').then((m) => ({ default: m.ArchivedSessionsSettings })))
const ModelsSettings = lazy(() => import('./models/ModelsSettings').then((m) => ({ default: m.ModelsSettings })))
const RemoteAccessSettings = lazy(() => import('./RemoteAccessSettings').then((m) => ({ default: m.RemoteAccessSettings })))
const ImChannelSettings = lazy(() => import('./ImChannelSettings').then((m) => ({ default: m.ImChannelSettings })))

export type { SettingsPage } from '../lib/settings-pages'

const PAGES = [
  { id: 'general', label: SETTINGS_PAGE_LABELS.general, Icon: SlidersHorizontal },
  { id: 'agent', label: SETTINGS_PAGE_LABELS.agent, Icon: Bot },
  { id: 'models', label: SETTINGS_PAGE_LABELS.models, Icon: Cpu },
  { id: 'appearance', label: SETTINGS_PAGE_LABELS.appearance, Icon: Palette },
  { id: 'usage', label: SETTINGS_PAGE_LABELS.usage, Icon: Gauge },
  { id: 'shortcuts', label: SETTINGS_PAGE_LABELS.shortcuts, Icon: Keyboard },
  { id: 'personalization', label: SETTINGS_PAGE_LABELS.personalization, Icon: UserRound },
  { id: 'remote', label: SETTINGS_PAGE_LABELS.remote, Icon: Smartphone },
  { id: 'im-channels', label: SETTINGS_PAGE_LABELS['im-channels'], Icon: MessageSquare },
  { id: 'memory', label: SETTINGS_PAGE_LABELS.memory, Icon: Brain },
  { id: 'archived', label: SETTINGS_PAGE_LABELS.archived, Icon: Archive },
  { id: 'about', label: SETTINGS_PAGE_LABELS.about, Icon: Info }
] as const

export function SettingsDialog({
  onClose,
  initialPage = 'general'
}: {
  onClose: () => void
  initialPage?: SettingsPage
}) {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const refreshInfo = useAppStore((state) => state.refreshInfo)
  const showToast = useAppStore((state) => state.showToast)
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  // Opening the dialog should not land on the close icon and paint a ring on
  // a control the user did not touch; the container receives focus instead.
  useDialogFocus(dialogRef, onClose, { initialFocus: 'dialog' })

  const [page, setPage] = useState<SettingsPage>(initialPage)
  const [pageQuery, setPageQuery] = useState('')
  // The row a result named, so opening its page can point at it instead of
  // leaving the reader to scan for the label they just typed.
  const [hit, setHit] = useState<{ text: string; seq: number } | undefined>(undefined)
  const contentRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const navRef = useRef<HTMLElement>(null)
  // The search reads the curated index in lib/settings-search.ts, never the
  // lazy pages themselves: mounting all twelve to read their labels would
  // start provider, update and memory requests the reader never asked for.
  const pageResults = useMemo(() => searchSettings(PAGES, pageQuery, t), [pageQuery, t])
  /** Open a result from a click, Enter in the field or a keyboard pick. */
  const openResult = useCallback((result: SettingsSearchResult) => {
    setPage(result.page)
    setPageQuery('')
    setHit((current) => result.match
      ? { text: result.match, seq: (current?.seq ?? 0) + 1 }
      : undefined)
  }, [])
  const [customInstructions, setCustomInstructions] = useState(settings.customInstructions ?? '')
  const customInstructionsRef = useRef(customInstructions)
  customInstructionsRef.current = customInstructions
  const savedInstructionsRef = useRef(settings.customInstructions ?? '')

  useEffect(() => {
    setPage(initialPage)
  }, [initialPage])

  useEffect(() => {
    const next = settings.customInstructions ?? ''
    const previous = savedInstructionsRef.current
    savedInstructionsRef.current = next
    // Do not overwrite a newer draft when an earlier autosave lands.
    setCustomInstructions((current) => (current === previous ? next : current))
  }, [settings.customInstructions])

  // Other settings save immediately; personalization is the one draft field.
  // Keep it automatic too, and flush on close so closing the dialog mid-typing
  // cannot lose the last characters.
  useEffect(() => {
    const value = customInstructions.trim() || undefined
    const saved = settings.customInstructions?.trim() || undefined
    if (value === saved) return
    const timer = window.setTimeout(() => {
      void updateSettings({ customInstructions: value })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [customInstructions, settings.customInstructions, updateSettings])

  useEffect(
    () => () => {
      const value = customInstructionsRef.current.trim() || undefined
      const saved = savedInstructionsRef.current.trim() || undefined
      if (value !== saved) void updateSettings({ customInstructions: value })
    },
    [updateSettings]
  )

  // A chosen result opens its page and then finds the row it named. The page is
  // lazy, so the row may not exist on the first frame: poll for a moment, flash
  // the deepest matching label, and clear the mark after the animation.
  useEffect(() => {
    if (!hit) return
    let cancelled = false
    let attempts = 0
    let timer: number | undefined
    const clear = () => {
      contentRef.current?.querySelectorAll('.settings-hit').forEach((node) => {
        node.classList.remove('settings-hit')
      })
    }
    const find = () => {
      if (cancelled) return
      const container = contentRef.current
      if (!container) return
      const node = findSettingLabel(container, hit.text)
      if (!node) {
        if (attempts < 20) {
          attempts += 1
          window.setTimeout(find, 80)
        }
        return
      }
      clear()
      node.classList.add('settings-hit')
      // The page just changed under the pointer; an animated scroll would make
      // the reader wait to see where the label landed.
      node.scrollIntoView({ block: 'center' })
      timer = window.setTimeout(() => node.classList.remove('settings-hit'), 1800)
    }
    const frame = requestAnimationFrame(find)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      if (timer !== undefined) window.clearTimeout(timer)
      clear()
    }
  }, [hit])

  // The full update reading lives in the shared module, not in a component:
  // closing Settings, reopening it, or toggling a switch in between must not
  // throw away the version the reader just checked for. This page only starts
  // checks — the answer is read by the sidebar button and the notice.
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [upgradingCli, setUpgradingCli] = useState(false)
  const [piCliProgress, setPiCliProgress] = useState<PiCliUpgradeProgress | null>(null)

  useEffect(
    () =>
      window.pi.app.onPiCliUpgradeProgress((progress) => {
        setPiCliProgress(progress)
      }),
    []
  )

  const handleCheck = async (silent = false) => {
    setCheckingUpdates(true)
    try {
      const result = await (silent ? window.pi.app.checkUpdate() : checkForAppUpdates())
      // A failed check keeps the last good reading in the shared module, so the
      // page must read that rather than the failure: a machine that is offline
      // right now has not stopped having the version it found yesterday.
      noteAppUpdateCheck(result)
    } catch {
      // The shared result card owns errors from a manual check.
    } finally {
      setCheckingUpdates(false)
    }
  }

  const handleUpgradeCli = async () => {
    setUpgradingCli(true)
    setPiCliProgress({ stage: 'preparing', percent: 0 })
    try {
      const res = await window.pi.app.upgradePiCli()
      if (res.success) {
        showToast(t('Upgrade completed'))
        await refreshInfo()
        const result = await window.pi.app.checkUpdate()
        noteAppUpdateCheck(result)
      } else {
        showToast(res.error ? `${t('Upgrade failed')}: ${t(res.error)}` : t('Upgrade failed'), 'error')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast(`${t('Upgrade failed')}: ${t(msg)}`, 'error')
    } finally {
      setUpgradingCli(false)
      setPiCliProgress(null)
    }
  }

  return (
    <div className="modal-layer no-drag" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // The conversation's Ctrl+F searches the transcript and is disabled
          // while a modal is open; inside Settings the same chord should reach
          // the settings search instead of doing nothing.
          if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
            event.preventDefault()
            searchRef.current?.focus()
            searchRef.current?.select()
          }
        }}
      >
        <div className="modal__head">
          <h2 id="settings-title" className="modal__title">{t('Settings')}</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={t('Close')}
            title={t('Close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="settings-layout">
          <nav
            ref={navRef}
            className="settings-nav"
            aria-label={t('Settings sections')}
            onKeyDown={(event) => {
              // The field and the page list are one keyboard column: the
              // arrows walk it, and the first or last row hands focus back to
              // the field. Enter on a row is the button's own activation.
              if (event.altKey || event.ctrlKey || event.metaKey) return
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              const buttons = [...(navRef.current?.querySelectorAll<HTMLButtonElement>('[data-settings-page]') ?? [])]
              if (!buttons.length) return
              event.preventDefault()
              const active = document.activeElement
              if (active === searchRef.current) {
                (event.key === 'ArrowDown' ? buttons[0] : buttons[buttons.length - 1]).focus()
                return
              }
              const index = buttons.indexOf(active as HTMLButtonElement)
              if (index < 0) return
              if (event.key === 'ArrowDown') {
                if (index === buttons.length - 1) searchRef.current?.focus()
                else buttons[index + 1].focus()
              } else if (index === 0) {
                searchRef.current?.focus()
              } else {
                buttons[index - 1].focus()
              }
            }}
          >
            <label className="settings-nav__search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                value={pageQuery}
                onChange={(event) => setPageQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Escape') {
                    if (!pageQuery) return
                    // The first Escape clears the field; the dialog's own
                    // Escape only gets the next one.
                    event.preventDefault()
                    event.stopPropagation()
                    setPageQuery('')
                    return
                  }
                  // Enter takes the top result, so a typed search is one
                  // keystroke away from the row it found.
                  if (event.key === 'Enter' && !event.shiftKey && pageQuery.trim() && pageResults[0]) {
                    event.preventDefault()
                    openResult(pageResults[0])
                  }
                }}
                placeholder={t('Search settings…')}
                aria-label={t('Search settings')}
                spellCheck={false}
              />
              {pageQuery ? (
                <button
                  type="button"
                  onClick={() => setPageQuery('')}
                  aria-label={t('Clear the search')}
                  title={t('Clear the search')}
                >
                  <X size={12} />
                </button>
              ) : null}
            </label>
            {pageResults.map((result) => {
              const target = PAGES.find((entry) => entry.id === result.page)
              if (!target) return null
              const Icon = target.Icon
              return (
                <button
                  key={result.page}
                  type="button"
                  data-settings-page={result.page}
                  data-active={page === result.page}
                  aria-current={page === result.page ? 'page' : undefined}
                  onClick={() => openResult(result)}
                >
                  <Icon size={15} />
                  <span className="settings-nav__text">
                    <span>{result.label}</span>
                    {result.match ? <span className="settings-nav__match">{result.match}</span> : null}
                  </span>
                </button>
              )
            })}
            {pageResults.length === 0 ? (
              <div className="settings-nav__empty" role="status">{t('No settings found')}</div>
            ) : null}
            {pageQuery.trim() && pageResults.length > 0 ? (
              <span className="sr-only" role="status" aria-live="polite">
                {t('{count} settings found').replace('{count}', String(pageResults.length))}
              </span>
            ) : null}
          </nav>

          <div className="settings-content" ref={contentRef}>
            <Suspense fallback={<FeatureLoading />}>
              {page === 'general' ? <GeneralSettings /> : null}
              {page === 'agent' ? <AgentSettings /> : null}
              {page === 'models' ? <ModelsSettings /> : null}
              {page === 'appearance' ? <AppearanceSettings /> : null}
              {page === 'usage' ? <UsageSettings /> : null}
              {page === 'shortcuts' ? <ShortcutsSettings /> : null}
              {page === 'personalization' ? (
                <PersonalizationSettings
                  value={customInstructions}
                  onChange={setCustomInstructions}
                />
              ) : null}
              {page === 'remote' ? <RemoteAccessSettings /> : null}
              {page === 'im-channels' ? <ImChannelSettings /> : null}
              {page === 'memory' ? <MemorySettings /> : null}
              {page === 'archived' ? <ArchivedSessionsSettings /> : null}
              {page === 'about' ? (
                <AboutSettings
                  checking={checkingUpdates}
                  upgradingCli={upgradingCli}
                  piCliProgress={piCliProgress}
                  onCheck={handleCheck}
                  onUpgradeCli={handleUpgradeCli}
                />
              ) : null}
            </Suspense>
          </div>
        </div>

      </div>
    </div>
  )
}

/**
 * The element a search result named, inside the page that just opened.
 *
 * Settings rows grew their own markup page by page, so there is no shared
 * anchor to point at. The label text is the one thing they have in common:
 * take the deepest element whose trimmed text is exactly that label, so a
 * wrapper row is not what flashes.
 */
function findSettingLabel(root: HTMLElement, label: string): HTMLElement | null {
  const needle = label.trim()
  if (!needle) return null
  const matches = [...root.querySelectorAll<HTMLElement>('*')].filter(
    (node) => node.textContent?.trim() === needle
  )
  return matches.find((node) => !matches.some((other) => other !== node && node.contains(other))) ?? null
}
