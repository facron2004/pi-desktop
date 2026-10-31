import { canonicalSessionFile } from './session-file'

/**
 * One writing turn per working directory.
 *
 * Viewing another conversation does not take the gate. A prompt or a bash
 * command does. The second session waits; it does not abort the holder.
 */
export class CwdGate {
  private holders = new Map<string, string>()

  static key(cwd: string): string {
    return canonicalSessionFile(cwd)
  }

  holder(cwd: string): string | undefined {
    if (!cwd) return undefined
    return this.holders.get(CwdGate.key(cwd))
  }

  /**
   * Reserve `cwd` for `key`.
   * The holder may reserve it again. A different key may not.
   */
  claim(cwd: string, key: string): boolean {
    if (!cwd) return true
    const id = CwdGate.key(cwd)
    const current = this.holders.get(id)
    if (current && current !== key) return false
    this.holders.set(id, key)
    return true
  }

  release(cwd: string, key: string): void {
    if (!cwd) return
    const id = CwdGate.key(cwd)
    if (this.holders.get(id) === key) this.holders.delete(id)
  }

  holds(key: string): boolean {
    for (const holder of this.holders.values()) {
      if (holder === key) return true
    }
    return false
  }

  retarget(from: string, to: string): void {
    for (const [cwd, holder] of this.holders) {
      if (holder === from) this.holders.set(cwd, to)
    }
  }
}
