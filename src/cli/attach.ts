import * as readline from 'node:readline'
import { parseArgs } from 'node:util'
import { dispatch, COMMAND_NAMES } from './dbg/Commands'
import { resolveTarget, formatHost, RpcClientError } from './dbg/Connection'
import { formatStop } from './dbg/format'
import { UsageError } from './args'

export const ATTACH_HELP = `Usage: 6502 attach [options]

An interactive monitor: type any "6502 dbg" command without the leading
"6502 dbg", and its result prints the same way. The machine's console output
streams in live, and stopping or resuming — however it happens, including from
another client — is reported as it happens.

  --port <n>       Talk to this port instead of reading ~/.6502/session.json
  --host <addr>    Host to connect to (default: 127.0.0.1)
  --token <token>  Override the token from the lock file

Type "help" for the command list, "exit" or Ctrl-D to leave.
`

/**
 * Split a line the way a shell would: whitespace-separated, with single or
 * double quotes protecting spaces — so `send 'PRINT 2+2\r'` is one argument,
 * not four.
 */
function tokenize(line: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(line)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return tokens
}

const OPTIONS = {
  port: { type: 'string' },
  host: { type: 'string' },
  token: { type: 'string' },
  help: { type: 'boolean', short: 'h' }
} as const

export async function attachCommand(argv: string[]): Promise<number> {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: OPTIONS }))
  } catch (e) {
    throw new UsageError((e as Error).message)
  }

  if (values.help) {
    process.stdout.write(ATTACH_HELP)
    return 0
  }

  let target
  try {
    target = resolveTarget(values)
  } catch (e) {
    if (e instanceof RpcClientError) {
      process.stderr.write(`6502 attach: ${e.message}\n`)
      return e.exitCode
    }
    throw e
  }

  // Every typed command reuses the one-shot dispatcher; these connection flags
  // are prepended as its defaults so a line like "regs" needs no arguments,
  // while a line that does pass --port overrides them, same as any other flag.
  const connectionDefaults = [
    '--port',
    String(target.port),
    '--host',
    target.host,
    ...(target.token ? ['--token', target.token] : [])
  ]

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '6502> ' })

  /**
   * True once the REPL is winding down.
   *
   * closing() calls `socket.close()`, which itself fires an asynchronous
   * 'error' if the handshake was still in flight — a self-inflicted abort, not
   * a real connectivity problem. Without this guard that event lands after
   * readline has already closed and crashes the process trying to redraw a
   * prompt that no longer exists.
   */
  let stopping = false

  /** Print output from the socket without mangling whatever the user is typing. */
  const printAsync = (text: string): void => {
    if (stopping) return
    readline.clearLine(process.stdout, 0)
    readline.cursorTo(process.stdout, 0)
    process.stdout.write(text)
    rl.prompt(true)
  }

  const url = `ws://${formatHost(target.host)}:${target.port}/${target.token ? `?token=${target.token}` : ''}`
  const socket = new WebSocket(url)
  let socketReady = false

  socket.addEventListener('open', () => {
    socketReady = true
  })
  socket.addEventListener('message', (event) => {
    let message: { method?: string; params?: Record<string, unknown> }
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.method === undefined) return // a response to a call, not a push

    switch (message.method) {
      case 'stopped':
        printAsync(`\n[stopped] ${formatStop((message.params as { stop: never }).stop)}\n`)
        return
      case 'resumed':
        printAsync(`\n[resumed] ${(message.params as { mode: string }).mode}\n`)
        return
      case 'serial.data':
        printAsync((message.params as { data: string }).data)
        return
      case 'log':
        printAsync(`\n[server] ${(message.params as { message: string }).message}\n`)
        return
    }
  })
  socket.addEventListener('error', () => {
    if (!socketReady) printAsync('\n(could not open a live connection — commands will still work)\n')
  })

  process.stdout.write(
    `6502: attached to ${target.host}:${target.port}. Type "help", "exit" or Ctrl-D.\n`
  )
  rl.prompt()

  return new Promise<number>((resolve) => {
    rl.on('line', (line) => {
      // Readline keeps emitting 'line' for whatever else is already buffered —
      // the whole point of a piped script — while a `send --wait` from an
      // earlier line can take seconds to resolve. Pausing here serializes
      // commands one at a time, the way a person typing them would get for
      // free, and stops a later "exit" from closing the interface out from
      // under a call still in flight.
      rl.pause()
      void (async () => {
        const trimmed = line.trim()
        if (trimmed === '') {
          // no-op
        } else if (trimmed === 'exit' || trimmed === 'quit') {
          rl.close()
          return
        } else if (trimmed === 'help' || trimmed === '?') {
          process.stdout.write(`Commands: ${COMMAND_NAMES.join(', ')}\n`)
        } else {
          const [command, ...rest] = tokenize(trimmed)
          await dispatch(command, [...connectionDefaults, ...rest])
        }

        if (stopping) return
        rl.resume()
        rl.prompt()
      })()
    })

    rl.on('close', () => {
      stopping = true
      // CLOSING or CLOSED already: closing a socket still mid-handshake is
      // what triggers the spurious 'error' printAsync now ignores.
      socket.close()
      process.stdout.write('\n')
      resolve(0)
    })
  })
}
