/**
 * The embed page's URL parameter API.
 *
 * Deliberately import-free — no Vue, no DOM, none of the emulator core — so the
 * entire configuration surface is testable as plain TypeScript under the
 * existing node-environment Jest setup. Anything that needs a browser (fetching
 * a URL, mounting the app) lives in `media.ts` and `EmbedApp.vue`.
 *
 * Two rules run through the whole file:
 *
 * 1. **Nothing here is fatal.** A malformed value falls back to its default and
 *    records a warning; an unknown parameter is ignored outright. A docs site
 *    pins an emulator version and then starts passing a parameter that version
 *    has never heard of — that has to degrade to "the emulator still boots",
 *    not to a blank frame.
 * 2. **Every source of bytes has a `64` twin.** `rom`/`rom64`, `cart`/`cart64`,
 *    `prg`/`prg64`, `cf`/`cf64`, `bin`/`bin64`. A URL needs CORS on whatever
 *    host serves it *and* a `connect-src` that permits it; an inline base64
 *    payload needs neither, which is what makes a self-contained snippet on a
 *    third-party page possible at all.
 */

export type ControlsMode = 'full' | 'minimal' | 'none'

/**
 * Whether the on-screen keyboard starts up.
 *
 * Three states rather than a flag, because the useful default is neither on nor
 * off. `auto` is resolved in the browser — see `EmbedApp.vue` — and comes out on
 * for a device that has no keyboard of its own and off for one that has. That
 * asymmetry is the point: a phone with no board on screen cannot type into BASIC
 * at all, and a desktop that opens one has given up a third of the frame to
 * something the reader already has under their hands.
 */
export type KeyboardMode = 'auto' | 'on' | 'off'

/** Where a piece of media comes from: fetched, or carried in the URL itself. */
export type MediaSource =
  | { kind: 'url'; url: string; label: string }
  | { kind: 'inline'; bytes: Uint8Array; label: string }

/** A `bin` / `bin64` entry: raw bytes and the address they belong at. */
export interface BinarySource {
  address: number
  source: MediaSource
}

export interface EmbedParams {
  /** ROM image; null means the bundled BIOS. */
  rom: MediaSource | null
  cart: MediaSource | null
  /** A `.prg` / `.bas` image for $0800. */
  program: MediaSource | null
  /** A CompactFlash image. */
  cf: MediaSource | null
  binaries: BinarySource[]
  autostart: boolean
  /** Text typed into the machine once it has booted, or null. */
  autotype: string | null
  controls: ControlsMode
  /** Whether the on-screen keyboard starts up; `auto` decides in the browser. */
  keyboard: KeyboardMode
  /** CPU clock in Hz. */
  frequency: number
  muted: boolean
  persist: boolean
  /** CompactFlash card size in bytes. */
  cfSize: number
  /**
   * Origins allowed to drive this embed over postMessage, or null for "any".
   * See `messaging.ts` for why null is the default.
   */
  origins: string[] | null
  /** Human-readable notes about anything that was ignored or corrected. */
  warnings: string[]
}

/** $8000 and up is I/O, so a `bin` address has to fit under it — and in a word. */
const MAX_ADDRESS = 0xffff

const ONE_MB = 1024 * 1024

/**
 * CF size when the embed keeps nothing.
 *
 * The store's 256 MB matches the real machine, but two embeds on one docs page
 * would be half a gigabyte of `Uint8Array` for a card neither of them touches.
 * One megabyte is one disk — enough for the BIOS to find a card at all.
 */
export const DEFAULT_EMBED_CF_SIZE = ONE_MB

/**
 * CF size when `persist=1`.
 *
 * The full card, because persistence shares one IndexedDB record with the main
 * app on the same origin. `Storage.loadData()` resizes to whatever it is handed,
 * so an embed that started small and saved first would shrink the user's real
 * 256 MB card to match. Same geometry, no surprise.
 */
export const PERSISTENT_CF_SIZE = 256 * ONE_MB

/** Largest `cfsize` we will honour, in megabytes. */
const MAX_CF_SIZE_MB = 256

