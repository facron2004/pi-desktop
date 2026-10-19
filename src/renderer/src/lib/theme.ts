import { useEffect, useState } from 'react'

/**
 * Whether the app is currently in the dark theme.
 *
 * The theme lives on the document element, so the change is observed there
 * instead of being read once.
 */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== 'light')

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.dataset.theme !== 'light')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return dark
}
