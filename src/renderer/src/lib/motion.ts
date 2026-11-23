/**
 * Whether the system asks for less movement.
 *
 * The app animates a lot — cards rise, turns flash, the view scrolls
 * smoothly — and all of it is decoration that can go when the system
 * says so.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The scrolling behaviour to use: smooth, unless motion is unwelcome. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}
