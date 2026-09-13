'use strict'

/**
 * The golden oracle for the VDP rewrite (PLAN.md §3).
 *
 * Everything about how a fixture is booted, how far it is run, and what is read
 * off it lives here, because two copies of that would not be an oracle. It is
 * used by two callers that cannot share TypeScript:
 *
 *   - `scripts/capture-goldens.mjs`, a Node script running the compiled engine
 *     out of `out/`, which writes the golden files
 *   - `src/tests/goldens/Goldens.test.ts`, running the engine from `src/`
 *     through ts-jest, which reads them back and asserts
 *
 * Hence plain CommonJS JavaScript with `fixtures.d.ts` beside it for types, and
 * hence `runFixture` taking the engine's classes as an argument rather than
 * importing them: the module has no opinion about which build it drives, only
 * about what is done with it.
 *
 * Nothing here is allowed to know anything about the TMS9918 or about the VDP
 * replacing it. A fixture is a ROM, a cartridge and a list of cycle counts; a
 * capture is whatever the video card will tell a debugger. That is what lets
 * the same goldens survive the rewrite that Phases 1–7 perform underneath them.
 */

const { createHash } = require('node:crypto')
const { deflateSync, inflateSync } = require('node:zlib')
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs')
const { join, dirname } = require('node:path')

/** Repository root: this file is `<root>/src/tests/goldens/fixtures.js`. */
const ROOT = join(__dirname, '..', '..', '..')

/** Where the captured goldens live, one directory per fixture. */
const GOLDENS_DIR = join(ROOT, 'src', 'tests', 'goldens')

/** The output buffer's geometry, which every golden frame is sized by. */
const FRAME_WIDTH = 320
const FRAME_HEIGHT = 240

/**
 * PHI2 for every fixture. The real board offers 1 MHz and 2 MHz, and the
 * difference is visible in the picture — the BIOS's boot menu times out after a
 * fixed number of 100 ms delays, not a fixed number of cycles. Pinned here so a
 * golden means one thing.
 */
const FREQUENCY = 1_000_000

/** Cycles in one 60 Hz frame at {@link FREQUENCY}. */
const CYCLES_PER_FRAME = FREQUENCY / 60

/** Cycles to run between one typed character and the next. */
const CYCLES_PER_KEYSTROKE = 20_000

/**
 * What the real-time clock reads at boot, instead of the host's wall clock.
 *
 * The last non-deterministic input to the engine. A fixed origin, not a stopped
 * clock — the card still advances from here in emulated time.
 */
const RTC_READING = Object.freeze({
  year: 2026,
  month: 1,
  date: 1,
  hours: 0,
  minutes: 0,
  seconds: 0
})

/**
 * How far a pixel golden's channel may move before it counts as a difference.
 *
 * Eight, as of Phase 3, and it was zero before it. The emulator no longer
 * renders through `TMS_PALETTE`'s 24-bit colors: it renders through §11's
 * palette, whose row 0 is those same colors quantized to 4 bits a channel, and
 * every pixel of a legacy-mode program therefore shifts by the quantization
 * error. Eight is not a margin picked to make something pass — it is the largest
 * that error can be over the sixteen colors of row 0, `max |v - round(v/17)*17|`,
 * reached by light green's `$5E` → `$66` and three others. A pixel that moves
 * further than one colour's quantization has not been quantized.
 *
 * The pixel frame was always the tolerant one; PLAN.md §3 keeps it as the
 * artifact a person can look at when an index frame differs and the diff is not
 * obvious. Index frames are not tolerant and never become so. See Appendix B.
 */
const PIXEL_TOLERANCE = 8

// ================================================================
//  The fixtures
// ================================================================

/**
 * A step is one of:
 *   { run: cycles }       advance the machine
 *   { type: string }      send characters to the console, paced
 *   { capture: name }     take a golden here
 *
 * Cycle counts are absolute in the sense that matters: the same list always
 * reaches the same checkpoint at the same cycle, because nothing in the engine
 * depends on how fast the host runs it.
 */
