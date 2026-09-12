# Moving to 3.0

Version 3.0 replaces the emulated video card. Everything up to 2.6.9 emulated a
TMS9918A; 3.0 emulates the **6502-PICOVDP** specified in
[VDP-SPEC.md](VDP-SPEC.md), a superset of it with two tile layers, 1/2/4/8 bpp,
256 colours, hardware scrolling, 64 sprites and four CPU ports. Nothing else about
the machine changed: the CPU, the other seven slots, the bundled BIOS, the command
line and the debug protocol all behave as they did, apart from what the new card
adds to them.

The short version:

- **Text and Graphics I programs run unmodified**, which covers the BIOS, BASIC's
  `CLS`/`LOCATE`/`COLOR`, and every cartridge written for those modes. The goldens
  in `src/tests/goldens/` hold the BIOS and the Wizards Lab cartridge to the frame
  they drew on 2.x, pixel for pixel before the palette lookup.
- **Graphics II and Multicolor are gone.** A program that selects either gets
  Graphics I and draws the wrong picture.
- **Snapshots from 2.x are refused.** Re-record them.
- **The emulator is now ahead of the hardware.** See
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

| What | 2.x | 3.0 | What to do |
|---|---|---|---|
| Graphics II (`M3`) | Emulated | Falls back to Graphics I; draws garbage | Rewrite for Graphics mode at 1bpp with the per-pattern-row attribute source (§8, §17) |
| Multicolor (`M2`) | Emulated | Falls back to Graphics I; draws garbage | Graphics mode at 4bpp does everything it did (§19) |
| `$9C02`/`$9C03` | Mirrors of `$9C00`/`$9C01` | A second, independent port pair (§4) | A program that reached the card through the mirror now talks to port B, with its own pointer and flip-flop. Use `$9C00`/`$9C01` |
| Register decode | 3 bits: register 8 wrote register 0 | 7 bits: `$08`–`$7F` are real registers (§5) | Anything that wrote a register above 7 expecting it to alias — the F18A unlock sequence, for one — now writes a VDP register instead. Detect the card with §16's probe |
| VRAM | 16 KB, wrapping at `$3FFF` | 64 KB, no wrap (§7) | A pointer run past `$3FFF` continues into `$4000` rather than landing back on `$0000` |
| Palette entries at `$FC00`–`$FDFF` | VRAM like any other | The palette (§11) | Nothing, in practice: a legacy program reaches it only by streaming more than 48 KB past `$3FFF` in one run, or by writing `VBANK` |
| Colours | 24-bit RGB | 12-bit RGB: row 0 is the same sixteen colours to 4 bits a channel | Nothing. Medium green `#21C942` becomes `#22CC44`; no channel moves by more than 8 |
| Sprites per line | 4, the fifth dropped and flagged | 32 (`SPRLIMIT`), the thirty-third flagged (§10) | A program that relied on the fifth-sprite flag, or on sprites vanishing past the fourth, sees neither |
| Sprite Y | First row at Y + 1 | First row at Y — one line higher (§10) | Nothing, unless a sprite is placed to the pixel against a tile |
| Negative sprite Y | 225–255 meant −31…−1 | 241–255 mean −15…−1; 225–240 are below the picture | A 32-pixel sprite entering from the top should start at 241, not 225 |
| Vertical-blank flag, `STAT0` b7 | Set only with `MODE1`'s interrupt enable on | Set at the end of every picture, enabled or not, as on the TMS9918A (§6) | Nothing — a program polling it with interrupts off now works, as it would on the chip |
| Cold reset | VRAM zeroed | VRAM zeroed, then the default palette written at `$FC00` (§15) | Nothing |

If a program is to run on both a TMS9918A and this card, §16's detection probe —
select `STAT4`, read `$AC` — tells them apart. Run it before `VideoSetColor`: on a
TMS9918A it writes register 7.

---

## Snapshots

Snapshots are now **version 2**, and a version 1 snapshot — everything a 2.x
emulator saved, with a video card or without — is refused:

```
snapshot: version 1, this build reads version 2 — version 1 holds a TMS9918 video card, which this build no longer emulates; re-record it
```

