import { useMemo } from 'react'
import type { ModelInfo } from '@shared/types'
import { selectableModels } from '@shared/provider-models'
import { useT } from '../../lib/i18n'
import { useAppStore } from '../../store/useAppStore'
import { SettingsSelect, type SettingsSelectOption } from './SettingsShared'

/** `provider/id`, the one spelling every stored model choice uses. */
export function modelSpec(model: ModelInfo): string {
  return `${model.provider}/${model.id}`
}

/** A disabled row that says the catalog is empty; it is not a real choice. */
const NO_MODELS = '\u0000no-models'

/**
 * Models the settings selects can offer.
 *
 * The saved provider catalog is folded in with whatever the live process
 * published, so a choice can be made while no Pi process is running. The
 * grouping is the composer picker's: providers in first-appearance order, Pi's
 * order preserved inside each provider.
 */
export function useModelChoices(): { models: ModelInfo[]; groups: [string, ModelInfo[]][] } {
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

/**
 * One model, chosen from every model the app knows about.
 *
 * `emptyLabel` is what an unset choice reads as — a settings page uses it for
 * "follow the conversation" or "follow the current model", which is a real
 * option rather than a missing value.
 */
export function ModelSelect({
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
  // It is a disabled row beside the default rather than a replacement for it:
  // "follow the current model" is still a real answer when nothing is catalogued.
  if (groups.length === 0) {
    options.push({ value: NO_MODELS, label: t('No models yet.'), disabled: true })
  }
  return (
    <SettingsSelect
      label={label}
      value={value}
      options={options}
      onChange={(next) => {
        if (next !== NO_MODELS) onChange(next)
      }}
      menuWidth={300}
      className={className}
    />
  )
}