const FIXTURES = [
  {
    name: 'bios',
    description: 'the bundled BIOS booting to the BASIC prompt on the video console',
    rom: 'src/renderer/public/roms/BIOS.bin',
    cart: null,
    steps: [
      // The boot menu waits ~5 emulated seconds for a keypress and then starts
      // BASIC by itself, so this fixture needs no input to reach a prompt. Seven
      // seconds is comfortably past the changeover at ~5.5 million cycles.
      { run: 7_000_000 },
      { capture: 'ok' },

      // Fifteen printed lines is the most the screen holds without scrolling:
      // row 22 is the last one written and the splash is still on rows 1 and 2.
      // A screenful of VideoChroutRaw, and nothing else.
      { type: 'FOR I=1 TO 15:PRINT "LINE";I:NEXT\r' },
      { run: 3_000_000 },
      { capture: 'screenful' },

      // One more line than fits, so the Kernal has to call VideoScroll.
      { type: 'PRINT "SCROLLED"\r' },
      { run: 3_000_000 },
      { capture: 'scroll' }
    ]
  },
  {
    name: 'wizardslab',
    description: 'the WL_DEBUG Wizards Lab cartridge playing itself from a cold start',
    rom: 'src/renderer/public/roms/BIOS.bin',
    cart: 'src/tests/fixtures/WizardsLab.crt',
    steps: [
      // Frames rather than seconds because this is the fixture whose picture
      // moves: the piece falls on a frame counter, and a checkpoint named for a
      // frame says what it should be showing.
      { run: frames(60) },
      { capture: 'frame-60' },
      { run: frames(120) },
      { capture: 'frame-180' },
      { run: frames(120) },
      { capture: 'frame-300' },
      { run: frames(300) },
      { capture: 'frame-600' }
    ]
  },
  {
    name: 'vdp-modes',
    description: 'the VDP Modes sample cartridge, one checkpoint per VMODE geometry',
    rom: 'src/renderer/public/roms/BIOS.bin',
    cart: 'samples/vdp-modes/VdpModes.crt',
    steps: [
      // The cartridge holds each screen for 60 frames with the display blanked
      // between them while it rebuilds the tables, so each checkpoint is taken
      // at the middle of its screen's window rather than at an edge: around 28
      // frames of slack either side, which no change short of a real timing bug
      // will cross. See samples/vdp-modes/README.md for the windows.
      { run: frames(36) },
      { capture: 'text' },
      { run: frames(63) },
      { capture: 'compact' },
      { run: frames(64) },
      { capture: 'graphics' },
      { run: frames(64) },
      { capture: 'full' }
    ]
  },
  {
    name: 'vdp-layers',
    description: 'the VDP Layers sample cartridge, two layers scrolling past four sprites',
    rom: 'src/renderer/public/roms/BIOS.bin',
    cart: 'samples/vdp-layers/VdpLayers.crt',
    steps: [
      // Unlike vdp-modes there is no window to sit in the middle of: this
      // cartridge scrolls every frame, so every frame is a different picture
      // and a checkpoint is a frame number rather than a mode. That is the
      // point of it — a golden that could not tell frame 90 from frame 91
      // could not tell scrolling from a still. It costs nothing in slack that
      // matters: the program has the display on before the first vertical
      // blank, so the frame count is not measured from a boot-menu timeout or
      // anything else that could drift. See samples/vdp-layers/README.md.
      { run: frames(90) },
      { capture: 'parallax' },
      { run: frames(90) },
      { capture: 'scroll-bit8-l1' },
      { run: frames(60) },
      { capture: 'occluded' },
      { run: frames(60) },
      { capture: 'scroll-bit8-l0' }
    ]
  }
]

/** Cycles in `count` frames, rounded to a whole cycle. */
function frames(count) {
  return Math.round(count * CYCLES_PER_FRAME)
}

/** Every checkpoint name a fixture takes, in order. */
function checkpointsOf(fixture) {
  return fixture.steps.filter((step) => step.capture !== undefined).map((step) => step.capture)
}

// ================================================================
//  Driving a fixture
// ================================================================

/**
 * Boot a fixture and run it, calling back at every checkpoint.
 *
 * `engine` supplies the classes: `{ Machine, RTC }`, from `src/` under ts-jest
 * or from `out/` under Node. Nothing else about the two callers differs, which
 * is the point — a golden captured by one has to be reproducible by the other,
 * and the only way to be sure of that is for them to run the same code.
 *
 * `options.beforeReset(machine)` is called with the machine loaded and not yet
 * reset — the one moment something can be attached that has to see the cold
 * start. `traces.js` attaches its recorder there.
 */
