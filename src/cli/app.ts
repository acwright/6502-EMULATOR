import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { ROM } from '../core/ROM'
import { BOOT_CONFIG_SWITCH } from '../shared/boot'
import type { BootConfig } from '../shared/boot'
import { DEFAULT_SERIAL_CONFIG } from '../shared/types'
import type { AppSettings } from '../shared/types'
import {
  UsageError,
  parseBinarySpec,
  parseClock,
  parseCount,
  parseFrequency,
  parseSerialFraming
} from './args'

/**
 * `6502 run` with a window: launch the desktop app with the build already
 * attached.
 *
 * This is the cross-development loop `make run` wants — assemble, then look at
 * the thing running on a screen with sound and a keyboard, rather than piping a
 * serial console around. Everything here is about getting from a shell to that
 * window: which binary is the app, what to tell it to load, and whether to wait.
 */

/** The parsed `run` flags this path cares about. */
export interface LaunchFlags {
  rom?: string
  cart?: string
  program?: string
  bin?: string[]
  cf?: string
  nvram?: string
  console?: string
  freq?: string
  baud?: string
  serial?: string
  'serial-config'?: string
  rtc?: string
  realtime?: boolean
  pause?: boolean
  'max-cycles'?: string
  timeout?: string
  'exit-on'?: string
  'input-after'?: string
  debug?: boolean
  'debug-port'?: string
  'debug-host'?: string
  'debug-token'?: string
  symbols?: string
  json?: boolean
  quiet?: boolean
  detach?: boolean
  fullscreen?: boolean
  app?: string
}

/**
 * Flags that describe a run with no window, and what to say about each.
 *
 * A window has no exit condition and no stdin: `--timeout` or `--exit-on`
 * against one would silently do nothing, so they are refused rather than
 * accepted and ignored.
 */
const HEADLESS_ONLY: { flag: keyof LaunchFlags; why: string }[] = [
  { flag: 'console', why: 'the app always has a video card, so its console is the screen' },
  { flag: 'max-cycles', why: 'a window runs until it is closed' },
  { flag: 'timeout', why: 'a window runs until it is closed' },
  { flag: 'exit-on', why: 'a window has no console output to match against' },
  { flag: 'input-after', why: 'a window takes its input from the keyboard, not stdin' },
  { flag: 'json', why: 'there is no run result to report' }
]

/**
 * Turn the `run` flags into what the app should boot with.
 *
 * Paths are resolved against the shell's working directory and checked here:
 * the app is launched from somewhere else entirely, and a mistyped filename
 * should fail in the terminal that typed it.
 */
