import {
  UsageError,
  checkCartImage,
  parseClock,
  parseFlowControlFlags,
  parseSerialCardFlags
} from '../../cli/args'

/**
 * `--rtc` is the flag that makes a run reproducible, so its parsing is stricter
 * than `new Date()` on two counts. `Date` accepts far more than ISO 8601 and
 * disagrees between runtimes about what. And it produces an *instant*, which
 * needs a timezone to turn back into the digits on a clock face — so a timezone
 * is refused outright rather than silently making the same flag mean different
 * registers on a developer's machine than on a UTC CI runner.
 */
describe('parseClock', () => {
  it('reads the digits out of an ISO date and time', () => {
    expect(parseClock('2026-01-02T03:04:05', '--rtc')).toEqual({
      year: 2026,
      month: 1,
      date: 2,
      hours: 3,
      minutes: 4,
      seconds: 5
    })
  })

  it('defaults the parts that were left off', () => {
    expect(parseClock('2026-01-02', '--rtc')).toMatchObject({ hours: 0, minutes: 0, seconds: 0 })
    expect(parseClock('2026-01-02T03:04', '--rtc')).toMatchObject({ hours: 3, seconds: 0 })
  })

  it('accepts a space in place of the T, which is what people type', () => {
    expect(parseClock('2026-01-02 03:04:05', '--rtc')).toMatchObject({ hours: 3, seconds: 5 })
  })

  it('refuses a timezone, and says why', () => {
    expect(() => parseClock('2026-01-02T03:04:05Z', '--rtc')).toThrow(/no timezone/)
    expect(() => parseClock('2026-01-02T03:04:05+05:00', '--rtc')).toThrow(/drop the "\+05:00"/)
  })

  it('refuses formats Date would guess at', () => {
    for (const text of ['January 2 2026', '01/02/2026', 'now', 'tomorrow', '2026']) {
      expect(() => parseClock(text, '--rtc')).toThrow(UsageError)
    }
  })

  it('refuses a date or time that looks right but is not real', () => {
    // Date would roll 2026-02-30 forward to 2 March rather than failing.
    expect(() => parseClock('2026-02-30', '--rtc')).toThrow(/not a real date/)
    expect(() => parseClock('2026-13-01', '--rtc')).toThrow(/not a real date/)
    expect(() => parseClock('2026-01-00', '--rtc')).toThrow(/not a real date/)
    expect(() => parseClock('2026-01-02T24:00:00', '--rtc')).toThrow(/not a real date/)
    expect(() => parseClock('2026-01-02T00:60:00', '--rtc')).toThrow(/not a real date/)
    expect(() => parseClock('2026-01-02T00:00:60', '--rtc')).toThrow(/not a real date/)
  })

  it('accepts a leap day in a leap year and refuses one otherwise', () => {
    expect(parseClock('2028-02-29', '--rtc').date).toBe(29)
    expect(() => parseClock('2026-02-29', '--rtc')).toThrow(/not a real date/)
  })

  it('names the flag it is complaining about', () => {
    expect(() => parseClock('nonsense', '--rtc')).toThrow(/^--rtc:/)
  })
})

/**
 * `--serial-card`, `--cts`, `--dcd`: the card and its jumpers, from the COB
 * and ACE schematics. A jumper belongs to a card, so one the card lacks is
 * refused — the Pro's CTS always reaches the cable, and the Serial Card's DCD
 * is tied to ground — rather than quietly dropped.
 */
