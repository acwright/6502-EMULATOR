import { UsageError, parseClock } from '../../cli/args'

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
