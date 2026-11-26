import { useEffect, useMemo, useRef, useState } from 'react'
import { RotateCcw, Search } from 'lucide-react'
import type { ProjectIconColor } from '@shared/types'
import {
  PROJECT_ICON_COLORS,
  projectIconColor
} from '../lib/project-icons'
import { searchProjectIcons } from '../lib/project-icon-search'
import { useT } from '../lib/i18n'

/** How many emoji the grid shows at once. */
const PAGE = 96

interface ProjectIconPickerProps {
  /** The emoji the project wears now, if any. */
  icon: string | undefined
  /** The tint it wears now. */
  color: ProjectIconColor
  /** Called with the new emoji and tint. */
  onPick: (icon: string, color: ProjectIconColor) => void
  /** Called when the project goes back to the folder icon. */
  onReset: () => void
}

/**
 * The emoji a project wears.
 *
 * MCode opens this from the project icon; the shape of the picker is the
 * same — a search field, a row of tints, and a grid of emoji — but it only
 * offers emoji, because Pi Desktop has no second icon set.
 */
export function ProjectIconPicker({
  icon,
  color,
  onPick,
  onReset
}: ProjectIconPickerProps) {
  const t = useT()
  const [query, setQuery] = useState('')
  // The tint is chosen here as well as on the project: picking a colour and
  // then an emoji has to end up with both.
  const [tint, setTint] = useState<ProjectIconColor>(projectIconColor(color))
  const [roving, setRoving] = useState<number | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const entries = useMemo(() => searchProjectIcons(query).slice(0, PAGE), [query])
  useEffect(() => setRoving(null), [query])
  const selected = entries.findIndex((entry) => entry.emoji === icon)
  const tabbable = roving !== null && roving < entries.length ? roving : Math.max(0, selected)

  return (
    <div className="project-icon-picker" role="dialog" aria-label={t('Change project icon')}>
      <div className="project-icon-picker__head">
        <div className="project-icon-picker__search">
          <Search size={13} />
          <input
            ref={searchRef}
            value={query}
            autoFocus
            placeholder={t('Search emoji')}
            aria-label={t('Search emoji')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown') return
              const first = gridRef.current?.querySelector<HTMLElement>('.project-icon-picker__option')
              if (!first) return
              event.preventDefault()
              event.stopPropagation()
              first.focus()
            }}
          />
        </div>
        <button
          type="button"
          className="project-icon-picker__reset"
          disabled={!icon}
          onClick={onReset}
        >
          <RotateCcw size={12} />
          <span>{t('Reset')}</span>
        </button>
      </div>

      <div
        className="project-icon-picker__colors"
        role="group"
        aria-label={t('Icon colour')}
      >
        {PROJECT_ICON_COLORS.map((name) => (
          <button
            key={name}
            type="button"
            className="project-icon-picker__color"
            data-icon-color={name}
            aria-label={t(COLOUR_LABELS[name])}
            aria-pressed={tint === name}
            onClick={() => {
              setTint(name)
              onPick(icon ?? '', name)
            }}
          >
            <span className="project-icon-picker__dot" />
          </button>
        ))}
      </div>

      <div
        className="project-icon-picker__grid"
        ref={gridRef}
        onKeyDown={(event) => {
          // A grid of 96 emoji is one Tab stop and two dimensions of arrows.
          // The popover's own arrow handler walks every button; this stops it
          // for the keys the grid owns so focus moves one cell, not twice.
          if (event.altKey || event.ctrlKey || event.metaKey) return
          const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
          if (!keys.includes(event.key)) return
          const target = event.target
          if (!(target instanceof HTMLElement) || !target.matches('.project-icon-picker__option')) return
          const options = [
            ...(gridRef.current?.querySelectorAll<HTMLElement>('.project-icon-picker__option') ?? [])
          ]
          const index = options.indexOf(target)
          if (index < 0) return
          const columns = Math.max(
            1,
            (getComputedStyle(gridRef.current as HTMLElement).gridTemplateColumns.split(' ').filter(Boolean).length)
          )
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'ArrowUp' && index < columns) {
            searchRef.current?.focus()
            return
          }
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? options.length - 1
                : event.key === 'ArrowLeft'
                  ? Math.max(0, index - 1)
                  : event.key === 'ArrowRight'
                    ? Math.min(options.length - 1, index + 1)
                    : event.key === 'ArrowUp'
                      ? Math.max(0, index - columns)
                      : Math.min(options.length - 1, index + columns)
          const option = options[next]
          if (!option) return
          setRoving(next)
          option.focus()
          option.scrollIntoView({ block: 'nearest' })
        }}
      >
        {entries.length === 0 ? (
          <div className="project-icon-picker__empty">{t('No emoji matches')}</div>
        ) : (
          entries.map((entry, index) => (
            <button
              key={`${entry.category}-${entry.emoji}`}
              type="button"
              className="project-icon-picker__option"
              aria-label={entry.keywords || entry.emoji}
              aria-pressed={icon === entry.emoji}
              tabIndex={index === tabbable ? 0 : -1}
              onFocus={() => setRoving(index)}
              onClick={() => onPick(entry.emoji, tint)}
            >
              {entry.emoji}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

/** The English name of each tint. The picker shows them as tooltips. */
const COLOUR_LABELS: Record<ProjectIconColor, string> = {
  neutral: 'Neutral',
  yellow: 'Yellow',
  orange: 'Orange',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  red: 'Red'
}
