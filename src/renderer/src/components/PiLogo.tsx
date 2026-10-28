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
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`pi-logo ${className ?? ''}`}
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      {/* Top bar & right hook (Coral #F09082) */}
      <rect x="0" y="0" width="4" height="4" rx="0.5" fill="#F09082" />
      <rect x="4" y="0" width="4" height="4" rx="0.5" fill="#F09082" />
      <rect x="8" y="0" width="4" height="4" rx="0.5" fill="#F09082" />
      <rect x="8" y="4" width="4" height="4" rx="0.5" fill="#F09082" />

      {/* Left stem & middle branch (Blue #4D9ABF) */}
      <rect x="0" y="4" width="4" height="4" rx="0.5" fill="#4D9ABF" />
      <rect x="0" y="8" width="4" height="4" rx="0.5" fill="#4D9ABF" />
      <rect x="4" y="8" width="4" height="4" rx="0.5" fill="#4D9ABF" />
      <rect x="0" y="12" width="4" height="4" rx="0.5" fill="#4D9ABF" />

      {/* Right leg (Yellow #F1BE58) */}
      <rect x="12" y="8" width="4" height="4" rx="0.5" fill="#F1BE58" />
      <rect x="12" y="12" width="4" height="4" rx="0.5" fill="#F1BE58" />
    </svg>
  )
}
