/**
 * Argument helpers shared by the CLI commands.
 *
 * Every one of these reports failure by throwing UsageError, which the entry
 * point turns into a message and exit code 1. Silently coercing a bad argument
 * would leave someone debugging their 6502 program instead of their command
 * line.
 */

import type { ClockReading } from '../core/IO/RTC'

export class UsageError extends Error {}

/**
 * Parse an address written the way a 6502 programmer writes one: `$0800`,
 * `0x0800`, or plain decimal. Symbol names arrive with the debug core.
 */
export function parseAddress(text: string, label = 'address'): number {
  const trimmed = text.trim()
  const hex = trimmed.startsWith('$')
    ? trimmed.slice(1)
    : /^0x/i.test(trimmed)
      ? trimmed.slice(2)
      : null

  const value = hex === null ? Number(trimmed) : parseInt(hex, 16)

  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new UsageError(`${label}: expected an address in $0000-$FFFF, got "${text}"`)
  }
  return value
}

/** `--bin 0x0800=sprites.bin` — an address and the file to place there. */
export function parseBinarySpec(spec: string): { address: number; path: string } {
  const split = spec.indexOf('=')
  if (split === -1) {
    throw new UsageError(`--bin: expected <address>=<file>, got "${spec}"`)
  }
  return {
    address: parseAddress(spec.slice(0, split), '--bin'),
    path: spec.slice(split + 1)
  }
}

/** A count of things, for `--max-cycles`. Accepts `10_000_000` and `5e6`. */
export function parseCount(text: string, label: string): number {
  const value = Number(text.replace(/_/g, ''))
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${label}: expected a positive number, got "${text}"`)
  }
  return Math.floor(value)
}

/** A duration: bare seconds, or suffixed `500ms`, `30s`, `5m`. */
export function parseDuration(text: string, label: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(text.trim())
  if (!match) {
    throw new UsageError(`${label}: expected a duration like 30s, 500ms or 5m, got "${text}"`)
  }
  const value = Number(match[1])
  switch (match[2]) {
    case 'ms':
      return value
    case 'm':
      return value * 60_000
    default:
      return value * 1000
  }
}

/**
 * What the emulated clock should read, from an ISO 8601 date and time.
 *
 * Parsed by hand rather than handed to `new Date()`, for two reasons that both
 * come back to `--rtc` existing to make a run reproducible. `Date` accepts a
 * good deal more than ISO 8601 and disagrees between runtimes about what — a
 * string one engine reads as March and another rejects is the opposite of
 * reproducible. And `Date` is an *instant*, so turning it back into the digits a
 * wall clock shows needs a timezone, which would give a developer different
 * register values than a UTC CI runner from the same flag.
 *
 * So a timezone is not merely unnecessary here, it is refused: the emulated
 * clock is a clock on a desk, not a moment in history.
 */
export function parseClock(text: string, label: string): ClockReading {
  const trimmed = text.trim()
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      trimmed
    )

  if (!match) {
    throw new UsageError(
      `${label}: expected an ISO 8601 date like 2026-01-01T00:00:00, got "${text}"`
    )
  }
  if (match[7] !== undefined) {
    throw new UsageError(
      `${label}: the emulated clock has no timezone — drop the "${match[7]}" and give the ` +
        'time you want it to read'
    )
  }

  const reading: ClockReading = {
    year: Number(match[1]),
    month: Number(match[2]),
    date: Number(match[3]),
    hours: Number(match[4] ?? 0),
    minutes: Number(match[5] ?? 0),
    seconds: Number(match[6] ?? 0)
  }

  // The shape check above lets through 2026-13-40 and 25:61, and the day count
  // varies by month, so the values are checked too. Date's own ISO parsing rolls
  // an out-of-range day forward instead of failing — 2026-02-30 silently becomes
  // 2 March — and reproducible has to mean the date that was asked for.
  const daysInMonth = new Date(Date.UTC(reading.year, reading.month, 0)).getUTCDate()
  const valid =
    reading.month >= 1 &&
    reading.month <= 12 &&
    reading.date >= 1 &&
    reading.date <= daysInMonth &&
    reading.hours <= 23 &&
    reading.minutes <= 59 &&
    reading.seconds <= 59

  if (!valid) throw new UsageError(`${label}: "${text}" is not a real date and time`)

  return reading
}

/** PHI2 in Hz. The real board's jumper offers exactly these two. */
export function parseFrequency(text: string): number {
  const normalised = text.trim().toLowerCase()
  if (normalised === '1' || normalised === '1mhz') return 1_000_000
  if (normalised === '2' || normalised === '2mhz') return 2_000_000

  const value = Number(normalised.replace(/_/g, ''))
  if (value === 1_000_000 || value === 2_000_000) return value

  throw new UsageError(`--freq: the hardware supports 1MHz or 2MHz, got "${text}"`)
}
