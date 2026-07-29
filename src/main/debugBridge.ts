import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { DebugServer } from '../debug/server/DebugServer'
import { RpcMethodError } from '../debug/server/Protocol'
import { IPC } from '../shared/types'
import type { DebugCallReply, DebugEventMessage, DebugServerStatus, DebugStartOptions } from '../shared/types'

/** How long main waits for the renderer to answer one call before giving up. */
const CALL_TIMEOUT_MS = 15_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The main-process half of the Electron debug bridge (PLAN.md §4.3).
 *
 * Main is where a socket can actually be bound; the Session a debugger wants
 * to drive lives in the renderer. So this owns the `DebugServer` but supplies
 * it a `dispatch` that hands every call to the renderer over IPC and waits —
 * this class never touches a Session directly, which is exactly the point:
 * the renderer's own `createMethods()` table is the only place a call
 * actually executes, so the headless host and the desktop app can never
 * silently diverge on what a method does.
 */
export class DebugBridgeService {
  private window?: BrowserWindow
  private server?: DebugServer
  private listening?: { host: string; port: number; token: string; url: string }

  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private eventCallback?: (method: string, params: unknown) => void

  setWindow(window: BrowserWindow): void {
    this.window = window
  }

  get isRunning(): boolean {
    return this.server !== undefined
  }

  status(): DebugServerStatus {
    return this.listening
      ? { running: true, ...this.listening }
      : { running: false }
  }

  async start(options: DebugStartOptions = {}): Promise<DebugServerStatus> {
    if (this.server) return this.status()

    const server = new DebugServer({
      hostName: 'electron',
      version: app.getVersion(),
      hostKind: 'electron',
      dispatch: (method, params) => this.callRenderer(method, params),
      onEvent: (callback) => {
        this.eventCallback = callback
        return () => {
          this.eventCallback = undefined
        }
      },
      ...(options.host ? { host: options.host } : {}),
      ...(options.port ? { port: options.port } : {}),
      ...(options.requireToken ? { requireToken: true } : {}),
      onLog: (message) => console.warn('[debug]', message)
    })

    this.listening = await server.listen()
    this.server = server
    return this.status()
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = undefined
    this.listening = undefined

    // Nothing still waiting on the renderer should hang once there is no
    // server left to answer through.
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('debug server stopped'))
      this.pending.delete(id)
    }

    await server.close()
  }

  /** A reply the renderer sent back for a call this service made. */
  handleReply(reply: DebugCallReply): void {
    const entry = this.pending.get(reply.id)
    if (!entry) return // late reply for a call that already timed out
    this.pending.delete(reply.id)
    clearTimeout(entry.timer)

    if (reply.error) {
      entry.reject(new RpcMethodError(reply.error.code, reply.error.message, reply.error.data))
    } else {
      entry.resolve(reply.result)
    }
  }

  /** A push event (`stopped`, `resumed`, ...) the renderer wants broadcast. */
  handleEvent(event: DebugEventMessage): void {
    this.eventCallback?.(event.method, event.params)
  }

  private callRenderer(method: string, params: unknown): Promise<unknown> {
    const window = this.window
    if (!window || window.isDestroyed()) {
      return Promise.reject(new RpcMethodError(-32000, 'the app window is not available'))
    }

    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcMethodError(-32000, `${method}: the renderer did not respond in time`))
      }, CALL_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })
      window.webContents.send(IPC.DEBUG_CALL_REQUEST, { id, method, params })
    })
  }
}
