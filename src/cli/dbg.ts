import { dispatch, COMMAND_NAMES } from './dbg/Commands'

export const DBG_HELP = `Usage: 6502 dbg <command> [options]

One-shot debug commands against a running emulator. Each connects, calls,
prints its result, and exits — nothing here keeps a session open; that is
what "6502 attach" is for.

Connection (every command accepts these)
  --port <n>       Talk to this port instead of reading ~/.6502/session.json
  --host <addr>    Host to connect to (default: 127.0.0.1)
  --token <token>  Override the token from the lock file
  --json           Print the raw JSON-RPC result instead of formatted text

Commands
  info                             What the machine is and what it's doing
  regs [--set A=0x42 ...]          Read or write the registers
  reset [--warm]                   Reset the machine (cold by default)
  config [--frequency 1|2] [--baud n]

  mem <addr> [length] [--space cpu|ram|rom|vram|nvram|cf]
  mem write <addr> <bytes>         Bytes as hex ("DEADBEEF") or a byte list
  mem fill <addr> <length> <value>
  mem search <pattern> [--text] [--start] [--end] [--limit]

  disasm [addr] [count]
  disasm range <start> <end>

  break <addr> [--watch read|write|access] [--condition expr]
               [--end addr] [--ignore n] [--temporary] [--disabled]
  break list
  break clear [id]                 Omit id to clear every breakpoint
  break enable <id> / disable <id>

  run [--realtime]                 Resume; turbo unless --realtime
  pause
  step [--over|--out|--cycle] [--count n]
  runto <addr> [--timeout dur] [--realtime]
  runcycles <n>

  send <text> [--wait pattern] [--timeout dur] [--encoding base64]
  wait [--serial pattern] [--stopped] [--cycles n] [--expression expr]
       [--since n] [--timeout dur] [--run turbo|realtime]

  sym load <file> [--format vice|ca65] [--no-merge]
  sym resolve <name>
  sym lookup <addr>
  sym list [prefix] [--limit n]

  load rom|cart|program <file>
  load bin <addr> <file>
  unload cart

  screen [text]                    Read the screen as text (only when it's the console)
  screen hash                      Cheap digest — "did the screen change"
  screen png [file]                Save a screenshot (default screen.png)

  input key <name|code> [--down|--up]   Tap, or hold/release, a key
  input joystick [--side a|b] <up|down|left|right|a|b|select|start ...>
  input joystick [--side a|b] --mask <n>
  input type <text> [--cps n]      Type text via the keyboard, not the console

Exit codes
  0  ok                    2  timed out
  1  usage or RPC error     3  no emulator found
                            4  a breakpoint or watchpoint fired

Examples
  6502 dbg regs
  6502 dbg break main --condition 'A == 0xFF'
  6502 dbg step --over
  6502 dbg send 'PRINT 2+2\\r' --wait 'OK' --timeout 5s
  6502 dbg wait --serial 'READY\\.' --timeout 5s
`

export async function dbgCommand(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(DBG_HELP)
    return 0
  }

  if (!COMMAND_NAMES.includes(command) && command !== 'reg') {
    process.stderr.write(`6502 dbg: unknown command "${command}"\n\n${DBG_HELP}`)
    return 1
  }

  return dispatch(command, rest)
}
