/**
 * Argument helpers shared by the CLI commands.
 *
 * Every one of these reports failure by throwing UsageError, which the entry
 * point turns into a message and exit code 1. Silently coercing a bad argument
 * would leave someone debugging their 6502 program instead of their command
 * line.
 */

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

/** PHI2 in Hz. The real board's jumper offers exactly these two. */
export function parseFrequency(text: string): number {
  const normalised = text.trim().toLowerCase()
  if (normalised === '1' || normalised === '1mhz') return 1_000_000
  if (normalised === '2' || normalised === '2mhz') return 2_000_000

  const value = Number(normalised.replace(/_/g, ''))
  if (value === 1_000_000 || value === 2_000_000) return value

  throw new UsageError(`--freq: the hardware supports 1MHz or 2MHz, got "${text}"`)
}
