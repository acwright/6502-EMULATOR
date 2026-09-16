/**
 * The traces the firmware project replays instead of booting the fixtures.
 *
 * `6502-PICOVDP` has no 6502. What it has of each golden fixture is a trace —
 * every port access the program made to the card, timed to the tick, recorded
 * through `Video.observer` — and a trace is only a substitute for the program if
 * a card fed nothing else reproduces the goldens. Three claims, one per test:
 *
 * - **Recording changes nothing.** The fixture booted with the recorder
 *   attached reproduces every golden, exactly as `Goldens.test.ts` asks of it
 *   booted without.
 * - **The committed trace is current.** The events recorded now are the events
 *   in the file. If the card changes what a fixture does to it, this fails
 *   before the firmware project replays a stale copy: re-record with
 *   `npm run record:traces`, in a commit of its own, as a golden is re-captured.
 * - **The trace is complete.** Replayed into a bare `Video` with no CPU, every
 *   read returns what it returned, and every checkpoint's index frame, VRAM and
 *   structural state are the golden's, byte for byte. The settle point and class
 *   written into each checkpoint are what the replay decides again.
 */
import { readFileSync } from 'node:fs'
import { Machine } from '../../core/Machine'
import { RTC } from '../../core/IO/RTC'
import { Video } from '../../core/IO/Video'
import { FIXTURES, diffBytes, diffFrame, readGolden } from './fixtures'
import type { Capture, Fixture } from './fixtures'
import { analyseTrace, annotationsOf, decodeTrace, eventsOf, recordFixture, tracePath } from './traces'
import type { Trace } from './traces'

const engine = { Machine, RTC, Video }

/** Everything that differs from the golden, as sentences; empty when nothing does. */
const differences = (fixture: string, checkpoint: string, capture: Capture): string[] => {
  const golden = readGolden(fixture, checkpoint)
  return [
    JSON.stringify(capture.structural) === JSON.stringify(golden.structural) ? null : 'structural state',
    diffBytes(capture.vram, golden.vram, { label: 'address' }),
    diffFrame(capture.indices, golden.indices)
  ].filter((difference): difference is string => difference !== null)
}

describe.each(FIXTURES.map((fixture): [string, Fixture] => [fixture.name, fixture]))(
  '%s',
  (_name, fixture) => {
    let committed: Trace

    beforeAll(() => {
      committed = decodeTrace(readFileSync(tracePath(fixture.name)))
    })

    it('records without disturbing a golden, and records what is committed', () => {
      const { trace, captures } = recordFixture(engine, fixture)

      for (const [checkpoint, capture] of captures) {
        expect({ checkpoint, differences: differences(fixture.name, checkpoint, capture) }).toEqual({
          checkpoint,
          differences: []
        })
      }

      expect(committed.header.fixture).toBe(fixture.name)
      const recorded = trace.lines
      const expected = eventsOf(committed)
      // Where they part, not 1.2 million lines of diff.
      const first = recorded.findIndex((line, index) => line !== expected[index])
      expect({ length: recorded.length, firstDifference: first }).toEqual({
        length: expected.length,
        firstDifference: -1
      })
    })

    it('replays with no CPU to every golden, with the class it says', () => {
      const checkpoints = analyseTrace(engine, committed)
      const annotations = annotationsOf(committed)

      expect(checkpoints.map((checkpoint) => checkpoint.name)).toEqual(
        fixture.steps.flatMap((step) => ('capture' in step ? [step.capture] : []))
      )
      for (const checkpoint of checkpoints) {
        const { name, frame, settle, window } = checkpoint
        expect({ name, differences: differences(fixture.name, name, checkpoint.capture) }).toEqual({
          name,
          differences: []
        })
        expect({ name, frame, settle, window, class: checkpoint.class }).toEqual({
          name,
          ...annotations.get(name)
        })
      }
    })
  }
)
