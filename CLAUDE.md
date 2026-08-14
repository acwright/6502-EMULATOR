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