There is no conversion, and `force` does not get past it. A version 1 snapshot
has eight registers, 16 KB of VRAM and one set of port latches, and reading it as
this card would mean inventing 120 registers, three quarters of the VRAM and which
port the pointer belonged to. A test loop that boots and saves a `ready.state` at
the start of each run, as [AGENTS.md](AGENTS.md#restore-instead-of-rebooting)
recommends, needs no change at all.

A snapshot of a machine with a video card is about 140 KB, where it was 74 KB; a
headless serial-console machine's is unchanged at 52 KB.

---

## The command line

Everything that worked still works. New:

- **`6502 run --headless --console video --screenshot <file>`** writes the last
  complete frame as a PNG when the run ends. It refuses a serial console rather
  than fitting a video card, because that would change which console the BIOS
  chooses.
- **`6502 dbg video`** shows the card's mode, status registers (peeked, so looking
  does not acknowledge an interrupt), both ports' pointers and flip-flops, and the
  VRAM size. `6502 dbg video regs` lists all 128 registers, `--set 0x0D=4` writes
  one through the card, and `6502 dbg video palette` shows the 256 colours it
  draws with.
- **`6502 dbg screen text`** returns 24 or 30 rows of 32 or 40 columns, whichever
  grid the card is drawing. It returned 24 rows before. A script that assumed 24
  keeps working for any program that stays in the legacy submode.

## The debug protocol

The protocol is still version 1; every change is an addition.

- `video.info`, `video.registers`, `video.setRegister` and `video.palette` — see
  [DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md#video).
- `mem.*` with `space: "vram"` reaches 64 KB, and refuses an offset past `$FFFF`
  where it refused one past `$3FFF`.
- `screen.text` follows the geometry, as above.
- `state.load` refuses version 1 snapshots, as above.

## Code that imports the engine

For anything built against `src/lib.ts` or `src/core/IO/Video.ts` directly:

| 2.x | 3.0 |
|---|---|
| `TmsMode`, `TmsColor` | Removed. They were TMS9918A vocabulary |
| `getMode(): TmsMode` | `getMode(): VideoMode` — `{ vmode, legacy, geometry, cols, rows, cellWidth, width, lines, originX, originY }`. `legacy` is `'text'`, `'graphics-i'`, `'graphics-ii'` or `'multicolor'` while `VMODE` is `$0`, otherwise `null` |
| `getRegister`/`setRegister` masked the index to 3 bits | 7 bits; `$02`–`$06` alias `$10`–`$12` and `$20`–`$21` |
| `readVRAM`/`writeVRAM`/`getVramByte`/`setVramByte` masked to 14 bits | 16 bits |
| `textGrid()` returned 40 × 24 or 32 × 24 | Any of 40 × 24, 32 × 24, 32 × 30, 40 × 30 |
| — | `vramSize`, `frameIndices()`, `paletteEntry()`, `peekStatus()`, `getDisplayLine()`, `portState()`; `lib.ts` also exports `DISPLAY_WIDTH`, `DISPLAY_HEIGHT`, `VIDEO_REGISTER_COUNT`, `VIDEO_STATUS_COUNT`, `VIDEO_PALETTE_ENTRIES` and the `VideoMode` family of types |

The class is still `Video`, so `Machine.video()` still finds it.

---

<a name="the-emulator-and-the-board"></a>

## The emulator and the board

Up to 2.6.9 the emulator ran what a real ACE runs. From 3.0 it runs a video card
the ACE does not have yet: the 6502-PICOVDP is replacement firmware for the
PICO9918 PRO v2.0, specified in [VDP-SPEC.md](VDP-SPEC.md) and not yet written. A
board today has a Pico9918 behaving as a TMS9918A.

For software meant for today's hardware, the emulator is still a faithful test
target as long as the program stays inside what both cards share: Text or
Graphics I, registers `$00`–`$07`, `$9C00`/`$9C01`, four sprites or fewer to a
line, and sprite positions that do not depend on the one-line difference above.
Outside that, they disagree in both directions — `VMODE`, a second layer and
scrolling work here and not on the board, while Graphics II, Multicolor and the
F18A's registers work on the board and not here.
