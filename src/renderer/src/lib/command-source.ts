import {
  AppWindow,
  ClipboardList,
  Copy,
  CopyPlus,
  Download,
  FileDiff,
  FileText,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  Image as ImageIcon,
  ListTree,
  MessageSquarePlus,
  Minimize2,
  Network,
  Pencil,
  Puzzle,
  Server,
  Sparkles,
  Target,
  Terminal,
  Users,
  Wrench
} from 'lucide-react'
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

/**
 * The mark of one app command.
 *
 * The app's commands are unrelated actions (rename, plan, export…), so the
 * window glyph the source shares would make a list of them read as one repeated
 * item. Skills, prompts and extensions only have their source to go on.
 */
const APP_COMMAND_ICONS: Record<string, LucideIcon> = {
  name: Pencil,
  plan: ClipboardList,
  goal: Target,
  subagent: Users,
  swarm: Network,
  plugin: Puzzle,
  image: ImageIcon,
  export: Download,
  duplicate: CopyPlus,
  branch: GitBranch,
  tree: ListTree,
  mcp: Server,
  compact: Minimize2,
  copy: Copy,
  changes: FileDiff,
  commit: GitCommitHorizontal,
  terminal: Terminal,
  files: FolderOpen,
  new: MessageSquarePlus
}

export function commandIcon(command: Pick<PiCommand, 'source' | 'name'>): LucideIcon {
  if (command.source === 'app') return APP_COMMAND_ICONS[command.name] ?? COMMAND_SOURCE.app.Icon
  return (COMMAND_SOURCE[command.source] ?? COMMAND_SOURCE.extension).Icon
}
