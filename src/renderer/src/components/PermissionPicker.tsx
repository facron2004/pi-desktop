import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, CircleHelp, ShieldCheck, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { PermissionMode } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'
import { ConfirmDialog } from './ConfirmDialog'
import '../styles/permissions.css'

const MODES: { value: PermissionMode; label: string; description: string; icon: LucideIcon }[] = [
  { value: 'ask', label: 'Request approval', description: 'Ask before every agent tool operation.', icon: CircleHelp },
  { value: 'auto', label: 'Approve for me', description: 'Approve ordinary files in the working folder; ask for commands and other access.', icon: ShieldCheck },
  { value: 'full', label: 'Full access', description: 'Allow all agent tools without approval.', icon: TriangleAlert }
]

export function PermissionPicker() {
  const mode = useAppStore((state) => state.settings.permissionMode ?? 'ask')
  const updateSettings = useAppStore((state) => state.updateSettings)
  const showToast = useAppStore((state) => state.showToast)
  const [saving, setSaving] = useState(false)
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const t = useT()
  const current = MODES.find((entry) => entry.value === mode) ?? MODES[0]
  const CurrentIcon = current.icon

  const save = async (value: PermissionMode) => {
    setSaving(true)
    try {
      await updateSettings({ permissionMode: value })
    } catch {
      showToast('Could not update agent permissions', 'error')
    } finally {
      setSaving(false)
    }
  }

  const select = (value: PermissionMode, close: () => void) => {
    close()
    if (value === mode) return
    if (value === 'full') {
      setConfirmFullAccess(true)
      return
    }
    void save(value)
  }

  return (
    <>
      <Popover
        placement="top"
        width={310}
        renderTrigger={({ open, toggle }) => (
          <button
            type="button"
            className="permission-picker"
            data-mode={current.value}
            aria-label={t('Agent permissions')}
            aria-haspopup="menu"
            aria-expanded={open}
            title={t(current.description)}
            disabled={saving}
            onClick={toggle}
          >
            <CurrentIcon size={13} />
            <span>{t(current.label)}</span>
            <ChevronDown size={11} />
          </button>
        )}
      >
        {(close) => (
          <div role="menu" aria-label={t('Agent permissions')}>
            <div className="popover__label">{t('Agent permissions')}</div>
            {MODES.map((entry) => {
              const Icon = entry.icon
              return (
                <button
                  key={entry.value}
                  type="button"
                  className="popover__item permission-picker__option"
                  role="menuitemradio"
                  aria-checked={entry.value === mode}
                  data-active={entry.value === mode}
                  data-mode={entry.value}
                  onClick={() => select(entry.value, close)}
                >
                  <Icon size={15} className="permission-picker__mode-icon" />
                  <span className="permission-picker__copy">
                    <span>{t(entry.label)}</span>
                    <span className="permission-picker__description">{t(entry.description)}</span>
                  </span>
                  {entry.value === mode ? <Check size={14} /> : null}
                </button>
              )
            })}
          </div>
        )}
      </Popover>
      {confirmFullAccess ? createPortal(
        <ConfirmDialog
          className="permission-confirm"
          title={t('Enable full access?')}
          body={t('Full access lets the agent read and change files outside the working folder, run commands, and access the network with your system account permissions. Tool operations will no longer ask for approval. You can switch back at any time.')}
          tone="danger"
          onCancel={() => setConfirmFullAccess(false)}
          onConfirm={() => {
            setConfirmFullAccess(false)
            void save('full')
          }}
        />,
        document.body
      ) : null}
    </>
  )
}
