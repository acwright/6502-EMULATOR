import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UsageError } from '../../cli/args'
import { buildBootConfig } from '../../cli/app'
import { checkScreenshot, runCommand } from '../../cli/run'
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