export function buildBootConfig(values: LaunchFlags, positionals: string[]): BootConfig {
  if (positionals.length > 1) {
    throw new UsageError(`expected at most one program, got ${positionals.length}`)
  }

  const offending = HEADLESS_ONLY.filter(({ flag }) => values[flag] !== undefined)
  if (offending.length > 0) {
    const list = offending.map(({ flag, why }) => `  --${flag}  \u2014 ${why}`).join('\n')
    throw new UsageError(
      `these only apply to a headless run:\n${list}\n\n` +
        'Add --headless to run without a window, or drop them to open the app.'
    )
  }

  const media = (path: string | undefined, label: string): string | undefined => {
    if (path === undefined) return undefined
    const full = resolve(path)
    try {
      accessSync(full, constants.R_OK)
    } catch {
      throw new UsageError(`${label}: cannot read "${path}"`)
    }
    return full
  }

  const binaries = (values.bin ?? []).map((spec) => {
    const { address, path } = parseBinarySpec(spec)
    return { address, path: media(path, '--bin')! }
  })

  const rom = media(values.rom, '--rom')
  // The renderer's ROM slot ignores an image that is the wrong size rather
  // than throwing, which as a window is indistinguishable from a machine with
  // no ROM at all. Headless refuses it outright, so refuse it here too.
  if (rom) {
    const size = statSync(rom).size
    if (size !== ROM.SIZE) {
      throw new UsageError(`--rom: must be exactly ${ROM.SIZE} bytes, got ${size}`)
    }
  }
  const cart = media(values.cart, '--cart')
  const program = media(values.program ?? positionals[0], 'program')
  const symbols = media(values.symbols, '--symbols')
  const settings = settingsFrom(values, media)
  const debugPort = values['debug-port'] ? parseCount(values['debug-port'], '--debug-port') : undefined

  return {
    ...(rom ? { rom } : {}),
    ...(cart ? { cart } : {}),
    ...(program ? { program } : {}),
    ...(binaries.length > 0 ? { binaries } : {}),
    ...(symbols ? { symbols } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    ...(values.serial ? { serialPort: values.serial } : {}),
    ...(values.rtc ? { rtc: parseClock(values.rtc, '--rtc') } : {}),
    ...(values.pause ? { pause: true } : {}),
    ...(values.fullscreen ? { fullscreen: true } : {}),
    ...(values.debug
      ? {
          debug: {
            ...(debugPort !== undefined ? { port: debugPort } : {}),
            ...(values['debug-host'] ? { host: values['debug-host'] } : {}),
            ...(values['debug-token'] ? { token: values['debug-token'] } : {})
          }
        }
      : {})
  }
}

/**
 * The flags that set something the app's own Settings panel sets.
 *
 * They land in the panel exactly as if they had been chosen there, but for this
 * launch only — see `BootConfig.settings`. The serial framing starts from the
 * app's default rather than the user's saved one, because half a framing
 * (`--serial-config 7E1` merged into whatever was left behind) is a line
 * nobody asked for.
 */
function settingsFrom(
  values: LaunchFlags,
  media: (path: string | undefined, label: string) => string | undefined
): Partial<AppSettings> {
  const cfPath = media(values.cf, '--cf')
  const nvramPath = media(values.nvram, '--nvram')
  const framing = values['serial-config']
    ? parseSerialFraming(values['serial-config'], '--serial-config')
    : undefined
  const baudRate = values.baud ? parseCount(values.baud, '--baud') : undefined

  return {
    ...(values.freq ? { frequency: parseFrequency(values.freq) } : {}),
    ...(cfPath ? { cfPath } : {}),
    ...(nvramPath ? { nvramPath } : {}),
    ...(framing || baudRate !== undefined
      ? {
          serialConfig: {
            ...DEFAULT_SERIAL_CONFIG,
            ...framing,
            ...(baudRate !== undefined ? { baudRate } : {})
          }
        }
      : {})
  }
}

/** The macOS executable inside an `.app` bundle. */
function macAppBinary(bundle: string): string {
  return join(bundle, 'Contents', 'MacOS', basename(bundle).replace(/\.app$/, ''))
}

/**
 * The Electron binary in a checkout's node_modules.
 *
 * `path.txt` is how the `electron` package itself records where its download
 * landed, which differs by platform; reading it beats guessing at
 * `dist/Electron.app/...`.
 */
function checkoutElectron(root: string): string | undefined {
  const dir = join(root, 'node_modules', 'electron')
  try {
    const binary = join(dir, 'dist', readFileSync(join(dir, 'path.txt'), 'utf8').trim())
    return existsSync(binary) ? binary : undefined
  } catch {
    return undefined
  }
}

/** Where an installed app lives, by platform. */
function installedCandidates(): string[] {
  const home = homedir()
  switch (process.platform) {
    case 'darwin':
      return ['/Applications/6502 Emulator.app', join(home, 'Applications', '6502 Emulator.app')].map(
        macAppBinary
      )
    case 'win32': {
      const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
      return [
        join(local, 'Programs', '6502-emulator', '6502 Emulator.exe'),
        join('C:\\Program Files', '6502 Emulator', '6502 Emulator.exe')
      ]
    }
    default:
      return ['/opt/6502 Emulator/6502-emulator', '/usr/bin/6502-emulator', '/usr/local/bin/6502-emulator']
  }
}

/**
 * Find the desktop app to launch.
 *
 * The installed case needs no search at all: the shim runs this CLI with
 * `ELECTRON_RUN_AS_NODE=1` inside the app's own Electron, so `process.execPath`
 * is already the app binary and launching it without that variable starts the
 * app itself. That is also what keeps the two from ever disagreeing on version.
 */
export function resolveApp(explicit?: string): { command: string; args: string[] } {
  if (explicit) {
    const command = explicit.endsWith('.app') ? macAppBinary(explicit) : explicit
    if (!existsSync(command)) throw new UsageError(`--app: nothing to run at "${command}"`)
    return { command, args: [] }
  }

  if (process.versions.electron) return { command: process.execPath, args: [] }

  // A checkout: this file is out/cli/index.js, two levels under the repo root.
  const root = join(__dirname, '..', '..')
  const electron = checkoutElectron(root)
  if (electron) {
    if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
      throw new UsageError('the desktop app is not built \u2014 run `npm run build` first')
    }
    return { command: electron, args: [root] }
  }

  const installed = installedCandidates().find((path) => existsSync(path))
  if (installed) return { command: installed, args: [] }

  throw new UsageError(
    'could not find the desktop app. Install it (Settings \u2192 COMMAND LINE \u2192 Install ' +
      'gives you a `6502` that always finds it), or pass --app <path>, or set SIXTY5O2_APP. ' +
      'Use --headless to run without a window.'
  )
}

/**
 * Hand the config to the app on disk rather than on its command line.
 *
 * Long arguments are quoted differently by every shell and every platform, and
 * an ISO date or a Windows path is exactly where that goes wrong. Main deletes
 * the file as soon as it has read it.
 */
function writeBootFile(config: BootConfig): string {
  const path = join(tmpdir(), `6502-boot-${process.pid}-${randomBytes(4).toString('hex')}.json`)
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 })
  return path
}

/**
 * Launch the app and, unless detached, wait for the window to close.
 *
 * Waiting is the default because a shell that returns immediately looks like
 * nothing happened, and because `make run` should stop when the emulator does.
 */
export async function launchApp(
  config: BootConfig,
  options: { detach?: boolean; quiet?: boolean; app?: string }
): Promise<number> {
  const { command, args } = resolveApp(options.app ?? process.env.SIXTY5O2_APP)
  const bootFile = writeBootFile(config)

  // The installed shim sets this to run us as Node; inherited by the child it
  // would start the app as a Node interpreter with no window at all.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(command, [...args, `${BOOT_CONFIG_SWITCH}${bootFile}`], {
    stdio: options.detach ? 'ignore' : 'inherit',
    detached: options.detach ?? false,
    env
  })

  if (options.detach) {
    child.unref()
    if (!options.quiet) process.stderr.write('6502: desktop app launched\n')
    return 0
  }

  if (!options.quiet) {
    process.stderr.write('6502: desktop app \u2014 close the window to exit\n')
  }

  const forward = (signal: NodeJS.Signals) => (): void => {
    child.kill(signal)
  }
  const onInt = forward('SIGINT')
  const onTerm = forward('SIGTERM')
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)

  try {
    return await new Promise<number>((done, fail) => {
      child.on('error', (e: NodeJS.ErrnoException) => {
        fail(
          e.code === 'ENOENT'
            ? new UsageError(`cannot launch "${command}"`)
            : new UsageError(`cannot launch "${command}": ${e.message}`)
        )
      })
      // A window closed by its own Ctrl-C reports the signal, not a code.
      child.on('exit', (code, signal) => done(code ?? (signal === 'SIGINT' ? 130 : 0)))
    })
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
  }
}
