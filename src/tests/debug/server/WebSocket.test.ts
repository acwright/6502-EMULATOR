import { PassThrough } from 'node:stream'
import { createHash, randomBytes } from 'node:crypto'
import {
  acceptKey,
  encodeFrame,
  Opcode,
  WebSocketConnection,
  MAX_MESSAGE_BYTES
} from '../../../debug/server/WebSocket'

/** Build a client frame: masked, as RFC 6455 requires of a client. */
function clientFrame(payload: Buffer, opcode: number = Opcode.TEXT, fin = true): Buffer {
  const mask = randomBytes(4)
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i & 3]!

  let header: Buffer
  if (masked.length < 126) {
    header = Buffer.alloc(2)
    header[1] = 0x80 | masked.length
  } else if (masked.length < 0x10000) {
    header = Buffer.alloc(4)
    header[1] = 0x80 | 126
    header.writeUInt16BE(masked.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(masked.length), 2)
  }
  header[0] = (fin ? 0x80 : 0) | opcode

  return Buffer.concat([header, mask, masked])
}

/**
 * A connection over an in-memory socket, with the two directions kept apart.
 *
 * `feed` pushes bytes at the connection as if a client had sent them; `sent`
 * collects what the connection writes back. A plain PassThrough would loop its
 * own writes round to its read side and make the server appear to answer itself.
 */
function connect(): {
  feed: (data: Buffer) => void
  sent: Buffer[]
  messages: string[]
  connection: WebSocketConnection
  closed: () => boolean
} {
  const socket = new PassThrough()
  const sent: Buffer[] = []
  socket.write = ((chunk: Buffer) => {
    sent.push(Buffer.from(chunk))
    return true
  }) as typeof socket.write

  const messages: string[] = []
  let isClosed = false
  const connection = new WebSocketConnection(socket, {
    onMessage: (text) => messages.push(text),
    onClose: () => {
      isClosed = true
    }
  })

  return {
    feed: (data) => {
      socket.push(data)
    },
    sent,
    messages,
    connection,
    closed: () => isClosed
  }
}

describe('the handshake', () => {
  // The one value in RFC 6455 with a published test vector, so it is worth
  // pinning: a wrong accept key means no browser will ever connect.
  it('derives the accept key the way RFC 6455 §1.3 does', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  })

  it('matches a hash computed independently', () => {
    const key = randomBytes(16).toString('base64')
    const expected = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    expect(acceptKey(key)).toBe(expected)
  })
})

describe('framing', () => {
  it.each([
    ['short', 5],
    ['at the 2-byte boundary', 125],
    ['just over it', 126],
    ['at the 8-byte boundary', 0xffff],
    ['just over that', 0x10000]
  ])('round-trips a %s payload', (_label, length) => {
    // Text, not random bytes: the protocol above this is JSON, and a message is
    // decoded as UTF-8, which would rewrite arbitrary bytes into replacement
    // characters and make the length comparison meaningless.
    const payload = Buffer.from('x'.repeat(length))
    const { feed, messages } = connect()

    feed(clientFrame(payload))
    // Server frames are never masked; the client's are always masked, so the
    // two encodings differ in length by exactly the 4-byte key.
    expect(encodeFrame(payload).length).toBe(clientFrame(payload).length - 4)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toHaveLength(length)
  })

  it('does not mask what it sends', () => {
    expect((encodeFrame(Buffer.from('hi'))[1]! & 0x80) === 0).toBe(true)
  })
})

describe('receiving', () => {
  it('delivers a whole message', () => {
    const { feed, messages } = connect()
    feed(clientFrame(Buffer.from('{"jsonrpc":"2.0"}')))
    expect(messages).toEqual(['{"jsonrpc":"2.0"}'])
  })

  // TCP gives no guarantee a frame arrives in one piece, and a 64 KB memory
  // write reliably proves it.
  it('reassembles a frame split across several chunks', () => {
    const { feed, messages } = connect()
    const frame = clientFrame(Buffer.from('hello world'))

    for (const byte of frame) feed(Buffer.from([byte]))
    expect(messages).toEqual(['hello world'])
  })

  it('reads several frames out of one chunk', () => {
    const { feed, messages } = connect()
    feed(Buffer.concat([clientFrame(Buffer.from('one')), clientFrame(Buffer.from('two'))]))
    expect(messages).toEqual(['one', 'two'])
  })

  it('joins a fragmented message', () => {
    const { feed, messages } = connect()
    feed(clientFrame(Buffer.from('he'), Opcode.TEXT, false))
    feed(clientFrame(Buffer.from('llo'), Opcode.CONTINUATION, false))
    feed(clientFrame(Buffer.from('!'), Opcode.CONTINUATION, true))
    expect(messages).toEqual(['hello!'])
  })

  it('answers a ping with a pong carrying the same payload', () => {
    const { feed, sent } = connect()
    feed(clientFrame(Buffer.from('ka'), Opcode.PING))

    const reply = sent[sent.length - 1]!
    expect(reply[0]! & 0x0f).toBe(Opcode.PONG)
    expect(reply.subarray(2).toString()).toBe('ka')
  })

  it('ignores a pong', () => {
    const { feed, sent, messages } = connect()
    feed(clientFrame(Buffer.alloc(0), Opcode.PONG))
    expect(messages).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('closes when the client closes', () => {
    const { feed, closed } = connect()
    feed(clientFrame(Buffer.alloc(0), Opcode.CLOSE))
    expect(closed()).toBe(true)
  })
})

describe('protocol violations', () => {
  /** The close code the server sent, if any. */
  function closeCode(sent: Buffer[]): number | undefined {
    const frame = sent.find((buffer) => (buffer[0]! & 0x0f) === Opcode.CLOSE)
    return frame?.readUInt16BE(2)
  }

  // An unmasked client frame means the peer is not speaking RFC 6455 — or that
  // the stream is out of sync — and either way nothing after it can be trusted.
  it('refuses an unmasked client frame', () => {
    const { feed, sent, closed } = connect()
    feed(encodeFrame(Buffer.from('unmasked'), Opcode.TEXT))

    expect(closeCode(sent)).toBe(1002)
    expect(closed()).toBe(true)
  })

  it('refuses a continuation with nothing to continue', () => {
    const { feed, sent } = connect()
    feed(clientFrame(Buffer.from('orphan'), Opcode.CONTINUATION, true))
    expect(closeCode(sent)).toBe(1002)
  })

  it('refuses a new message while one is still being assembled', () => {
    const { feed, sent } = connect()
    feed(clientFrame(Buffer.from('start'), Opcode.TEXT, false))
    feed(clientFrame(Buffer.from('interrupt'), Opcode.TEXT, true))
    expect(closeCode(sent)).toBe(1002)
  })

  // Without this a single frame header could make the server allocate — and
  // wait for — an unbounded amount of memory.
  it('refuses a frame declaring more than the size limit', () => {
    const { feed, sent } = connect()
    const header = Buffer.alloc(14)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES + 1), 2)

    feed(header)
    expect(closeCode(sent)).toBe(1002)
  })

  it('stops parsing once closed', () => {
    const { feed, messages } = connect()
    feed(encodeFrame(Buffer.from('unmasked'), Opcode.TEXT))
    feed(clientFrame(Buffer.from('after')))
    expect(messages).toHaveLength(0)
  })
})

describe('sending', () => {
  it('writes nothing once closed', () => {
    const { feed, sent, connection } = connect()
    connection.close()
    const after = sent.length

    connection.send('ignored')
    expect(sent).toHaveLength(after)
    expect(connection.isOpen).toBe(false)
  })
})
