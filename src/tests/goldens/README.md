Golden frames
=============

What the emulator's video card showed, captured from two real programs before
the VDP rewrite began, so that every phase of it can be measured against a
picture that was known to be right — and, since, from two programs written for
the card that replaced it.

All of it rests on the machine being deterministic: the same fixture, run from a
cold reset to the same cycle count, draws the same frame every time.
`npm run capture:goldens` boots each fixture twice and refuses to write anything
if the two runs disagree.

```sh
npm test -- src/tests/goldens    # check the emulator still reproduces them
npm run capture:goldens          # re-capture (deliberately — see below)
npm run capture:goldens -- --check   # report what would move, change nothing
npm run record:traces            # re-record the traces (after a re-capture)
npm run record:traces -- --check     # report whether the traces are current
npm run replay:traces            # replay the traces with no CPU, against the goldens
```

The files
---------

One directory per fixture, four files per checkpoint and one trace:

| | |
|---|---|
| `<checkpoint>.json` | registers, mode, status, the name table as text, a VRAM digest — exact |
| `<checkpoint>.vram.bin` | all 64 KB of VRAM — exact |
| `<checkpoint>.idx.bin` | the 320 × 240 frame as **palette indices**, one byte per pixel — exact |
| `<checkpoint>.png` | the same frame as colour, within a tolerance |
| `<fixture>.vdpt.gz` | every port access the program made to the card, timed to the tick — see below |

**The index frame is the oracle.** It is the frame before the palette lookup, so
it fails on any pixel the renderer puts in the wrong place while being immune to
the palette itself changing — which Phase 3 did, shifting WIZARDSLAB's colours by
up to 8 a channel as the spec's 12-bit entries replaced the TMS9918's 24-bit
ones, and not moving a pixel of either index frame. The `.png` is kept beside it,
within that tolerance, because it is the artifact a person can look at: when an
index frame differs and the reported pixel does not explain itself, open the
picture.

The fixtures
------------

| | |
|---|---|
| `bios/` | the bundled BIOS on the video console: at the `OK` prompt, with the screen full, and after a scroll |
| `wizardslab/` | the Wizards Lab cartridge playing itself, at frames 60, 180, 300 and 600 |
| `vdp-modes/` | the [VDP Modes](../../../samples/vdp-modes/) sample cartridge, one checkpoint per `VMODE` geometry |
| `vdp-layers/` | the [VDP Layers](../../../samples/vdp-layers/) sample cartridge: two layers scrolling past four sprites, at four frames |
| `vdp-font/` | the [VDP Font](../../../samples/vdp-font/) sample cartridge: the built-in font as reset installs it, reloaded, and relocated |

The first two are the oracle proper. Between them they use everything the legacy
submode has to keep working: Text and Graphics I, 1bpp patterns coloured per cell
and per pattern group, palette row 0, the vertical-blank flag, sprites, and the
`$D0` sprite-list terminator. Neither touches anything the rewrite adds, which is
exactly why they can measure it.

`vdp-modes/` is the other way round and arrived with Phase 6. It is the only
fixture written for this card rather than inherited from the one it replaces, and
it is the only one that boots a program that has heard of `VMODE`: four screens
crossing §9's geometries with 1, 2, 4 and 8bpp and three of §8's four attribute
sources. Nothing legacy can reach any of that, so without it the new modes have
no golden at all — only unit tests, which poke registers rather than run code.
`vdp-layers/` arrived with Phase 7 for the same reason, for what `vdp-modes/`
leaves out: layer 1, §12's priority levels and §13's scrolling. It draws a
different picture every frame, so its checkpoints are frame numbers with no slack.
`vdp-font/` arrived with VDP-SPEC draft 0.5 and is the only fixture that never
uploads a character set: every other one boots through BIOS 1.x's
`InitCharacters`, which copies the same 2,048 bytes to `$0800` before the first
checkpoint, so only this one can see the font the card installs at reset (§7),
and the `FONT` command loading it again and into a moved pattern table.

`scripts/bench.mjs` boots the same four fixtures by the same recipe to measure
throughput, so the machine a benchmark times is one a golden says is right.

How a fixture is booted, how far it is run and what is read off it are all in
`fixtures.js`, which is plain JavaScript because it is shared by two callers
that cannot share TypeScript: `scripts/capture-goldens.mjs`, which drives the
compiled engine in `out/` and writes these files, and `Goldens.test.ts`, which
drives `src/` through ts-jest and reads them back. A golden that reproduces in
one toolchain and not the other is not evidence of anything, so the two run the
same recipe by construction.

The traces
----------

These goldens are also the oracle of the firmware being written for the card in
`6502-PICOVDP`, which has no 6502 to boot a fixture with. What it takes instead
is each fixture's **trace**: every read and write the program made to the
card's four ports, with the tick it happened on, the line starts between them,
`/INT`, and the checkpoints. The format is that project's `docs/TRACE.md`,
version 1 — gzip-compressed text, one event a line — and `traces.js` is its
reference reader and writer, shared by the scripts and the test the way
`fixtures.js` is.

A trace is recorded through `Video.observer`, during the same `runFixture` run a
golden is captured by. `scripts/replay-trace.mjs` is the proof that it is
complete: a bare `Video`, no CPU, ticked to each recorded event and fed only the
program's side — resets, reads, writes, checkpoints — has to produce the same
line starts, `/INT` changes and read values, line for line, and every
checkpoint's index frame, VRAM and JSON byte for byte.

Each checkpoint line in a trace also carries what the replay found:

| | |
|---|---|
| `frame` | which frame the golden frame is, counting the one in progress at the cold start as 0 |
| `settle` | the reads and writes before that frame's first row was latched |
| `window` | the reads and writes while its rows were being latched |
| `class` | `static` if the card, given only the first `settle` operations and left to run, presents the golden frame anyway; otherwise `dynamic` |

All eighteen are static. The firmware's bench replays a static checkpoint
through real bus pins with no timing at all, so that is worth knowing — and it
is decided by running it, not by counting: fourteen of the eighteen have 1,576
to 1,690 operations in their window, every one of them a status read on port A
polling for vertical blank, and none of them changes what a frame shows.
`vdp-font/relocated` has none: the cartridge has stopped in a loop by then.

`Traces.test.ts` fails if recording moves a golden, if a committed trace is no
longer what the fixture records, or if one stops replaying to its goldens.

When one moves
--------------

A golden that changes is either an intended change or a bug. If it is intended,
re-capture it in a commit of its own that says what changed and why. If it is
not, the change that moved it is where the fix belongs.

A change that moves a golden usually moves the fixture's trace as well, and a
change to what a program does to the card moves the trace even where no golden
moves. Either way `Traces.test.ts` goes red: run `npm run record:traces`, commit
the traces on their own, and tell `6502-PICOVDP` to re-sync its pinned copy.
`record-traces.mjs` refuses to write a trace whose run does not reproduce the
goldens, so re-capture first.

Editing a golden to make a red test green is how the oracle stops being an
oracle. `--check` exists so that asking "did anything move?" never requires
overwriting the answer.
