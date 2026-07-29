import { invalidParams } from './Protocol'

/**
 * Parameter coercion for RPC methods.
 *
 * Every helper reports a bad value rather than defaulting it. A debugger that
 * quietly reads address 0 because a symbol did not resolve wastes far more time
 * than one that says so.
 */

export type Params = Record<string, unknown>

export function asObject(params: unknown, method: string): Params {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw invalidParams(`${method}: params must be an object`)
  }
  return params as Params
}

export function optionalNumber(params: Params, name: string): number | undefined {
  const value = params[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidParams(`${name}: expected a number, got ${JSON.stringify(value)}`)
  }
  return value
}

export function requireNumber(params: Params, name: string): number {
  const value = optionalNumber(params, name)
  if (value === undefined) throw invalidParams(`${name} is required`)
  return value
}

export function optionalBoolean(params: Params, name: string): boolean | undefined {
  const value = params[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw invalidParams(`${name}: expected true or false`)
  }
  return value
}

export function optionalString(params: Params, name: string): string | undefined {
  const value = params[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw invalidParams(`${name}: expected a string`)
  return value
}

export function requireString(params: Params, name: string): string {
  const value = optionalString(params, name)
  if (value === undefined) throw invalidParams(`${name} is required`)
  return value
}

export function oneOf<T extends string>(
  params: Params,
  name: string,
  allowed: readonly T[]
): T | undefined {
  const value = optionalString(params, name)
  if (value === undefined) return undefined
  if (!(allowed as readonly string[]).includes(value)) {
    throw invalidParams(`${name}: expected one of ${allowed.join(', ')}, got "${value}"`)
  }
  return value as T
}

/**
 * An address, written any of the ways a 6502 programmer writes one — `49152`,
 * `$C000`, `0xC000` — or a symbol name.
 *
 * Symbols are accepted everywhere an address is, which is the difference
 * between `bp.set {address: "main"}` and making every caller resolve first.
 */
export function toAddress(
  value: unknown,
  name: string,
  resolve?: (symbol: string) => number | undefined
): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw invalidParams(`${name}: expected an address in $0000-$FFFF, got ${value}`)
    }
    return value
  }

  if (typeof value !== 'string') throw invalidParams(`${name}: expected an address or symbol`)

  const text = value.trim()
  const hex = text.startsWith('$') ? text.slice(1) : /^0x/i.test(text) ? text.slice(2) : null

  if (hex !== null) {
    const parsed = parseInt(hex, 16)
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 0xffff) {
      throw invalidParams(`${name}: expected an address in $0000-$FFFF, got "${value}"`)
    }
    return parsed
  }

  if (/^\d+$/.test(text)) {
    const parsed = Number(text)
    if (parsed > 0xffff) {
      throw invalidParams(`${name}: expected an address in $0000-$FFFF, got "${value}"`)
    }
    return parsed
  }

  const symbol = resolve?.(text)
  if (symbol === undefined) {
    throw invalidParams(`${name}: no symbol named "${text}" — load one with sym.load`)
  }
  return symbol
}

export function requireAddress(
  params: Params,
  name: string,
  resolve?: (symbol: string) => number | undefined
): number {
  if (params[name] === undefined || params[name] === null) {
    throw invalidParams(`${name} is required`)
  }
  return toAddress(params[name], name, resolve)
}

export function optionalAddress(
  params: Params,
  name: string,
  resolve?: (symbol: string) => number | undefined
): number | undefined {
  if (params[name] === undefined || params[name] === null) return undefined
  return toAddress(params[name], name, resolve)
}

/**
 * Bytes, given as base64 or as an array of numbers.
 *
 * Both are accepted on input on purpose: base64 is what a program generates,
 * and `[1,2,3]` is what a person types into a shell one-liner.
 */
export function toBytes(value: unknown, name: string): Uint8Array {
  if (typeof value === 'string') {
    const bytes = Uint8Array.from(Buffer.from(value, 'base64'))
    // Buffer.from ignores anything it cannot decode, so a typo silently becomes
    // a shorter write. Re-encoding and comparing catches that.
    if (Buffer.from(bytes).toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
      throw invalidParams(`${name}: not valid base64`)
    }
    return bytes
  }

  if (Array.isArray(value)) {
    const out = new Uint8Array(value.length)
    value.forEach((byte, i) => {
      if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw invalidParams(`${name}[${i}]: expected a byte 0-255, got ${JSON.stringify(byte)}`)
      }
      out[i] = byte
    })
    return out
  }

  throw invalidParams(`${name}: expected base64 or an array of bytes`)
}

/** Compile a client-supplied pattern, reporting a bad one as a param error. */
export function toRegExp(value: string, name: string): RegExp {
  try {
    return new RegExp(value)
  } catch (e) {
    throw invalidParams(`${name}: ${(e as Error).message}`)
  }
}

export const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
