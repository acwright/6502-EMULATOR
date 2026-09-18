/**
 * Argument helpers shared by the CLI commands.
 *
 * Every one of these reports failure by throwing UsageError, which the entry
 * point turns into a message and exit code 1. Silently coercing a bad argument
 * would leave someone debugging their 6502 program instead of their command
 * line.
 */

import type { ClockReading } from '../core/IO/RTC'
import type { VdpModel } from '../core/IO/VideoCard'
import { SERIAL_CARDS, normalizeSerialCard } from '../core/IO/SerialCard'
import type { SerialCardConfig } from '../core/IO/SerialCard'
import { parseVdp } from '../shared/vdp'
import {
  DEFAULT_SERIAL_CARD,
  SERIAL_CARDS_OFFERED,
  parseJumperPosition,
  parseSerialCard
} from '../shared/serialCard'

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

/**
 * A single byte, written the way a 6502 programmer writes one: `$EA`, `0xEA`,
 * or plain decimal. Zero is a value, not an omission — `mem fill … 0` is the
 * most common fill there is, so this must not borrow parseCount's
 * "positive number" rule.
 */
export function parseByte(text: string, label: string): number {
  const trimmed = text.trim()
  const hex = trimmed.startsWith('$')
    ? trimmed.slice(1)
    : /^0x/i.test(trimmed)
      ? trimmed.slice(2)
      : null

  const value =
    hex === null
      ? /^\d+$/.test(trimmed)
        ? Number(trimmed)
        : NaN
      : /^[0-9a-f]+$/i.test(hex)
        ? parseInt(hex, 16)
        : NaN

  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new UsageError(`${label}: expected a byte in $00-$FF, got "${text}"`)
  }
  return value
}

