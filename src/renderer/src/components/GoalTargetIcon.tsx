/**
 * The goal mark: a bullseye whose centre is solid.
 *
 * Lucide's `Target` is three *stroked* circles, so its middle is a tiny ring —
 * at the 13px the chips use, the hole inside it is about one pixel wide and the
 * pill's own background shows through the middle of the mark. Drawing the same
 * geometry here with a filled centre keeps the footprint and leaves no gap: the
 * centre circle keeps its stroke and gains `fill`, so the dot is one solid disc
 * of the same radius at every size.
 */
export function GoalTargetIcon({
  size = 13,
  className
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
  )
}
