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
        {/* Fills are classes, not presentation attributes. An attribute of
            fill="var(--brand-mark-blue)" is resolved once on some Chromium
            builds and then ignores a theme change, so the light mark stays
            the dark blue. */}
        <rect className="pi-logo__blue" x="55" y="0" width="831" height="161" />
        <rect className="pi-logo__blue" x="137" y="161" width="206" height="677" />
        <rect className="pi-logo__blue" x="55" y="725" width="288" height="113" />
        <rect className="pi-logo__blue" x="543" y="161" width="207" height="677" />
        <rect className="pi-logo__blue" x="543" y="725" width="288" height="113" />

        <rect className="pi-logo__coral" x="0" y="0" width="169" height="105" />
        <rect className="pi-logo__coral" x="0" y="105" width="55" height="56" />
        <rect className="pi-logo__coral" x="543" y="161" width="207" height="185" />
        <rect className="pi-logo__coral" x="543" y="346" width="108" height="125" />

        <rect className="pi-logo__yellow" x="636" y="0" width="135" height="87" />
        <rect className="pi-logo__yellow" x="137" y="289" width="80" height="162" />
      </g>
    </svg>
  )
}
