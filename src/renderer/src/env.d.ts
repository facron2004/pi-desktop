/// <reference types="vite/client" />

import type { PiDesktopBridge } from '@shared/types'

declare global {
  interface Window {
    pi: PiDesktopBridge
  }
}

export {}