function runFixture(engine, fixture, onCapture, options = {}) {
  const { Machine, RTC } = engine

  // A fixed reading handed to the card at construction, not written into its
  // registers afterwards, so a cold reset re-reads the same date rather than
  // quietly falling back to wall time.
  const machine = new Machine({ io3: new RTC(() => RTC_READING) })
  machine.frequency = FREQUENCY

  machine.loadROM(readFixtureFile(fixture.rom))
  if (fixture.cart) machine.loadCart(readFixtureFile(fixture.cart))

  // Everything above changed what the CPU will fetch, so reset re-reads the
  // vectors. Cold, because a golden starts from a power cycle or it starts from
  // whatever the last one left behind.
  if (options.beforeReset) options.beforeReset(machine)
  machine.reset(true)

  for (const step of fixture.steps) {
    if (step.run !== undefined) {
      machine.runCycles(step.run)
    } else if (step.type !== undefined) {
      // Delivered to the serial card, which the BIOS reads even when the
      // console it prints to is the video card. Paced, because a byte arriving
      // before the IRQ handler has drained the last one is simply lost.
      for (const character of step.type) {
        machine.onReceive(character.charCodeAt(0))
        machine.runCycles(CYCLES_PER_KEYSTROKE)
      }
    } else if (step.capture !== undefined) {
      onCapture(step.capture, captureState(machine))
    } else {
      throw new Error(`${fixture.name}: unrecognised step ${JSON.stringify(step)}`)
    }
  }

  return machine
}

/** Read one of a fixture's binaries, by its path relative to the repository. */
function readFixtureFile(relativePath) {
  return new Uint8Array(readFileSync(join(ROOT, relativePath)))
}

/**
 * Everything a golden holds, read off a machine without disturbing it.
 *
 * The three kinds of PLAN.md §3, in decreasing strictness: `structural` is what
 * a debugger would print, `indices` is the frame before the palette lookup, and
 * `rgba` is the picture. `vram` sits with the structural half — it is the
 * program's own state, and a renderer bug cannot move it.
 */
