/** Reveal the app after bootstrap, or its error screen after a failed render. */
export function dismissStartupScreen(): void {
  const root = document.getElementById('root')
  root?.removeAttribute('inert')
  root?.removeAttribute('aria-hidden')
  const screen = document.getElementById('startup-screen')
  if (!screen || screen.dataset.ready === 'true') return
  screen.dataset.ready = 'true'
  screen.setAttribute('aria-hidden', 'true')
  screen.addEventListener('transitionend', () => screen.remove(), { once: true })
  // Reduced motion skips the transition, and a hidden window may not emit it.
  window.setTimeout(() => screen.remove(), 300)
}
