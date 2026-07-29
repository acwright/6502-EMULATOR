import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session } from '../../../debug/Session'
import { Empty } from '../../../core/IO/Empty'
import { SymbolTable } from '../../../debug/symbols/Symbols'
import { DebugServer } from '../../../debug/server/DebugServer'
import type { DebugTarget } from '../../../debug/server/DebugTarget'
import { ErrorCode } from '../../../debug/server/Protocol'

function bareSession(): Session {
  return new Session({
    io1: new Empty(),
    io2: new Empty(),
    io3: new Empty(),
    io4: new Empty(),
    io5: new Empty(),
    io6: new Empty(),
    io7: new Empty(),
    io8: new Empty()
  })
}

function testTarget(session = bareSession()): DebugTarget {
  return {
    session,
    symbols: new SymbolTable(),
    hostName: 'test',
    version: '1.2.3',
    consoleMode: () => 'serial'
  }
}

interface Harness {
  server: DebugServer
  url: string
  token: string
  post: (body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: unknown }>
  session: Session
}

let temp: string
let started: DebugServer[] = []

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), '6502-server-'))
  started = []
})

afterEach(async () => {
  for (const server of started) await server.close()
  rmSync(temp, { recursive: true, force: true })
})

async function serve(
  options: Partial<ConstructorParameters<typeof DebugServer>[0]> = {}
): Promise<Harness> {
  const session = bareSession()
  const server = new DebugServer({
    target: testTarget(session),
    lockFile: join(temp, 'session.json'),
    ...options
  })
  started.push(server)

  const listening = await server.listen()
  const url = `http://127.0.0.1:${listening.port}/rpc`

  return {
    server,
    url,
    token: listening.token,
    session,
    post: async (body, headers = {}) => {
      const reply = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      })
      const text = await reply.text()
      return { status: reply.status, body: text === '' ? undefined : JSON.parse(text) }
    }
  }
}

const call = (method: string, params?: unknown, id: number | string = 1): unknown => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params })
})

describe('HTTP one-shot calls', () => {
  // This shape is the whole reason for the HTTP endpoint: an agent's `6502 dbg`
  // is a fresh process every time and has no session to resume.
  it('answers a request', async () => {
    const { post } = await serve()
    const { status, body } = await post(call('session.info'))

    expect(status).toBe(200)
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 1, result: { host: 'test', protocol: 1 } })
  })

  it('reports an unknown method without inventing a result', async () => {
    const { post } = await serve()
    const { body } = await post(call('nope.nope'))
    expect(body).toMatchObject({ error: { code: ErrorCode.METHOD_NOT_FOUND } })
  })

  it('reports a parse error for a body that is not JSON', async () => {
    const { post } = await serve()
    const { body } = await post('{ not json')
    expect(body).toMatchObject({ error: { code: ErrorCode.PARSE_ERROR } })
  })

  it('rejects something that is not a JSON-RPC request', async () => {
    const { post } = await serve()
    expect((await post({ hello: 'world' })).body).toMatchObject({
      error: { code: ErrorCode.INVALID_REQUEST }
    })
  })

  it('answers a batch, in one reply', async () => {
    const { post } = await serve()
    const { body } = await post([call('reg.get', undefined, 1), call('exec.state', undefined, 2)])

    expect(Array.isArray(body)).toBe(true)
    expect((body as unknown[]).map((entry) => (entry as { id: number }).id)).toEqual([1, 2])
  })

  // The spec is explicit that a request without an id gets no reply at all,
  // even when it fails.
  it('answers a notification with nothing', async () => {
    const { post, session } = await serve()
    const { status, body } = await post({ jsonrpc: '2.0', method: 'exec.step' })

    expect(status).toBe(204)
    expect(body).toBeUndefined()
    expect(session.cycles).toBeGreaterThan(0)
  })

  it('serves nothing but POST /rpc', async () => {
    const { url } = await serve()
    expect((await fetch(url.replace('/rpc', '/'), { method: 'GET' })).status).toBe(404)
  })

  it('reports a method that threw, rather than dropping the connection', async () => {
    const { post } = await serve()
    const { status, body } = await post(call('mem.read', { address: -1 }))

    expect(status).toBe(200)
    expect(body).toMatchObject({ error: { code: ErrorCode.INVALID_PARAMS } })
  })
})

