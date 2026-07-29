import { runCommand, RUN_HELP } from './run'
import { dbgCommand, DBG_HELP } from './dbg'
import { attachCommand, ATTACH_HELP } from './attach'
import { UsageError } from './args'

const HELP = `6502 — A.C. Wright 6502 emulator

Usage: 6502 <command> [options]

Commands
  run     Boot a machine, optionally loaded with your build output
  dbg     One-shot debug commands against a running emulator
  attach  An interactive monitor session
  help    Show help for a command

Run "6502 <command> --help" for a command's own options.
`

const HELP_FOR: Record<string, string> = { run: RUN_HELP, dbg: DBG_HELP, attach: ATTACH_HELP }

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  switch (command) {
    case 'run':
      return runCommand(rest)

    case 'dbg':
      return dbgCommand(rest)

    case 'attach':
      return attachCommand(rest)

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(HELP_FOR[rest[0] ?? ''] ?? HELP)
      return 0

    case '--version':
    case '-v':
      process.stdout.write(`${process.env.npm_package_version ?? 'dev'}\n`)
      return 0

    default:
      process.stderr.write(`6502: unknown command "${command}"\n\n${HELP}`)
      return 1
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
    // stdin is resumed while the machine runs; without this the process would
    // linger waiting on a stream nobody is reading any more.
    process.stdin.pause()
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`6502: ${message}\n`)
    if (!(error instanceof UsageError) && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`)
    }
    process.exitCode = 1
    process.stdin.pause()
  })