function captureState(machine) {
  const video = machine.video()
  if (!video) throw new Error('capture: the machine has no video card')

  const vram = new Uint8Array(video.vramSize)
  for (let address = 0; address < vram.length; address++) vram[address] = video.readVRAM(address)

  // All 128 of them (§5), indexed by register number. Eight was the whole card
  // when these goldens were first captured; on this one, every register that
  // says what mode the picture is in — `VMODE`, `L0CTRL`, `L0PAL`, `SPRCTRL` —
  // lives above $07, and a structural golden that stopped at 8 would be blind
  // in exactly the place the modes are.
  const registers = []
  for (let register = 0; register < 128; register++) registers.push(video.getRegister(register))

  return {
    structural: {
      cycles: machine.cycles,
      // §9's terms — the geometry drawn, and the TMS9918 mode a legacy program
      // chose — rather than the TMS9918 enum this field held until Phase 8,
      // which called every one of vdp-modes' four screens "Graphics I".
      mode: video.getMode(),
      displayEnabled: video.isDisplayEnabled(),
      // Peeked, not read through the port: reading the status register clears
      // it, and a capture that changed the machine would not be a capture.
      status: video.getStatus(),
      registers,
      vramSha256: sha256(vram),
      textGrid: video.textGrid()
    },
    vram,
    indices: Uint8Array.from(video.frameIndices()),
    rgba: Uint8Array.from(video.buffer)
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// ================================================================
//  Golden files
// ================================================================

/** The four files one checkpoint is stored as. */
function goldenPaths(fixtureName, checkpoint) {
  const base = join(GOLDENS_DIR, fixtureName, checkpoint)
  return {
    structural: `${base}.json`,
    vram: `${base}.vram.bin`,
    indices: `${base}.idx.bin`,
    rgba: `${base}.png`
  }
}

function writeGolden(fixtureName, checkpoint, capture) {
  const paths = goldenPaths(fixtureName, checkpoint)
  mkdirSync(dirname(paths.structural), { recursive: true })
  writeFileSync(paths.structural, JSON.stringify(capture.structural, null, 2) + '\n')
  writeFileSync(paths.vram, capture.vram)
  writeFileSync(paths.indices, capture.indices)
  writeFileSync(paths.rgba, encodePNG(FRAME_WIDTH, FRAME_HEIGHT, capture.rgba))
  return paths
}

function readGolden(fixtureName, checkpoint) {
  const paths = goldenPaths(fixtureName, checkpoint)
  for (const path of Object.values(paths)) {
    if (!existsSync(path)) {
      throw new Error(
        `missing golden ${path} — run \`npm run capture:goldens\` and commit what it writes`
      )
    }
  }
  return {
    structural: JSON.parse(readFileSync(paths.structural, 'utf8')),
    vram: new Uint8Array(readFileSync(paths.vram)),
    indices: new Uint8Array(readFileSync(paths.indices)),
    rgba: decodePNG(readFileSync(paths.rgba), FRAME_WIDTH, FRAME_HEIGHT)
  }
}

// ================================================================
//  Comparison
// ================================================================

/**
 * Where two byte arrays first differ, as a sentence, or null if they do not.
 *
 * A golden frame is 76,800 bytes and a failed `toEqual` on one is unreadable,
 * so this reports the first difference and how many there are — enough to say
 * whether a renderer moved one tile or the whole picture.
 */
function diffBytes(actual, expected, options = {}) {
  const { tolerance = 0, stride = 1, label = 'byte' } = options
  if (actual.length !== expected.length) {
    return `length ${actual.length}, expected ${expected.length}`
  }

  let first = -1
  let count = 0
  for (let i = 0; i < actual.length; i++) {
    if (Math.abs(actual[i] - expected[i]) <= tolerance) continue
    if (first < 0) first = i
    count++
  }
  if (count === 0) return null

  const where =
    stride > 1
      ? `${label} ${Math.floor(first / stride)} channel ${first % stride}`
      : `${label} ${first}`
  return (
    `${count} of ${actual.length} differ; first at ${where}: ` +
    `${actual[first]}, expected ${expected[first]}` +
    (tolerance > 0 ? ` (tolerance ${tolerance})` : '')
  )
}

/** The same, addressed as pixels of a 320-wide frame. */
function diffFrame(actual, expected, options = {}) {
  const { tolerance = 0, channels = 1 } = options
  const difference = diffBytes(actual, expected, { tolerance, stride: channels, label: 'pixel' })
  if (difference === null) return null

  const match = /first at pixel (\d+)/.exec(difference)
  if (!match) return difference
  const pixel = Number(match[1])
  return `${difference} (x ${pixel % FRAME_WIDTH}, y ${Math.floor(pixel / FRAME_WIDTH)})`
}

// ================================================================
//  PNG
// ================================================================

/**
 * A PNG codec for the goldens, separate from `src/debug/PNG.ts` on purpose.
 *
 * That one runs in the Electron renderer as well as under Node, so it cannot
 * call `node:zlib` and emits uncompressed DEFLATE blocks — a 300 KB file per
 * frame, which is the wrong thing to commit seven of and re-commit every time a
 * phase changes the picture. This one runs only in Node, compresses properly,
 * and reads back what it wrote so a pixel golden can be compared rather than
 * only looked at.
 *
 * 8-bit RGBA, no interlacing, filter 0 on every row — the same subset, so a
 * file from either encoder opens in anything.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, crc])
}

function encodePNG(width, height, rgba) {
  const stride = width * 4
  if (rgba.length !== stride * height) {
    throw new Error(`encodePNG: expected ${stride * height} bytes, got ${rgba.length}`)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter: adaptive, all "none" here
  ihdr[12] = 0 // interlace: none

  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function decodePNG(file, width, height) {
  if (!file.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('decodePNG: not a PNG')

  const parts = []
  let offset = 8
  while (offset < file.length) {
    const length = file.readUInt32BE(offset)
    const type = file.toString('ascii', offset + 4, offset + 8)
    if (type === 'IHDR') {
      const [depth, colorType, , , interlace] = file.subarray(offset + 16, offset + 21)
      if (file.readUInt32BE(offset + 8) !== width || file.readUInt32BE(offset + 12) !== height) {
        throw new Error('decodePNG: golden is not the expected size')
      }
      if (depth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error('decodePNG: expected 8-bit RGBA, not interlaced')
      }
    } else if (type === 'IDAT') {
      parts.push(file.subarray(offset + 8, offset + 8 + length))
    }
    offset += length + 12 // length + type + payload + CRC
  }

  const stride = width * 4
  const raw = inflateSync(Buffer.concat(parts))
  const rgba = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    if (filter !== 0) throw new Error(`decodePNG: row ${y} uses filter ${filter}, expected 0`)
    rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride)
  }
  return rgba
}

module.exports = {
  FIXTURES,
  FRAME_WIDTH,
  FRAME_HEIGHT,
  FREQUENCY,
  CYCLES_PER_FRAME,
  PIXEL_TOLERANCE,
  GOLDENS_DIR,
  checkpointsOf,
  runFixture,
  captureState,
  goldenPaths,
  writeGolden,
  readGolden,
  diffBytes,
  diffFrame,
  encodePNG,
  decodePNG
}
