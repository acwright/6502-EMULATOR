# Moving a program to the PICOVDP card

Version 3.0 adds a second emulated video card. Everything up to 2.7.0 emulated a
TMS9918A, and 3.0 still does, unchanged and by default (`--vdp tms9918a`). Beside
it is the **6502-PICOVDP** specified in [VDP-SPEC.md](VDP-SPEC.md)
(`--vdp picovdp`, `vdp=picovdp`, or Settings → VIDEO CARD): a superset of the
TMS9918A's Text and Graphics I with two tile layers, 1/2/4/8 bpp, 256 colours,
hardware scrolling, 64 sprites, four CPU ports and a built-in font. Nothing else
about the machine changed: the CPU, the other seven slots, the bundled BIOS, the
command line and the debug protocol all behave as they did, apart from what
choosing a card adds to them.

A program that runs on 2.x runs on 3.0 as it is, on the default card. This
document is about moving one to the PICOVDP, and about the few things in 3.0
that are new whichever card is in the slot.

The short version:

- **Choose the card.** It is named the same way everywhere: `--vdp`, `vdp=`,
  `AppSettings.vdp`, a snapshot's `vdp`, `session.info.vdp`. Each card boots its
  own bundled BIOS: the TMS9918A boots BIOS 1.6, and since 3.1 the PICOVDP boots
  BIOS 2.0 (in 3.0 it booted 1.6, in its legacy submode). A ROM you name is used
  as given and never changes the card.
  The default becomes the PICOVDP in a later release of its own, so name the
  card a program needs.
- **Text and Graphics I programs run unmodified on the PICOVDP**, which covers the
  BIOS, BASIC's `CLS`/`LOCATE`/`COLOR`, and every cartridge written for those
  modes; BIOS 1.6 still runs there with `--rom`. The goldens in
  `src/tests/goldens/` hold the Wizards Lab cartridge to the frame it drew on 2.x,
  pixel for pixel before the palette lookup, on both cards, and it draws the same
  frames on BIOS 2.0.
- **Graphics II and Multicolor are gone on the PICOVDP card.** A program that
  selects either there gets Graphics I and draws the wrong picture. On the
  TMS9918A they work as they did.
- **BIOS 2.x is for the PICOVDP alone.** A 2.x ROM on the TMS9918A draws garbage;
  the CLI and the app warn (`BIOS 2.x needs the PICOVDP card (--vdp picovdp)`).
- **Snapshots from 2.x still load**, on the TMS9918A.
- **PICOVDP snapshots taken on 3.0.x are refused by 3.1** as taken with a
  different ROM: they hold BIOS 1.6, and the PICOVDP now boots 2.0. Relaunch with
  `--rom` naming the same 1.6 image, or restore with `force`. **The bundled
  `BIOS.bin` is no longer that image:** 1.6 has been rebuilt three times since
  3.1.1 (6502-BIOS `27bd4e0`, `f858890` and the `v1.6` tag as it now stands, all
  serial flow-control fixes), and a snapshot is matched on the ROM, not the
  version string, which has said `v1.6` throughout.
  `src/tests/fixtures/BIOS-1.6-emulator-2.7.0.bin` is the 1.6 that 2.7.0 through
  3.1.1 shipped.
- **`BIOS2.bin` moved from 6502-BIOS `v2.0` to `v2.0.1` and, in 3.2.0, to
  `v2.0.2`** — the flow-control fixes on the 2.x line, then the border a first
  `COLOR` asks for. A PICOVDP snapshot taken against either earlier image needs
  `force` or a `--rom` naming it. The version string has said `v2.0` throughout,
  so the digest in [../assets/roms/README.md](../assets/roms/README.md) is what
  tells the three apart.
- **`COLOR` as the first thing a program does behaves differently on `v2.0.2`.**
  The Text console comes up on first use, and it used to blank and clear in the
  *old* pen before settling on the new one. It now takes the pen and the border
  it was asked for, so the screen a first `COLOR` brings up is cleared in that
  `COLOR`'s own background rather than the previous one, and border and
  background agree. A border given to `COLOR fg,bg,border` also survives a
  program handing the machine back to the Text console, where `InitVideo` used
  to take the border from the pen. The new Kernal video variable is
  `VID_BORDER`, at `$039C`.
