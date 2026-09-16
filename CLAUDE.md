# Working in this repository

## The CPU core is verified against outside test suites

`src/core/CPU.ts` emulates a **WDC W65C02S** — not an NMOS 6502, and not a Rockwell
R65C02. Where they differ, the W65C02S data sheet is the specification.

Any change to the CPU core, however small, must be run past the conformance suites
before it is considered done:

```sh
npm run test:conformance
```

That is Tom Harte's `wdc65c02` ProcessorTests (2.54 million cases), Klaus Dormann's
functional and 65C02 extended opcodes tests, Bruce Clark's decimal mode test, and
AllSuiteA. None of them were written for this emulator, which is the point. It takes
about ten seconds once `test-suites/` has been fetched. See the README's *CPU
conformance suites* section for setup.

`npm test` does **not** include them. Passing `npm test` is not evidence that a CPU
change is correct.

Interrupts are the gap, and it is a real one. Harte's single-step format cannot
express an interrupt, and Klaus's `6502_interrupt_test` both needs an unavailable
assembler *and* is written to tolerate several instructions of slack about when an
interrupt arrives — so it would not settle a timing question even if it ran here.
Do not reach for it as an oracle without reading what it actually asserts.

`src/tests/Interrupts.test.ts` enumerates the failure modes by hand instead. Its
"when the interrupt is sampled" section is the delicate part: the mask is sampled
before an instruction's final cycle, so CLI, SEI and PLP — which write I in that
cycle — decide against the mask from *before* they ran, while RTI does not. One
divergence is left and is documented in the final test: the sampling *moment* is
still instruction decode rather than the penultimate cycle, worth up to one
instruction of extra latency. That test pins current behaviour on purpose; if you
fix it, that test is what should change, and read its comment first — the fix has
snapshot-format and debugger-stepping consequences.

## The CPU core is shared with 6502-KIMULATOR

`src/core/CPU.ts` and `src/tests/W65C02S.test.ts` are kept **byte-identical** with
the copies in the sibling `6502-KIMULATOR` repository, along with
`src/tests/Interrupts.test.ts`, `src/tests/conformance/`, `jest.conformance.cjs` and
`scripts/fetch-conformance-tests.mjs`. A CPU fix in one is a CPU fix in both — make
the change in both places and run both test suites, or the two machines drift.

`src/tests/CPU.test.ts` is *nearly* identical and deliberately not synced blindly; it
differs in a comment about how each machine counts cycles.

## Claims about the CPU need a source

The suites above disagree with each other in places, and secondary opcode tables
found online are frequently wrong about the CMOS part — that is how a 5-cycle
`BBR`/`BBS` and an NMOS decimal `SBC` both survived in here for a long time. When
fixing or documenting CPU behaviour, cite what the claim rests on in the code
comment: the data sheet's table and note numbers, or the suite whose cases pin it.
"A published table says 5" is not a source; a suite where all 10,000 cases say 6,
with a bus trace that explains why, is.

If a suite and the data sheet genuinely conflict, do not silently pick one. Record
the disagreement where it can fail — `CYCLE_DIVERGENCE` in
`src/tests/conformance/harte.test.ts` is the existing pattern, and it asserts the
numbers on both sides so that it breaks if either moves.

## The VDP specification is shared with the firmware

`docs/VDP-SPEC.md` specifies the 6502-PICOVDP video card, and it is the same
document the firmware is being written against in the sibling `6502-PICOVDP`
project, which also has a published HTML rendering. **`SPEC.md` in
`6502-PICOVDP` is the canonical copy**, and `docs/VDP-SPEC.md` is a byte copy of
it: a spec change is made there first and copied here in the same sitting, never
edited here on its own. `6502-PICOVDP`'s `tools/check-spec.mjs` (CTest
`spec_in_step`) fails when the two differ. This emulator is the only working
implementation of the card, so a firmware author will treat what it does as the
answer wherever the spec is silent — which is why the spec must not be silent
where the emulator has made a choice.

The firmware project is also held to this emulator's golden frames, through a
**trace** kept beside each fixture's goldens
(`src/tests/goldens/<fixture>/<fixture>.vdpt.gz`, see
`src/tests/goldens/README.md`). A change that alters what a fixture does to the
card fails `Traces.test.ts` even when no golden moves. Re-record with
`npm run record:traces` in a commit of its own, as for a golden, and say in the
message that `6502-PICOVDP` needs to re-sync. `Video.test.ts` is run against the
firmware's C core as well (`jest.picovdp.cjs`), so a new test that only this
emulator could pass — about recording or the debugger, say — belongs in another
file.

`src/core/IO/Video.ts` cites the spec by section (`// §8`). The rules the card was
built under still hold: where the implementation and the spec disagree, one of
them is wrong, and it is decided in the spec first; do not encode a behaviour that
is not written down. When fixing the card, check whether the fix is a behaviour
the spec states. If it is not, the spec change is part of the fix.

Goldens are not edited to pass. A golden that moves is either an intended change
— re-captured with `npm run capture:goldens` in a commit of its own, with the
reason in the message — or a bug. Editing one to turn a red test green is how the
oracle stops being an oracle; `npm run capture:goldens -- --check` reports what
would move without writing anything. The committed binaries the goldens boot
(`src/tests/fixtures/`, `samples/`) are held to the same rule, since rebuilding
one moves every golden captured from it.
