import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'

/**
 * The server half of RFC 6455, in about as little code as the spec allows.
 *
 * Written rather than depended upon for a specific reason: this ships inside an
 * Electron app that a user installs, and the client side needs nothing at all —
 * Node has had a standards-compliant `WebSocket` client global since v22, so
 * the CLI connects with no dependency either. Adding a package to both ends of
 * a loopback socket we fully control is not a trade worth making.
 *
 * Deliberately not implemented: extensions (permessage-deflate), because
 * loopback JSON does not need compressing, and the client-side masking path,
 * because this end never masks.
 */

/** The magic string RFC 6455 §4.2.2 makes part of the handshake. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * Largest message accepted. Generous for JSON-RPC — a full 64K memory write in
 * base64 is ~87 KB — while still bounding what one client can make us buffer.
 */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

export const Opcode = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
} as const

export type Opcode = (typeof Opcode)[keyof typeof Opcode]

/** The `Sec-WebSocket-Accept` value proving we understood the handshake. */
export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + GUID)
    .digest('base64')
}

/** Frame a payload for sending. The server never masks — RFC 6455 §5.1. */
export function encodeFrame(payload: Buffer, opcode: Opcode = Opcode.TEXT): Buffer {
  const length = payload.length
  let header: Buffer

  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 0x10000) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }

  header[0] = 0x80 | opcode // FIN set: every message we send is one frame.
  return Buffer.concat([header, payload])
}

interface DecodedFrame {
  fin: boolean
  opcode: Opcode
  payload: Buffer
  /** Total bytes consumed, so the caller can advance its buffer. */
  size: number
}

/**
 * Decode one frame, or report that more bytes are needed.
 *
 * Returns undefined when the buffer holds only part of a frame — TCP gives no
 * guarantee that a frame arrives in one chunk, and a debugger sending a 64K
 * memory write will reliably prove it.
 */
function decodeFrame(buffer: Buffer): DecodedFrame | undefined {
  if (buffer.length < 2) return undefined

  const first = buffer[0]!
  const second = buffer[1]!
  const fin = (first & 0x80) !== 0
  const opcode = (first & 0x0f) as Opcode
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2

  if (length === 126) {
    if (buffer.length < offset + 2) return undefined
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined
    const big = buffer.readBigUInt64BE(offset)
    if (big > BigInt(MAX_MESSAGE_BYTES)) {
      throw new Error(`frame of ${big} bytes exceeds the ${MAX_MESSAGE_BYTES} byte limit`)
    }
    length = Number(big)
    offset += 8
  }

  if (length > MAX_MESSAGE_BYTES) {
    throw new Error(`frame of ${length} bytes exceeds the ${MAX_MESSAGE_BYTES} byte limit`)
  }

  // RFC 6455 §5.1: a client frame that is not masked is a protocol error.
  if (!masked) throw new Error('client frames must be masked')

  if (buffer.length < offset + 4 + length) return undefined
  const mask = buffer.subarray(offset, offset + 4)
  offset += 4

  const payload = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i++) payload[i] = buffer[offset + i]! ^ mask[i & 3]!

  return { fin, opcode, payload, size: offset + length }
}

export interface WebSocketHandlers {
  onMessage?: (text: string) => void
  onClose?: () => void
}

/**
 * One accepted connection.
 *
 * The handshake has already happened by the time this exists; it owns the raw
 * socket from there on.
 */
export class WebSocketConnection {
  /**
   * Bytes received but not yet forming a whole frame.
   *
   * Typed loosely on the backing store because what arrives from a socket and
   * what Buffer.concat returns do not agree with Buffer.alloc's narrower type.
   */
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private closed = false

  /** Payload of a message still arriving in continuation frames. */
  private fragments: Buffer<ArrayBufferLike>[] = []
  private fragmentOpcode: Opcode | undefined

  constructor(
    private readonly socket: Duplex,
    private readonly handlers: WebSocketHandlers = {}
  ) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    socket.on('close', () => this.finish())
    socket.on('error', () => this.finish())
  }

  get isOpen(): boolean {
    return !this.closed
  }

  send(text: string): void {
    if (this.closed) return
    this.socket.write(encodeFrame(Buffer.from(text, 'utf8'), Opcode.TEXT))
  }

  /** Send a close frame and drop the socket. */
  close(code = 1000, reason = ''): void {
    if (this.closed) return
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
    payload.writeUInt16BE(code, 0)
    payload.write(reason, 2)
    this.socket.write(encodeFrame(payload, Opcode.CLOSE))
    this.socket.end()
    this.finish()
  }

  private receive(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

    for (;;) {
      let frame: DecodedFrame | undefined
      try {
        frame = decodeFrame(this.buffer)
      } catch (e) {
        // 1002 is "protocol error" — an unmasked or oversized frame means the
        // stream can no longer be trusted to be in sync.
        this.close(1002, (e as Error).message)
        return
      }

      if (!frame) return
      this.buffer = this.buffer.subarray(frame.size)
      this.handleFrame(frame)
      if (this.closed) return
    }
  }

  private handleFrame(frame: DecodedFrame): void {
    switch (frame.opcode) {
      case Opcode.PING:
        this.socket.write(encodeFrame(frame.payload, Opcode.PONG))
        return

      case Opcode.PONG:
        return

      case Opcode.CLOSE:
        this.close(1000)
        return

      case Opcode.TEXT:
      case Opcode.BINARY:
        if (this.fragmentOpcode !== undefined) {
          this.close(1002, 'new message started before the previous one finished')
          return
        }
        if (frame.fin) {
          this.deliver(frame.opcode, frame.payload)
          return
        }
        this.fragmentOpcode = frame.opcode
        this.fragments = [frame.payload]
        return

      case Opcode.CONTINUATION: {
        if (this.fragmentOpcode === undefined) {
          this.close(1002, 'continuation frame with nothing to continue')
          return
        }
        this.fragments.push(frame.payload)
        if (!frame.fin) return

        const opcode = this.fragmentOpcode
        const payload = Buffer.concat(this.fragments)
        this.fragmentOpcode = undefined
        this.fragments = []
        this.deliver(opcode, payload)
        return
      }

      default:
        this.close(1002, `unknown opcode ${frame.opcode}`)
    }
  }

  private deliver(opcode: Opcode, payload: Buffer): void {
    // Binary is accepted on the wire but the protocol above is JSON text, so
    // both arrive as a string rather than making the caller handle two shapes.
    void opcode
    this.handlers.onMessage?.(payload.toString('utf8'))
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.handlers.onClose?.()
  }
}
