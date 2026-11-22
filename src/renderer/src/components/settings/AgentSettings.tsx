import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ModelInfo, PermissionMode } from '@shared/types'
import { resolveSavedModel, selectableModels } from '@shared/provider-models'
import { useT } from '../../lib/i18n'
import { DEFAULT_THINKING_LEVELS } from '../../lib/thinking'
import { useAppStore } from '../../store/useAppStore'
import { ConfirmDialog } from '../ConfirmDialog'
import { Switch } from '../Switch'
import { PageIntro, SettingsGroup, SettingsSelect, type SettingsSelectOption } from './SettingsShared'
import '../../styles/settings-agent.css'

const modelSpec = (model: ModelInfo): string => `${model.provider}/${model.id}`

/**
 * The three levels with the exact words `PermissionPicker` shows. That list is
 * private to the component, so the strings live here too; sharing the English
 * keys is what keeps the two dialogs from drifting into different wording.
 */
const PERMISSION_MODES: { value: PermissionMode; label: string; description: string }[] = [
  { value: 'ask', label: 'Request approval', description: 'Ask before every agent tool operation.' },
  {
    value: 'auto',
    label: 'Approve for me',
    description: 'Approve ordinary files in the working folder; ask for commands and other access.'
  },
  { value: 'full', label: 'Full access', description: 'Allow all agent tools without approval.' }
]

/** The row shape GeneralSettings uses: title and description left, control right. */
function SettingsItemRow({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    // The page's own row class: these descriptions are two lines long, and the
    // shared row sizes its text column by content — which pushed the control
    // onto a second line instead of holding it on the row's right edge.
    <div className="settings-item-row settings-item-row--agent">
      <div className="settings-item-row__info">
        <span className="settings-item-row__title">{title}</span>
        {description ? <span className="settings-item-row__desc">{description}</span> : null}
      </div>
      {children}
    </div>
  )
}

/**
 * Models the selects on this page can offer.
 *
 * The saved provider catalog is folded in with whatever the live process
 * published, so a default can be chosen while no Pi process is running. The
 * grouping is the composer picker's: providers in first-appearance order, Pi's
 * order preserved inside each provider.
 */
function useModelChoices(): { models: ModelInfo[]; groups: [string, ModelInfo[]][] } {
  const runtimeModels = useAppStore((state) => state.models)
  const catalogModels = useAppStore((state) => state.catalogModels)
  const disabledModelSpecs = useAppStore((state) => state.disabledModelSpecs)
  const models = useMemo(
    () => selectableModels(runtimeModels, catalogModels, disabledModelSpecs),
    [runtimeModels, catalogModels, disabledModelSpecs]
  )
  const groups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>()
    for (const model of models) {
      const group = map.get(model.provider)
      if (group) group.push(model)
      else map.set(model.provider, [model])
    }
    return [...map]
  }, [models])
  return { models, groups }
}

function ModelSelect({
  label,
  value,
  groups,
  emptyLabel,
  onChange,
  className
}: {
  label: string
  value: string
  groups: [string, ModelInfo[]][]
  emptyLabel?: string
  onChange: (spec: string) => void
  className?: string
}) {
  const t = useT()
  // A saved pair the catalog no longer offers still has to appear in the
  // control. Dropping it would paint the first row and claim that was the choice.
  const listed = groups.some(([, list]) => list.some((model) => modelSpec(model) === value))
  const options: SettingsSelectOption[] = []
  if (emptyLabel) options.push({ value: '', label: emptyLabel })
  for (const [provider, list] of groups) {
    for (const model of list) {
      options.push({ value: modelSpec(model), label: model.name || model.id, group: provider })
    }
  }
  if (value && !listed) options.push({ value, label: value })
  // Nothing to list is worth saying out loud; a bare default looks like a choice.
  if (groups.length === 0) {
    return (
      <SettingsSelect
        label={label}
        value=""
        options={[{ value: '', label: t('No models yet.'), disabled: true }]}
        onChange={() => undefined}
        menuWidth={300}
        className={className}
      />
    )
  }
  return (
    <SettingsSelect
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      menuWidth={300}
      className={className}
    />
  )
}

/**
 * A reasoning-effort select.
 *
 * The levels Pi reports belong to the model on screen. A saved effort that came
 * from another model is still offered, or the control would read as unset.
 */
