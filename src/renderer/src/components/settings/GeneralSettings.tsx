import { useEffect, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { AuthStatus } from '@shared/types'
import { useT } from '../../lib/i18n'
import { useAppStore } from '../../store/useAppStore'
import { Popover } from '../Popover'
import { Switch } from '../Switch'
import { ProjectSafetySettings, SettingsGroup } from './SettingsShared'

function NativeMark({ src }: { src?: string }) {
  if (!src) return null
  return <img className="settings-icon-select__img" src={src} alt="" />
}

function SettingsIconSelect({
  label,
  value,
  icons,
  options,
  onChange,
  className
}: {
  label: string
  value: string
  icons: Record<string, string>
  options: { value: string; label: string; icon: string }[]
  onChange: (value: string) => void
  className?: string
}) {
  const current = options.find((option) => option.value === value) ?? options[0]
  return (
    <Popover
      align="right"
      width={220}
      className="settings-icon-select__popover"
      renderTrigger={({ open, toggle }) => (
        <button
          type="button"
          className={`settings-icon-select ${className ?? ''}`}
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={toggle}
        >
          <NativeMark src={icons[current.icon]} />
          <span className="settings-icon-select__label">{current.label}</span>
          <ChevronDown size={13} className="settings-icon-select__chevron" data-open={open} />
        </button>
      )}
    >
      {(close) => (
        <div className="settings-icon-select__menu" role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="settings-icon-select__option"
              onClick={() => {
                onChange(option.value)
                close()
              }}
            >
              <NativeMark src={icons[option.icon]} />
              <span>{option.label}</span>
              {option.value === value ? <Check size={13} /> : null}
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}

export interface GeneralSettingsForm {
  piPath: string
  provider: string
  defaultModel: string
  defaultThinking: string
}

interface GeneralSettingsProps {
  form?: GeneralSettingsForm
  onChange?: (patch: Partial<GeneralSettingsForm>) => void
  auth?: AuthStatus | null
  checking?: boolean
  onCheck?: (providerOverride?: string) => void
  onOpenProject?: () => void
  onResetPiPath?: () => void
}

export function GeneralSettings(_props: GeneralSettingsProps = {}) {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const info = useAppStore((state) => state.info)
  const showToast = useAppStore((state) => state.showToast)
  const t = useT()

  const currentChatFolder = settings.externalChatFolder || info?.sessionRoot || ''
  const [nativeIcons, setNativeIcons] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancel = false
    void window.pi.shell.nativeIcons().then((next) => {
      if (!cancel) setNativeIcons(next)
    })
    return () => {
      cancel = true
    }
  }, [])

  const handlePickChatFolder = async () => {
    try {
      const selected = await window.pi.dialog.pickDirectory(currentChatFolder)
      if (selected) {
        await updateSettings({ externalChatFolder: selected })
        showToast(t('Settings saved'))
      }
    } catch {
      showToast(t('Could not pick directory'), 'error')
    }
  }

  return (
    <div className="settings-page settings-page--compact">
      <SettingsGroup title={t('General')}>
        {/* 1. 项目外聊天文件夹 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Out-of-project chat folder')}</span>
            <span className="settings-item-row__desc">
              {t('Default storage location for data from new chats started outside a project.')}
            </span>
          </div>
          <div className="settings-folder-picker">
            <span className="settings-folder-path" title={currentChatFolder}>
              {currentChatFolder}
            </span>
            <button type="button" className="btn btn--sm" onClick={handlePickChatFolder}>
              {t('Change')}
            </button>
          </div>
        </div>

        {/* 2. 默认文件打开位置 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Default file opening location')}</span>
            <span className="settings-item-row__desc">{t('Default location to open files and folders')}</span>
          </div>
          <SettingsIconSelect
            label={t('Default file opening location')}
            value={settings.defaultFileOpener ?? 'vscode'}
            icons={nativeIcons}
            onChange={(value) => void updateSettings({ defaultFileOpener: value })}
            options={[
              { value: 'vscode', label: 'VS Code', icon: 'vscode' },
              { value: 'cursor', label: 'Cursor', icon: 'cursor' },
              { value: 'windsurf', label: 'Windsurf', icon: 'windsurf' },
              { value: 'system', label: t('System default'), icon: 'system' }
            ]}
          />
        </div>

        {/* 3. 链接打开方式 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Where links open')}</span>
            <span className="settings-item-row__desc">
              {t('Open links from the conversation in the system browser or in the app.')}
            </span>
          </div>
          <div className="segmented">
            <button
              type="button"
              data-active={(settings.urlOpenTarget ?? 'external') === 'external'}
              aria-pressed={(settings.urlOpenTarget ?? 'external') === 'external'}
              onClick={() => void updateSettings({ urlOpenTarget: 'external' })}
            >
              {t('System browser')}
            </button>
            <button
              type="button"
              data-active={(settings.urlOpenTarget ?? 'external') === 'internal'}
              aria-pressed={(settings.urlOpenTarget ?? 'external') === 'internal'}
              onClick={() => void updateSettings({ urlOpenTarget: 'internal' })}
            >
              {t('In-app browser')}
            </button>
          </div>
        </div>

        {/* 3. 智能体环境 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Agent environment')}</span>
            <span className="settings-item-row__desc">{t('Choose where the agent runs on Windows')}</span>
          </div>
          <SettingsIconSelect
            label={t('Agent environment')}
            value={settings.agentEnvironment ?? 'windows'}
            icons={nativeIcons}
            onChange={(value) => void updateSettings({ agentEnvironment: value })}
            options={[
              { value: 'windows', label: t('Windows Native'), icon: 'windows' },
              { value: 'wsl', label: 'WSL', icon: 'wsl' }
            ]}
          />
        </div>

        {/* 4. 集成终端 Shell */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Integrated terminal shell')}</span>
            <span className="settings-item-row__desc">{t('Choose the shell to open in the integrated terminal')}</span>
          </div>
          <SettingsIconSelect
            label={t('Integrated terminal shell')}
            value={settings.terminalShell ?? 'powershell'}
            icons={nativeIcons}
            onChange={(value) => void updateSettings({ terminalShell: value })}
            options={[
              { value: 'powershell', label: 'PowerShell', icon: 'powershell' },
              { value: 'cmd', label: 'Command Prompt (CMD)', icon: 'cmd' },
              { value: 'gitbash', label: 'Git Bash', icon: 'gitbash' },
              { value: 'wsl', label: 'WSL (Bash)', icon: 'wsl' }
            ]}
          />
        </div>

        {/* 5. 语言 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Language')}</span>
            <span className="settings-item-row__desc">{t('Application interface language')}</span>
          </div>
          <SettingsIconSelect
            label={t('Language')}
            value={settings.language ?? 'zh-CN'}
            icons={{}}
            className="settings-icon-select--language"
            onChange={(value) => void updateSettings({ language: value as 'zh-CN' | 'en' })}
            options={[
              { value: 'zh-CN', label: '简体中文', icon: '' },
              { value: 'en', label: 'English', icon: '' }
            ]}
          />
        </div>

        {/* 6. 压缩本地保存的聊天历史记录 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Compact locally saved chat history')}</span>
            <span className="settings-item-row__desc">
              {t('Compact older local chat history to save disk space. Changes take effect after restarting.')}
            </span>
          </div>
          <Switch
            checked={settings.compactChatHistory !== false}
            onChange={(checked) => void updateSettings({ compactChatHistory: checked })}
            label={t('Compact locally saved chat history')}
          />
        </div>

        {/* 7. 插件 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Plugins')}</span>
            <span className="settings-item-row__desc">{t('Allow using installed plugins')}</span>
          </div>
          <Switch
            checked={settings.pluginsEnabled !== false}
            onChange={(checked) => void updateSettings({ pluginsEnabled: checked })}
            label={t('Plugins')}
          />
        </div>

        {/* Closing hides to the tray instead of quitting. The process reads this live. */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Keep running in the tray')}</span>
            <span className="settings-item-row__desc">
              {t('Closing the window hides Pi Desktop in the system tray instead of quitting.')}
            </span>
          </div>
          <Switch
            checked={settings.trayPersistent === true}
            onChange={(checked) => void updateSettings({ trayPersistent: checked })}
            label={t('Keep running in the tray')}
          />
        </div>

        {/* Computer Use is a capability, not a task mode. The switch is the approval. */}
        <div className="settings-item-row settings-item-row--fixed-control">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Computer Use')}</span>
            <span className="settings-item-row__desc">
              {t('Let the agent see and operate this Windows desktop. Screenshots, clicks and keystrokes are not asked for one by one. Plan Mode still cannot use it.')}
            </span>
          </div>
          <Switch
            checked={settings.computerUse === true}
            onChange={(checked) => void updateSettings({ computerUse: checked })}
            label={t('Computer Use')}
          />
        </div>
      </SettingsGroup>

      <ProjectSafetySettings />

      <SettingsGroup title={t('Editor')}>
        {/* 纯文本编辑器 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Plain text editor')}</span>
            <span className="settings-item-row__desc">
              {t('When composing messages, keep code, Markdown, and tables as plain text only')}
            </span>
          </div>
          <Switch
            checked={Boolean(settings.plainTextEditor)}
            onChange={(checked) => void updateSettings({ plainTextEditor: checked })}
            label={t('Plain text editor')}
          />
        </div>

        {/* 显示上下文窗口使用情况 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Show context window usage')}</span>
          </div>
          <Switch
            checked={settings.showContextUsage !== false}
            onChange={(checked) => void updateSettings({ showContextUsage: checked })}
            label={t('Show context window usage')}
          />
        </div>

        {/* 发送快捷键 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Send shortcut')}</span>
            <span className="settings-item-row__desc">{t('Choose whether pressing Enter sends or inserts a new line')}</span>
          </div>
          <SettingsIconSelect
            label={t('Send shortcut')}
            value={settings.sendShortcut ?? 'enter'}
            icons={{}}
            className="settings-icon-select--shortcut"
            onChange={(value) =>
              void updateSettings({ sendShortcut: value as 'enter' | 'ctrlEnter' })
            }
            options={[
              { value: 'enter', label: t('Press Enter'), icon: '' },
              { value: 'ctrlEnter', label: t('Press Ctrl+Enter'), icon: '' }
            ]}
          />
        </div>
      </SettingsGroup>

    </div>
  )
}
