Golden frames
=============

What the emulator's video card showed, captured from two real programs before
the VDP rewrite began, so that every phase of it can be measured against a
picture that was known to be right. See PLAN.md §3.

```sh
npm test -- src/tests/goldens    # check the emulator still reproduces them
npm run capture:goldens          # re-capture (deliberately — see below)
npm run capture:goldens -- --check   # report what would move, change nothing
```

The files
---------

One directory per fixture, four files per checkpoint:

| | |
|---|---|
| `<checkpoint>.json` | registers, mode, status, the name table as text, a VRAM digest — exact |
| `<checkpoint>.vram.bin` | all 64 KB of VRAM — exact |
| `<checkpoint>.idx.bin` | the 320 × 240 frame as **palette indices**, one byte per pixel — exact |
| `<checkpoint>.png` | the same frame as colour, within a tolerance |

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

Between them they use everything the legacy submode has to keep working: Text
and Graphics I, 1bpp patterns coloured per cell and per pattern group, palette
row 0, the vertical-blank flag, sprites, and the `$D0` sprite-list terminator.
Neither touches anything the rewrite adds.

How a fixture is booted, how far it is run and what is read off it are all in
`fixtures.js`, which is plain JavaScript because it is shared by two callers
that cannot share TypeScript: `scripts/capture-goldens.mjs`, which drives the
compiled engine in `out/` and writes these files, and `Goldens.test.ts`, which
drives `src/` through ts-jest and reads them back. A golden that reproduces in
one toolchain and not the other is not evidence of anything, so the two run the
same recipe by construction.

When one moves
--------------

A golden that changes is either an intended change or a bug — PLAN.md ground
rule 4. If it is intended, re-capture it in a commit of its own that says what
changed and why. If it is not, the phase that moved it is where the fix belongs.

Editing a golden to make a red test green is how the oracle stops being an
oracle. `--check` exists so that asking "did anything move?" never requires
overwriting the answer.