const DISPLAY_NAMES: Record<string, string> = {
  rom: 'ROM',
  cart: 'Cart',
  prg: 'Program',
  cf: 'CF image',
  bin: 'Binary',
}

// ── base64 ───────────────────────────────────────────────────────────────────

const BASE64_VALUES: Record<string, number> = (() => {
  const table: Record<string, number> = {}
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < alphabet.length; i++) table[alphabet[i]!] = i
  // The URL-safe alphabet (RFC 4648 §5), so a payload generated with
  // `base64url` needs no translation on the way in.
  table['-'] = 62
  table['_'] = 63
  // A query string decodes `+` to a space, so plain base64 pasted into a URL
  // arrives with its 62nd character replaced. Accepting the space is friendlier
  // than requiring every caller to percent-encode by hand, and a space means
  // nothing else here.
  table[' '] = 62
  return table
})()

/**
 * Decode a base64 payload as it arrives from a URL parameter.
 *
 * Hand-rolled rather than `atob` for two reasons: it runs identically in the
 * browser and in the node-environment test suite, and it *rejects* junk instead
 * of quietly tolerating it — a mistyped payload should surface as a warning
 * about that parameter, not as an emulator loading half a program.
 *
 * Accepts the standard and URL-safe alphabets, optional padding, embedded
 * whitespace, and a leading `data:...;base64,` prefix.
 *
 * @throws if the text contains anything that is not base64.
 */
export function decodeBase64(text: string): Uint8Array {
  const payload = text
    .replace(/^data:[^,]*;base64,/i, '')
    .replace(/[\r\n\t]/g, '')

  const bytes: number[] = []
  let bits = 0
  let bitCount = 0

  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i]!
    if (ch === '=') {
      // Padding, and nothing but padding, may follow.
      const stray = /[^=]/.exec(payload.slice(i))
      if (stray) throw new Error(`unexpected "${stray[0]}" after base64 padding`)
      break
    }
    const value = BASE64_VALUES[ch]
    if (value === undefined) throw new Error(`invalid base64 character "${ch}"`)
    // Masked, or the accumulator overflows after a handful of characters — the
    // low 14 bits are all `bitCount` can ever reach back into.
    bits = ((bits << 6) | value) & 0x3fff
    bitCount += 6
    if (bitCount >= 8) {
      bitCount -= 8
      bytes.push((bits >> bitCount) & 0xff)
    }
  }

  return Uint8Array.from(bytes)
}

// ── scalar values ────────────────────────────────────────────────────────────

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on', ''])
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off'])

/**
 * A flag, in any of the spellings someone hand-writing a URL might reach for.
 * A bare `?autostart` with no value counts as true — that is what writing it at
 * all means.
 */
function readBoolean(
  raw: string | null,
  key: string,
  fallback: boolean,
  warnings: string[]
): boolean {
  if (raw === null) return fallback
  const value = raw.trim().toLowerCase()
  if (TRUE_WORDS.has(value)) return true
  if (FALSE_WORDS.has(value)) return false
  warnings.push(`${key}: expected 1 or 0, got "${raw}" — using ${fallback ? '1' : '0'}.`)
  return fallback
}

/**
 * An address the way a 6502 programmer writes one — `$0800`, `0x0800` or plain
 * decimal — matching `parseAddress` in the CLI so `--bin` and `bin=` accept the
 * same spellings.
 */
function parseAddress(text: string): number | null {
  const trimmed = text.trim()
  const hex = trimmed.startsWith('$')
    ? trimmed.slice(1)
    : /^0x/i.test(trimmed)
      ? trimmed.slice(2)
      : null

  const value = hex === null ? Number(trimmed) : parseInt(hex, 16)
  if (trimmed === '' || !Number.isInteger(value) || value < 0 || value > MAX_ADDRESS) return null
  return value
}

/**
 * `\r`, `\n`, `\t` and `\\` written literally, because `autotype=RUN\r` is what
 * anyone writing this parameter by hand will type. Percent-encoded control
 * characters arrive already decoded and pass through untouched.
 */
