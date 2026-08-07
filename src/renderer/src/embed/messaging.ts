import { onUnmounted } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { usePaste } from '@/composables/usePaste'
import { decodeBase64 } from './params'
import { PROGRAM_LOAD_ADDRESS } from '@core/ProgramImage'
import type { StopReason } from '@debug/Session'

/**
 * The `postMessage` control API.
 *
 * What it is for: a docs page putting a "Run this" button beside a code block,
 * without reloading the iframe or round-tripping through a URL. Everything the
 * URL parameters can do at load time, this can do at any time.
 *
 * Message names are prefixed `6502:` so a host page sharing its window with
 * other widgets can tell ours apart, and so we can ignore everyone else's.
 */

export type EmbedInbound =
  | { type: '6502:load'; kind: LoadKind; data: unknown; address?: number; label?: string }
  | { type: '6502:run' }
  | { type: '6502:pause' }
  | { type: '6502:reset' }
  | { type: '6502:powerCycle' }
  | { type: '6502:setMuted'; muted: boolean }
  | { type: '6502:type'; text: string }

export type LoadKind = 'rom' | 'cart' | 'prg' | 'bin' | 'cf'

const LOAD_KINDS: readonly LoadKind[] = ['rom', 'cart', 'prg', 'bin', 'cf']

/**
 * Serial bytes are coalesced over this window before being posted out.
 *
 * The ACIA transmits one byte at a time; a `postMessage` per character during a
 * BASIC listing would be thousands of structured clones a second for data the
 * host page will only ever concatenate anyway.
 */
const SERIAL_FLUSH_MS = 32

export interface EmbedMessagingOptions {
  /** Origins allowed to send us commands; null accepts any. See params.ts. */
  origins: string[] | null
  /**
   * Muting, supplied by the caller rather than taken from `useAudio` directly:
   * the embed's mute is a per-frame thing and must not write back over the main
   * app's stored preference on the same origin.
   */
  setMuted: (muted: boolean) => void
  /** Reported alongside `6502:ready` so a host can branch on what it got. */
  describe?: () => Record<string, unknown>
}

/** Coerce whatever a host page put in `data` into bytes. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (Array.isArray(data)) return Uint8Array.from(data.map((n) => Number(n) & 0xff))
  // A string is base64 — the form that survives being written into a JSON blob
  // or an HTML attribute, which is how most host pages will carry a program.
  if (typeof data === 'string') {
    try {
      return decodeBase64(data)
    } catch {
      return null
    }
  }
  return null
}

export function useEmbedMessaging(options: EmbedMessagingOptions) {
  const store = useEmulatorStore()
  const paste = usePaste()

  /**
   * Where outbound messages go.
   *
   * With `origins` configured, each named origin gets its own post and the
   * browser drops it unless the frame's parent really is that origin. Without,
   * `'*'` — the same open default the inbound side runs, documented in
   * docs/EMBEDDING.md. Nothing we send contains anything the host page did not
   * already give us or could not already see on screen.
   */
  function post(message: Record<string, unknown>): void {
    if (window.parent === window) return
    for (const origin of options.origins ?? ['*']) {
      try {
        window.parent.postMessage(message, origin)
      } catch {
        /* a host that went away mid-run is not our problem */
      }
    }
  }

  function allowed(origin: string): boolean {
    return options.origins === null || options.origins.includes(origin)
  }

  function applyLoad(message: Extract<EmbedInbound, { type: '6502:load' }>): void {
    const kind = message.kind
    if (!LOAD_KINDS.includes(kind)) return
    const bytes = toBytes(message.data)
    if (!bytes || bytes.length === 0) {
      console.warn('[embed] 6502:load — no usable bytes in `data`')
      return
    }
    const label = message.label ?? `${kind} (postMessage)`

    switch (kind) {
      // Both reset as part of the load: new vectors, and the CPU would
      // otherwise carry on from wherever the old image had it.
      case 'rom':
        store.loadROM(bytes, label)
        break
      case 'cart':
        store.loadCart(bytes, label)
        break
      case 'prg':
        store.loadProgram(bytes, label)
        break
      case 'bin':
        store.loadBinary(bytes, message.address ?? PROGRAM_LOAD_ADDRESS, label)
        break
      case 'cf':
        store.reloadCF(bytes)
        break
    }
  }

  function onMessage(event: MessageEvent): void {
    if (!allowed(event.origin)) return
    const message = event.data as EmbedInbound | null
    if (!message || typeof message !== 'object') return
    if (typeof message.type !== 'string' || !message.type.startsWith('6502:')) return

    switch (message.type) {
      case '6502:load':
        applyLoad(message)
        break
      case '6502:run':
        store.run()
        break
      case '6502:pause':
        store.stop()
        break
      case '6502:reset':
        store.reset()
        break
      case '6502:powerCycle':
        store.powerCycle()
        break
      case '6502:setMuted':
        options.setMuted(!!message.muted)
        break
      case '6502:type':
        if (typeof message.text === 'string') void paste.injectText(message.text)
        break
      default:
        // Unknown `6502:` verbs are ignored, for the same reason unknown URL
        // parameters are: a host page may be newer than the pinned emulator.
        break
    }
  }

  // ── Outbound: serial ───────────────────────────────────────────────────────

  let serialBuffer: number[] = []
  let serialTimer: ReturnType<typeof setTimeout> | null = null

  function flushSerial(): void {
    serialTimer = null
    if (serialBuffer.length === 0) return
    const bytes = serialBuffer
    serialBuffer = []
    post({
      type: '6502:serial',
      bytes,
      // The same bytes as text, since a host page logging the machine's output
      // would otherwise have to reimplement this on the other side.
      text: String.fromCharCode(...bytes.map((b) => b & 0x7f)),
    })
  }

  store.setTransmitCallback((data: number) => {
    serialBuffer.push(data & 0xff)
    serialTimer ??= setTimeout(flushSerial, SERIAL_FLUSH_MS)
  })

  // ── Outbound: stops ────────────────────────────────────────────────────────

  const unsubscribeStop = store.session?.onStop((reason: StopReason) => {
    post({ type: '6502:stopped', reason })
  })

  window.addEventListener('message', onMessage)

  onUnmounted(() => {
    window.removeEventListener('message', onMessage)
    if (serialTimer !== null) clearTimeout(serialTimer)
    unsubscribeStop?.()
  })

  /** Announce the frame once the machine is up and the first ROM is in. */
  function announceReady(): void {
    post({ type: '6502:ready', ...(options.describe?.() ?? {}) })
  }

  return { announceReady, post }
}
