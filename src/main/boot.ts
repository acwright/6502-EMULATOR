import { readFileSync, unlinkSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename } from 'path'
import { BOOT_CONFIG_SWITCH } from '../shared/boot'
import type { BootConfig, BootMedia, BootPayload } from '../shared/boot'

/**
 * The main-process half of `6502 run` with a window.
 *
 * The CLI left a JSON file and named it on our command line; this reads it,
 * then reads the media it points at. Nothing here decides anything about the
 * machine — the renderer owns that — so this is deliberately just filesystem
 * access on the renderer's behalf, which is the one thing it cannot do itself.
 */

/** The boot config named on this process's command line, if there is one. */
export function bootConfigFrom(argv: string[]): BootConfig | undefined {
  const arg = argv.find((value) => value.startsWith(BOOT_CONFIG_SWITCH))
  if (!arg) return undefined

  const path = arg.slice(BOOT_CONFIG_SWITCH.length)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    console.error('[boot] cannot read boot config:', e)
    return undefined
  }

  // A temp file whose whole life is this launch. Removing it now means a crash
  // between here and the window appearing still leaves nothing behind.
  try {
    unlinkSync(path)
  } catch {
    /* Already gone, or not ours to remove. */
  }

  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    return parsed as BootConfig
  } catch (e) {
    console.error('[boot] boot config is not valid JSON:', e)
    return undefined
  }
}

/**
 * Read everything the config points at.
 *
 * A file that cannot be read is collected rather than thrown: the CLI already
 * checked all of them before launching, so anything failing here happened in
 * the moment between, and a machine that boots without its cartridge and says
 * so beats a window that never opens.
 */
export async function readBootPayload(config: BootConfig): Promise<BootPayload> {
  const errors: string[] = []

  const media = async (path: string, label: string): Promise<BootMedia | undefined> => {
    try {
      return { label: basename(path), bytes: new Uint8Array(await readFile(path)) }
    } catch (e) {
      errors.push(`${label}: cannot read "${path}" (${(e as Error).message})`)
      return undefined
    }
  }

  const rom = config.rom ? await media(config.rom, 'ROM') : undefined
  const cart = config.cart ? await media(config.cart, 'cartridge') : undefined
  const program = config.program ? await media(config.program, 'program') : undefined

  const binaries: BootPayload['binaries'] = []
  for (const binary of config.binaries ?? []) {
    const bytes = await media(binary.path, 'binary')
    if (bytes) binaries.push({ address: binary.address, media: bytes })
  }

  let symbols: BootPayload['symbols']
  if (config.symbols) {
    try {
      symbols = { path: config.symbols, text: await readFile(config.symbols, 'utf8') }
    } catch (e) {
      errors.push(`symbols: cannot read "${config.symbols}" (${(e as Error).message})`)
    }
  }

  return {
    ...(rom ? { rom } : {}),
    ...(cart ? { cart } : {}),
    ...(program ? { program } : {}),
    binaries,
    ...(symbols ? { symbols } : {}),
    ...(config.rtc ? { rtc: config.rtc } : {}),
    ...(config.serialPort ? { serialPort: config.serialPort } : {}),
    pause: config.pause === true,
    errors
  }
}
