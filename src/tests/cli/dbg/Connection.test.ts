import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { resolveTarget, httpCall, RpcClientError, formatHost } from '../../../cli/dbg/Connection'
import { writeLock } from '../../../debug/server/LockFile'
import { ExitCode } from '../../../cli/dbg/ExitCode'

let temp: string
let previousHome: string | undefined

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), '6502-connection-'))
  previousHome = process.env.SIXTY5O2_HOME
  process.env.SIXTY5O2_HOME = temp
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.SIXTY5O2_HOME
  else process.env.SIXTY5O2_HOME = previousHome
  rmSync(temp, { recursive: true, force: true })
})

describe('resolveTarget', () => {
  it('reads the lock file when nothing overrides it', () => {
    writeLock(join(temp, 'session.json'), {
      pid: process.pid,
      host: '127.0.0.1',
      port: 4444,
      token: 'tok',
      started: new Date().toISOString(),
      version: '1.0.0',
      host_kind: 'headless'
    })

    expect(resolveTarget({})).toEqual({ host: '127.0.0.1', port: 4444, token: 'tok' })
  })

  it('reports that no emulator is running, with the exit code an agent should use', () => {
    let error: RpcClientError | undefined
    try {
      resolveTarget({})
    } catch (e) {
      error = e as RpcClientError
    }
    expect(error).toBeInstanceOf(RpcClientError)
    expect(error!.exitCode).toBe(ExitCode.NOT_RUNNING)
  })

  it('lets --port skip the lock file entirely', () => {
    expect(resolveTarget({ port: '9999' })).toEqual({ host: '127.0.0.1', port: 9999 })
  })

  it('lets --token override what the lock file says', () => {
    writeLock(join(temp, 'session.json'), {
      pid: process.pid,
      host: '127.0.0.1',
      port: 4444,
      token: 'from-lock',
      started: new Date().toISOString(),
      version: '1.0.0',
      host_kind: 'headless'
    })
    expect(resolveTarget({ token: 'override' }).token).toBe('override')
  })

  it('rejects a --port that is not a valid port number', () => {
    expect(() => resolveTarget({ port: 'nope' })).toThrow(RpcClientError)
    expect(() => resolveTarget({ port: '0' })).toThrow(RpcClientError)
    expect(() => resolveTarget({ port: '99999' })).toThrow(RpcClientError)
  })
})

describe('formatHost', () => {
  it('brackets an IPv6 literal', () => {
    expect(formatHost('::1')).toBe('[::1]')
    expect(formatHost('127.0.0.1')).toBe('127.0.0.1')
  })
})

describe('httpCall', () => {
  let server: Server
  let port: number

  function start(
    handler: (body: unknown) => { status?: number; body: unknown }
  ): Promise<void> {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const { status = 200, body } = handler(parsed)
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port
        resolve()
      })
    })
  }

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('sends a JSON-RPC request and returns the result', async () => {
    await start((body) => ({
      body: { jsonrpc: '2.0', id: (body as { id: number }).id, result: { ok: true } }
    }))

    expect(await httpCall({ host: '127.0.0.1', port }, 'session.info')).toEqual({ ok: true })
  })

  it('sends the token as a bearer header', async () => {
    let seenAuth: string | undefined
    server = createServer((req, res) => {
      seenAuth = req.headers.authorization
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port
        resolve()
      })
    })

    await httpCall({ host: '127.0.0.1', port, token: 'secret' }, 'session.info')
    expect(seenAuth).toBe('Bearer secret')
  })

  it('turns a JSON-RPC error into an RpcClientError', async () => {
    await start((body) => ({
      body: {
        jsonrpc: '2.0',
        id: (body as { id: number }).id,
        error: { code: -32602, message: 'address is required' }
      }
    }))

    await expect(httpCall({ host: '127.0.0.1', port }, 'bp.set')).rejects.toThrow(
      /address is required/
    )
  })

  it('turns a 401 into an RpcClientError without retrying', async () => {
    server = createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port
        resolve()
      })
    })

    await expect(httpCall({ host: '127.0.0.1', port }, 'session.info')).rejects.toThrow(
      /unauthorized/
    )
  })

  // The case that lets a script tell "nothing is running" apart from "the RPC
  // call itself failed" — different exit codes, per PLAN.md §6.1.
  it('reports an unreachable target with the not-running exit code', async () => {
    // A port just released is reliably unbound for the moment it takes to
    // reconnect — more trustworthy than a hardcoded number, which this
    // environment's network stack turned out to answer on (400, no server).
    const probe = createServer()
    const freedPort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port))
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    let error: RpcClientError | undefined
    try {
      await httpCall({ host: '127.0.0.1', port: freedPort }, 'session.info')
    } catch (e) {
      error = e as RpcClientError
    }
    expect(error).toBeInstanceOf(RpcClientError)
    expect(error!.exitCode).toBe(ExitCode.NOT_RUNNING)
  })
})
