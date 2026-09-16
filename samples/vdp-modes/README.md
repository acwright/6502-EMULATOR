VDP Modes
=========

An AC6502 cartridge that puts each of the 6502-PICOVDP's four display modes on
the screen in turn, one second each, round and round. It is the sample program
the VDP work called for: proof that `VMODE`'s geometries and the tile engine's
bit depths work from 6502 code through the real port pair, and not only from a
test that pokes registers.

```sh
brew install cc65
make            # rebuild VdpModes.crt
make run        # run it in this repository's emulator
make view       # hexdump
```

The screens
-----------

| | `VMODE` | Geometry | `L0CTRL` | What it shows |
|---|:--:|---|:--:|---|
| **Text** | `$1` | 40 × 24 of 6 × 8 | `$30` | 1bpp with a colour byte **per cell** — the fourteen visible colours of palette row 0 as backgrounds along the title, as foregrounds under it, and a diagonal wash over the whole character set. Legacy Text mode fetches no attribute at all and paints the screen from `COLOR`; this is the same geometry doing what that one cannot. |
| **Compact** | `$2` | 32 × 24 of 8 × 8 | `$31` | 2bpp: four colours a cell, sixteen sub-palettes, and flipping on both axes. The grid a Graphics I program lands in, run at four times its colour depth. |
| **Graphics** | `$3` | 32 × 30 of 8 × 8 | `$32` | 4bpp: sixteen colours a cell. Tile 0 is a sixteen-step ramp and each row takes a different sub-palette, so all 256 palette entries are on screen at once. Every eighth cell sets the attribute's b7 and draws pattern `$100`, past the 256 a name byte can name. |
| **Full** | `$4` | 40 × 30 of 8 × 8 | `$3F` | 8bpp with **no attribute fetch**: the pattern byte is the palette index, so there is no attribute table at all. Edge to edge across the whole 320 × 240 frame, no border for the backdrop to show in. |

Sprites are off throughout (`SPRCTRL` b0 clear). They are §10's, the Wizards Lab
fixture and the §10 unit tests already pin them, and leaving them out means every
pixel here is attributable to the tile engine.

Everything sits below VRAM `$4000`, so `VBANK` stays 0 and a pointer is the
fourteen bits the command protocol carries: name table at `$0000`, attribute
table at `$0800`, patterns at `$1000`, and pattern `$100` at `$3000` for the
screen that reaches it. The palette is whatever reset left at `$FC00` — §11's
default, which is the point of having one.

Timing
------

Each screen blanks the display, rebuilds its tables, turns the display back on
and holds for 60 vertical blanks polled off `STAT0` b7. Interrupts are never
enabled: the poll owns that flag, and the Kernal's IRQ handler reading the status
register would take it away.

That puts the display on over these frames from a cold reset, which is what the
golden checkpoints in `src/tests/goldens/vdp-modes/` are placed inside:

| Screen | Display on | Captured at |
|---|---|:--:|
| Text | 8–65 | 36 |
| Compact | 71–128 | 99 |
| Graphics | 135–192 | 163 |
| Full | 199–256 | 227 |

Each capture is at the middle of its window with about 28 frames of slack either
side — a margin nothing short of a real timing bug will cross, and one that stays
honest because a golden captured during a blank between screens would be a black
frame rather than a mode.

Rebuilding
----------

`VdpModes.crt` is committed, so the golden suite boots it from a clean checkout
with no toolchain installed. Rebuilding it moves all four golden checkpoints:
re-capture them in a commit of their own that says what changed and why, exactly
as for any golden, which is never edited to pass.

| | |
|---|---|
| Built with | cc65 `cl65` |
| Layout | `vdp-modes.cfg` — `$8000` padding, `$C000` code, `$FFFA` vectors |
| Size | 32768 bytes, which is what the emulator's `Cart` takes and what an EEPROM wants |
