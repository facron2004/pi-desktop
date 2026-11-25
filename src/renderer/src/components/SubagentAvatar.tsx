import cap from '../assets/subagents/pi-cap.png'
import monocle from '../assets/subagents/pi-monocle.png'
import cat from '../assets/subagents/pi-cat.png'
import wings from '../assets/subagents/pi-wings.png'
import type { SubagentTreeTask } from '../lib/subagents'
import '../styles/subagent-avatar.css'

const AVATARS = [cap, monocle, cat, wings]

type AvatarProps = { size?: number } & (
  | { task: Pick<SubagentTreeTask, 'id' | 'label' | 'source'>; workerName?: never }
  | { workerName: string; task?: never }
)

export function SubagentAvatar({ task, workerName, size = 18 }: AvatarProps) {
  // Rotate through the palette within each dispatch. A named Swarm worker
  // keeps its face across assignments. Both keys survive session replay.
  const worker = workerName || (task?.source === 'swarm' ? task.label : undefined)
  const id = task?.id ?? ''
  const separator = id.lastIndexOf(':')
  const key = worker || (separator < 0 ? id : id.slice(0, separator))
  const slot = worker || separator < 0 ? 0 : Number(id.slice(separator + 1))
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash, 31) + key.charCodeAt(index)
  }
  const src = AVATARS[((hash >>> 0) + slot) % AVATARS.length]

  return <img className="subagent-avatar" src={src} width={size} height={size} alt="" draggable={false} />
}
