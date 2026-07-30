import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { UsageError } from '../../cli/args'
import { buildBootConfig, resolveApp } from '../../cli/app'

/**
 * `6502 run` without `--headless` launches the desktop app, which means the
 * flags are checked here, in the terminal, rather than in a window that opens
 * missing half of what was asked for. That is what these cover: what the app is
 * told to boot with, and what it is told is a mistake.
 */

let dir: string
let program: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), '6502-app-test-'))
  program = join(dir, 'game.prg')
  writeFileSync(program, Uint8Array.from([0x00, 0x08]))
})

describe('buildBootConfig', () => {
  it('takes the program from the positional argument or --program', () => {
    expect(buildBootConfig({}, [program]).program).toBe(program)
    expect(buildBootConfig({ program }, []).program).toBe(program)
  })

  it('resolves paths against the shell, not the app', () => {
    // The app is launched from somewhere else entirely, so a relative path is
    // meaningless by the time it arrives.
    const relative = './package.json'
    expect(buildBootConfig({}, [relative]).program).toBe(resolve(relative))
  })

  it('refuses a file it cannot read, naming the flag', () => {
    expect(() => buildBootConfig({ cart: join(dir, 'nope.crt') }, [])).toThrow(/--cart: cannot read/)
    expect(() => buildBootConfig({}, [join(dir, 'nope.prg')])).toThrow(/program: cannot read/)
  })

  it('refuses flags that only mean something without a window, and says why', () => {
    expect(() => buildBootConfig({ timeout: '5s' }, [])).toThrow(UsageError)
    expect(() => buildBootConfig({ 'exit-on': 'OK' }, [])).toThrow(/--exit-on/)
    // All of them at once: someone adapting a headless command line should see
    // the whole list rather than fixing one flag per attempt.
    expect(() => buildBootConfig({ console: 'serial', json: true }, [])).toThrow(
      /--console[\s\S]*--json/
    )
  })

  it('refuses a ROM that is not the 32 KB the address space expects', () => {
    // The ROM slot ignores a wrong-size image rather than throwing, so left to
    // the app this is a window that boots to nothing with no explanation.
    expect(() => buildBootConfig({ rom: program }, [])).toThrow(/--rom: must be exactly 32768/)
  })

  it('refuses a second program', () => {
    expect(() => buildBootConfig({}, [program, program])).toThrow(/at most one program/)
  })

  it('carries the machine settings across', () => {
    const config = buildBootConfig({ rtc: '2026-01-01T00:00:00', pause: true, fullscreen: true }, [])
    expect(config).toMatchObject({
      rtc: { year: 2026, month: 1, date: 1 },
      pause: true,
      fullscreen: true
    })
  })

  it('puts what the Settings panel owns under settings, for the launch only', () => {
    const config = buildBootConfig({ freq: '2', cf: program, nvram: program }, [])
    expect(config.settings).toEqual({
      frequency: 2_000_000,
      cfPath: program,
      nvramPath: program
    })
  })

  it('builds a whole serial config, never half of one', () => {
    // Merging framing into whatever was saved would produce a line nobody
    // asked for, so a flag that touches the port starts from the default.
    expect(buildBootConfig({ baud: '9600' }, []).settings?.serialConfig).toEqual({
      baudRate: 9600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1
    })
    expect(buildBootConfig({ 'serial-config': '7e2' }, []).settings?.serialConfig).toEqual({
      baudRate: 19200,
      dataBits: 7,
      parity: 'even',
      stopBits: 2
    })
    expect(() => buildBootConfig({ 'serial-config': '9Z3' }, [])).toThrow(/like 8N1/)
  })

  it('treats a serial port as an action, not a setting', () => {
    // The app does not remember a port between runs, so this is something to
    // do at launch rather than something to put in the panel.
    const config = buildBootConfig({ serial: '/dev/tty.usbserial-1420' }, [])
    expect(config.serialPort).toBe('/dev/tty.usbserial-1420')
    expect(config.settings).toBeUndefined()
  })

  it('parses --bin the same way the headless path does', () => {
    const config = buildBootConfig({ bin: [`0xC000=${program}`] }, [])
    expect(config.binaries).toEqual([{ address: 0xc000, path: program }])
  })

  it('only asks for a debug server when --debug says so', () => {
    expect(buildBootConfig({ 'debug-port': '9000' }, []).debug).toBeUndefined()
    expect(buildBootConfig({ debug: true }, []).debug).toEqual({})
    expect(buildBootConfig({ debug: true, 'debug-port': '9000', 'debug-token': 'abc' }, []).debug)
      .toEqual({ port: 9000, token: 'abc' })
  })

  it('leaves out what was not asked for', () => {
    // Absent is absent: main reads only the keys that are present, so an
    // explicit undefined would be indistinguishable from a file named "".
    expect(Object.keys(buildBootConfig({}, []))).toEqual([])
  })
})

describe('resolveApp', () => {
  it('takes an explicit path, and reports one that is not there', () => {
    expect(resolveApp(program)).toEqual({ command: program, args: [] })
    expect(() => resolveApp(join(dir, 'missing'))).toThrow(/--app: nothing to run/)
  })

  it('looks inside a macOS bundle for the executable', () => {
    // `--app /Applications/6502 Emulator.app` is what a person would type; the
    // thing to spawn is the binary buried in it.
    expect(() => resolveApp('/nowhere/6502 Emulator.app')).toThrow(
      /Contents\/MacOS\/6502 Emulator/
    )
  })
})
