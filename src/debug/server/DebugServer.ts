import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { MethodTable } from './Methods'
import {
  ErrorCode,
  RpcMethodError,
  errorResponse,
  isRequest,
  notification,
  response
} from './Protocol'
import type { RpcResponse } from './Protocol'
import { acceptKey, WebSocketConnection, MAX_MESSAGE_BYTES } from './WebSocket'
import { clearLock, defaultLockPath, writeLock } from './LockFile'
import type { SessionLock } from './LockFile'

export interface DebugServerOptions {
  hostName: string
  version: string
  hostKind: 'headless' | 'electron'

  /**
   * Execute calls directly — a method table already built by createMethods(),
   * for a host that owns its own Session.
   */
  methods?: MethodTable

  /**
   * Forward calls elsewhere instead of executing them here.
   *
   * What the Electron main process uses: its own Session lives in the
   * renderer (§4.3), so main is a relay rather than an executor. `methods` and
   * `dispatch` are mutually exclusive on purpose — a host either can run a
   * call or it can't, and mixing the two would risk half of a protocol
   * silently degrading to NOT_FOUND on the wrong side of the bridge.
   */
  dispatch?: (method: string, params: unknown) => Promise<unknown>

  /**
   * Push events the backend originates — `stopped`, `resumed`, `serial.data`,
   * `log` — forwarded verbatim to every attached WebSocket client. Returns an
   * unsubscribe.
   */
  onEvent(callback: (method: string, params: unknown) => void): () => void

  /** Interface to bind. Loopback unless deliberately changed. */
  host?: string
  /** 0 asks the OS for a free port, which is then published in the lock file. */
  port?: number

  /** Shared secret. Generated when not supplied. */
  token?: string
  /**
   * Demand the token even from loopback clients.
   *
   * Off by default: on loopback the lock file is already readable only by this
   * user, so anything that could read the token could equally attach a debugger
   * to the process. Binding to any other interface flips this on regardless.
   */
  requireToken?: boolean

  /** Where to publish host/port/token. `false` publishes nowhere. */
  lockFile?: string | false

  /** Browser origins permitted to connect. Empty means none, which is the point. */
  allowedOrigins?: string[]

  /** Somewhere to report connection-level problems. */
  onLog?: (message: string) => void
}

export interface ListenResult {
  host: string
  port: number
  token: string
  url: string
}

/** Bodies larger than this are refused before being buffered. */
const MAX_BODY_BYTES = MAX_MESSAGE_BYTES

/**
 * JSON-RPC over a loopback socket, in two shapes for two callers.
 *
 * **WebSocket** for anything that stays attached — an interactive monitor, a
 * VSCode session — because those need server-initiated notifications when the
 * machine hits a breakpoint or prints a line.
 *
 * **`POST /rpc`** for one-shot calls, because that is what an agent does. Every
 * `6502 dbg` invocation is a fresh process with no session to resume, and
 * making it complete a WebSocket handshake to ask for the registers would be
 * pure ceremony.
 */
export class DebugServer {
  private readonly server: Server
  private readonly sockets = new Set<WebSocketConnection>()
  private readonly unsubscribes: (() => void)[] = []

  private readonly lockPath: string | undefined
  private readonly onLog?: (message: string) => void

  readonly token: string
  private listening?: ListenResult

  constructor(private readonly options: DebugServerOptions) {
    if (!options.methods && !options.dispatch) {
      throw new Error('DebugServer: needs either methods or dispatch')
    }

    this.token = options.token ?? randomBytes(32).toString('hex')
    this.onLog = options.onLog

    this.lockPath =
      options.lockFile === false ? undefined : (options.lockFile ?? defaultLockPath())

    this.server = createServer((request, reply) => this.onRequest(request, reply))
    this.server.on('upgrade', (request, socket, head) => this.onUpgrade(request, socket, head))
  }

  get host(): string {
    return this.options.host ?? '127.0.0.1'
  }