describe('parseSerialCardFlags', () => {
  it('says nothing when no flag is given', () => {
    expect(parseSerialCardFlags({})).toBeUndefined()
  })

  it('fits each card with its own jumpers at ground unless told otherwise', () => {
    expect(parseSerialCardFlags({ 'serial-card': 'standard' })).toEqual({
      card: 'standard',
      jumpers: { cts: 'ground' }
    })
    expect(parseSerialCardFlags({ 'serial-card': 'Pro' })).toEqual({ card: 'pro', jumpers: { dcd: 'ground' } })
    expect(parseSerialCardFlags({ 'serial-card': ' ace ', cts: 'cable' })).toEqual({
      card: 'ace',
      jumpers: { cts: 'cable', dcd: 'ground' }
    })
  })

  it('puts a jumper with no card on the default card, the ACE', () => {
    expect(parseSerialCardFlags({ dcd: 'cable' })).toEqual({
      card: 'ace',
      jumpers: { cts: 'ground', dcd: 'cable' }
    })
  })

  it('refuses a jumper the card does not have, and says why', () => {
    expect(() => parseSerialCardFlags({ 'serial-card': 'pro', cts: 'cable' })).toThrow(
      '--cts: the Serial Card Pro has no CTS jumper — its CTS always reaches the cable'
    )
    expect(() => parseSerialCardFlags({ 'serial-card': 'standard', dcd: 'ground' })).toThrow(
      '--dcd: the Serial Card has no DCD jumper — its DCD is tied to ground'
    )
  })

  it('refuses a card or a position it does not know', () => {
    expect(() => parseSerialCardFlags({ 'serial-card': 'kim' })).toThrow(UsageError)
    expect(() => parseSerialCardFlags({ 'serial-card': 'kim' })).toThrow(
      '--serial-card: expected "standard", "pro", "ace", got "kim"'
    )
    expect(() => parseSerialCardFlags({ cts: 'off' })).toThrow('--cts: expected "ground" or "cable", got "off"')
  })
})

/**
 * `--peer-rts honour|ignore`, and the deprecated `--[no-]flow-control` that
 * says the same, which still works.
 */
describe('parseFlowControlFlags', () => {
  it.each([
    [{}, undefined],
    [{ 'peer-rts': 'honour' }, true],
    [{ 'peer-rts': 'honor' }, true],
    [{ 'peer-rts': 'IGNORE' }, false],
    [{ 'flow-control': true }, true],
    [{ 'no-flow-control': true }, false],
    [{ 'peer-rts': 'ignore', 'no-flow-control': true }, false]
  ] as const)('reads %j as %s', (values, expected) => {
    expect(parseFlowControlFlags(values)).toBe(expected)
  })

  it('refuses a value it does not know, and flags that disagree', () => {
    expect(() => parseFlowControlFlags({ 'peer-rts': 'on' })).toThrow(
      '--peer-rts: expected "honour" or "ignore", got "on"'
    )
    expect(() => parseFlowControlFlags({ 'peer-rts': 'honour', 'no-flow-control': true })).toThrow(
      '--peer-rts honour and --no-flow-control say opposite things'
    )
  })
})

/**
 * `--cart` used to take whatever it was given and let `loadCart` drop a wrong
 * size in silence, which is how a flash image could be handed to a 3.3.0
 * machine and simply not appear.
 */
describe('checkCartImage', () => {

  it.each([
    ['Cart.crt', 32_768],
    ['Cart-128K.crt', 131_072],
    ['Cart-256K.crt', 262_144],
    ['Cart-VDP-512K.crt', 524_288],
    ['Cart-1M.crt', 1_048_576]
  ])('takes %s at %d bytes', (name, size) => {
    expect(checkCartImage(name, size)).toBeNull()
  })

  it('refuses any other size, and says which sizes there are', () => {
    expect(() => checkCartImage('build/game.crt', 16_384)).toThrow(UsageError)
    expect(() => checkCartImage('build/game.crt', 16_384)).toThrow(
      /is 16,384 bytes; a cartridge must be 32,768, 131,072, 262,144, 524,288, 1,048,576/
    )
  })

  it('warns, rather than refusing, when the name and the size disagree', () => {
    expect(checkCartImage('build/game-512K.crt', 262_144)).toMatch(
      /^--cart: "game-512K.crt" is named 512K but is 262,144 bytes/
    )
  })

  it('judges the basename, not the directory it sits in', () => {
    expect(checkCartImage('/builds/512K/game.crt', 32_768)).toBeNull()
  })

})
