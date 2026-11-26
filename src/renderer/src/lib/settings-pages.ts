/**
 * The settings dialog's pages.
 *
 * The ids live here rather than in the dialog because the search index has to
 * name them, and a library importing a React component would drag the whole
 * dialog into every module that only wants to know where a setting lives.
 */

export type SettingsPage =
  | 'general'
  | 'agent'
  | 'models'
  | 'appearance'
  | 'usage'
  | 'shortcuts'
  | 'personalization'
  | 'remote'
  | 'im-channels'
  | 'memory'
  | 'archived'
  | 'about'

/** The English page labels, keys in the i18n map. Icons live with the dialog. */
export const SETTINGS_PAGE_LABELS: Record<SettingsPage, string> = {
  general: 'General',
  agent: 'Agent and conversation',
  models: 'Model management',
  appearance: 'Appearance',
  usage: 'Usage',
  shortcuts: 'Keyboard shortcuts',
  personalization: 'Personalization',
  remote: 'Remote access',
  'im-channels': 'IM channels',
  memory: 'Memory',
  archived: 'Archived conversations',
  about: 'About'
}

/** The order the navigation draws; a search result follows it. */
export const SETTINGS_PAGE_IDS: readonly SettingsPage[] = [
  'general',
  'agent',
  'models',
  'appearance',
  'usage',
  'shortcuts',
  'personalization',
  'remote',
  'im-channels',
  'memory',
  'archived',
  'about'
]