- **The PICOVDP is ahead of the hardware.** See
  [the last section](#the-emulator-and-the-board).

---

<a name="programs"></a>

## 6502 programs

### Unchanged

The classic port pair at `$9C00`/`$9C01`, the two-write command protocol, the
read-ahead byte, registers `$00`–`$07`, the name, colour and pattern table
layouts, the `COLOR` register, 1bpp patterns, the `$D0` sprite-list terminator,
the early-clock bit, sprite size and magnification, collision, and the status
register's shape. The legacy submode (§9) is in effect until a program writes
`VMODE`, which no program written for a TMS9918A does.

### Changed

What a program sees on the PICOVDP card that it did not see on 2.x's TMS9918A,
which `--vdp tms9918a` still is.

| What | TMS9918A (2.x, and `--vdp tms9918a`) | PICOVDP (`--vdp picovdp`) | What to do |
|---|---|---|---|
| Graphics II (`M3`) | Emulated | Falls back to Graphics I; draws garbage | Rewrite for Graphics mode at 1bpp with the per-pattern-row attribute source (§8, §17) |
| Multicolor (`M2`) | Emulated | Falls back to Graphics I; draws garbage | Graphics mode at 4bpp does everything it did (§19) |
| `$9C02`/`$9C03` | Mirrors of `$9C00`/`$9C01` | A second, independent port pair (§4) | A program that reached the card through the mirror now talks to port B, with its own pointer and flip-flop. Use `$9C00`/`$9C01` |
| Register decode | 3 bits: register 8 wrote register 0 | 7 bits: `$08`–`$7F` are real registers (§5) | Anything that wrote a register above 7 expecting it to alias — the F18A unlock sequence, for one — now writes a VDP register instead. Detect the card with §16's probe |
| VRAM | 16 KB, wrapping at `$3FFF` | 64 KB, no wrap (§7) | A pointer run past `$3FFF` continues into `$4000` rather than landing back on `$0000` |
| Palette entries at `$FC00`–`$FDFF` | VRAM like any other | The palette (§11) | Nothing, in practice: a legacy program reaches it only by streaming more than 48 KB past `$3FFF` in one run, or by writing `VBANK` |
| Colours | 24-bit RGB | 12-bit RGB: row 0 is the same sixteen colours to 4 bits a channel | Nothing. Medium green `#21C942` becomes `#22CC44`; no channel moves by more than 8 |
| Sprites per line | 4, the fifth dropped and flagged | 16 by default, the seventeenth flagged; up to 32 through `SPRLIMIT` (§5, §10) | A program that relied on the fifth-sprite flag, or on sprites vanishing past the fourth, sees neither |
| Vertical-blank flag, `STAT0` b7 | Set only with `MODE1`'s interrupt enable on | Set at the end of every picture, enabled or not, as on the TMS9918A (§6) | Nothing — a program polling it with interrupts off now works, as it would on the chip |
| Fifth-sprite and collision flags | Cleared at the start of every frame | Kept until status is read, as on the TMS9918A (§6) | Nothing — a program that reads status once a frame sees what it saw |
| Cold reset | VRAM zeroed | VRAM zeroed, then the default palette written at `$FC00` and the built-in font at `$0800` (§15) | Nothing |
| Warm reset | VRAM kept | VRAM kept, except the palette at `$FC00` and the built-in font at `$0800`, which are written again (§15) | A program that kept something of its own in `$0800`–`$0FFF` across a RESET press finds the font there instead |

**The built-in font (VDP-SPEC draft 0.5).** The card has a font of its own, the
CP437 6 × 8 character set BIOS 1.x keeps at `$B800`, byte for byte. Reset writes
it to `$0800`–`$0FFF`, where Text mode's pattern table sits with `L0PAT` = `$01`,
so a program that selects Text finds characters already there and need not
upload any. Writing register `$30` (`FONT`) loads it again: b7 clear into layer
0's pattern table at `L0PAT` × `$800`, set into layer 1's, sampled at the write,
and complete at the next vertical blank — read `STAT0` to clear F, write `FONT`,
wait for F (§7). `STAT5` reads `$05`, the draft the emulator implements, and
`STAT6` reads `$BF`: b7 says the font and the register are there (§6, §16).
Nothing a 2.x program did changes: the BIOS still uploads its own copy of the
same bytes.

If a program is to run on both a TMS9918A and this card, §16's detection probe —
select `STAT4`, read `$AC` — tells them apart. Run it before `VideoSetColor`: on a
TMS9918A it writes register 7.

---

## Snapshots

Snapshots are now **version 3**, and name the video card they were taken with in
a top-level `vdp`: `"tms9918a"`, `"picovdp"`, or `null` for a machine with an
empty video slot. Versions 1 and 2 still load, and imply the card: a version 1
snapshot — everything a 2.x emulator saved — holds a TMS9918A, and a version 2
snapshot, from 3.0 builds before the TMS9918A came back, holds a PICOVDP.

A snapshot loads only onto the card it was taken with, and `force` does not get
past that; it is checked before the ROM:

```
snapshot: taken with the tms9918a video card; this machine has picovdp — relaunch with --vdp tms9918a (or choose it in Settings)
```

There is no conversion. A TMS9918A snapshot has eight registers, 16 KB of VRAM and
one set of port latches, and reading it as the PICOVDP would mean inventing 120
registers, three quarters of the VRAM and which port the pointer belonged to. A
version 1 snapshot from 2.7.0 (BIOS 1.6) restores on `--vdp tms9918a` once it is
pointed at the 1.6 it was taken on — the bundled one has been rebuilt since, so
it otherwise needs `--rom` or `force`, and
`src/tests/fixtures/BIOS-1.6-emulator-2.7.0.bin` is that image. One from 2.6.x
(BIOS 1.5) also needs `force`, as it did in 2.7.0. A test loop that
boots and saves a `ready.state` at the start of each run, as
[AGENTS.md](AGENTS.md#restore-instead-of-rebooting) recommends, needs no change at
all. Emulator 2.7.0 refuses a version 3 snapshot.

A snapshot of a machine with a video card is about 140 KB, where it was 74 KB; a
headless serial-console machine's is unchanged at 52 KB.

---

## The command line

Everything that worked still works, and on the default card works as it did. New:

- **`--vdp tms9918a|picovdp`** picks the card, headless or windowed, and with it
  the bundled BIOS. A value that names no card exits 1. On a windowed run it
  applies to that launch only, as `--freq` does. With `--console serial` the card
  still picks the ROM, and io8 stays empty.
- **`6502 run --headless --console video --screenshot <file>`** writes the last
  complete frame as a PNG when the run ends. It refuses a serial console rather
  than fitting a video card, because that would change which console the BIOS
  chooses.
- **`6502 dbg info`** names the card: `video console (picovdp)`.
- **`6502 dbg video`** shows the card's mode, status registers (peeked, so looking
  does not acknowledge an interrupt), both ports' pointers and flip-flops, and the
  VRAM size. `6502 dbg video regs` lists all 128 registers, `--set 0x0D=4` writes
  one through the card, and `6502 dbg video palette` shows the 256 colours it
  draws with. On the TMS9918A the same commands show its mode, display bit and
  one status byte, its eight registers, and refuse the palette, which is fixed.
- **`6502 dbg screen text`** returns 24 or 30 rows of 32 or 40 columns on the
  PICOVDP, whichever grid the card is drawing, with the layer-0 scroll applied. A
  script that assumed 24 keeps working for any program that stays in the legacy
  submode. On the TMS9918A it is unchanged.

## The debug protocol

The protocol is still version 1; every change is an addition.

- `session.info` has `vdp`: `"tms9918a"`, `"picovdp"`, or `null` for an empty io8.
- `video.info`, `video.registers`, `video.setRegister` and `video.palette` — see
  [DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md#video). Each answers in the shape of the
  card in the slot, and `video.info` names it in `vdp`.
- `mem.*` with `space: "vram"` reaches 64 KB on the PICOVDP, and refuses an offset
  past `$FFFF` where it refused one past `$3FFF`; on the TMS9918A it is 16 KB as
  before.
- `screen.text` follows the geometry, as above.
- `state.save` writes version 3 with a `vdp` field; `state.load` reads versions 1,
  2 and 3, returns the version it read, and refuses a snapshot taken with the other
  video card, as above. A refusal made before anything was written now says
  `The machine is unchanged.`

## The app, the web build and embeds

- **Settings → VIDEO CARD** switches the card. It is a power cycle with the other
  card in the slot; the bundled BIOS follows the card, and a ROM you loaded stays.
  The desktop app saves the choice in `settings.json` (`vdp`), the web build in
  local storage (`6502-emulator-vdp`).
- **`vdp=`** in the web app's URL applies to that load only. In `embed.html` it
  picks the frame's card, which the embed never saves; `6502:ready` reports `vdp`.
  See [EMBEDDING.md](EMBEDDING.md).
- **`/v2/`** is release 2.7.0, frozen, for pages that must never change.

## Code that imports the engine

`Machine`'s own default io8 is the PICOVDP (`Video`), the core's reference card.
Every host passes the card explicitly — `io8: createVideoCard(model)` — and so
should anything that wants the TMS9918A. `lib.ts` exports `TMS9918A`, `TmsMode`,
`TmsColor`, `createVideoCard` and the `VideoCard` and `VdpModel` types;
`Machine.video()` returns either card as a `VideoCard`, with `model` and
`registerCount`. `TMS9918A` is the 2.7.0 class restored under a new name, frozen
in behaviour.

For anything built against `Video`, the PICOVDP, where it was built against 2.x's
`src/core/IO/Video.ts`:

| 2.x `Video` (a TMS9918A) | 3.0 `Video` (the PICOVDP) |
|---|---|
| `TmsMode`, `TmsColor` | Moved to `TMS9918A.ts`, with the TMS9918A |
| `getMode(): TmsMode` | `getMode(): VideoMode` — `{ vmode, legacy, geometry, cols, rows, cellWidth, width, lines, originX, originY }`. `legacy` is `'text'`, `'graphics-i'`, `'graphics-ii'` or `'multicolor'` while `VMODE` is `$0`, otherwise `null` |
| `getRegister`/`setRegister` masked the index to 3 bits | 7 bits; `$02`–`$06` alias `$10`–`$12` and `$20`–`$21` |
| `readVRAM`/`writeVRAM`/`getVramByte`/`setVramByte` masked to 14 bits | 16 bits |
| `textGrid()` returned 40 × 24 or 32 × 24 | Any of 40 × 24, 32 × 24, 32 × 30, 40 × 30 |
| — | `vramSize`, `frameIndices()`, `paletteEntry()`, `peekStatus()`, `getDisplayLine()`, `portState()`; `lib.ts` also exports `DISPLAY_WIDTH`, `DISPLAY_HEIGHT`, `VIDEO_REGISTER_COUNT`, `VIDEO_STATUS_COUNT`, `VIDEO_PALETTE_ENTRIES` and the `VideoMode` family of types |

The PICOVDP's class is still `Video`, in `src/core/IO/Video.ts`.

---

<a name="the-emulator-and-the-board"></a>

## The emulator and the board

The TMS9918A card runs what a real ACE runs today: a Pico9918 behaving as a
TMS9918A. The PICOVDP card is one the ACE does not have yet: the 6502-PICOVDP is
replacement firmware for the PICO9918 PRO v2.0, specified in
[VDP-SPEC.md](VDP-SPEC.md).

The firmware is being written, in the `6502-PICOVDP` project and against the same
specification. Once it is confirmed working on the hardware, the BIOS and the
AC6502 documentation are rewritten and the family moves to it as its default VDP.
Until then this emulator is the only working implementation of the card, and the
closest thing the firmware has to a reference.

For software meant for today's hardware, run it on `--vdp tms9918a`. The PICOVDP
card is still a faithful test target for it as long as the program stays inside
what both cards share: Text or
Graphics I, registers `$00`–`$07`, `$9C00`/`$9C01`, and four sprites or fewer to
a line. Legacy sprites are placed, coloured and terminated as the TMS9918A does
them, to the line.
Outside that, they disagree in both directions — `VMODE`, a second layer and
scrolling work here and not on the board, while Graphics II, Multicolor and the
F18A's registers work on the board and not here.