  /** True when bound somewhere other than the loopback interface. */
  private get isExposed(): boolean {
    const host = this.host
    return host !== '127.0.0.1' && host !== '::1' && host !== 'localhost'
  }

  async listen(): Promise<ListenResult> {
    if (this.listening) return this.listening

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.options.port ?? 0, this.host, () => {
        this.server.off('error', reject)
        resolve()
      })
    })

    const address = this.server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('debug server: could not determine the bound port')
    }

    this.listening = {
      host: this.host,
      port: address.port,
      token: this.token,
      url: `ws://${formatHost(this.host)}:${address.port}`
    }

    this.subscribe()
    this.publishLock()
    return this.listening
  }

  /** Forward the backend's own events to every attached client. */
  private subscribe(): void {
    this.unsubscribes.push(this.options.onEvent((method, params) => this.broadcast(method, params)))
  }

  private publishLock(): void {
    if (!this.lockPath || !this.listening) return

    const lock: SessionLock = {
      pid: process.pid,
      host: this.listening.host,
      port: this.listening.port,
      token: this.token,
      started: new Date().toISOString(),
      version: this.options.version,
      host_kind: this.options.hostKind,
      cwd: process.cwd()
    }

    try {
      writeLock(this.lockPath, lock)
    } catch (e) {
      // A server nobody can find is still a working server if the caller passes
      // --port, so this is a warning rather than a failure to start.
      this.log(`could not write the lock file at ${this.lockPath}: ${(e as Error).message}`)
    }
  }

  async close(): Promise<void> {
    for (const off of this.unsubscribes) off()
    this.unsubscribes.length = 0

    for (const socket of this.sockets) socket.close(1001, 'server shutting down')
    this.sockets.clear()

    if (this.lockPath) clearLock(this.lockPath)
    this.listening = undefined

    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  /** Send a notification to every attached WebSocket client. */
  broadcast(method: string, params?: unknown): void {
    if (this.sockets.size === 0) return
    const text = JSON.stringify(notification(method, params))
    for (const socket of this.sockets) socket.send(text)
  }

  private log(message: string): void {
    this.onLog?.(message)
    this.broadcast('log', { message })
  }

  //
  // Authorisation
  //

  /**
   * Decide whether a request may proceed.
   *
   * Two separate concerns. The token answers "is this the client we told about
   * this session"; the Origin check answers "is this a web page the user
   * happens to have open". The second matters more than it looks: a loopback
   * server is reachable from any site the browser visits, and without this a
   * page could POST `mem.write` — or read the CF image — at will.
   */
  private authorise(request: IncomingMessage): string | undefined {
    const origin = request.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      const allowed = this.options.allowedOrigins ?? []
      if (!allowed.includes(origin)) {
        return `origin "${origin}" is not allowed to reach the debug server`
      }
    }

    const presented = tokenFrom(request)
    if (presented === undefined) {
      // Loopback callers may omit it; see requireToken in the options.
      if (this.isExposed || this.options.requireToken) return 'a token is required'
      return undefined
    }

    return matches(presented, this.token) ? undefined : 'the token is not valid'
  }

  //
  // HTTP
  //

  private onRequest(request: IncomingMessage, reply: ServerResponse): void {
    if (request.method !== 'POST' || !(request.url ?? '').startsWith('/rpc')) {
      sendJSON(reply, 404, { error: 'POST /rpc is the only endpoint' })
      return
    }

    const denied = this.authorise(request)
    if (denied) {
      sendJSON(reply, 401, { error: denied })
      return
    }

    // Requiring this content type is load-bearing, not pedantry: it is the one
    // a browser cannot send cross-origin without a preflight, which we never
    // answer. Without it a malicious page could fire commands at the machine
    // even though it could not read the replies.
    const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim()
    if (contentType !== 'application/json') {
      sendJSON(reply, 415, { error: 'Content-Type must be application/json' })
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let aborted = false

    request.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        sendJSON(reply, 413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` })
        request.destroy()
        return
      }
      chunks.push(chunk)
    })

    request.on('end', () => {
      if (aborted) return
      void this.handleText(Buffer.concat(chunks).toString('utf8')).then((result) => {
        // A body of only notifications has nothing to answer with.
        if (result === undefined) sendJSON(reply, 204, undefined)
        else sendJSON(reply, 200, result)
      })
    })
  }

  //
  // WebSocket
  //

  private onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if ((request.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      socket.destroy()
      return
    }

    const denied = this.authorise(request)
    if (denied) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n${denied}`)
      socket.destroy()
      return
    }

    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    )

    const connection = new WebSocketConnection(socket, {
      onMessage: (text) => {
        void this.handleText(text).then((result) => {
          if (result !== undefined) connection.send(JSON.stringify(result))
        })
      },
      onClose: () => this.sockets.delete(connection)
    })

    this.sockets.add(connection)
    // Anything that has just attached needs the machine's current state without
    // having to ask for it as a separate round trip.
    connection.send(
      JSON.stringify(
        notification('attached', {
          protocol: 1,
          host: this.options.hostName,
          version: this.options.version
        })
      )
    )

    if (head.length > 0) socket.unshift(head)
  }

  //
  // Dispatch
  //

  /** Parse a message and answer it. Undefined means nothing to send back. */
  private async handleText(text: string): Promise<RpcResponse | RpcResponse[] | undefined> {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      return errorResponse(null, ErrorCode.PARSE_ERROR, (e as Error).message)
    }

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return errorResponse(null, ErrorCode.INVALID_REQUEST, 'empty batch')
      }
      const results = await Promise.all(parsed.map((entry) => this.dispatch(entry)))
      const answers = results.filter((entry): entry is RpcResponse => entry !== undefined)
      return answers.length > 0 ? answers : undefined
    }

    return this.dispatch(parsed)
  }

  private async dispatch(raw: unknown): Promise<RpcResponse | undefined> {
    if (!isRequest(raw)) {
      return errorResponse(null, ErrorCode.INVALID_REQUEST, 'not a JSON-RPC 2.0 request')
    }

    // A request without an id is a notification: run it, answer nothing — not
    // even on failure, which the spec is explicit about.
    const id = raw.id ?? null
    const wantsReply = raw.id !== undefined && raw.id !== null

    const handler = this.options.methods?.[raw.method]
    if (!handler && !this.options.dispatch) {
      return wantsReply
        ? errorResponse(id, ErrorCode.METHOD_NOT_FOUND, `no such method "${raw.method}"`)
        : undefined
    }

    try {
      const result = handler ? await handler(raw.params) : await this.options.dispatch!(raw.method, raw.params)
      return wantsReply ? response(id, result) : undefined
    } catch (e) {
      if (!wantsReply) return undefined
      if (e instanceof RpcMethodError) {
        return errorResponse(id, e.code, e.message, e.data)
      }
      const message = e instanceof Error ? e.message : String(e)
      return errorResponse(id, ErrorCode.INTERNAL_ERROR, `${raw.method}: ${message}`)
    }
  }
}

/** Bearer token from the header, or the query string a browser API cannot set. */
function tokenFrom(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match) return match[1]
  }

  // The WHATWG WebSocket API — including Node's own client — cannot set request
  // headers, so the query string is the only place a token can go on a connect.
  const url = request.url ?? ''
  const query = url.indexOf('?')
  if (query === -1) return undefined
  return new URLSearchParams(url.slice(query + 1)).get('token') ?? undefined
}

/** Constant-time comparison, so a wrong token leaks nothing about the right one. */
function matches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function sendJSON(reply: ServerResponse, status: number, body: unknown): void {
  if (body === undefined) {
    reply.writeHead(status)
    reply.end()
    return
  }
  const text = JSON.stringify(body)
  reply.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text)
  })
  reply.end(text)
}

/** IPv6 literals need brackets in a URL. */
const formatHost = (host: string): string => (host.includes(':') ? `[${host}]` : host)