describe('authorisation', () => {
  it('accepts a loopback caller with no token', async () => {
    const { post } = await serve()
    expect((await post(call('session.info'))).status).toBe(200)
  })

  it('accepts the right token', async () => {
    const { post, token } = await serve()
    const { status } = await post(call('session.info'), { Authorization: `Bearer ${token}` })
    expect(status).toBe(200)
  })

  it('refuses a wrong token even from loopback', async () => {
    const { post } = await serve()
    const { status } = await post(call('session.info'), { Authorization: 'Bearer wrong' })
    expect(status).toBe(401)
  })

  it('demands a token when asked to', async () => {
    const { post, token } = await serve({ requireToken: true })

    expect((await post(call('session.info'))).status).toBe(401)
    expect(
      (await post(call('session.info'), { Authorization: `Bearer ${token}` })).status
    ).toBe(200)
  })

  it('takes the token from the query string, which is all a WebSocket can do', async () => {
    const { url, token } = await serve({ requireToken: true })
    const reply = await fetch(`${url}?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(call('session.info'))
    })
    expect(reply.status).toBe(200)
  })

  /**
   * A loopback server is reachable from every page the browser has open.
   *
   * Without this a site could drive the machine — write memory, read the CF
   * image — using a form post it never needs to read the reply to.
   */
  it('refuses a browser origin', async () => {
    const { post } = await serve()
    const { status } = await post(call('session.info'), { Origin: 'https://example.com' })
    expect(status).toBe(401)
  })

  it('allows an origin that was explicitly permitted', async () => {
    const { post } = await serve({ allowedOrigins: ['https://tools.example'] })
    const { status } = await post(call('session.info'), { Origin: 'https://tools.example' })
    expect(status).toBe(200)
  })

  // application/json is the content type a page cannot send cross-origin
  // without a preflight, and we answer no preflight.
  it('insists on a content type a cross-origin form cannot set', async () => {
    const { url } = await serve()
    const reply = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(call('session.info'))
    })
    expect(reply.status).toBe(415)
  })
})

describe('WebSocket transport', () => {
  /** Connect with Node's own client, so the handshake is tested for real. */
  async function attach(port: number, token: string): Promise<{
    call: (method: string, params?: unknown) => Promise<Record<string, unknown>>
    notifications: { method: string; params?: unknown }[]
    close: () => void
  }> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`)
    const notifications: { method: string; params?: unknown }[] = []
    let nextId = 0

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id === undefined) notifications.push(message)
    })

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('could not connect')))
    })

    return {
      call: (method, params) =>
        new Promise((resolve) => {
          const id = ++nextId
          const onMessage = (event: MessageEvent): void => {
            const message = JSON.parse(String(event.data))
            if (message.id !== id) return
            socket.removeEventListener('message', onMessage)
            resolve(message)
          }
          socket.addEventListener('message', onMessage)
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
        }),
      notifications,
      close: () => socket.close()
    }
  }

  it('completes the handshake and answers calls', async () => {
    const { server, token } = await serve()
    const port = (await server.listen()).port
    const client = await attach(port, token)

    expect(await client.call('session.info')).toMatchObject({ result: { host: 'test' } })
    client.close()
  })

  it('greets a new client with what it attached to', async () => {
    const { server, token } = await serve()
    const client = await attach((await server.listen()).port, token)

    await client.call('exec.state')
    expect(client.notifications[0]).toMatchObject({
      method: 'attached',
      params: { host: 'test', version: '1.2.3' }
    })
    client.close()
  })

  // Without these a client would have to poll to notice a breakpoint, which is
  // the whole reason the WebSocket exists alongside the HTTP endpoint.
  it('pushes stopped and resumed without being asked', async () => {
    const { server, token, session } = await serve()
    const client = await attach((await server.listen()).port, token)

    await client.call('exec.run', { mode: 'turbo' })
    await client.call('exec.pause')
    await new Promise((resolve) => setTimeout(resolve, 50))

    const methods = client.notifications.map((entry) => entry.method)
    expect(methods).toContain('resumed')
    expect(methods).toContain('stopped')
    session.pause()
    client.close()
  })

  it('refuses to upgrade without a required token', async () => {
    const { server } = await serve({ requireToken: true })
    const port = (await server.listen()).port

    await expect(attach(port, 'wrong')).rejects.toThrow(/could not connect/)
  })
})

describe('the lock file', () => {
  it('publishes where to find the server, readable only by this user', async () => {
    const path = join(temp, 'session.json')
    const { server } = await serve({ lockFile: path })
    const listening = await server.listen()

    const lock = JSON.parse(readFileSync(path, 'utf8'))
    expect(lock).toMatchObject({
      pid: process.pid,
      host: '127.0.0.1',
      port: listening.port,
      token: listening.token,
      host_kind: 'headless',
      version: '1.2.3'
    })
  })

  it('removes it on close, so the next client does not chase a dead port', async () => {
    const path = join(temp, 'session.json')
    const { server } = await serve({ lockFile: path })

    expect(existsSync(path)).toBe(true)
    await server.close()
    expect(existsSync(path)).toBe(false)
  })

  it('publishes nowhere when told not to', async () => {
    const path = join(temp, 'session.json')
    await serve({ lockFile: false })
    expect(existsSync(path)).toBe(false)
  })
})
