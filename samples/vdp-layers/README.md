VDP Layers
==========

An AC6502 cartridge that scrolls two layers past four stationary sprites,
forever. It is the demo the VDP work called for: proof that the second layer,
§12's six-level priority resolution and §13's hardware scrolling work from 6502
code through the real port pair, and not only from a test that pokes registers.

```sh
brew install cc65
make            # rebuild VdpLayers.crt
make run        # run it in this repository's emulator
make view       # hexdump
```

The picture
-----------

Full mode — `VMODE` `$4`, 40 × 30 of 8 × 8, edge to edge across the whole
320 × 240 frame. Both layers 4bpp with a colour byte per cell, sharing one
pattern table.

| | `LxCTRL` | What it draws |
|---|:--:|---|
| **Layer 0** | `$32` | 4bpp per cell, **index 0 opaque** — so it covers the backdrop and nothing shows through it. Five bands of sky over twelve rows of brick, with a grey post every fifth column whose attribute byte carries **b6**: §12 level 4, in front of an ordinary sprite. Scrolls one pixel a frame horizontally and one every eighth vertically. |
| **Layer 1** | `$12` | 4bpp per cell, **index 0 transparent** — every empty cell, and the two pixels either side of each trunk, show layer 0 through. Tree trunks over the lower rows at level 3, and across the top a band alternating two cells of banner (**b6** set, level 6) with two of awning (b6 clear, level 3). Scrolls two pixels a frame: twice layer 0, which is parallax. |

Four sprites, magnified to 16 × 16, stand still while the scenery moves past.
Each pair is the same sprite twice with one bit changed:

| Slot | Position | Attribute | Level | What it shows |
|:--:|---|:--:|:--:|---|
| 0 | 60, 176 | `$0A` | 2 | Cut in half by every post (4) and every trunk (3) that passes over it. |
| 1 | 100, 176 | `$4A` | 5 | Never occluded by either — b6 lifts it over both. |
| 2 | 160, 20 | `$4A` | 5 | In front of the awning (3), **behind** the banner (6). The one sprite that separates level 5 from level 6, and it does it within a single band. |
| 3 | 200, 20 | `$0A` | 2 | Behind the awning as well, which is what slot 2 is being compared against. |

Between them the four levels above the backdrop are all resolved against a
neighbour, in motion: a sprite is occluded and revealed as a post scrolls across
it, which no still picture proves.

The ninth scroll bit
--------------------

Full mode is 320 pixels wide and `LxSCRX` is eight bits, so bit 8 lives in
`LxCTRL` b6 (§13). The frame loop writes the control register alongside the
scroll register every frame, with b6 set whenever the scroll has passed 255. It
is the reason this demo is in Full mode rather than the cheaper Graphics one: in
every other geometry the map is 256 pixels wide or narrower and b6 is never set,
so a card that ignored it entirely would look correct.

VRAM
----

Everything sits below `$4000`, so `VBANK` stays 0 and a pointer is the fourteen
bits the command protocol carries. Full mode's name and attribute tables are
1200 bytes each and so span two of §5's 1 KB blocks apiece — contiguous from
their bases, like every other geometry's.

| | |
|---|---|
| `$0000` | layer 0 name table, 1200 bytes |
| `$0800` | layer 0 attribute table, 1200 bytes |
| `$1000` | layer 1 name table |
| `$1800` | layer 1 attribute table |
| `$2000` | seven 4bpp tiles, 32 bytes each — shared by both layers |
| `$2800` | the sprite pattern |
| `$3000` | the sprite attribute table |

The palette is whatever reset left at `$FC00` — §11's default — so a sub-palette
is a palette row and the attribute bytes read as colour names.

Timing
------

The tables are built and the display turned on inside the first frame, so the
golden checkpoints in `src/tests/goldens/vdp-layers/` are frame numbers counted
from a cold reset with nothing in between that could drift: no boot-menu
timeout, no mode changes, no blanked rebuilds.

| Checkpoint | Frame | `L0SCRX` | `L1SCRX` | `L0SCRY` |
|---|--:|--:|--:|--:|
| `parallax` | 90 | 64 | 128 | 8 |
| `scroll-bit8-l1` | 180 | 154 | **308** | 19 |
| `occluded` | 240 | 214 | 108 | 26 |
| `scroll-bit8-l0` | 300 | **274** | 228 | 34 |

Unlike `vdp-modes/`, these have no slack, and that is deliberate: this cartridge
draws a different picture every frame, and a golden that could not tell frame 90
from frame 91 could not tell scrolling from a still. A checkpoint that moves here
means the cycle count from reset to the first vertical blank has moved.

Rebuilding
----------

`VdpLayers.crt` is committed, so the golden suite boots it from a clean checkout
with no toolchain installed. Rebuilding it moves all four golden checkpoints:
re-capture them in a commit of their own that says what changed and why, exactly
as for any golden, which is never edited to pass.

| | |
|---|---|
| Built with | cc65 `cl65` |
| Layout | `vdp-layers.cfg` — `$8000` padding, `$C000` code, `$FFFA` vectors |
| Size | 32768 bytes, which is what the emulator's `Cart` takes and what an EEPROM wants |
