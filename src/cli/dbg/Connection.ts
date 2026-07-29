import { readLock, defaultLockPath } from '../../debug/server/LockFile'
import { ExitCode } from './ExitCode'

/** Where to find a running emulator, and how to prove we are allowed to. */
export interface Target {
  host: string
  port: number
  token?: string
}

/** An RPC-layer failure, carrying the exit code it should produce. */
export class RpcClientError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = ExitCode.ERROR
  ) {
    super(message)
    this.name = 'RpcClientError'
  }
}

export interface TargetFlags {
  port?: string
  host?: string
  token?: string
}

/**
 * Find the emulator to talk to.
 *
 * `--port` (with an optional `--host`/`--token`) always wins, for the rare case
 * of more than one instance or a manually-chosen port. Otherwise this reads the
 * lock file the running emulator published — see LockFile.ts — which is what
 * lets `6502 dbg regs` take no arguments in the ordinary single-instance case.
 */
export function resolveTarget(flags: TargetFlags): Target {
  if (flags.port !== undefined) {
    const port = Number(flags.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RpcClientError(`--port: expected 1-65535, got "${flags.port}"`)
    }
    return { host: flags.host ?? '127.0.0.1', port, ...(flags.token ? { token: flags.token } : {}) }
  }

  const lock = readLock(defaultLockPath())
  if (!lock) {
    throw new RpcClientError(
      'no running emulator found — start one with `6502 run --headless --debug`, ' +
        'or pass --port if it is not the one at ~/.6502/session.json',
      ExitCode.NOT_RUNNING
    )
  }

  return { host: lock.host, port: lock.port, token: flags.token ?? lock.token }
}

/** IPv6 literals need brackets in a URL. */
export const formatHost = (host: string): string => (host.includes(':') ? `[${host}]` : host)

/** A JSON-RPC call to the target over one-shot HTTP. */
export async function httpCall(target: Target, method: string, params?: unknown): Promise<unknown> {
  const url = `http://${formatHost(target.host)}:${target.port}/rpc`

  let reply: Response
  try {
    reply = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(target.token ? { Authorization: `Bearer ${target.token}` } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
  } catch (e) {
    throw new RpcClientError(
      `could not reach the emulator at ${target.host}:${target.port} (${(e as Error).message}) — ` +
        'is it still running?',
      ExitCode.NOT_RUNNING
    )
  }

  if (reply.status === 401) {
    const body = (await reply.json().catch(() => undefined)) as { error?: string } | undefined
    throw new RpcClientError(body?.error ?? 'unauthorized', ExitCode.ERROR)
  }

  const body = (await reply.json()) as {
    result?: unknown
    error?: { code: number; message: string }
  }
  if (body.error) throw new RpcClientError(body.error.message)
  return body.result
}
