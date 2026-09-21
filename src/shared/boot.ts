import type { ClockReading } from '../core/IO/RTC'
import type { AppSettings } from './types'

/**
 * What `6502 run` hands the desktop app when it launches it.
 *
 * The CLI cannot poke a machine that lives in another process's renderer, so
 * a windowed run passes its media and settings forward instead: the CLI writes
 * a BootConfig to a temp file, puts `--boot-config=<path>` on the app's command
 * line, and main turns it into a BootPayload the renderer applies during its
 * normal boot sequence.
 *
 * Paths, not bytes, cross that boundary — a command line has no room for a
 * cartridge, and main is the process with filesystem access anyway. The CLI
 * still checks every file is readable before spawning, so a typo is a message
 * in the terminal rather than a window that opens missing its program.
 */

/** The switch the CLI puts on the app's command line. */
export const BOOT_CONFIG_SWITCH = '--boot-config='

export interface BootBinary {
  address: number
  path: string
}

export interface BootDebug {
  port?: number
  host?: string
  token?: string
}

export interface BootConfig {
  rom?: string
  cart?: string
  /**
   * Where a flash cart's `.sav` overlay lives, or `false` for `--no-cart-save`.
   *
   * Absent means the default: `<stem>.sav` beside the `.crt`. It is a path and
   * not bytes for the same reason `cart` is — and because the renderer has to
   * name the file again when it writes the overlay back on eject.
   */
  cartSave?: string | false
  program?: string
  binaries?: BootBinary[]
  symbols?: string
  rtc?: ClockReading
  /** Start stopped, so a debugger can attach before the BIOS runs. */
  pause?: boolean
  fullscreen?: boolean
  /** Serve the debug protocol from launch, without the Settings toggle. */
  debug?: BootDebug
  /**
   * Settings the app would otherwise have been given through its own panel —
   * CPU frequency, serial framing, which CF and NVRAM files to use.
   *
   * Applied to this launch only. Someone trying a build out has not decided to
   * change their defaults, and `6502 run` is not where you would expect to;
   * anything they then change in the panel persists as it always did.
   */
  settings?: Partial<AppSettings>
  /** Connect the machine's ACIA to this host serial port at launch. */
  serialPort?: string
}

/** A file main read on the renderer's behalf, with the name to show for it. */
export interface BootMedia {
  label: string
  bytes: Uint8Array
}

export interface BootPayload {
  rom?: BootMedia
  cart?: BootMedia
  /**
   * The flash cart's overlay: where it goes, and what was already there.
   *
   * `bytes` is absent when no save exists yet, which is the ordinary first run
   * — the path still matters, because that is where this session's writes will
   * go. The whole field is absent when there is no flash cart, or when
   * `--no-cart-save` said to throw the writes away.
   */
  cartSave?: { path: string; bytes?: Uint8Array }
  program?: BootMedia
  binaries: { address: number; media: BootMedia }[]
  symbols?: { path: string; text: string }
  rtc?: ClockReading
  pause: boolean
  /**
   * A host serial port to connect at launch. An action rather than a setting —
   * the app does not remember a port between runs — so it stays out of
   * `settings`, which main applies without the renderer's help.
   */
  serialPort?: string
  /**
   * Anything main could not read. The renderer boots without it rather than
   * refusing to start — a missing cartridge should leave a usable machine and
   * a message, not a dead window.
   */
  errors: string[]
}
