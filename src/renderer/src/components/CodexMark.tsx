type CodexMarkProps = {
  className?: string
}

export function CodexMark({ className }: CodexMarkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21.5 24H10.7a7.2 7.2 0 1 1 1.5-14.2A9.2 9.2 0 0 1 28 15.2 6 6 0 0 1 21.5 24Z" />
      <path d="m12 14.2 2.6 2.1-2.6 2.1M17.3 18.4h3" />
    </svg>
  )
}
