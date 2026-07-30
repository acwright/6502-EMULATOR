/**
 * The vocabulary every device serializes with.
 *
 * Snapshots travel as JSON over the debug protocol, so a device's state has to
 * be JSON-ready — no typed arrays, no Maps, no class instances. Byte arrays
 * become base64: four characters per three bytes, against roughly three
 * characters per byte for `[0,0,0,…]`, which turns 32 KB of RAM into 44 KB
 * encoded instead of over 100 KB.
 *
 * Every read validates. A snapshot is untrusted input — a truncated file, a
 * hand-edited field, a format written by a build this one has never seen — and a
 * device that quietly accepted `undefined` for a register would leave the
 * machine in a state no real board can be in, which is far harder to diagnose
 * than a refusal.
 *
 * Buffer rather than atob/btoa because it exists in every context this code
 * runs in: plain Node in the headless host, and the renderer, which already
 * polyfills it (Video's framebuffer is a Buffer).
 */

/** One device's complete state, as it appears in a snapshot. */
export interface DeviceState {
  /**
   * Names the device.
   *
   * Checked on the way back in, so a state cannot be applied to the wrong
   * device — restoring a Video card's registers into a Sound card would
   * otherwise half-succeed and leave no trace of why the machine went wrong.
   */
  kind: string
  [field: string]: unknown
}

/** A snapshot that cannot be applied, and why. */
export class StateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StateError'
  }
}

export function toBase64(bytes: Uint8Array | number[]): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes)).toString('base64')
}

export function fromBase64(text: string, label: string): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(text, 'base64'))
  // Buffer.from ignores anything it cannot decode, so a corrupted field would
  // silently become a shorter array. Re-encoding and comparing catches it.
  if (Buffer.from(bytes).toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) {
    throw new StateError(`${label}: not valid base64`)
  }
  return bytes
}

/** Where a field sits, for an error message that says which device complained. */
const at = (state: DeviceState, field: string): string => `${String(state.kind)}.${field}`

export function readNumber(state: DeviceState, field: string): number {
  const value = state[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StateError(`${at(state, field)}: expected a number, got ${JSON.stringify(value)}`)
  }
  return value
}

export function readBoolean(state: DeviceState, field: string): boolean {
  const value = state[field]
  if (typeof value !== 'boolean') {
    throw new StateError(`${at(state, field)}: expected true or false, got ${JSON.stringify(value)}`)
  }
  return value
}

export function readString(state: DeviceState, field: string): string {
  const value = state[field]
  if (typeof value !== 'string') {
    throw new StateError(`${at(state, field)}: expected a string, got ${JSON.stringify(value)}`)
  }
  return value
}

/** A base64 byte array, optionally required to be an exact length. */
export function readBytes(state: DeviceState, field: string, length?: number): Uint8Array {
  const bytes = fromBase64(readString(state, field), at(state, field))
  if (length !== undefined && bytes.length !== length) {
    throw new StateError(
      `${at(state, field)}: expected ${length} bytes, got ${bytes.length}`
    )
  }
  return bytes
}

/** A plain array of bytes — for the handful of places a queue is more natural. */
export function readByteList(state: DeviceState, field: string): number[] {
  const value = state[field]
  if (!Array.isArray(value)) {
    throw new StateError(`${at(state, field)}: expected an array of bytes`)
  }
  return value.map((byte, i) => {
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new StateError(`${at(state, field)}[${i}]: expected a byte 0-255`)
    }
    return byte
  })
}

/** A nested device state — a SID voice, a VIA attachment. */
export function readState(state: DeviceState, field: string): DeviceState {
  const value = state[field]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StateError(`${at(state, field)}: expected a nested state object`)
  }
  const nested = value as Record<string, unknown>
  if (typeof nested.kind !== 'string') {
    throw new StateError(`${at(state, field)}: nested state has no "kind"`)
  }
  return nested as DeviceState
}

export function readStates(state: DeviceState, field: string, count?: number): DeviceState[] {
  const value = state[field]
  if (!Array.isArray(value)) {
    throw new StateError(`${at(state, field)}: expected an array of nested states`)
  }
  if (count !== undefined && value.length !== count) {
    throw new StateError(`${at(state, field)}: expected ${count} entries, got ${value.length}`)
  }
  return value.map((entry, i) =>
    readState({ kind: state.kind, [`${field}[${i}]`]: entry }, `${field}[${i}]`)
  )
}

/** Refuse a state that belongs to a different device. */
export function expectKind(state: DeviceState, kind: string): void {
  if (state.kind !== kind) {
    throw new StateError(
      `snapshot: expected ${kind} state here, got ${JSON.stringify(state.kind)} — ` +
        'the snapshot was taken from a machine with a different configuration'
    )
  }
}