function unescapeText(text: string): string {
  return text.replace(/\\([rnt\\])/g, (_, ch: string) =>
    ch === 'r' ? '\r' : ch === 'n' ? '\n' : ch === 't' ? '\t' : '\\'
  )
}

/** The last path segment of a URL, for the "loaded file" labels the store keeps. */
function labelFromUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? url
  const segment = withoutQuery.split('/').filter(Boolean).pop()
  if (!segment) return url
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

// ── media ────────────────────────────────────────────────────────────────────

/**
 * One media slot from its two spellings. `<key>64` wins when both are present:
 * it is already in hand and needs no network at all, so preferring it can only
 * make the embed load in fewer round trips.
 */
function readMedia(
  query: URLSearchParams,
  key: string,
  warnings: string[]
): MediaSource | null {
  const inline = query.get(`${key}64`)
  const url = query.get(key)
  const name = DISPLAY_NAMES[key] ?? key

  if (inline !== null) {
    if (url !== null) {
      warnings.push(`${key} and ${key}64 both given — using ${key}64.`)
    }
    return decodeInline(inline, `${key}64`, name, warnings)
  }

  if (url === null) return null
  const trimmed = url.trim()
  if (!trimmed) {
    warnings.push(`${key}: empty — ignored.`)
    return null
  }
  return { kind: 'url', url: trimmed, label: labelFromUrl(trimmed) }
}

function decodeInline(
  payload: string,
  key: string,
  name: string,
  warnings: string[]
): MediaSource | null {
  let bytes: Uint8Array
  try {
    bytes = decodeBase64(payload)
  } catch (e) {
    warnings.push(`${key}: ${(e as Error).message} — ignored.`)
    return null
  }
  if (bytes.length === 0) {
    warnings.push(`${key}: decoded to no bytes — ignored.`)
    return null
  }
  return { kind: 'inline', bytes, label: `${name} (inline)` }
}

/**
 * `bin` and `bin64` in the order they appear in the URL, because they are
 * writes to memory and two of them can overlap. Whatever the author wrote last
 * should land last, whichever spelling they used for each.
 */
function readBinaries(query: URLSearchParams, warnings: string[]): BinarySource[] {
  const binaries: BinarySource[] = []

  for (const [key, value] of query.entries()) {
    if (key !== 'bin' && key !== 'bin64') continue

    const split = value.indexOf('=')
    if (split === -1) {
      warnings.push(`${key}: expected <address>=${key === 'bin' ? '<url>' : '<base64>'}, got "${value}" — ignored.`)
      continue
    }

    const address = parseAddress(value.slice(0, split))
    if (address === null) {
      warnings.push(`${key}: expected an address in $0000-$FFFF, got "${value.slice(0, split)}" — ignored.`)
      continue
    }

    // First `=` only: base64 padding is made of them, so the rest of the value
    // belongs to the payload.
    const rest = value.slice(split + 1)
    const source =
      key === 'bin64'
        ? decodeInline(rest, 'bin64', DISPLAY_NAMES.bin!, warnings)
        : rest.trim()
          ? ({ kind: 'url', url: rest.trim(), label: labelFromUrl(rest.trim()) } as MediaSource)
          : null

    if (!source) {
      if (key === 'bin') warnings.push('bin: empty URL — ignored.')
      continue
    }
    binaries.push({ address, source })
  }

  return binaries
}

// ── the parser ───────────────────────────────────────────────────────────────

/**
 * Read the embed's configuration out of a query string.
 *
 * Accepts a raw `location.search` (leading `?` and all) or an already-built
 * `URLSearchParams`. Never throws.
 */
