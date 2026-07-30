import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOOT_CONFIG_SWITCH } from '../../shared/boot'
import type { BootConfig } from '../../shared/boot'
import { bootConfigFrom, readBootPayload } from '../../main/boot'

/**
 * The main-process end of `6502 run` with a window: read what the CLI left,
 * then read the media it names. Both halves have to tolerate a file that has
 * gone missing between the CLI checking it and the app starting, because the
 * alternative is a window that never opens.
 */

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), '6502-boot-test-'))
})

function writeConfig(config: BootConfig, name = 'boot.json'): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(config))
  return path
}

describe('bootConfigFrom', () => {
  it('is undefined when the app was opened any other way', () => {
    expect(bootConfigFrom(['/path/to/app'])).toBeUndefined()
  })

  it('reads the config named on the command line and takes the file away', () => {
    const path = writeConfig({ program: '/tmp/game.prg' }, 'read-once.json')
    expect(bootConfigFrom(['app', `${BOOT_CONFIG_SWITCH}${path}`])).toEqual({
      program: '/tmp/game.prg'
    })
    // A temp file whose whole life is this launch — nothing should find it
    // later and boot a stale machine from it.
    expect(existsSync(path)).toBe(false)
  })

  it('boots normally rather than failing on a config it cannot use', () => {
    // It reports both cases to the console it was launched from; that is the
    // point of them, and not something the test output needs to repeat.
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const broken = join(dir, 'broken.json')
      writeFileSync(broken, '{ not json')
      expect(bootConfigFrom(['app', `${BOOT_CONFIG_SWITCH}${broken}`])).toBeUndefined()
      expect(bootConfigFrom(['app', `${BOOT_CONFIG_SWITCH}${join(dir, 'gone.json')}`])).toBeUndefined()
      expect(logged).toHaveBeenCalledTimes(2)
    } finally {
      logged.mockRestore()
    }
  })
})

describe('readBootPayload', () => {
  it('reads each file and labels it with its name', async () => {
    const cart = join(dir, 'game.crt')
    writeFileSync(cart, Uint8Array.from([1, 2, 3]))

    const payload = await readBootPayload({ cart, binaries: [{ address: 0xc000, path: cart }] })

    expect(payload.cart).toEqual({ label: 'game.crt', bytes: Uint8Array.from([1, 2, 3]) })
    expect(payload.binaries).toEqual([
      { address: 0xc000, media: { label: 'game.crt', bytes: Uint8Array.from([1, 2, 3]) } }
    ])
    expect(payload.errors).toEqual([])
  })

  it('reads symbols as text, keeping the path the format is derived from', async () => {
    const labels = join(dir, 'game.lbl')
    writeFileSync(labels, 'al 000800 .start\n')
    const payload = await readBootPayload({ symbols: labels })
    expect(payload.symbols).toEqual({ path: labels, text: 'al 000800 .start\n' })
  })

  it('collects what it could not read instead of refusing to boot', async () => {
    const payload = await readBootPayload({
      rom: join(dir, 'missing.bin'),
      program: join(dir, 'missing.prg')
    })
    expect(payload.rom).toBeUndefined()
    expect(payload.errors).toHaveLength(2)
    expect(payload.errors[0]).toMatch(/ROM: cannot read/)
    expect(payload.errors[1]).toMatch(/program: cannot read/)
  })

  it('passes a serial port through for the renderer to connect', async () => {
    // Settings are main's to apply; a connection is the renderer's.
    const payload = await readBootPayload({ serialPort: '/dev/ttyUSB0', settings: { frequency: 2e6 } })
    expect(payload.serialPort).toBe('/dev/ttyUSB0')
    expect(payload).not.toHaveProperty('settings')
  })

  it('defaults pause to running, the way opening the app does', async () => {
    expect((await readBootPayload({})).pause).toBe(false)
    expect((await readBootPayload({ pause: true })).pause).toBe(true)
  })
})
