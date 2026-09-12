6502-PICOVDP — Emulator implementation plan
===========================================

Replacing the TMS9918A emulation in `src/core/IO/Video.ts` with the custom VDP
specified in [docs/VDP-SPEC.md](docs/VDP-SPEC.md).

**Target:** a `v3` major revision branch.
**Definition of done:** the **unmodified** BIOS boots to an `OK` prompt on the
video console, and the **unmodified** WIZARDSLAB cartridge runs, on a VDP with
none of the TMS9918 left inside it.

---

Contents
--------

1. [What this is and is not](#1-what-this-is-and-is-not)
2. [Ground rules](#2-ground-rules)
3. [The oracle](#3-the-oracle)
4. [Phases](#4-phases)
5. [Risk register](#5-risk-register)
6. [Appendix A — blast radius](#appendix-a--blast-radius)
7. [Appendix B — what the spec changes](#appendix-b--what-the-spec-changes)

---

1. What this is and is not
--------------------------

### In scope

The video card, and everything in this repository that touches it. The VDP
becomes a superset of the TMS9918 with a legacy submode: two layers, 1/2/4/8bpp
tiles, 64 sprites at 32 per line, a 256-entry palette of 4096 colors, hardware
scrolling, scanline interrupts, 64 KB of VRAM and four CPU ports.

### Not in scope

- **The CPU.** `src/core/CPU.ts` is byte-identical with the copy in
  `6502-KIMULATOR` (see `CLAUDE.md`). Nothing in this work needs it. If a phase
  appears to need a CPU change, that is a signal the diagnosis is wrong.
- **The BIOS.** The whole point is that it boots unaltered. Kernal changes —
  hardware scrolling, port B in the IRQ handler, new entry points — are follow-on
  work in `6502-BIOS`, after this branch lands.
- **WIZARDSLAB.** Likewise unaltered. It is an acceptance test here, not a
  porting target.
- **The AC6502 documentation.** `6502-DOCS` needs rewriting for the new modes,
  but not until the emulator can run the samples.

### The two acceptance targets need only the legacy submode

This is the single most useful fact for sequencing. The BIOS uses Text; WIZARDSLAB
uses Graphics I. Between them they touch:

- registers 0–7 with TMS9918 semantics
- the classic two-write command protocol on `$9C00`/`$9C01`
- 1bpp patterns, per-cell *absent* (BIOS) and per-pattern-group (WIZARDSLAB) coloring
- palette row 0
- `STAT0` b7 polled for vertical blank
- the `$D0` sprite-list terminator

Neither touches `VMODE`, layer 1, scrolling, 2/4/8bpp, sprite flipping, the new
port pair, or 240-line geometry. **Both targets are reachable by the end of
Phase 5**, with four phases of new capability built afterwards on a base that is
already regression-protected.

---

2. Ground rules
---------------

1. **Do not touch `src/core/CPU.ts`.** Or `src/tests/W65C02S.test.ts`,
   `src/tests/Interrupts.test.ts`, `src/tests/conformance/`,
   `jest.conformance.cjs`, or `scripts/fetch-conformance-tests.mjs` — all synced
   with `6502-KIMULATOR`.
2. **`docs/VDP-SPEC.md` is the specification.** Where the implementation and the
   spec disagree, one of them is wrong and it gets decided in the spec first.
   Do not encode a behavior that is not written down.
3. **Every phase ends green.** `npm test` and `npm run typecheck` pass at every
   phase boundary, and the machine still boots. No phase leaves the tree broken
   for the next one to fix.
4. **Goldens are not edited to pass.** If a golden changes, either the change is
   intended — in which case re-capture it in its own commit, with the reason in
   the message — or it is a bug. Editing a golden to make a red test green is how
   the oracle stops being an oracle.
5. **Spec section numbers in code comments.** `// §8` beats a paraphrase that
   drifts.

---

3. The oracle
-------------

The hardest thing about this work is that "no faults" is a claim about a picture,
and pictures fail quietly. The answer is to capture what the *current* emulator
produces, before changing anything, and hold the new one to it.

### Three kinds of golden, in decreasing strictness

| Kind | What | Tolerance |
|---|---|---|
| **Structural** | `textGrid()` output, VRAM at checkpoints, register values | exact |
| **Index frame** | the 320 × 240 buffer as *palette indices*, before RGB lookup | exact |
| **Pixel frame** | the 320 × 240 RGBA buffer | per-channel tolerance |

**The index frame is the one that matters.** The old renderer emits indices 0–15;
the new one emits 0–255 with row 0 holding the same sixteen colors. So for any
legacy-mode program the index frames must be **byte-identical** — which catches
every renderer bug while being completely immune to the palette quantization
described in Appendix B.

Capturing it needs a small accessor on the video card:

```ts
/** The frame as palette indices, for golden comparison. Debug only. */
frameIndices(): Uint8Array
```

Add it to the *current* `Video.ts` in Phase 0, keep it through the rewrite.

The pixel frame is kept anyway, with a tolerance, because it is the artifact a
human can look at when an index frame differs and the diff is not obvious.

### Checkpoints to capture

| Fixture | Checkpoint |
|---|---|
| BIOS, video console | at the `OK` prompt |
| BIOS, video console | after `InitVideo` + a screenful of `VideoChroutRaw` |
| BIOS, video console | after a `VideoScroll` |
| WIZARDSLAB | frames 60, 180, 300, 600 from cold start (`WL_DEBUG=1` build, so it plays without input) |
| WIZARDSLAB | VRAM + registers at each of those frames |

Deterministic because the machine is: fixed cycle counts from a cold reset, and
WIZARDSLAB's RNG is seeded the same way every boot. If any checkpoint proves
non-deterministic, find out why before proceeding — a non-deterministic emulator
is a worse problem than the one this plan is about.

---

4. Phases
---------

### Phase 0 — Branch, fixtures, and the oracle

*No production behavior changes. This is the phase that makes every later phase
verifiable, and it is the one most likely to feel skippable.*

- `git switch -c v3-vdp`
- `docs/VDP-SPEC.md` is already in place — confirm it is the version you intend
  to build, because Phase 4 onwards is a transcription of it
- Build WIZARDSLAB with `make DEBUG=1 -C AC6502` and commit `WizardsLab.crt` to
  `src/tests/fixtures/`
- Add `frameIndices()` to `src/core/IO/Video.ts`
- `scripts/capture-goldens.mjs` — boots each fixture headless, dumps structural,
  index and pixel goldens to `src/tests/goldens/`
- `src/tests/goldens/Goldens.test.ts` — asserts the current emulator reproduces
  every golden

**Done when:** goldens are committed and `npm test` proves the *unmodified*
emulator matches them. That green run is the baseline; every later phase is
measured against it.

---

### Phase 1 — Bus, register file, VRAM

*The structural change, with the old renderer left running on top of it.*

- Port decode `address & 1` → `address & 3` (§4)
- Two independent port pairs: each with its own pointer, direction latch,
  read-ahead byte, command flip-flop and `STATSEL`
- 128-register file; command byte decodes 7 register bits, not 3
- VRAM 16 KB → 64 KB; `VBANK` supplies A15:A14; `VINC` signed stride with carry
  into the bank
- Legacy aliases: `$02`/`$10`, `$03`/`$11`, `$04`/`$12`, `$05`/`$20`, `$06`/`$21`
  are the same storage
- Widen `getRegister`/`setRegister` from `& 0x07` to `& 0x7F`
- Snapshot schema v2: bigger VRAM, bigger register file, two port pairs. **Reject
  v1 with a clear error** rather than migrating — a v1 snapshot is a TMS9918 and
  there is no honest mapping
- The old TMS renderers keep working, reading registers 0–7 out of the new file

**Done when:** all goldens unchanged, BIOS boots, `make smoke-AC6502` still
passes, and new unit tests cover the second port pair, bank carry and the 7-bit
register decode.

> Keeping the old renderer alive through this phase is deliberate. It is the
> riskiest structural change in the project, and doing it while the picture is
> still known-good means any golden that moves is unambiguously this phase's
> fault.

---

### Phase 2 — Timing, status registers, interrupts

- Display-line counter: counts from the first active line of the current mode,
  wraps at 262 (§3)
- Vertical blank fires at the **end of the picture** — display line 192 or 240 —
  not at a fixed frame line (§14)
- `STAT0` b7 is the TMS9918's F flag: **set regardless of `IRQEN`** (§6). The
  current code gates it on `TMS_R1_INT_ENABLE`; that is the divergence being fixed
- `IRQLINE` scanline compare; `IRQEN`; `/INT` asserted while any enabled source
  is latched
- `STAT0`–`STAT7`, selected per port by `STATSEL_A`/`STATSEL_B`
- `STAT4` returns `$AC` so §16's detection probe works

**Done when:** every index, pixel and VRAM golden unchanged; a test measures the
vblank window at 70.5 display lines in a 192-line mode and 22.5 in a 240-line
mode; a test proves b7 sets with `IRQEN` clear.

> One structural golden *does* move, and it is the b7 fix landing rather than a
> regression. The BIOS runs its video console with `MODE1` = `$D0` — display on,
> IE **off** — so it is exactly the program the old gate broke: its captured
> `status` goes from `$00` to `$80`. Re-capture it in its own commit, per ground
> rule 4. WIZARDSLAB enables the interrupt (`$E0`) and does not move at all.

---

### Phase 3 — Palette

- 256 entries × 12-bit RGB, VRAM-resident at `PALBASE`, 512 bytes (§11)
- Write-snooping: a VRAM write inside the palette window updates the cache
  immediately — no dirty flag, no reload command
- Default palette generated from §11's table: row 0 the TMS9918 colors, row 1
  grayscale, rows 2–13 twelve hues, row 14 brown, row 15 blue-grey
- Reset writes the default palette into VRAM at `$FC00` and loads the cache
- Output path: `TMS_PALETTE[i & 0x0F]` → 256-entry lookup

**Done when:** index goldens exact, pixel goldens within tolerance, and a test
asserts palette row 0 renders `COLOR = $1F` as black on white.

---

### Phase 4 — The tile engine and the legacy submode → **BIOS boots**

*The heart of the work. Four mode-specific renderers become one parameterized
engine.*

- Delete `graphicsIScanLine`, `graphicsIIScanLine`, `textScanLine`,
  `multicolorScanLine`
- One engine parameterized on bit depth × attribute source × geometry (§8)
- 1bpp pair coloring: fg/bg nibbles into the group selected by `LxPAL`
- Attribute sources: per cell, per pattern group, per pattern row, none
- `LxCTRL` bit layout; `L0PAL`; index-0 opacity
- Legacy submode (§9): `VMODE` = `$0` → `M1`/`M2`/`M3` select Text or Compact and
  pin layer 0's depth and attribute source; `L0ATTR` scaled ×`$40`
- Graphics II and Multicolor fall back to Graphics I
- Widen the layer table bases to §5's eight bits, which is what the extra range
  is for now that there is a renderer that can draw from it

**Done when:**
- **the unmodified BIOS boots to `OK` on the video console** and its text
  goldens are exact
- WIZARDSLAB's board renders and its index goldens are exact
- unit tests cover every depth × attribute-source combination that the spec
  declares meaningful

> **`VMODE` and the four geometries land here, not in Phase 6.** Not scope
> creep — the third parameter of "bit depth × attribute source × geometry" has to
> be a real parameter for the engine to be one engine, and the done-when above
> cannot be met without it: §9 pins layer 0 to 1bpp and to one of two attribute
> sources while `VMODE` = `$0`, so *every* depth beyond 1bpp and two of the four
> attribute sources are unreachable until some `VMODE` other than legacy exists.
> The geometries are a table of four `{cols, rows, cellWidth}` triples; making
> them selectable is the cheap half of Phase 6 and it is the half Phase 4 needs.
> It also settles a disagreement Phase 2 left open: display timing already said
> 240 lines for `VMODE` `$3`/`$4` while the renderer drew 192, and now one table
> answers both.
>
> What is left for Phase 6 is the expensive half: a sample program in each mode
> and the full mode × depth × attribute test matrix.

---

### Phase 5 — Sprites → **WIZARDSLAB runs**

- 64 slots, `SPRCOUNT`, `SPRLIMIT`, `SPRPAL`
- `SPRCTRL`: enable, collision, `$D0` terminator (reset **set**), detailed
  collision, bit depth
- 9-bit X: 0–383 on screen, 384–511 mean −128…−1 (§10)
- Flip, 32 per line with overflow reporting, no flicker. Priority *among*
  sprites is the table index; the attribute byte's b6 — priority against a
  layer — is Phase 7's, with the rest of §12
- Collision: sticky bit always; per-sprite bitmap in `STAT8`–`STAT15` behind
  `SPRCTRL` b3
- Legacy semantics: 1bpp, attribute b3:0 a direct palette index, b7 early clock
- Widen `SPRATTR` and `SPRPAT` to §5's eight bits, as Phase 4 did for the layer

**Done when:**
- **`make smoke-AC6502` exits 2** — ran five seconds without halting
- WIZARDSLAB's `DisableSprites` correctly draws *nothing*: its `$D0` write must
  terminate the list, or 32 sprites of uninitialized VRAM appear over the board
- all WIZARDSLAB goldens exact

> **Y is the sprite's top edge, and that is one line off a TMS9918.** §10 gives
> the Y byte one meaning in every mode — the top edge as a display line, with
> 241–255 reading as −15…−1 and 240 the first row below a 240-line picture —
> where the TMS9918 drew a sprite's first row at Y + 1, so that `$FF` put it on
> line 0. A legacy sprite therefore sits one line higher here than on the real
> part. The alternative is two readings of the same byte chosen by `VMODE`, which
> the spec does not describe and ground rule 2 forbids inventing. Neither
> acceptance target draws a sprite at all, so no golden can see it; the
> divergence is pinned by a test that says which convention it is testing.

> **Both acceptance targets are met here.** Everything after this phase is new
> capability built on a base that legacy software already proves.
>
> Risk 4, measured here as it asks for: 2,537 frames a second on the legacy
> workload — WIZARDSLAB's Graphics I picture, where Phase 4 measured 2,391 — and
> 602 frames a second, 10× real time, extrapolated to §18's worst case: every
> one of 240 lines carrying 32 magnified 16 × 16 sprites at 4bpp with 32 more
> dropped behind them, over a Full-mode 4bpp layer, collision detection on.
> Layer 1 is the remaining unknown, and Phase 7 measures again.

---

### Phase 6 — `VMODE` and the new modes

Most of the register work landed in Phase 4, for the reason set out there:
`VMODE` `$0D`, the four geometries, bit depths 2/4/8 with §8's palette-group
mapping, and the attribute byte's sub-palette, flip and ninth pattern-index bit.
What remains:

- Sprite priority — the attribute byte's b6 — which needs the compositor and so
  moves to Phase 7 with the rest of §12
- Full mode's 9-bit horizontal scroll via `LxCTRL` b6 — its 1200-byte tables
  need nothing, being contiguous from a 1 KB base like every other geometry's.
  **Moves to Phase 7 as well**, with the rest of §13: b6 is the ninth bit of
  `L0SCRX`, and there is no way to implement a register's ninth bit without
  implementing the register. Landing X here and Y there would split one spec
  section across two phases and leave a half-scrollable layer in between
- A sample program in each mode, and the mode × depth × attribute test matrix
  that Phase 4's per-combination tests do not cross with geometry

**Done when:** a test matrix covers mode × depth × attribute source; a new sample
program renders in each mode; the legacy goldens are *still* exact.

> **The sample is the first program written for this card.** `samples/vdp-modes/`
> is a cartridge that cycles the four geometries at 1, 2, 4 and 8bpp, and it
> joins the golden suite as a third fixture with a checkpoint per mode. That
> matters more than it sounds: the BIOS and WIZARDSLAB are the oracle precisely
> *because* they know nothing about this card, which is also why they can say
> nothing about the modes it adds. Until Phase 6 the new modes had unit tests and
> no picture anywhere, and a unit test pokes registers where a program drives the
> port pair.
>
> The matrix is sixty-four cases: four geometries × four depths × four attribute
> sources, one probe cell at column 3, row 2, read from pixel row 3 inside it.
> The crossings are where the address arithmetic lives — the name table's stride
> is the geometry's column count, the attribute table is indexed by a cell number
> that stride produces, the pattern row stride is the depth, and a Text cell is
> six pixels wide at every depth rather than only at 1bpp. Each of those was
> reachable by mutating the renderer and watching the matrix fail; none was
> covered by the per-parameter tests Phase 4 left.
>
> One structural golden moves and it is not a regression: the `registers` array
> stopped at eight, which is how many the card had when the oracle was built. All
> 128 now, because `VMODE`, `L0CTRL`, `L0PAL` and `SPRCTRL` are all above `$07`
> and a structural golden that stopped at eight was blind exactly where the modes
> are. Re-captured in its own commit per ground rule 4; no frame, VRAM image or
> text grid differs by a byte.

---

### Phase 7 — Layer 1 and scrolling

- Second layer, full register block
- Six-level priority resolution (§12)
- `LxSCRX`/`LxSCRY`, per-pixel, sampled per scanline — nine bits of X, the ninth
  being `LxCTRL` b6, which is what Full mode's 320 pixels need (§13); handed
  back here by Phase 6
- Map wrapping at the mode's map size

**Done when:** compositing tests cover all six priority levels; a two-layer
scrolling demo runs; a test proves scroll values are sampled per scanline by
changing `L0SCRX` from a scanline interrupt.

> **A layer is a register block, not a renderer.** `$18`–`$1F` is "identical
> layout, different reset values" (§5), so layer 1 costs one parameter — an
> index into a table of two bases — and the engine Phase 4 built draws either
> layer without knowing which it is. That is the whole of "second layer" here.
>
> **§12 is one array, consulted per pixel.** Every source writes through
> `level > priority[x]` against a parallel line of levels, so the drawing order
> is not the priority order and does not have to be. The alternative — ordering
> the sources and hoping — cannot express level 4 at all, because a layer 0
> tile with b6 set has to land above ordinary sprites and below priority ones,
> and it is drawn before either.
>
> One reading of §12 is worth writing down because the prose and the table say
> different things. The prose says a layer 0 priority tile "lifts that tile
> above ordinary sprites"; the table also lifts it above an ordinary *layer 1*,
> level 4 over level 3. The table is the specification and a test pins it.
>
> **The compositor turns itself off.** A line with layer 1 disabled and a layer
> 0 that has no attribute byte to carry b6 — 1bpp, or an attribute source of
> "none" — cannot produce a contest: every layer write wins unopposed and every
> sprite over it outranks it anyway. That is the picture the BIOS draws, so it
> keeps the branchless inner loop it had, and the legacy workload comes back to
> within 5% of Phase 6 rather than paying 16% for §12's table.
>
> Risk 4, measured here as it asks. Legacy workload: 2,416 frames a second,
> where the same harness measures Phase 6 at 2,554. §18's worst case, that
> harness's heaviest line extrapolated to all 240 — two Full-mode 4bpp layers
> both scrolling off the cell grid, 32 sprites drawn and 32 dropped, collision
> on — 439 frames a second, 7.3× real time. The same measurement with one layer
> is 490, against the 602 Phase 5 reported for a lighter one-layer fixture; the
> second layer costs about a third, which is what a second layer should cost.

---

### Phase 8 — Host integration

Everything outside `src/core/IO/`. See Appendix A for the file list.

- `textGrid()` mode-aware: 40 × 24, 32 × 24, 32 × 30, 40 × 30
- Debugger (`src/debug/server/Methods.ts`): 128 registers, 64 KB VRAM, palette
  inspection
- `src/lib.ts` exports; `Machine.video()`'s `instanceof` check
- `TmsMode`/`TmsColor` removed or replaced — they are TMS9918 vocabulary
- Snapshot round-trip through the debug session
- **`--screenshot` on the CLI**, so golden capture stops needing a bespoke script
  and CI can diff pictures

**Done when:** `npm run typecheck` green, and every test under `src/tests/debug/`,
`src/tests/host/`, `src/tests/renderer/` and `src/tests/cli/` green.

> **Half of this list had already happened.** `textGrid()` became mode-aware in
> Phase 4, when the geometry table did; the debugger's `vram` space has asked the
> card for its size since Phase 1, so it reached 64 KB the moment VRAM did; and
> `Machine.video()` never broke, because the class was never renamed. Those got
> tests rather than code — all four grids through `screen.text`, the byte at
> `$FFFF` through `mem.read`, and both answers of `video()` pinned beside the
> class `lib.ts` exports, which is the one risk 3 is about.
>
> **`getMode()` speaks §9 now.** It returns the geometry being drawn, `VMODE` as
> written, and — only while `VMODE` is legacy — the TMS9918 mode `M1`/`M2`/`M3`
> chose. Both halves, because they differ exactly when something is drawn wrong:
> Graphics II asks for a picture this card does not have and gets Compact's
> Graphics I. `TmsMode` and `TmsColor` are gone. The structural goldens' `mode`
> field carried the old enum, which called all four of vdp-modes' screens
> "Graphics I"; it moves in all fifteen checkpoints, and nothing else in them does.
> Re-captured on its own per ground rule 4.
>
> Replacing the enum surfaced a disagreement with §9's table, which is ordered:
> `M1` set is Text whatever `M2` and `M3` hold. The code let `M3` win over
> everything, so a program setting `M1` and `M3` drew on the Compact grid where
> the spec puts it on Text's, and a unit test pinned that. The spec is the
> specification; the test now pins the spec. No golden sets both bits. The same
> pass found §15's "direction read" reset as write — invisible until the
> debugger could show a port's direction, and corrected with it.
>
> **The debugger reads the card, not only the picture.** `video.info`,
> `video.registers`, `video.setRegister` and `video.palette`, and `6502 dbg video`
> over them. The status registers are *peeked* — a program reading `STAT0`
> acknowledges every latched interrupt, and a debugger that did that by looking
> would show a machine that no longer exists — and the palette is the cache the
> card draws from, beside the address of the VRAM copy to compare it with. The
> snapshot round-trip runs `state.save` and `state.load` through the method
> table and checks the result through those same methods, on a machine carrying
> everything a version 1 snapshot could not have held.
>
> **`--screenshot <file>`** writes the last complete frame when a headless run
> ends, compressed through `node:zlib` — `src/debug/PNG.ts` takes a deflate
> function now, since it also runs in the renderer, which has none. It refuses a
> serial console outright rather than implying `--console video`: that flag
> decides whether the BIOS finds a video card at all, and a camera that changed
> what it photographed would be a strange kind of camera. With `--rtc` and
> `--max-cycles` the file is the same bytes on every run, and a test says so.
> Golden capture still has its script, since a golden is four files at several
> checkpoints with typing between them. What no longer needs one is a picture.

---

### Phase 9 — Performance gate, docs, release

- **Benchmark headless throughput.** See risk 4 — this is a gate, not a
  formality
- README, `docs/AGENTS.md`, `docs/DEBUG-PROTOCOL.md`
- Version 3.0.0; migration notes covering the rejected v1 snapshots
- A written list of what `6502-BIOS` and `6502-DOCS` now want, handed to those
  repositories

> **The gate is `npm run bench`, and it measures the machine, not the renderer.**
> Phases 5 and 7 timed a renderer harness that was never committed. Risk 4's
> question is whether the emulator keeps up, and a user runs the CPU, all eight
> slots and the SID along with the card — so each workload is the whole machine,
> run for a fixed stretch of emulated time in a process of its own and reported
> as a multiple of real time at 1 MHz and 2 MHz. Real time at 2 MHz is two
> million cycles *and* sixty frames, so the frequencies are not interchangeable
> and both are measured. The programs are the four golden fixtures, booted by
> their own recipe, plus the BIOS with no video card, which is the CLI's default.
>
> The worst case is §18's worst line on **every** line. No program can produce
> it — 64 slots of 32-pixel sprites cover 32 lines at most — so every eight lines
> the harness moves all 64 sprites down to straddle the lines about to be drawn,
> which is what a program would do with scanline interrupts. Two Full-mode 4bpp
> layers scrolled off the cell grid in both axes with X through the ninth bit, a
> quarter of the cells carrying the priority bit so the compositor cannot turn
> itself off, 64 sprites competing for 32 places, detailed collision on. Checked
> rather than assumed: `STAT0` reports overflow and collision on every sample
> across three frames, and the first dropped index is 32.
>
> The floors were set before the first measurement: 4× real time at 2 MHz for
> anything a program draws, 2× for the worst case. Headless on an M-series Mac,
> Node 26, median of five:
>
> | Workload | 1 MHz | 2 MHz | Floor |
> |---|--:|--:|--:|
> | `serial` — BIOS prompt, no video card | 10.7× | 7.0× | 4× |
> | `bios` — BIOS prompt, video console | 8.1× | 5.7× | 4× |
> | `wizardslab` — Graphics I, legacy sprites | 8.8× | 6.0× | 4× |
> | `vdp-modes` — all four geometries | 7.8× | 5.1× | 4× |
> | `vdp-layers` — Full mode, two layers, sprites | 6.8× | 4.7× | 4× |
> | `worst` — §18's worst line, 240 times | 4.4× | 3.6× | 2× |
>
> **The legacy picture costs what it cost before.** The same harness driving a
> v2.6.9 build — `--engine` takes any compiled `out/`, and skips the workloads a
> TMS9918A cannot draw — measures `serial` 10.8×/7.0×, `bios` 8.3×/5.7× and
> `wizardslab` 8.9×/6.2×: within about 3% on both clocks, not much more than the
> spread between two runs of either build. The arithmetic says why. Phase 7's
> renderer harness drew the legacy picture 2,416 times a second, which is 25 ms
> of each emulated second; the whole machine at 8× takes about 120 ms of it. The
> card was never most of the cost of a legacy frame — a cycle-stepped CPU and
> seven other cards are — and it is only in Full mode with two layers that it
> becomes what decides the number.
>
> What this does not measure is any host slower than the one it ran on. The
> browser build on a phone is the obvious one, and the floors are margin for it,
> not a measurement of it. The gate is not in `npm test` or CI, where a shared
> runner's timing would fail it for reasons unrelated to the code.
>
> **Docs.** `docs/MIGRATING.md` is the migration notes: every behaviour a 6502
> program can observe that moved, what to do about each, the snapshot refusal,
> the additions to the CLI and the protocol, and the engine API for anything
> importing it. Its last section is the one that matters most outside this
> repository — up to 2.6.9 the emulator ran what a real ACE runs, and from 3.0 it
> runs a card the board does not have yet, with programs that work on one and not
> the other in both directions. The README, `docs/AGENTS.md` and
> `docs/DEBUG-PROTOCOL.md` say the same where they touch it. Snapshot sizes are
> measured rather than carried over: 52 KB headless, unchanged, and 140 KB with a
> video card, where 2.6.9's was 74.
>
> **The two lists are `docs/handoff/6502-BIOS.md` and `docs/handoff/6502-DOCS.md`**,
> kept here until work opens in those repositories, with line numbers pinned to
> the commits they were read at. Neither repository was changed. The BIOS list
> leads with a constraint the spec's §17 does not state: on a TMS9918A a write to
> `L0SCRY`, register `$14`, lands on register 4 and moves the pattern table, so
> hardware scrolling has to be behind §16's detection on every board that exists
> today. The DOCS list leads with a decision the rewrite is waiting on — whether
> the hardware is moving to this card — and one thing that cannot wait: the site
> embeds machines from the emulator's live Pages build, so its Graphics II and
> Multicolor demos break the day 3.0.0 reaches `main`.
>
> **Version 3.0.0**, built locally for macOS and not tagged or published: the
> branch is not merged, and a tag on it would name a commit `main` may never have.

---

5. Risk register
----------------

**1. Phase 0 is skipped or done thinly.** *The* risk. Once `Video.ts` is
rewritten there is no way back to a known-good picture, and "it looks right" is
not a test. Everything else on this list is recoverable; this one is not.

**2. Snapshot compatibility.** v1 snapshots describe a TMS9918 with 16 KB of VRAM
and eight registers. There is no honest migration. Reject them with a message
that says so.

**3. `Machine.video()` uses `instanceof Video`.** If the class is renamed, the
video slot silently reports vacant and the console routes to serial — which looks
exactly like "the BIOS didn't boot". Cheap to get right, expensive to diagnose.

**4. Emulator performance.** Real risk, and easy to discover too late. The
current renderer draws 192 lines of one layer with at most four sprites and a
16-entry palette. The new one draws up to 240 lines of two layers with up to 32
sprites and a 256-entry palette — several times the per-scanline work, in
TypeScript, 15,720 scanline calls per second. If it drops below real time the
emulator is not usable at the very moment it becomes interesting. Benchmark at
the end of Phase 5, with the legacy workload, and again at the end of Phase 7
with two layers and 32 sprites. Typed arrays and pre-expanded lookup tables — the
same trick §18 prescribes for the firmware — are the first answer.

**5. Golden drift from palette quantization.** Expected and bounded: see Appendix
B. Handled by making index frames the strict oracle and pixel frames tolerant.

**6. Determinism.** The whole oracle rests on the machine producing the same
frames from the same cold start. Verify in Phase 0, not Phase 5.

**7. Scope creep into the BIOS.** Hardware scrolling makes `VideoScroll` about
75× faster and it will be tempting. It is not this branch's job, and doing it here
destroys the acceptance criterion — an altered BIOS proves nothing about
compatibility.

---

Appendix A — blast radius
-------------------------

Eleven files reference the video card.

| File | What it uses | Phase |
|---|---|---|
| `src/core/IO/Video.ts` | everything | 1–7 |
| `src/core/Machine.ts` | construction, `video()`, `instanceof` | 1, 8 |
| `src/debug/server/Methods.ts` | `textGrid`, `readVRAM`, `writeVRAM` | 8 |
| `src/debug/Scheduler.ts` | `frameReady` | 8 |
| `src/host/headless/HeadlessHost.ts` | console selection | 8 |
| `src/lib.ts` | public exports | 8 |
| `src/renderer/src/components/VideoCanvas.vue` | `buffer` | 8 |
| `src/renderer/src/stores/emulator.ts` | `getVideo()` | 8 |
| `src/tests/IO/Video.test.ts` | the whole API — 735 lines, expect a rewrite | 1–7 |
| `src/tests/debug/Snapshot.test.ts` | `setRegister`, `readVRAM`, `getMode` | 1, 8 |
| `src/tests/debug/server/Methods.test.ts`, `src/tests/debug/Session.test.ts`, `src/tests/host/HeadlessHost.test.ts` | incidental | 8 |

Public API that changes shape: `getRegister`/`setRegister` (3-bit → 7-bit index),
`getMode()` (returns `TmsMode`), `readVRAM`/`writeVRAM`/`getVramByte`/
`setVramByte` (14-bit → 16-bit address), `textGrid()` (two geometries → four),
`TmsMode` and `TmsColor` (TMS9918 vocabulary, no longer meaningful).

---

Appendix B — what the spec changes about the current emulator
--------------------------------------------------------------

Things already correct, which is more than expected:

| | |
|---|---|
| `DISPLAY_WIDTH` / `DISPLAY_HEIGHT` | 320 × 240 — exactly the spec's virtual frame |
| `BORDER_X` / `BORDER_Y` | 32 / 24 — exactly where §3 puts the 192-line modes |
| `TOTAL_SCANLINES` / `FRAMES_PER_SECOND` | 262 / 60 |
| Text position | `TEXT_PADDING_PX = 8` inside a 256-wide area at x 32 puts glyphs at x 40–279, which is §3's figure to the pixel |
| Per-scanline rendering into a back buffer | the structure the new engine wants |

Things that change:

| | From | To |
|---|---|---|
| `VRAM_SIZE` | `1 << 14` | `1 << 16` |
| Port decode | `address & 1` | `address & 3` |
| Register file | 8 | 128 |
| Register index mask | `& 0x07` | `& 0x7F` |
| Palette | `TMS_PALETTE[i & 0x0F]`, 16 entries | 256 entries, 12-bit, VRAM-resident |
| Vblank flag | `y === TMS_PIXELS_Y - 1 && (R1 & INT_ENABLE)` | end of picture, **regardless of `IRQEN`** |
| `MAX_SCANLINE_SPRITES` | 4 | 32, configurable via `SPRLIMIT` |
| `MAX_SPRITES` | 32 | 64, bounded by `SPRCOUNT` |
| `LAST_SPRITE_YPOS` | always active | `SPRCTRL` b2, reset set |
| Mode renderers | four | one parameterized engine |

**The colors shift very slightly.** `TMS_PALETTE` holds 24-bit RGBA; the spec's
row 0 is those values quantized to 4 bits per channel, because the hardware
outputs 12-bit RGB. Medium green `#21C942` becomes `$2C4` → `#22CC44`. This is
why index frames are the strict oracle and pixel frames carry a tolerance.

*Measured in Phase 3, where this was guessed at:* the BIOS console's pixel
goldens do not move at all — it draws in black and white, `$000` and `$FFF`,
both exact. WIZARDSLAB's do. It does not use only white, gray and black: its
index frames hold eight colors — 1, 3, 6, 7, 8, 11, 13 and 15 — of which light
green, dark red, cyan and light yellow each quantize to 8 away from where they
were on some channel. Eight is the worst case across the whole of row 0, and it
is what `PIXEL_TOLERANCE` is set to.
