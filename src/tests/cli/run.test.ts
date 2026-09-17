import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageError } from '../../cli/args'
import { buildBootConfig } from '../../cli/app'
import { HeadlessHost } from '../../host/headless/HeadlessHost'
import { checkScreenshot, runCommand } from '../../cli/run'
import * as cards from '../../core/IO/createVideoCard'
import { Video } from '../../core/IO/Video'
import { TMS9918A } from '../../core/IO/TMS9918A'
import { decodePNG } from '../goldens/fixtures'

/**
 * `run --screenshot`: the flag that lets CI diff what a program draws without a
 * bespoke capture script.
 */

jest.setTimeout(60_000)

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), '6502-run-test-'))
})

describe('checkScreenshot', () => {
  it('accepts a video console', () => {
    expect(() => checkScreenshot('video', undefined)).not.toThrow()
    expect(() => checkScreenshot('video', ['io3'])).not.toThrow()
  })

  it('refuses a serial console, and says which flag to add', () => {
    expect(() => checkScreenshot('serial', undefined)).toThrow(UsageError)
    expect(() => checkScreenshot('serial', undefined)).toThrow(/needs --console video/)
  })

  it('refuses a video console whose card has been taken out', () => {
    expect(() => checkScreenshot('video', ['io8'])).toThrow(/--empty video/)
  })
})

describe('run --screenshot', () => {
  /** Run the command with its terminal output swallowed. */
  async function quietly(argv: string[]): Promise<number> {
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      return await runCommand(argv)
    } finally {
      out.mockRestore()
      err.mockRestore()
    }
  }

  const args = (path: string): string[] => [
    '--headless',
    '--console',
    'video',
    '--rtc',
    '2026-01-01T00:00:00',
    '--max-cycles',
    '2e6',
    '--quiet',
    '--screenshot',
    path
  ]

  it('writes the screen as a 320x240 PNG when the run ends', async () => {
    const path = join(dir, 'screen.png')
    expect(await quietly(args(path))).toBe(0)

    const rgba = decodePNG(readFileSync(path), 320, 240)
    // The BIOS splash is black text on white: a picture, not an empty buffer.
    const colors = new Set<number>()
    for (let i = 0; i < rgba.length; i += 4) colors.add((rgba[i]! << 16) | (rgba[i + 1]! << 8) | rgba[i + 2]!)
    expect(colors.size).toBeGreaterThan(1)
  })

  it('writes the same bytes on every run, given a fixed clock and budget', async () => {
    const first = join(dir, 'first.png')
    const second = join(dir, 'second.png')
    await quietly(args(first))
    await quietly(args(second))
    expect(readFileSync(first).equals(readFileSync(second))).toBe(true)
  })

  it('refuses before booting anything when there is no video card', async () => {
    const path = join(dir, 'never.png')
    await expect(runCommand(['--headless', '--screenshot', path])).rejects.toThrow(/--console video/)
    expect(existsSync(path)).toBe(false)
  })

  it('is refused for a window, which has no end of run to take it at', () => {
    expect(() => buildBootConfig({ screenshot: 'screen.png' }, [])).toThrow(/--screenshot/)
  })
})

describe('run --flow-control', () => {
  it('is in the help, and says it is off by default', async () => {
    const chunks: string[] = []
    const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    })
    try {
      expect(await runCommand(['--help'])).toBe(0)
    } finally {
      out.mockRestore()
    }
    expect(chunks.join('')).toMatch(/--flow-control +Hold serial input while the machine raises RTS \(default: off\)/)
  })

  it.each([
    [['--flow-control'], true],
    [[], false]
  ] as const)('turns flow control on for a headless run only when given (%j)', async (flag, on) => {
    const chunks: string[] = []
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    })
    const hosts = jest.spyOn(HeadlessHost.prototype, 'run')
    try {
      expect(await runCommand(['--headless', '--max-cycles', '1000', ...flag])).toBe(0)
      expect((hosts.mock.contexts[0] as HeadlessHost).flowControl).toBe(on)
    } finally {
      hosts.mockRestore()
      out.mockRestore()
      err.mockRestore()
    }
    expect(chunks.join('')).toContain(`serial console, 1 MHz${on ? ', flow control' : ''}, turbo`)
  })
})

describe('run --vdp', () => {
  /** Run the command, keeping what it wrote to stderr. */
  async function withStderr(argv: string[]): Promise<{ code: number; err: string }> {
    const chunks: string[] = []
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    })
    try {
      const code = await runCommand(argv)
      return { code, err: chunks.join('') }
    } finally {
      out.mockRestore()
      err.mockRestore()
    }
  }

  const briefly = ['--headless', '--max-cycles', '1000']

  it('refuses a card it does not know, headless or windowed, before booting', async () => {
    const spy = jest.spyOn(cards, 'createVideoCard')
    try {
      await expect(runCommand([...briefly, '--console', 'video', '--vdp', 'tms9918'])).rejects.toThrow(UsageError)
      await expect(runCommand([...briefly, '--vdp', 'nope'])).rejects.toThrow(
        '--vdp: expected "tms9918a" or "picovdp", got "nope"'
      )
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
    expect(() => buildBootConfig({ vdp: 'nope' }, [])).toThrow(/--vdp: expected "tms9918a" or "picovdp"/)
  })

  it.each([
    ['picovdp', Video],
    ['tms9918a', TMS9918A]
  ] as const)('boots a video console on --vdp %s, and says which card', async (vdp, Card) => {
    const spy = jest.spyOn(cards, 'createVideoCard')
    try {
      const { code, err } = await withStderr([...briefly, '--console', 'video', '--vdp', vdp])
      expect(code).toBe(0)
      expect(spy).toHaveBeenCalledWith(vdp)
      expect(spy.mock.results[0]!.value).toBeInstanceOf(Card)
      expect(err).toContain(`6502: headless, video console (${vdp}), 1 MHz, turbo`)
    } finally {
      spy.mockRestore()
    }
  })

  it('boots the TMS9918A when no card is named, and names no card on a serial console', async () => {
    const spy = jest.spyOn(cards, 'createVideoCard')
    try {
      const video = await withStderr([...briefly, '--console', 'video'])
      expect(spy).toHaveBeenCalledWith('tms9918a')
      expect(video.err).toContain('video console (tms9918a)')

      spy.mockClear()
      const serial = await withStderr([...briefly, '--vdp', 'picovdp'])
      expect(serial.code).toBe(0)
      expect(spy).not.toHaveBeenCalled()
      expect(serial.err).toContain('6502: headless, serial console, 1 MHz')
    } finally {
      spy.mockRestore()
    }
  })

  it('warns, and does not change the card, when a BIOS 2.x ROM meets the TMS9918A', async () => {
    const rom = new Uint8Array(readFileSync(join(__dirname, '../../../assets/roms/BIOS.bin')))
    rom.set(Buffer.from('6502 BIOS v2.0', 'latin1'), 0x10)
    const path = join(dir, 'bios2.bin')
    writeFileSync(path, rom)

    const tms = await withStderr([...briefly, '--console', 'video', '--rom', path])
    expect(tms.code).toBe(0)
    expect(tms.err).toContain('6502: warning: BIOS 2.x needs the PICOVDP card (--vdp picovdp)')
    expect(tms.err).toContain('video console (tms9918a)')

    const pico = await withStderr([...briefly, '--console', 'video', '--vdp', 'picovdp', '--rom', path])
    expect(pico.err).not.toContain('warning')

    const bundled = await withStderr([...briefly, '--console', 'video'])
    expect(bundled.err).not.toContain('warning')
  })
})
