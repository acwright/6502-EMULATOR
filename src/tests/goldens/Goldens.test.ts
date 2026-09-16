/**
 * The baseline the VDP rewrite is measured against.
 *
 * Two real programs are booted from a cold reset and run to fixed cycle counts,
 * and what the video card shows at each checkpoint is compared against files
 * captured before any of the rewrite happened. The BIOS's Text-mode console and
 * Wizards Lab's Graphics I board are the two acceptance targets of the whole
 * branch, so between them these goldens cover the legacy submode the rewrite
 * has to keep working: 1bpp patterns coloured per cell and per pattern group,
 * palette row 0, the vertical-blank flag, sprites and their `$D0` terminator.
 *
 * **The index frame is the one that matters.** It is the 320 × 240 buffer as
 * palette indices, before the lookup that turns them into colours, so it is
 * immune to the palette changing underneath it — which Phase 3 does — while
 * still failing on any pixel the renderer puts in the wrong place. It is
 * compared exactly and always will be. The RGBA frame is kept beside it, within
 * a tolerance, because it is the artifact a human can look at when an index
 * frame differs and the diff is not obvious: open the `.png`.
 *
 * **A golden that moves is not a test to be fixed.** Either the change is
 * intended, in which case re-capture with `npm run capture:goldens` in a commit
 * of its own that says why, or it is a bug in whatever moved it. Editing a
 * golden to turn a red test green is how the oracle stops being an oracle.
 *
 * Determinism is asserted by this file existing and passing: the goldens
 * were captured by another process, from a separately compiled build of
 * the same engine, at another time. Reproducing them byte for byte here is the
 * claim that the machine is a function of its ROM and its cycle count and
 * nothing else. `npm run capture:goldens` additionally boots each fixture twice
 * and refuses to write anything if the two runs disagree.
 */
import { Machine } from '../../core/Machine'
import { RTC } from '../../core/IO/RTC'
import { Video } from '../../core/IO/Video'
import { TMS9918A } from '../../core/IO/TMS9918A'
import {
  FIXTURES,
  TMS9918A_FIXTURES,
  pixelTolerance,
  captureState,
  checkpointsOf,
  diffBytes,
  diffFrame,
  readGolden,
  runFixture
} from './fixtures'
import type { Capture, Fixture } from './fixtures'

/** The engine this side of the comparison drives: `src/`, through ts-jest. */
const engine = { Machine, RTC, Video, TMS9918A }

/**
 * Both cards: the PICOVDP's fixtures, then the same programs on the TMS9918A
 * under `tms9918a/`, which pin the 2.7.0 card and move only for a bug fix in it.
 */
describe.each([...FIXTURES, ...TMS9918A_FIXTURES].map((fixture): [string, Fixture] => [fixture.name, fixture]))(
  '%s',
  (_name, fixture) => {
    const captures = new Map<string, Capture>()

    beforeAll(() => {
      runFixture(engine, fixture, (checkpoint, capture) => captures.set(checkpoint, capture))
    })

    for (const checkpoint of checkpointsOf(fixture)) {
      describe(`at ${checkpoint}`, () => {
        let actual: Capture
        let expected: Capture

        beforeAll(() => {
          actual = captures.get(checkpoint)!
          expected = readGolden(fixture.name, checkpoint)
        })

        // First, because it is the one whose failure message can be read: a
        // wrong mode or a moved register says what happened, where a frame that
        // differs in 4,000 pixels only says that something did.
        it('reports the same registers, mode and screen contents', () => {
          expect(actual.structural).toEqual(expected.structural)
        })

        it('leaves the same bytes in VRAM', () => {
          // The program's own state. A renderer cannot move it, so a difference
          // here means the CPU or the port protocol ran differently — which is
          // a much bigger problem than a wrong picture.
          expect(diffBytes(actual.vram, expected.vram, { label: 'address' })).toBeNull()
        })

        it('draws the same frame, palette index for palette index', () => {
          expect(diffFrame(actual.indices, expected.indices)).toBeNull()
        })

        it('draws the same frame in colour', () => {
          expect(
            diffFrame(actual.rgba, expected.rgba, {
              channels: 4,
              tolerance: pixelTolerance(fixture)
            })
          ).toBeNull()
        })
      })
    }
  }
)

/**
 * The capture is a reading, not an action. A golden taken at a checkpoint has to
 * describe the machine that reached it and not a machine that has been asked
 * what it looks like — reading the status register through the port would clear
 * it, and the next checkpoint would be measuring the measurement.
 */
describe('capturing does not disturb the machine', () => {
  it('leaves the status register and the frame alone', () => {
    const fixture = FIXTURES[0]!
    const machine = runFixture(engine, fixture, () => {})
    const before = captureState(machine)
    const after = captureState(machine)

    expect(after.structural).toEqual(before.structural)
    expect(diffFrame(after.indices, before.indices)).toBeNull()
  })
})
