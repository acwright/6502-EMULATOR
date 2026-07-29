import type { Session } from '@debug/Session'
import { SymbolTable } from '@debug/symbols/Symbols'
import type { DebugTarget } from '@debug/server/DebugTarget'

/**
 * Presents the desktop app's own machine to the debug protocol.
 *
 * The Electron counterpart to HeadlessTarget — same interface, same
 * `createMethods()` table, different host. The desktop app always populates
 * the video slot (`stores/emulator.ts` never overrides it), so this machine's
 * console is always the screen: no serial console methods, `screen.*` and
 * `input.*` are the way in. File reads proxy to main, which is the only
 * process with filesystem access.
 */
export class RendererTarget implements DebugTarget {
  readonly hostName = 'electron'
  readonly symbols = new SymbolTable()

  constructor(
    readonly session: Session,
    readonly version: string
  ) {}

  consoleMode(): 'serial' | 'video' {
    return 'video'
  }

  async readTextFile(path: string): Promise<string> {
    if (!window.api) throw new Error('no filesystem access outside the desktop app')
    return window.api.debug.readTextFile(path)
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    if (!window.api) throw new Error('no filesystem access outside the desktop app')
    return window.api.debug.readBinaryFile(path)
  }
}
