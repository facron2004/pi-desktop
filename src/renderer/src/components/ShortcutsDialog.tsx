import { X } from 'lucide-react'

const SHORTCUTS: { keys: string[]; label: string; group: string }[] = [
  { keys: ['Ctrl', 'N'], label: 'Start a new conversation', group: 'Workspace' },
  { keys: ['Ctrl', 'B'], label: 'Show or hide the sidebar', group: 'Workspace' },
  { keys: ['Ctrl', 'K'], label: 'Focus the composer', group: 'Workspace' },
  { keys: ['Ctrl', 'F'], label: 'Search the conversation', group: 'Workspace' },
  { keys: ['Ctrl', '/'], label: 'Show this shortcut list', group: 'Workspace' },
  { keys: ['Enter'], label: 'Send the message', group: 'Composing' },
  { keys: ['Shift', 'Enter'], label: 'Insert a line break', group: 'Composing' },
  { keys: ['↑'], label: 'Recall the previous prompt', group: 'Composing' },
  { keys: ['↓'], label: 'Recall an older prompt', group: 'Composing' },
  { keys: ['/'], label: 'Open the command palette', group: 'Composing' },
  { keys: ['Esc'], label: 'Stop the running turn', group: 'Composing' },
  { keys: ['↑', '↓'], label: 'Move through the command list', group: 'Command palette' },
  { keys: ['Tab'], label: 'Insert the highlighted command', group: 'Command palette' },
  { keys: ['Enter'], label: 'Go to the next search hit', group: 'Search' },
  { keys: ['Shift', 'Enter'], label: 'Go to the previous search hit', group: 'Search' },
  { keys: ['Esc'], label: 'Close the search bar', group: 'Search' }
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const groups = Array.from(new Set(SHORTCUTS.map((entry) => entry.group)))

  return (
    <div className="modal-layer" onMouseDown={onClose}>
      <div className="modal modal--narrow" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Keyboard shortcuts</h2>
          <button className="icon-btn" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="modal__body">
          {groups.map((group) => (
            <section className="shortcut-group" key={group}>
              <h3 className="shortcut-group__title">{group}</h3>
              {SHORTCUTS.filter((entry) => entry.group === group).map((entry) => (
                <div className="shortcut" key={entry.label}>
                  <span className="shortcut__label">{entry.label}</span>
                  <span className="shortcut__keys">
                    {entry.keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>

        <div className="modal__foot">
          <button className="btn btn--primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
