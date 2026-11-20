import type { InspectorRequest } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { normalizeExternalUrl } from './url-link'

/**
 * Open a link where the reader asked links to go.
 *
 * `urlOpenTarget` is a setting: `external` hands the URL to the OS default
 * browser, `internal` loads it in the app's own Browser page. Both paths end up
 * somewhere the reader can read the page — never in the file manager, which is
 * what a URL mistaken for a project file used to do.
 */
export function openResolvedUrl(value: string): void {
  const url = normalizeExternalUrl(value)
  if (!url) return
  const target = useAppStore.getState().settings.urlOpenTarget ?? 'external'
  if (target === 'internal') {
    window.dispatchEvent(
      new CustomEvent<InspectorRequest>('pi:open-inspector', {
        detail: { tab: 'browser', url }
      })
    )
    return
  }
  void window.pi.shell.openExternal(url)
}
