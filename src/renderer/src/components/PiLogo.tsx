export function PiLogo({
  size = 16,
  className
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 886 886"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`pi-logo ${className ?? ''}`}
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {/* The mark is centred in a square canvas, matching the app icon. */}
      <g transform="translate(0 24)">
        {/* Blue body: top bar, both stems and both feet. */}
        <rect x="55" y="0" width="831" height="161" fill="var(--brand-mark-blue)" />
        <rect x="137" y="161" width="206" height="677" fill="var(--brand-mark-blue)" />
        <rect x="55" y="725" width="288" height="113" fill="var(--brand-mark-blue)" />
        <rect x="543" y="161" width="207" height="677" fill="var(--brand-mark-blue)" />
        <rect x="543" y="725" width="288" height="113" fill="var(--brand-mark-blue)" />

        {/* Coral corner and the upper half of the right leg. */}
        <rect x="0" y="0" width="169" height="105" fill="var(--brand-mark-coral)" />
        <rect x="0" y="105" width="55" height="56" fill="var(--brand-mark-coral)" />
        <rect x="543" y="161" width="207" height="185" fill="var(--brand-mark-coral)" />
        <rect x="543" y="346" width="108" height="125" fill="var(--brand-mark-coral)" />

        {/* Golden accents on the top bar and the left stem. */}
        <rect x="636" y="0" width="135" height="87" fill="var(--brand-mark-yellow)" />
        <rect x="137" y="289" width="80" height="162" fill="var(--brand-mark-yellow)" />
      </g>
    </svg>
  )
}