function LevelSelect({
  label,
  value,
  levels,
  emptyLabel,
  onChange
}: {
  label: string
  value: string
  levels: readonly string[]
  emptyLabel: string
  onChange: (level: string) => void
}) {
  const t = useT()
  const levelLabel = (level: string) => t(level.charAt(0).toUpperCase() + level.slice(1))
  const match = value
    ? levels.find((level) => level.toLowerCase() === value.toLowerCase())
    : undefined
  const options: SettingsSelectOption[] = [{ value: '', label: emptyLabel }]
  for (const level of levels) {
    options.push({ value: level, label: levelLabel(level) })
  }
  if (value && !match) options.push({ value, label: levelLabel(value) })
  return (
    <SettingsSelect
      label={label}
      value={match ?? value}
      options={options}
      onChange={onChange}
      menuWidth={200}
    />
  )
}

/**
 * The defaults a new conversation starts with and how its work is shown.
 * Every control saves on the spot — this dialog has no save button.
 */
export function AgentSettings() {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const refreshModelCatalog = useAppStore((state) => state.refreshModelCatalog)
  const liveLevels = useAppStore((state) => state.thinkingLevels)
  const t = useT()
  const { models, groups } = useModelChoices()
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)

  // A provider saved in the Model page is not in this store until the catalog is
  // re-read, and this page has to work with no Pi process to tell it otherwise.
  useEffect(() => {
    void refreshModelCatalog()
  }, [refreshModelCatalog])

  // This is a saved default for new conversations, so it can use Pi's generic
  // effort choices even when no running session has reported model-specific levels.
  const levels: readonly string[] = liveLevels.length > 0 ? liveLevels : DEFAULT_THINKING_LEVELS
  const permissionMode = settings.permissionMode ?? 'ask'
  const defaultModel = resolveSavedModel(settings.model, settings.provider, models)
  const subagentModel = resolveSavedModel(settings.subagentModel, settings.subagentProvider, models)

  const saveModel = (spec: string) => {
    if (!spec) {
      void updateSettings({ model: undefined, provider: undefined })
      return
    }
    const model = models.find((item) => modelSpec(item) === spec)
    if (!model) return
    // Kept in the shape the rest of the app compares: `provider/id`, plus the
    // provider id on its own, exactly as `setModel` writes the live choice.
    void updateSettings({ model: spec, provider: model.provider })
  }

  const saveSubagentModel = (spec: string) => {
    if (!spec) {
      void updateSettings({ subagentModel: undefined, subagentProvider: undefined })
      return
    }
    const model = models.find((item) => modelSpec(item) === spec)
    if (!model) return
    void updateSettings({ subagentModel: spec, subagentProvider: model.provider })
  }

  const savePermission = (value: PermissionMode) => {
    void updateSettings({ permissionMode: value })
  }

  // The picker's safety step, kept here too: full access is never one click away.
  const pickPermission = (value: PermissionMode) => {
    if (value === permissionMode) return
    if (value === 'full') {
      setConfirmFullAccess(true)
      return
    }
    savePermission(value)
  }

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Agent and conversation')}
        description={t('What every new conversation starts with, and how the work it does is shown to you.')}
      />

      <SettingsGroup title={t('Agent defaults')}>
        <SettingsItemRow
          title={t('Default model')}
          description={t('The model a new conversation starts with. The conversation on screen keeps the model it already chose.')}
        >
          <ModelSelect
            label={t('Default model')}
            value={defaultModel ? modelSpec(defaultModel) : ''}
            groups={groups}
            emptyLabel={t('Automatic (Pi default)')}
            onChange={saveModel}
          />
        </SettingsItemRow>

        <SettingsItemRow
          title={t('Default permission')}
          description={t('How Pi asks before it uses a tool. This one applies straight away, including to a conversation already running.')}
        >
          <div className="segmented" role="group" aria-label={t('Default permission')}>
            {PERMISSION_MODES.map((entry) => {
              const active = entry.value === permissionMode
              return (
                <button
                  key={entry.value}
                  type="button"
                  data-active={active}
                  aria-pressed={active}
                  title={t(entry.description)}
                  onClick={() => pickPermission(entry.value)}
                >
                  {t(entry.label)}
                </button>
              )
            })}
          </div>
        </SettingsItemRow>

        {/* Seven effort levels do not fit one segmented control, so this row
            gets a select; the scale is Pi's, not a made-up shortlist. */}
        <SettingsItemRow
          title={t('Default reasoning effort')}
          description={t('The reasoning effort a new conversation starts with. Automatic leaves the choice to Pi.')}
        >
          <LevelSelect
            label={t('Default reasoning effort')}
            value={settings.thinkingLevel ?? ''}
            levels={levels}
            emptyLabel={t('Automatic (Pi default)')}
            onChange={(level) => void updateSettings({ thinkingLevel: level || undefined })}
          />
        </SettingsItemRow>

        <SettingsItemRow
          title={t('Default plan mode')}
          description={t('Start new conversations in Plan Mode with read-only file tools, user questions, and plan review. Approving a plan starts implementation. Use /plan off to leave Plan Mode. Open and resumed conversations keep their saved mode.')}
        >
          <Switch
            checked={settings.defaultPlanMode === true}
            onChange={(checked) => void updateSettings({ defaultPlanMode: checked })}
            label={t('Default plan mode')}
          />
        </SettingsItemRow>
      </SettingsGroup>

      <SettingsGroup title={t('Subagents')}>
        <SettingsItemRow
          title={t('Subagent model')}
          description={t('The model a spawned subagent runs on. Follow the conversation keeps the model of the conversation that delegated the task. Reaches the subagents dispatched by conversations started from now on.')}
        >
          <ModelSelect
            label={t('Subagent model')}
            value={subagentModel ? modelSpec(subagentModel) : ''}
            groups={groups}
            emptyLabel={t('Follow the conversation')}
            className="settings-select--subagent"
            onChange={saveSubagentModel}
          />
        </SettingsItemRow>

        <SettingsItemRow
          title={t('Subagent reasoning effort')}
          description={t('The reasoning effort a spawned subagent runs with. The setup is written when a conversation starts, so it reaches the subagents of new conversations.')}
        >
          <LevelSelect
            label={t('Subagent reasoning effort')}
            value={settings.subagentThinking ?? ''}
            levels={levels}
            emptyLabel={t('Follow the conversation')}
            onChange={(level) => void updateSettings({ subagentThinking: level || undefined })}
          />
        </SettingsItemRow>
      </SettingsGroup>

      <SettingsGroup title={t('Composer')}>
        <SettingsItemRow
          title={t('Auto-mention pasted images')}
          description={t('Reference a pasted picture in the message, not only attach it.')}
        >
          <Switch
            checked={settings.pasteMentions === true}
            onChange={(checked) => void updateSettings({ pasteMentions: checked })}
            label={t('Auto-mention pasted images')}
          />
        </SettingsItemRow>
      </SettingsGroup>

      <SettingsGroup title={t('Message folding')}>
        <SettingsItemRow
          title={t('Auto-fold the working process')}
          description={t('Keep completed tool groups folded under a summary. Click the summary to see commands, results, and edits.')}
        >
          <Switch
            checked={settings.autoFoldProcess !== false}
            onChange={(checked) => void updateSettings({ autoFoldProcess: checked })}
            label={t('Auto-fold the working process')}
          />
        </SettingsItemRow>

        {/* A different thing from the row above: this one is about the live list
            while the agent works, not about a turn that has already settled. */}
        <SettingsItemRow
          title={t('Tool call summary')}
          description={t('Gather consecutive tool calls into one expandable summary while they run.')}
        >
          <Switch
            checked={settings.toolCallSummary !== false}
            onChange={(checked) => void updateSettings({ toolCallSummary: checked })}
            label={t('Tool call summary')}
          />
        </SettingsItemRow>
      </SettingsGroup>

      <SettingsGroup title={t('Chat titles')}>
        <SettingsItemRow
          title={t('Auto-generate title')}
          description={t('Name a new conversation from its first exchange. This spends one extra model call.')}
        >
          <Switch
            checked={settings.autoTitle === true}
            onChange={(checked) => void updateSettings({ autoTitle: checked })}
            label={t('Auto-generate title')}
          />
        </SettingsItemRow>
      </SettingsGroup>

      {confirmFullAccess
        ? createPortal(
            <ConfirmDialog
              className="permission-confirm"
              title={t('Enable full access?')}
              body={t(
                'Full access lets the agent read and change files outside the working folder, run commands, and access the network with your system account permissions. Tool operations will no longer ask for approval. You can switch back at any time.'
              )}
              tone="danger"
              onCancel={() => setConfirmFullAccess(false)}
              onConfirm={() => {
                setConfirmFullAccess(false)
                savePermission('full')
              }}
            />,
            document.body
          )
        : null}
    </div>
  )
}