/** A count of things, for `--max-cycles`. Accepts `10_000_000` and `5e6`. */
export function parseCount(text: string, label: string): number {
  const value = Number(text.replace(/_/g, ''))
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${label}: expected a positive number, got "${text}"`)
  }
  return Math.floor(value)
}

/**
 * A position in the console's output stream, for `--since`.
 *
 * Zero is the start of the stream, not a missing argument: a machine that has
 * printed nothing yet hands out a cursor of 0, and `--since 0` asking for
 * everything the console has ever produced is the useful answer, not an error.
 */
export function parseCursor(text: string, label: string): number {
  const value = Number(text.replace(/_/g, ''))
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageError(`${label}: expected a stream position, got "${text}"`)
  }
  return value
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

/**
 * A serial line's framing, written the way every terminal program writes it:
 * `8N1`, `7E2`. Data bits, parity, stop bits.
 */
export function parseSerialFraming(
  text: string,
  label: string
): { dataBits: 5 | 6 | 7 | 8; parity: 'none' | 'even' | 'odd'; stopBits: 1 | 2 } {
  const match = /^([5-8])([neo])([12])$/i.exec(text.trim())
  if (!match) {
    throw new UsageError(`${label}: expected framing like 8N1 or 7E2, got "${text}"`)
  }
  const parity = { n: 'none', e: 'even', o: 'odd' } as const
  return {
    dataBits: Number(match[1]) as 5 | 6 | 7 | 8,
    parity: parity[match[2]!.toLowerCase() as 'n' | 'e' | 'o'],
    stopBits: Number(match[3]) as 1 | 2
  }
}

/**
 * `--serial-flow rtscts|none`: flow control on the *host's* port. Deprecated
 * in 3.3 and ignored.
 *
 * The app now opens a real port with the OS's own RTS/CTS off and has the
 * emulated machine do the handshake: its RTS drives the port's RTS line, and
 * the port's CTS reaches the chip wherever the card's jumper connects it to
 * the cable. An OS doing RTS/CTS as well would fight the machine for the line.
 *
 * Still parsed, so a typo is still an error and a script that passes it keeps
 * running, for one release. The value says nothing.
 */
export function parseSerialFlow(text: string, label: string): boolean {
  const normalised = text.trim().toLowerCase()
  if (normalised === 'rtscts') return true
  if (normalised === 'none') return false
  throw new UsageError(`${label}: expected rtscts or none, got "${text}"`)
}

/** What a run says when it is given `--serial-flow`. */
export const SERIAL_FLOW_DEPRECATED =
  '--serial-flow is deprecated and ignored: the machine drives the port\'s RTS itself, ' +
  'and the card\'s CTS EN jumper decides whether the port\'s CTS can stop it (--cts cable)'

/**
 * Whether the far end of the console honours the machine's RTS:
 * `--peer-rts honour|ignore`, or the older `--flow-control` /
 * `--no-flow-control`, which say the same and are deprecated in 3.3 but still
 * work. Undefined when none was given, so a caller can fall back to its default
 * (honour) or, in the app, to the saved setting.
 *
 * This is the console or pipe, never a real port: a real device honours RTS or
 * not by itself.
 */
export function parseFlowControlFlags(values: {
  'flow-control'?: boolean
  'no-flow-control'?: boolean
  'peer-rts'?: string
}): boolean | undefined {
  const on = values['flow-control'] === true
  const off = values['no-flow-control'] === true
  if (on && off) throw new UsageError('--flow-control and --no-flow-control cannot both be given')
  const legacy = on ? true : off ? false : undefined

  const text = values['peer-rts']
  if (text === undefined) return legacy

  const normalised = text.trim().toLowerCase()
  const honours =
    normalised === 'honour' || normalised === 'honor'
      ? true
      : normalised === 'ignore'
        ? false
        : null
  if (honours === null) {
    throw new UsageError(`--peer-rts: expected "honour" or "ignore", got "${text}"`)
  }
  if (legacy !== undefined && legacy !== honours) {
    throw new UsageError(
      `--peer-rts ${normalised} and --${legacy ? '' : 'no-'}flow-control say opposite things`
    )
  }
  return honours
}

/**
 * `--serial-card standard|pro|ace`, `--cts ground|cable`, `--dcd ground|cable`:
 * the serial card and where its jumpers are. Undefined when none was given.
 *
 * A jumper without a card belongs to the default card, the ACE, as a framing
 * without a port belongs to the default port settings: the flags describe a
 * whole card, never half of one merged into whatever was saved. A jumper the
 * card does not have is refused rather than dropped, because someone asked
 * for it and the board cannot do it.
 */
export function parseSerialCardFlags(values: {
  'serial-card'?: string
  cts?: string
  dcd?: string
}): SerialCardConfig | undefined {
  const cardText = values['serial-card']
  if (cardText === undefined && values.cts === undefined && values.dcd === undefined) {
    return undefined
  }

  let card = DEFAULT_SERIAL_CARD.card
  if (cardText !== undefined) {
    const parsed = parseSerialCard(cardText)
    if (parsed === null) {
      throw new UsageError(
        `--serial-card: expected ${SERIAL_CARDS_OFFERED.map((c) => `"${c}"`).join(', ')}, got "${cardText}"`
      )
    }
    card = parsed
  }

  const spec = SERIAL_CARDS[card]
  const jumpers: SerialCardConfig['jumpers'] = {}
  for (const pin of ['cts', 'dcd'] as const) {
    const text = values[pin]
    if (text === undefined) continue
    const position = parseJumperPosition(text)
    if (position === null) {
      throw new UsageError(`--${pin}: expected "ground" or "cable", got "${text}"`)
    }
    const wiring = spec.wiring[pin]
    if (wiring !== 'jumper') {
      const where = wiring === 'ground' ? 'is tied to ground' : 'always reaches the cable'
      throw new UsageError(
        `--${pin}: the ${spec.name} has no ${pin.toUpperCase()} jumper — its ${pin.toUpperCase()} ${where}`
      )
    }
    jumpers[pin] = position
  }

  return normalizeSerialCard({ card, jumpers })
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

/** `--vdp tms9918a|picovdp` — the video card. */
export function parseVdpFlag(text: string): VdpModel {
  const model = parseVdp(text)
  if (model === null) {
    throw new UsageError(`--vdp: expected "tms9918a" or "picovdp", got "${text}"`)
  }
  return model
}
