/**
 * `Video.observer` and `Video.tickCount`: what the firmware project's traces are
 * recorded through (see `src/tests/goldens/traces.js`).
 *
 * Not in `Video.test.ts`, because that file is also run against 6502-PICOVDP's
 * C core (`jest.picovdp.cjs`), and recording is this emulator's business, not
 * the card's.
 */
import { Video } from '../../core/IO/Video'
import type { VideoObserver } from '../../core/IO/Video'

const FREQUENCY = 1_000_000

type Event = [string, ...Array<number | boolean>]

/** Records every call, with the tick count it was made at. */
const observe = (video: Video): Event[] => {
  const events: Event[] = []
  const observer: VideoObserver = {
    read: (port, value) => events.push(['read', port, value, video.tickCount]),
    write: (port, value) => events.push(['write', port, value, video.tickCount]),
    lineStart: (screenLine, displayLine) => events.push(['line', screenLine, displayLine, video.tickCount]),
    reset: (coldStart, screenLine) => events.push(['reset', coldStart, screenLine, video.tickCount])
  }
  video.observer = observer
  return events
}

const tick = (video: Video, count: number): void => {
  for (let i = 0; i < count; i++) video.tick(FREQUENCY)
}

/** A little of everything: a register, VRAM through the port, a status read. */
const exercise = (video: Video): number[] => {
  const reads: number[] = []
  video.write(1, 0xe0) // MODE1: display on, vblank interrupt on
  video.write(1, 0x81)
  video.write(1, 0x00) // pointer $0000 for writing
  video.write(1, 0x40)
  for (let i = 0; i < 64; i++) video.write(0, i)
  tick(video, 20_000) // into vertical blank
  reads.push(video.read(1)) // STAT0
  video.write(1, 0x00) // pointer $0000 for reading
  video.write(1, 0x00)
  reads.push(video.read(0), video.read(0))
  tick(video, 20_000)
  return reads
}

describe('Video.observer', () => {
  it('changes nothing about the card', () => {
    const plain = new Video()
    const watched = new Video()
    observe(watched)

    expect(exercise(watched)).toEqual(exercise(plain))
    expect(watched.getStatus()).toBe(plain.getStatus())
    expect(watched.peekStatus(1)).toBe(plain.peekStatus(1))
    expect(watched.getDisplayLine()).toBe(plain.getDisplayLine())
    expect(Array.from(watched.frameIndices())).toEqual(Array.from(plain.frameIndices()))
    expect(watched.serialize()).toEqual(plain.serialize())
  })

  it('hears each read and write after it, by port, with the value read', () => {
    const video = new Video()
    const events = observe(video)

    video.write(0x3fd, 0x3f) // port A's command port, mirrored: STATSEL_B = $3F
    video.write(0x3fd, 0x8e)
    video.write(3, 0x04) // port B's command port: STATSEL_B = STAT4
    video.write(3, 0x8e)
    const identification = video.read(0x7) // port B's status, mirrored

    expect(identification).toBe(0xac)
    expect(events).toEqual([
      ['write', 1, 0x3f, 0],
      ['write', 1, 0x8e, 0],
      ['write', 3, 0x04, 0],
      ['write', 3, 0x8e, 0],
      ['read', 3, 0xac, 0]
    ])
  })

  it('hears every line start the raster makes, numbered as it was then', () => {
    const video = new Video()
    const events = observe(video)
    tick(video, 1_000_000 / 60) // one frame

    const lines = events.filter((event) => event[0] === 'line')
    expect(lines).toHaveLength(262)
    // A cold start begins display line 0 of the reset geometry, screen line 24.
    expect(lines[0]!.slice(1, 3)).toEqual([25, 1])
    expect(lines.find((event) => event[1] === 0)!.slice(1, 3)).toEqual([0, 238])
    // Ticks are counted from the card's making, and a line starts on one.
    expect(lines[0]![3]).toBe(64)
  })

  it('hears a reset once, with the screen line the raster is on', () => {
    const video = new Video()
    tick(video, 10_000)
    const events = observe(video)
    const scanning = video.getDisplayLine() + 24

    video.reset(false)
    expect(video.tickCount).toBe(10_000) // a warm reset leaves the raster alone
    video.reset(true)
    expect(video.tickCount).toBe(0)

    // The cold start's own line start is the reset's, not a lineStart.
    expect(events).toEqual([
      ['reset', false, scanning, 10_000],
      ['reset', true, 24, 0]
    ])
  })
})
