import { AppWindow, FileText, Sparkles, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PiCommand } from '@shared/types'

/** How a command is marked, wherever it is shown. */
export const COMMAND_SOURCE: Record<
  PiCommand['source'],
  { label: string; Icon: LucideIcon; className: string }
> = {
  skill: { label: 'Skill', Icon: Sparkles, className: 'palette__badge--skill' },
  prompt: { label: 'Prompt', Icon: FileText, className: 'palette__badge--prompt' },
  extension: { label: 'Extension', Icon: Wrench, className: 'palette__badge--extension' },
  app: { label: 'App', Icon: AppWindow, className: 'palette__badge--app' }
}