export function parseEmbedParams(search: string | URLSearchParams = ''): EmbedParams {
  const query = typeof search === 'string' ? new URLSearchParams(search) : search
  const warnings: string[] = []

  const persist = readBoolean(query.get('persist'), 'persist', false, warnings)

  return {
    rom: readMedia(query, 'rom', warnings),
    cart: readMedia(query, 'cart', warnings),
    program: readMedia(query, 'prg', warnings),
    cf: readMedia(query, 'cf', warnings),
    binaries: readBinaries(query, warnings),
    autostart: readBoolean(query.get('autostart'), 'autostart', true, warnings),
    autotype: readAutotype(query, warnings),
    controls: readControls(query, warnings),
    keyboard: readKeyboard(query, warnings),
    frequency: readFrequency(query, warnings),
    // Muted by default: an iframe is the one place a browser is most likely to
    // refuse audio anyway, and an embed that starts making noise on a page the
    // reader was only scrolling past is the worse failure of the two.
    muted: readBoolean(query.get('muted'), 'muted', true, warnings),
    persist,
    cfSize: readCfSize(query, persist, warnings),
    origins: readOrigins(query),
    warnings,
  }
}

function readAutotype(query: URLSearchParams, warnings: string[]): string | null {
  const raw = query.get('autotype')
  if (raw === null) return null
  const text = unescapeText(raw)
  if (!text) {
    warnings.push('autotype: empty — ignored.')
    return null
  }
  return text
}

function readControls(query: URLSearchParams, warnings: string[]): ControlsMode {
  const raw = query.get('controls')
  if (raw === null) return 'minimal'
  const value = raw.trim().toLowerCase()
  if (value === 'full' || value === 'minimal' || value === 'none') return value
  warnings.push(`controls: expected full, minimal or none, got "${raw}" — using minimal.`)
  return 'minimal'
}

/**
 * `keyboard=1|0|auto`, sharing the flag words with every other boolean here so
 * that `keyboard=yes` and `keyboard=on` mean what they look like — and a bare
 * `?keyboard` means on, which is what writing it at all means.
 *
 * `auto` is a third state and not a fallback: it survives to `EmbedApp.vue`,
 * which is the only place that can ask the browser whether this device has a
 * keyboard already.
 */
function readKeyboard(query: URLSearchParams, warnings: string[]): KeyboardMode {
  const raw = query.get('keyboard')
  if (raw === null) return 'auto'
  const value = raw.trim().toLowerCase()
  if (value === 'auto') return 'auto'
  if (TRUE_WORDS.has(value)) return 'on'
  if (FALSE_WORDS.has(value)) return 'off'
  warnings.push(`keyboard: expected 1, 0 or auto, got "${raw}" — using auto.`)
  return 'auto'
}

function readFrequency(query: URLSearchParams, warnings: string[]): number {
  const raw = query.get('freq')
  if (raw === null) return 1_000_000
  const value = raw.trim().toLowerCase().replace(/\s*mhz$/, '')
  if (value === '1' || value === '1000000') return 1_000_000
  if (value === '2' || value === '2000000') return 2_000_000
  warnings.push(`freq: expected 1 or 2 (MHz), got "${raw}" — using 1.`)
  return 1_000_000
}

function readCfSize(query: URLSearchParams, persist: boolean, warnings: string[]): number {
  const fallback = persist ? PERSISTENT_CF_SIZE : DEFAULT_EMBED_CF_SIZE
  const raw = query.get('cfsize')
  if (raw === null) return fallback

  const megabytes = Number(raw.trim())
  if (!Number.isInteger(megabytes) || megabytes < 1 || megabytes > MAX_CF_SIZE_MB) {
    warnings.push(
      `cfsize: expected 1-${MAX_CF_SIZE_MB} (MB), got "${raw}" — using ${fallback / ONE_MB}.`
    )
    return fallback
  }
  return megabytes * ONE_MB
}

/**
 * Origins permitted to drive the embed over postMessage.
 *
 * Absent — or `*` — means any, which is what lets a raw `<iframe>` on someone
 * else's CDN work with no configuration at all. The exposure is bounded: the
 * emulator holds no credentials and cannot see the host page, so the worst a
 * hostile framer can do is drive the emulated machine it is already framing.
 * Naming origins narrows it to those; see docs/EMBEDDING.md.
 */
function readOrigins(query: URLSearchParams): string[] | null {
  const raw = query.get('origins')
  if (raw === null) return null
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  if (origins.length === 0 || origins.includes('*')) return null
  return origins
}
