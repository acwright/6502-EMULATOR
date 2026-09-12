6502-PICOVDP — Specification
============================

A custom Video Display Processor for the AC6502 family, implemented in firmware
on PICO9918 PRO v2.0 hardware.

**Status:** draft 0.1 — design document, not yet implemented.

---

Contents
--------

1. [Goals](#1-goals)
2. [Target hardware](#2-target-hardware)
3. [Display model](#3-display-model)
4. [CPU interface](#4-cpu-interface)
5. [Register map](#5-register-map)
6. [Status registers](#6-status-registers)
7. [Video RAM](#7-video-ram)
8. [The tile engine](#8-the-tile-engine)
9. [Display modes](#9-display-modes)
10. [Sprites](#10-sprites)
11. [Palette](#11-palette)
12. [Compositing and priority](#12-compositing-and-priority)
13. [Scrolling](#13-scrolling)
14. [Interrupts](#14-interrupts)
15. [Reset state](#15-reset-state)
16. [Detection](#16-detection)
17. [BIOS impact](#17-bios-impact)
18. [Implementation notes](#18-implementation-notes)
19. [Deliberate omissions and future space](#19-deliberate-omissions-and-future-space)

---

1. Goals
--------

The PICO9918 emulates a TMS9918A faithfully, which the AC6502 does not need. This
design keeps the parts of the TMS9918 interface that cost nothing to keep, and
spends everything else on capability.

**What this design provides**

| | TMS9918A / PICO9918 | 6502-PICOVDP |
|---|---|---|
| Display modes | Text, Graphics I, Graphics II, Multicolor | Text, Compact, Graphics, Full — plus a legacy submode |
| Tile bit depth | 1 | 1, 2, 4 or 8, per layer |
| Tile layers | 1 | 2 |
| Colors on screen | 15 + transparent | 256, from 4096 |
| Palette | fixed | 256 entries, user defined |
| Colors per tile | 2 (per 8-pixel row at best) | 2, 4, 16 or 256 |
| Sprites | 32 total, 4 per line, 1 color | 64 total, 32 per line, 15 colors |
| Sprite flipping | none | horizontal and vertical |
| Scrolling | none | hardware, per layer, per pixel |
| Interrupts | vblank | vblank, scanline compare, overflow, collision |
| VRAM | 16 KB | 64 KB |
| VRAM access window | ~8 µs between accesses | unrestricted |
| Registers | 8 | 128 |
| CPU ports | 2 | 4 |

**Design principles**

1. **The classic port pair still works.** `$9C00`/`$9C01` behave as they always
   have. The existing Kernal drives this VDP unmodified (see §17). There is no
   unlock sequence and no lock: everything new is simply present.
2. **No mode is reachable only by magic.** Registers `$08`–`$7F` are always live.
3. **The 6502 is the bottleneck, not the Pico.** At 1 MHz a `sta VC_DATA` run
   moves ~250 KB/s. Every design decision that trades VRAM or CPU writes for
   VDP-side work is worth taking; every decision that demands more CPU writes is
   not. This is why VRAM is 64 KB and not 512 KB, and why hardware scrolling
   matters more than extra tile capacity.
4. **Nothing is at a fixed address.** Every table is placed by a base register.

**Non-goals**

- TMS9918 Graphics II and Multicolor modes. Dropped — see §19 for why Graphics II
  in particular did not survive. The *capability* Graphics II offered, one color
  pair per pattern row, is a first-class feature of the tile engine (§8).
- F18A compatibility. The F18A register set is not implemented and not emulated.
- A GPU/coprocessor.
- A blitter or VRAM fill/copy engine. See §19.

---

2. Target hardware
------------------

**PICO9918 PRO v2.0 (RP2350) only.**

| | |
|---|---|
| MCU | RP2350, dual Cortex-M33 |
| SRAM | 520 KB |
| System clock | 302.4 MHz (VGA preset 1) or 352 MHz (preset 2) |
| Video out | VGA 640×480@60, HDMI, or SCART RGB, via the FFC dongles |
| Color depth | 12 bits (4-4-4 R/G/B on GPIO 2–13) |

### Why not v1.0–1.3 (RP2040)

The per-scanline budget at 302.4 MHz is ~9,600 cycles (31.78 µs line period).
Estimated cost of a full line — two 4bpp layers, 32 sprites, palette expansion,
sprite evaluation and bus interrupt service — is roughly 7,400 cycles on an M33
(see §18). The same work on an M0+ at 252 MHz runs to an estimated ~12,000
cycles against a ~8,000 cycle budget. A v1.x profile would mean cutting to
roughly 16 sprites per line and dropping 8bpp, which means two renderers and a
capability query in every piece of software. Not worth it.

If a v1.x profile is wanted later, `STAT6` (§6) already reports capability bits
for exactly this purpose.

### No hardware modification required

The AC6502 already wires the PICO9918's `MODE` pin (GPIO 28) to A0 and `MODE1`
(GPIO 29) to A1. The existing `tmsWrite` PIO program already samples both:
`in pins, 16` from GPIO 14 reaches GPIO 29, and MODE1 lands in bit 31 of the
FIFO word. Only `tmsRead` needs a change — `in pins, 1` becomes `in pins, 2`.

This is a firmware-only project.

---

3. Display model
----------------

The PICO9918 renders a **320 × 240 virtual frame** at one byte (palette index)
per pixel, and expands it 2× in both axes through a 256-entry RGB lookup into
the 640 × 480 VGA raster. This VDP keeps that pipeline exactly.

| | |
|---|---|
| Virtual frame | 320 × 240, 8-bit palette index per pixel |
| Physical output | 640 × 480 @ 59.94 Hz (2× scale) |
| Pixel clock | 25.175 MHz |
| Line period | 31.78 µs |
| Frame period | 16.68 ms |
| Vertical blanking | 45 VGA lines ≈ 1.43 ms ≈ 1,430 CPU cycles @ 1 MHz |
| Palette | 256 entries × 12-bit RGB (4096 colors) |

Active areas within the 320 × 240 frame:

| Mode | Cells | Pixels | Position | Border |
|---|---|---|---|---|
| Text | 40 × 24 of 6 × 8 | 240 × 192 | x 40–279, y 24–215 | 40 px left/right, 24 lines top/bottom |
| Compact | 32 × 24 of 8 × 8 | 256 × 192 | x 32–287, y 24–215 | 32 px left/right, 24 lines top/bottom |
| Graphics | 32 × 30 of 8 × 8 | 256 × 240 | x 32–287, y 0–239 | 32 px left/right, none top/bottom |
| Full | 40 × 30 of 8 × 8 | 320 × 240 | the whole frame | none |

On a 4:3 monitor at 640 × 480 the pixels are square, so Full mode's 8 × 8 cells
are square on screen and the frame has no border at all. Text mode's 6 × 8 cells
are taller than they are wide, as they are on a TMS9918.

Text mode therefore occupies exactly the same physical screen area it does
today (240 virtual pixels → 480 VGA pixels wide, either way). Graphics mode is
the same width as today's 256-pixel modes but 240 lines tall instead of 192.

Scanline numbering used by `IRQLINE` and `STAT2` is the **display line**, which
counts from the first line of the active picture *in the current mode* — not from
the top of the frame. Display line 0 is the first visible line, the count runs
up through the picture, the bottom border, vertical blanking and the top border,
and wraps at 262. In the 192-line modes it is therefore offset from the screen
position above: display line 0 is screen line 24.

| Mode | Active | Picture occupies | Blanking occupies |
|---|--:|---|---|
| Text, Compact | 192 lines | display lines 0–191 | 192–262 |
| Graphics, Full | 240 lines | display lines 0–239 | 240–262 |

Counting from the picture rather than from the frame means a raster split stays
put across a mode change: `IRQLINE = 80` is ten character rows down whatever mode
is running. It is also how the TMS9918 counts, which matters for §14.

---

4. CPU interface
----------------

Four byte-wide ports in I/O slot 8, decoded from A1:A0. Slot 8 mirrors them
across `$9C00`–`$9FFF`; use the canonical addresses.

| A1 | A0 | Address | Name | Write | Read |
|:--:|:--:|---|---|---|---|
| 0 | 0 | `$9C00` | `VC_DATA` | VRAM data, port A | VRAM data, port A |
| 0 | 1 | `$9C01` | `VC_REG` / `VC_STATUS` | command, port A | status, port A |
| 1 | 0 | `$9C02` | `VC_DATA2` | VRAM data, port B | VRAM data, port B |
| 1 | 1 | `$9C03` | `VC_REG2` / `VC_STATUS2` | command, port B | status, port B |

### Two independent ports

`$9C02`/`$9C03` are a second, complete copy of the interface. Each port pair has
its own:

- VRAM address pointer
- read/write direction latch
- read-ahead prefetch byte
- first-byte/second-byte flip-flop
- status register selector (`STATSEL_A` / `STATSEL_B`)

Both ports address the same 64 KB of VRAM and write the same register file.

This exists for three reasons:

1. **Interrupt safety.** The hazard the AC6502 documentation warns about — an
   interrupt landing between the two halves of a command pair — disappears if
   interrupt handlers use port B and foreground code uses port A. No `sei`/`cli`
   around VDP work.
2. **VRAM to VRAM copies without a RAM buffer.** `lda VC_DATA2 : sta VC_DATA` in
   an unrolled loop is 8 cycles per byte, both pointers advancing.
3. **Two live cursors.** Park port B on the sprite attribute table and port A on
   the name table and neither needs re-addressing.

### Command protocol

Identical to the TMS9918 on both ports. Two writes to the command port:

```
  1st write:  payload byte P
  2nd write:  command byte C
```

| C | Effect |
|---|---|
| `%1rrrrrrr` | Write register `r` (0–127) with value `P` |
| `%01aaaaaa` | Set VRAM pointer for **write** to `{VBANK[1:0], a[5:0], P[7:0]}` |
| `%00aaaaaa` | Set VRAM pointer for **read** to the same, and prefetch |

The TMS9918 decodes 3 register bits and the F18A 6; this VDP decodes 7. Legacy
writes of `$80`–`$87` reach registers 0–7 unchanged.

Reading the status port resets that port's flip-flop.

### VRAM pointer

The pointer is a full 16-bit counter. The command protocol sets bits 13:0;
bits 15:14 come from `VBANK` (§5). After each `VC_DATA` access the pointer
advances by the signed stride in `VINC` (reset value `+1`), **carrying into the
bank bits** — a streaming write runs off the end of a bank into the next one.
`VBANK` reads back updated.

> This is the one place where TMS9918 behavior is deliberately broken: a real
> TMS9918 wraps within 16 KB. Nothing in the AC6502 software suite relies on
> that wrap.

Reads are prefetched: setting a read address fetches the byte at that address
immediately, and each `VC_DATA` read returns the prefetched byte and fetches the
next. This is TMS9918 behavior and the reason the read-then-advance pattern
works.

### Access timing

There is no minimum interval between VRAM accesses. VRAM is RP2350 SRAM, not a
DRAM array being time-shared with the raster, so the ~8 µs gap a real TMS9918
demands does not exist. The 65C02's fastest back-to-back port access is
`sta abs` at 4 cycles — 4 µs at 1 MHz, 2 µs at 2 MHz — which leaves the RP2350
roughly 600 cycles to service each access. The PIO-plus-interrupt path costs
well under 100.

Sustained throughput through an unrolled `sta VC_DATA` run:

| CPU | Bytes/s | 960-byte table | 8 KB pattern set | Full 64 KB |
|---|---|---|---|---|
| 1 MHz | ~250 K | 3.8 ms | 33 ms | 262 ms |
| 2 MHz | ~500 K | 1.9 ms | 16 ms | 131 ms |

Writing during active display is permitted and will not corrupt the raster, but
changing a structure the current frame is still drawing will tear. Structures
are sampled as the raster reaches them; the palette is an exception (§11).

---

5. Register map
---------------

128 registers, all write-only. Read back state through the status registers (§6).

Registers `$02`–`$06` are **aliases** of registers in the layer and sprite
blocks — the same storage under two addresses — so that legacy register writes
and the symmetric new layout describe the same hardware.

### $00–$07 — Legacy core

| # | Name | Reset | Bits |
|---|---|---|---|
| `$00` | `MODE0` | `$00` | **b1 M3** legacy mode select (§9); b0 EXTVID *(ignored)*; b7:2 reserved |
| `$01` | `MODE1` | `$00` | b7 *(ignored, 4/16K)*; **b6 DISP** display enable; **b5 IE** vblank IRQ enable; **b4 M1** and **b3 M2** legacy mode select (§9); b2 reserved; **b1 SPRSIZE** 0 = 8×8, 1 = 16×16; **b0 SPRMAG** magnify ×2 |
| `$02` | `L0NAME` | `$00` | Layer 0 name table base, ×`$400`. Alias of `$10`. |
| `$03` | `L0ATTR` | `$00` | Layer 0 attribute table base, ×`$400`. Alias of `$11`. |
| `$04` | `L0PAT` | `$00` | Layer 0 pattern table base, ×`$800`. Alias of `$12`. |
| `$05` | `SPRATTR` | `$00` | Sprite attribute table base, ×`$80`. Alias of `$20`. |
| `$06` | `SPRPAT` | `$00` | Sprite pattern table base, ×`$800`. Alias of `$21`. |
| `$07` | `COLOR` | `$00` | b7:4 default foreground index, b3:0 backdrop/border index — both within the 16-entry palette group named by `L0PAL` |

`M1`, `M2` and `M3` select the display mode only while `VMODE` (register `$0D`)
is `$0`, which it is at reset. See §9 for what each combination resolves to and
what `VMODE` does instead.

Base register fields are widened from the TMS9918's. `L0NAME` was 4 bits, now 8
(×`$400` → reaches `$3FC00`, of which bits 5:0 are meaningful in 64 KB).
`L0PAT`/`SPRPAT` were 3 bits, now 8 (×`$800` → `$F800` within 64 KB).
`SPRATTR` stays ×`$80` over 8 bits, reaching `$7F80`. Legacy values land exactly
where they used to.

### $08–$0F — Access and interrupts

| # | Name | Reset | Bits |
|---|---|---|---|
| `$08` | `VBANK` | `$00` | VRAM address bits A21:A14. Bits 1:0 implemented (64 KB); the rest read as written and are reserved for a larger VRAM. |
| `$09` | `VINC` | `$01` | VRAM auto-increment stride, signed 8-bit, −128…+127. `$00` = no increment. |
| `$0A` | `IRQEN` | `$00` | b0 vblank, b1 scanline compare, b2 sprite overflow, b3 sprite collision |
| `$0B` | `IRQLINE` | `$00` | Scanline compare value, display line 0–255 |
| `$0C` | `PALBASE` | `$3F` | Palette base, ×`$400`. Reset = `$FC00`. |
| `$0D` | `VMODE` | `$00` | b3:0 display mode (§9); b7:4 reserved |
| `$0E` | `STATSEL_B` | `$00` | Which status register port B returns |
| `$0F` | `STATSEL_A` | `$00` | Which status register port A returns |

`STATSEL_A` is at `$0F` because the F18A puts its status select at R15; anyone
carrying F18A habits lands in the right place. The two selectors are separate so
an interrupt handler reading status on port B cannot disturb foreground code
reading status on port A.

### $10–$17 — Layer 0

| # | Name | Reset | Bits |
|---|---|---|---|
| `$10` | `L0NAME` | `$00` | Name table base, ×`$400` *(= `$02`)* |
| `$11` | `L0ATTR` | `$00` | Attribute table base, ×`$400` *(= `$03`)* |
| `$12` | `L0PAT` | `$00` | Pattern table base, ×`$800` *(= `$04`)* |
| `$13` | `L0SCRX` | `$00` | Horizontal scroll, pixels — bits 7:0; bit 8 is `L0CTRL` b6 |
| `$14` | `L0SCRY` | `$00` | Vertical scroll, pixels |
| `$15` | `L0CTRL` | `$3C` | b1:0 bit depth; b3:2 attribute source; b4 layer enable; b5 index 0 opaque; b6 horizontal scroll bit 8; b7 reserved — see §8 |
| `$16` | `L0PAL` | `$00` | b3:0 palette group high bits — see §8 |
| `$17` | — | — | Reserved |

### $18–$1F — Layer 1

Identical layout, different reset values.

| # | Name | Reset | Bits |
|---|---|---|---|
| `$18` | `L1NAME` | `$00` | Name table base, ×`$400` |
| `$19` | `L1ATTR` | `$00` | Attribute table base, ×`$400` |
| `$1A` | `L1PAT` | `$00` | Pattern table base, ×`$800` |
| `$1B` | `L1SCRX` | `$00` | Horizontal scroll, pixels — bits 7:0; bit 8 is `L1CTRL` b6 |
| `$1C` | `L1SCRY` | `$00` | Vertical scroll, pixels |
| `$1D` | `L1CTRL` | `$0C` | Same bits as `L0CTRL`. Reset: layer disabled, index 0 transparent. |
| `$1E` | `L1PAL` | `$00` | b3:0 palette group high bits |
| `$1F` | — | — | Reserved |

`L0CTRL` resets to `$3C` — 1bpp, no attribute table, enabled, index 0 opaque —
so that a bare text screen has a solid background colored by `COLOR`. `L1CTRL`
resets to `$0C` — the same, but disabled and with index 0 transparent, which is
what an overlay layer wants.

While `VMODE` = `$0` the bit-depth and attribute-source fields of `L0CTRL` are
ignored and derived from the legacy mode bits instead (§9).

### $20–$27 — Sprites

| # | Name | Reset | Bits |
|---|---|---|---|
| `$20` | `SPRATTR` | `$00` | Attribute table base, ×`$80` *(= `$05`)* |
| `$21` | `SPRPAT` | `$00` | Pattern table base, ×`$800` *(= `$06`)* |
| `$22` | `SPRCOUNT` | `$20` | Active sprite slots, 0–64. Slots at or above this index are not evaluated. |
| `$23` | `SPRCTRL` | `$27` | b0 sprites enable; b1 collision detection enable; b2 `$D0` terminates the sprite list; b3 detailed collision reporting; b5:4 bit depth (00 = 1, 01 = 2, 10 = 4, 11 = 8); b7:6 reserved |
| `$24` | `SPRLIMIT` | `$20` | Maximum sprites drawn per scanline, 1–32 |
| `$25` | `SPRPAL` | `$00` | b3:0 palette group high bits for sprites — `LxPAL`'s equivalent |
| `$26`–`$27` | — | — | Reserved |

Sprite size and magnification live in `MODE1` b1:b0, as on the TMS9918. They are
not duplicated here. While `VMODE` = `$0` the bit-depth field is ignored and
sprites render with TMS9918 semantics (§9).

`SPRCTRL` resets to `$27` — enabled, collision on, `$D0` terminator active,
detailed collision off, 4bpp.

`SPRLIMIT` exists both as a performance valve and as a way to deliberately
reproduce a low per-line limit for period-correct flicker, should anyone want it.

### $28–$7F — Reserved

Write 0. Reserved for a second sprite bank, raster effect tables, additional
layers, or a blitter (§19).

---

6. Status registers
-------------------

Reading a status port returns the register named by that port's `STATSEL`.
Eight are defined.

| # | Name | Contents |
|---|---|---|
| 0 | `STAT0` | b7 **F** — the active picture has ended this frame, set **regardless of `IRQEN`**; b6 **OVF** — sprite overflow occurred; b5 **COL** — sprite collision occurred; b4:0 low five bits of the first dropped sprite's index |
| 1 | `STAT1` | b0 vblank, b1 scanline compare, b2 overflow, b3 collision — which **enabled** sources are latched; b7:4 reserved |
| 2 | `STAT2` | Current display line, low 8 bits. Lines 256–262 alias to 0–6; `STAT3` b0 disambiguates. |
| 3 | `STAT3` | b0 vertical blanking active; b1 horizontal blanking active; b7:2 reserved |
| 4 | `STAT4` | **`$AC`** — identification byte |
| 5 | `STAT5` | Firmware version, BCD: high nibble major, low nibble minor |
| 6 | `STAT6` | Capabilities: b0 two layers, b1 8bpp layer, b2 sprite flip, b3 hardware scroll, b4 scanline IRQ, b5 64 KB VRAM, b7:6 reserved |
| 7 | `STAT7` | Full index (0–63) of the first sprite dropped on the last overflowing line |
| 8–15 | `STAT8`–`STAT15` | Collision bitmap — bit *n* of `STAT(8 + s/8)` is set if sprite *s* collided this frame. Only maintained while `SPRCTRL` b3 is set. |

`STAT0` keeps the TMS9918's shape exactly, including the five-bit sprite field,
so that code testing `bit VC_STATUS` / `bmi` for vblank still works.

**b7 is a flag, not an interrupt.** It is the TMS9918's F bit: it sets when the
active picture ends, whether or not `IRQEN` b0 is on, because `IRQEN` governs the
`/INT` pin and nothing else. Polling `STAT0` for vertical blank with interrupts
disabled is a common idiom and it has to work. The other interrupt sources do not
appear in b7 at all — read `STAT1` for those.

**Acknowledgement.** Reading either `STAT0` or `STAT1` clears all latched
interrupt flags and releases `/INT`. Read `STAT1` when the handler needs to know
which source fired; read `STAT0` otherwise. Reading both in one handler loses
information — the second read returns zeros.

Reading any status register resets that port's command flip-flop.

---

7. Video RAM
------------

**64 KB**, flat, addressed as a 16-bit space. No banking is visible to software
beyond `VBANK` supplying the top two address bits.

64 KB is four times the TMS9918 and takes a 1 MHz 65C02 a quarter of a second to
fill end to end. More would be memory the CPU cannot realistically populate.
`VBANK` is specified as a full byte so a later revision can grow to 4 MB without
changing the command protocol.

Every structure is placed by a base register. This is the **recommended** layout
for graphics mode, not a requirement:

```
  $0000 - $03BF   Layer 0 name table            960 B    L0NAME = $00
  $0400 - $07BF   Layer 0 attribute table       960 B    L0ATTR = $01
  $0800 - $0BBF   Layer 1 name table            960 B    L1NAME = $02
  $0C00 - $0FBF   Layer 1 attribute table       960 B    L1ATTR = $03
  $1000 - $10FF   Sprite attribute table        256 B    SPRATTR = $20
  $1100 - $3FFF   free                           12 KB
  $4000 - $7FFF   Layer 0 pattern table          16 KB   L0PAT = $08
  $8000 - $BFFF   Layer 1 pattern table          16 KB   L1PAT = $10
  $C000 - $DFFF   Sprite pattern table            8 KB   SPRPAT = $18
  $E000 - $FBFF   free                            7 KB
  $FC00 - $FDFF   Palette                       512 B    PALBASE = $3F
  $FE00 - $FFFF   free                          512 B
```

Text mode after reset keeps today's layout, which the existing Kernal already
programs:

```
  $0000 - $03BF   Layer 0 name table            960 B    L0NAME = $00
  $0800 - $0FFF   Layer 0 pattern table           2 KB   L0PAT = $01
  $FC00 - $FDFF   Palette                       512 B
```

Alignment rules:

| Structure | Base register granularity | Size |
|---|---|---|
| Name table | 1 KB | 960 B |
| Attribute table | 1 KB | 960 B |
| Pattern table | 2 KB | 2 KB (text), up to 16 KB (graphics) |
| Sprite attribute table | 128 B | 256 B |
| Sprite pattern table | 2 KB | up to 8 KB |
| Palette | 1 KB | 512 B |

The name table is 960 bytes in **both** Text and Graphics — 40 × 24 and 32 × 30
are the same count — so a swap between them needs no reallocation, and Graphics
I's 768 bytes fit in the same 1 KB block. Full mode is the exception at 1200
bytes, which spans two 1 KB blocks; budget 2 KB for each of its tables. The
attribute table, when per-cell, always has exactly the same geometry as the name
table it belongs to.

---

8. The tile engine
------------------

Both layers, in every mode, are the same engine: a **name table** mapping screen
cells to pattern indices, a **pattern table** of pixel data, and a **source of
color** for each cell. Mode selection (§9) chooses the geometry; `LxCTRL`
chooses everything else, per layer.

### Bit depth — `LxCTRL` b1:b0

| b1:b0 | Depth | Bytes per 8×8 tile | Colors per cell | 512 tiles | Upload @ 1 MHz |
|:--:|:--:|--:|:--:|--:|--:|
| 00 | 1bpp | 8 | 2, independent fg and bg | 4 KB | 16 ms |
| 01 | 2bpp | 16 | 4 | 8 KB | 33 ms |
| 10 | 4bpp | 32 | 16 | 16 KB | 66 ms |
| 11 | 8bpp | 64 | 256 | 16 KB *(256 tiles)* | 66 ms |

Patterns are stored row by row from the top, pixels left to right, the most
significant bit or nibble leftmost — 1, 2, 4 or 8 bytes per row.

In text mode the cell is 6 pixels wide: the leftmost 6 pixels of each row are
drawn and the rest ignored. At 1bpp that is the top 6 bits of one byte, which is
the TMS9918 text format exactly, and the format of the character set in AC6502
ROM at `$B800`.

The low depths are not a consolation prize. VRAM is not the binding constraint
on this machine — **upload time is** — and a 1bpp tile set costs a quarter of
what a 4bpp one costs to get into the VDP. A 512-tile 1bpp set is 4 KB and 16 ms
at 1 MHz; the same set at 4bpp is 16 KB and 66 ms, four frames' worth. 8bpp is
the odd one out: it costs the most VRAM but is the *cheapest to render*, because
there is no unpacking to do.

### Attribute source — `LxCTRL` b3:b2

Where the color byte for a cell comes from:

| b3:b2 | Source | Address of the color byte | Bytes |
|:--:|---|---|--:|
| 00 | Per cell | `LxATTR + cell` | 960 (or 768) |
| 01 | Per pattern group | `LxATTR + (pattern >> 3)` | 32 |
| 10 | Per pattern row | `LxATTR + (pattern × 8) + row` | 2 KB |
| 11 | None | *no fetch* — see below | 0 |

**Per cell** is the general case, and the only one in which two cells sharing a
pattern can have different colors. **Per pattern group** is the TMS9918's
Graphics I color table: one byte per eight consecutive patterns, 32 bytes for
the whole screen. **Per pattern row** is Graphics II's scheme: one color byte per
pattern row, so an 8×8 pattern carries eight fg/bg pairs down its height.

Sources 01 and 10 are only meaningful at 1bpp. Per-pattern-group is what makes
Graphics I fall out of the engine rather than needing a mode of its own.
Per-pattern-row is the one genuinely useful thing Graphics II could do that
nothing else could — eight color pairs down the height of a pattern — kept here
as a feature of the engine even though legacy Graphics II itself is not
supported (§19).

**None** means no attribute fetch at all. At 1bpp the whole layer is colored by
`COLOR` (register `$07`) — which is what today's text mode does, and why the
existing Kernal needs no changes. At 2, 4 and 8bpp the layer uses sub-palette 0
of the group selected by `LxPAL`, with no flipping, no priority and no ninth
pattern-index bit.

### The color byte

**At 1bpp** it is a pair of nibbles, foreground in b7:4 and background in b3:0,
each indexing the 16-entry group selected by `LxPAL`:

```
  b7 b6 b5 b4 | b3 b2 b1 b0
  foreground  | background
```

This is the TMS9918 convention unchanged, which is why `VideoSetColor` still
means what it means and a Graphics I color table still colors what it colored.

**At 2, 4 and 8bpp** it is an attribute byte:

| Bit | 2bpp and 4bpp | 8bpp |
|:--:|---|---|
| b3:0 | sub-palette | *ignored* |
| b4 | flip horizontally | flip horizontally |
| b5 | flip vertically | flip vertically |
| b6 | priority — draw in front of sprites | same |
| b7 | pattern index bit 8 → 512 tiles | *ignored* |

### Palette mapping

A **palette group** is `2^bpp` consecutive palette entries. The group number is
`LxPAL × 16 + subpal`, and the palette index of a pixel is
`(group × 2^bpp + value) & $FF`. In practice:

| Depth | Group size | Groups available | Palette index of a pixel |
|:--:|--:|--:|---|
| 1bpp | — | — | `LxPAL × 16 + nibble` — fg or bg, as a 4-bit index |
| 2bpp | 4 | 64 | `(LxPAL & 3) × 64 + subpal × 4 + value` |
| 4bpp | 16 | 16 | `subpal × 16 + value` |
| 8bpp | 256 | 1 | `value` |

At 4bpp the sixteen groups already cover the whole palette, so `LxPAL` only
matters when the attribute source is "none". At 2bpp its low two bits pick which
quarter of the palette the sixty-four groups are drawn from, so all 256 entries
stay reachable. At 1bpp it picks which sixteen colors the fg/bg nibbles name.

### Transparency

A pixel whose value is 0 within its group is transparent, unless `LxCTRL` b5
(index 0 opaque) is set. At 1bpp this applies to **both** nibbles — a foreground
nibble of 0 is as transparent as a background nibble of 0, exactly as TMS9918
color 0 is.

Setting index 0 opaque gives a layer the full `2^bpp` colors and makes it
occlude everything behind it. Layer 0 resets that way; layer 1 does not.

---

9. Display modes
----------------

`VMODE` (register `$0D`) b3:0 selects the geometry. Everything else about a
layer comes from `LxCTRL` (§8).

| `VMODE` | Mode | Cells | Cell | Pixels | Name table | Position in the frame |
|:--:|---|---|:--:|---|--:|---|
| `$0` | **Legacy** | from `M1`/`M2`/`M3` | | | | see below |
| `$1` | **Text** | 40 × 24 | 6 × 8 | 240 × 192 | 960 B | x 40–279, y 24–215 |
| `$2` | **Compact** | 32 × 24 | 8 × 8 | 256 × 192 | 768 B | x 32–287, y 24–215 |
| `$3` | **Graphics** | 32 × 30 | 8 × 8 | 256 × 240 | 960 B | x 32–287, y 0–239 |
| `$4` | **Full** | 40 × 30 | 8 × 8 | 320 × 240 | 1200 B | the whole frame |
| `$5`–`$F` | reserved | | | | | |

**Full mode** fills the 320 × 240 frame edge to edge — no border, square cells on
a 4:3 monitor. It is the mode for anything that wants the whole screen: a title
page, a game field with no letterboxing, or a 40 × 30 text display six rows taller
than Text mode and with square characters, by running it at 1bpp with per-cell
attributes.

It costs three small things and nothing else. Its name and attribute tables are
1200 bytes rather than 960, so each occupies two 1 KB blocks instead of one. Its
horizontal scroll needs nine bits (§13). And 320 pixels of layer per line is 25%
more layer work than 256, which takes the estimated per-scanline budget from
about 23% margin to about 17% (§18) — comfortable, but it is the most expensive
mode in the design.

The names describe geometry and nothing else. **Compact** is the TMS9918's
Graphics I grid — which is why a legacy Graphics I program lands there — but it
is not "Graphics I": new software can run that 32 × 24 grid at 4bpp with per-cell
attributes and flipping, and can equally run **Graphics** at 1bpp with a 32-byte
color table if that is what the art wants. Geometry and coloring are orthogonal,
and only the legacy submode pins particular combinations.

Compact exists for software that wants the 192-line height and its top and bottom
borders, or simply wants a smaller name table and a cheaper line. Graphics is the
one most new software should reach for.

`VMODE` `$1` and `$3` both use a 960-byte name table, so a mode change between
them needs no reallocation.

### The legacy submode

`VMODE` = `$0`, the reset value, hands mode selection to the TMS9918's `M1`,
`M2` and `M3` bits — `MODE1` b4, `MODE1` b3 and `MODE0` b1 — and pins layer 0's
bit depth and attribute source to match. `L0CTRL`'s depth and attribute fields
are ignored while this is in effect; its enable and opacity bits still apply, and
layer 1 is unaffected.

| `M1` | `M2` | `M3` | TMS9918 mode | Geometry | L0 depth | L0 attribute source |
|:--:|:--:|:--:|---|---|:--:|---|
| 1 | × | × | Text | 40 × 24 | 1bpp | none — `COLOR` colors the screen |
| 0 | 0 | 0 | Graphics I | 32 × 24 | 1bpp | per pattern group, base = `L0ATTR` × `$40` |
| 0 | 0 | 1 | Graphics II | 32 × 24 | 1bpp | *not supported* — falls back to Graphics I |
| 0 | 1 | × | Multicolor | 32 × 24 | 1bpp | *not supported* — falls back to Graphics I |

One register reinterpretation applies, and only here: **`L0ATTR` is scaled by
`$40`, not `$400`**, so that a Graphics I program's 32-byte color table lands
where it wrote it.

Graphics II and Multicolor are not implemented. A program selecting either gets
Graphics I geometry and coloring and will draw the wrong thing — but it will draw
*something* rather than hanging the raster. There is no capability bit for them;
the detection probe in §16 is the signal, since a program that finds this VDP
rather than a TMS9918 already knows it should be using `VMODE` instead. §19 sets
out why Graphics II was cut.

Sprites in the legacy submode take TMS9918 semantics regardless of `SPRCTRL`:
1 bit per pixel, 8 bytes per 8 × 8 pattern, attribute b3:0 a direct palette index
0–15 rather than a sub-palette, and attribute b7 the early-clock bit, shifting
the sprite 32 pixels left rather than 256.

### What this buys

Text mode and Graphics I both run exactly as they do today, which means the
unmodified BIOS boots (§17) and `graphics-1.asm` still draws what it drew.
Neither cost the engine anything: Text is a geometry plus "no attribute fetch",
and Graphics I is the Compact geometry plus one attribute-source value. The compatibility
is a consequence of the design rather than a layer bolted onto it, which is why
it is worth having — and why Graphics II, which *would* have been a bolted-on
layer, is not here.

### Recommended starting point for new software

```asm
  lda #$03                      ; Graphics: 32x30 of 8x8
  sta VC_REG
  lda #($80 | $0D)              ; register $0D = VMODE
  sta VC_REG

  lda #%00110010                ; 4bpp, per-cell attributes, enabled, index 0 opaque
  sta VC_REG
  lda #($80 | $15)              ; register $15 = L0CTRL
  sta VC_REG
```

---

10. Sprites
-----------

64 sprite slots, up to 32 drawn per scanline, at 1, 2, 4 or 8 bits per pixel.

**Attribute table** — 4 bytes per slot, up to 64 slots = 256 bytes. Only slots
below `SPRCOUNT` are evaluated.

| Offset | Contents |
|---|---|
| +0 | **Y** — top edge, as a display line (§3). 0–239 position the sprite down the picture; 241–255 mean −15…−1, entering from the top; 240 is the first row below a 240-line picture. In the 192-line modes anything from 192 up is below the picture. |
| +1 | **X** — left edge, bits 7:0 |
| +2 | **Pattern** — index into the sprite pattern table |
| +3 | **Attributes** |

Attribute byte:

| Bit | Meaning |
|---|---|
| b3:0 | Sub-palette, 0–15 |
| b4 | Flip horizontally |
| b5 | Flip vertically |
| b6 | Priority — 0: behind layer 1, 1: in front of layer 1 |
| b7 | X bit 8 — see below |

**Horizontal position.** X is a 9-bit value: bits 7:0 from attribute offset +1,
bit 8 from attribute b7. Values **0–383** are screen coordinates, covering the
widest mode with room to spare; values **384–511** mean −128…−1, which is how a
sprite enters from the left. One rule, every mode, no reinterpretation — −128 is
four times the width of a magnified 16 × 16 sprite.

**Ending the list.** `SPRCOUNT` always bounds the table, which makes evaluation
a fixed cost. In addition, while `SPRCTRL` b2 is set — the reset state, and
forced in the legacy submode — a slot whose Y is `$D0` ends the list there, as
on the TMS9918.

Y = `$D0` is row 208, which is off the bottom of a 192-line legacy screen but
**on** a 240-line Graphics screen. Software using the full height should clear
`SPRCTRL` b2 and rely on `SPRCOUNT`; software that wants the familiar idiom can
leave it alone. Keeping both costs one bit and one comparison.

**Patterns** — depth from `SPRCTRL` b5:4, value 0 always transparent.

| Size | 1bpp | 2bpp | 4bpp | 8bpp | Layout |
|---|--:|--:|--:|--:|---|
| 8 × 8 | 8 B | 16 B | 32 B | 64 B | one row at a time, MSB/high nibble leftmost |
| 16 × 16 | 32 B | 64 B | 128 B | 256 B | four 8 × 8 quadrants in TMS9918 order — top-left, bottom-left, top-right, bottom-right; pattern index bits 1:0 ignored |

Sprite palette mapping follows §8 with `SPRPAL` in `LxPAL`'s place: the palette
index of a sprite pixel is `((SPRPAL × 16 + subpal) × 2^bpp + value) & $FF`.

Size is global, from `MODE1` b1. `MODE1` b0 magnifies every sprite ×2, giving
16 × 16 or 32 × 32 on screen. Flipping applies to the whole sprite, quadrant
arrangement included.

**Per-line limit.** Sprites are evaluated in table order. When more than
`SPRLIMIT` sprites cover a line, the excess — highest indices first — is dropped
for that line only. `STAT0` b6 is set, `STAT0` b4:0 and `STAT7` record the first
dropped index. Sprites do not flicker; if you want flicker you must implement it
yourself.

**Priority among sprites.** Lower table index wins, as on the TMS9918.

**Collision.** When `SPRCTRL` b1 is set — the reset state — any two
non-transparent sprite pixels landing on the same screen pixel set `STAT0` b5
and, if enabled, raise an interrupt. This is the TMS9918's flag, with the
TMS9918's limitation: it says *something* collided, not what.

**Detailed collision.** Setting `SPRCTRL` b3 additionally records **which**
sprites were involved, as a 64-bit map across `STAT8`–`STAT15`. Both members of
every colliding pair are marked. The map is sticky for the frame and clears when
`STAT0` or `STAT1` is read.

This is opt-in because it is the one collision feature with a real cost: the
sprite line buffer has to carry an owner index per pixel alongside the color,
which is roughly 500 extra cycles on a worst-case line (§18). Leave b3 clear and
you pay nothing; the plain sticky bit needs no owner tracking at all.

Collision is tested before priority resolution, so a sprite hidden behind a layer
still collides.

---

11. Palette
-----------

512 bytes at `PALBASE`, 256 entries of 12-bit RGB.

```
  entry n + 0:  %0000RRRR
  entry n + 1:  %GGGGBBBB
```

How the palette is divided into groups depends on bit depth — §8 has the rule
and the table. At 4bpp it is 16 groups of 16; at 2bpp, 64 groups of 4; at 8bpp
the division does not apply. In every case the entry at value 0 within a group is
the transparency slot, and its stored color goes unused by anything except a
layer with `LxCTRL` b5 set.

**The backdrop** — the color behind every layer and the border outside the active
area — is palette entry `(L0PAL × 16) + (COLOR & $0F)`.

**Writes take effect immediately.** The VDP holds a cache of the palette as
expanded RGB pairs and snoops VRAM writes that fall inside the 512-byte window
at `PALBASE`, updating the cache on the spot. There is no dirty flag to set and
no reload command. Moving `PALBASE` re-reads the whole window.

**Default palette.** Reset writes a default palette into VRAM at `$FC00` and
loads the cache from it. It is organized as sixteen rows of sixteen — so that a
4bpp sub-palette selector picks a row — after the Commander X16's arrangement:

| Row | Contents |
|:--:|---|
| 0 | The sixteen TMS9918 colors the ACE shows today, index 0 transparent |
| 1 | Grayscale ramp, `$000` to `$FFF` |
| 2–13 | Twelve hues at 30° intervals — red, orange, yellow, chartreuse, green, spring green, cyan, azure, blue, violet, magenta, rose |
| 14 | Brown / sepia |
| 15 | Blue-grey |

Each hue row is a sixteen-step ramp, dark at index 0, the pure hue at index 7,
tinted toward white at index 15 — so a 4bpp tile that selects one row gets a
complete shading ramp for that hue, and picking a row is picking a color scheme.

Values, as 12-bit `$RGB`:

```
  row   0    1    2    3    4    5    6    7    8    9    A    B    C    D    E    F
  ---  ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ---- ----
   0   000  000  2C4  6D7  55E  77F  C55  4EE  F55  F77  CB5  DC8  2A4  C5B  CCC  FFF
   1   000  111  222  333  444  555  666  777  888  999  AAA  BBB  CCC  DDD  EEE  FFF
   2   200  400  600  800  900  B00  D00  F00  F22  F33  F55  F77  F88  FAA  FCC  FDD
   3   210  420  630  840  950  B60  D70  F80  F92  FA3  FA5  FB7  FC8  FDA  FDC  FED
   4   220  440  660  880  990  BB0  DD0  FF0  FF2  FF3  FF5  FF7  FF8  FFA  FFC  FFD
   5   120  240  360  480  590  6B0  7D0  8F0  9F2  AF3  AF5  BF7  CF8  DFA  DFC  EFD
   6   020  040  060  080  090  0B0  0D0  0F0  2F2  3F3  5F5  7F7  8F8  AFA  CFC  DFD
   7   021  042  063  084  095  0B6  0D7  0F8  2F9  3FA  5FA  7FB  8FC  AFD  CFD  DFE
   8   022  044  066  088  099  0BB  0DD  0FF  2FF  3FF  5FF  7FF  8FF  AFF  CFF  DFF
   9   012  024  036  048  059  06B  07D  08F  29F  3AF  5AF  7BF  8CF  ADF  CDF  DEF
   A   002  004  006  008  009  00B  00D  00F  22F  33F  55F  77F  88F  AAF  CCF  DDF
   B   102  204  306  408  509  60B  70D  80F  92F  A3F  A5F  B7F  C8F  DAF  DCF  EDF
   C   202  404  606  808  909  B0B  D0D  F0F  F2F  F3F  F5F  F7F  F8F  FAF  FCF  FDF
   D   201  402  603  804  905  B06  D07  F08  F29  F3A  F5A  F7B  F8C  FAD  FCD  FDE
   E   110  321  431  642  742  852  A63  B73  B84  C96  CA7  DB8  DBA  ECB  EDC  FEE
   F   112  223  334  446  468  579  68A  79C  8AC  9AD  ABD  BCD  BCE  CDE  DEE  EEF
```

Row 0 is taken from the values the AC6502 documentation publishes for the
TMS9918's sixteen colors, quantized to 4 bits per channel — so the same nibble
means the same color it does today, and `COLOR = $1F` is black on white with no
software change.

Rows 2–15 are generated, not hand-picked, so they can be regenerated at a
different depth or ramp shape:

```python
def ramp(base):                         # base = pure hue, 4 bits per channel
    out = []
    for n in range(16):
        if n <= 7:  out.append(tuple(round(b * (n + 1) / 8) for b in base))
        else:       out.append(tuple(b + round((15 - b) * (n - 7) / 9) for b in base))
    return out
```

The `/ 9` in the upper half is deliberate: `/ 8` would end every ramp at pure
white and waste fourteen entries on the same color.

> Reset clobbers `$FC00`–`$FDFF`. Nothing in the reset-time memory map lives
> there.

---

12. Compositing and priority
----------------------------

Each pixel gathers candidates from the backdrop, both layers and the sprites.
Each candidate carries a priority level; the highest non-transparent candidate
wins.

| Level | Source |
|:--:|---|
| 6 | Layer 1 tile with attribute b6 set |
| 5 | Sprite with attribute b6 set |
| 4 | Layer 0 tile with attribute b6 set |
| 3 | Layer 1 tile, normal |
| 2 | Sprite with attribute b6 clear |
| 1 | Layer 0 tile, normal |
| 0 | Backdrop |

The default arrangement — no priority bits set anywhere — is backdrop, layer 0,
sprites, layer 1, back to front. Setting a layer 0 tile's priority bit lifts that
tile above ordinary sprites, which is how a sprite walks behind scenery. Setting
a sprite's priority bit lifts it above layer 1, which is how a cursor or a health
bar stays on top of everything.

A disabled layer contributes nothing. A layer whose `LxCTRL` b5 (index 0 opaque)
is set never contributes a transparent pixel, so it occludes everything below
it.

Collision detection considers only sprite-against-sprite overlap, before
priority resolution. A sprite hidden behind a layer still collides.

---

13. Scrolling
-------------

`LxSCRX` and `LxSCRY` offset each layer's view into its map, in pixels,
independently, with wrapping. Scrolling costs nothing per frame — it is two
register writes.

| Mode | Map size | X wraps at | Y wraps at |
|---|---|---|---|
| Text | 240 × 192 | 240 | 192 |
| Compact | 256 × 192 | 256 | 192 |
| Graphics | 256 × 240 | 256 | 240 |
| Full | 320 × 240 | 320 | 240 |

`LxSCRX` is 9 bits — the register plus `LxCTRL` b6 — because Full mode is 320
pixels wide and an 8-bit register could only reach 255 of them. Every other mode
leaves b6 clear and never thinks about it.

The map is the same size as the screen, so the map wraps around onto itself. To
scroll through content larger than one screen, write the incoming row or column
into the cells the scroll is about to expose — the standard technique, and at
one row of 32 bytes per 8 pixels of travel it is well within a 1 MHz budget.

The most immediate use is text. The Kernal's `VideoScroll` currently moves 920
bytes through a RAM buffer, 23 rows at a time, at roughly 30,000 cycles — about
30 ms at 1 MHz, nearly two frames. Hardware scrolling replaces it with one
register write plus 40 stores to clear the newly exposed row: under 400 cycles.
See §17.

**Granularity is per pixel, in both axes, in every mode** — including text.
There is no cost to this: the renderer does the same arithmetic either way, and
software that only wants whole-row scrolling simply writes multiples of 8. The
Kernal should do exactly that, keeping a row origin and writing `row × 8`, and
can then ignore that the hardware is finer than it needs. Smooth scrolling is
there for anything that wants it — a credits roll, a menu, a message line —
without the Kernal having to know.

Scroll values are sampled per scanline, so writing `LxSCRX` from a scanline
interrupt bends the layer line by line.

---

14. Interrupts
--------------

`/INT` is asserted while any enabled and latched source is pending, and released
when acknowledged. It is level-driven and shares the AC6502 IRQ line, so a
handler must chain to the Kernal's as described in the AC6502 interrupt
documentation.

| Source | `IRQEN` bit | Latched in `STAT1` | Fires |
|---|:--:|:--:|---|
| Vertical blank | b0 | b0 | End of the active picture — display line 192 in Text and Compact, 240 in Graphics and Full |
| Scanline compare | b1 | b1 | Start of the line matching `IRQLINE` |
| Sprite overflow | b2 | b2 | First line on which sprites are dropped |
| Sprite collision | b3 | b3 | First colliding pixel of the frame |

`MODE1` b5 is an alias for `IRQEN` b0, so legacy code that enables the vblank
interrupt through register 1 still works. `STAT0` b7 sets at the end of the
picture regardless of `IRQEN`, so software can poll for vertical blank without
enabling an interrupt at all (§6).

**A source latches only while it is enabled.** `STAT1` holds the sources that
fired *and* were enabled in `IRQEN` at the moment they did, so a handler reading
it sees its own interrupts and nothing else; a disabled source leaves no trace
there. `/INT` is asserted exactly while `STAT1` is non-zero. The flags in `STAT0`
are not interrupts and do not follow this rule — b7, b6 and b5 set whether or not
anything is enabled, which is what makes polling work (§6).

Acknowledge by reading `STAT0` or `STAT1` (§6). All latched flags clear on either
read.

### The vertical blanking window

Vertical blank fires when the **picture** ends, not when the frame does, so the
window between the flag and the next visible line is everything that is not
active display — bottom border, blanking and top border together:

| Mode | Active | Window | Time | Cycles @ 1 MHz | @ 2 MHz |
|---|--:|--:|--:|--:|--:|
| Text, Compact | 192 lines | 70.5 lines | 4.48 ms | ~4,480 | ~8,960 |
| Graphics, Full | 240 lines | 22.5 lines | 1.43 ms | ~1,430 | ~2,860 |

The 192-line figure is the TMS9918's, to the line — which is the point. Software
written against a real VDP gets the window it was written for.

**The 240-line modes give up two thirds of it.** That is the true cost of a
full-height picture, and it is easy to miss: Graphics and Full have no borders to
hide work in, so roughly 1,400 cycles is all the tear-free time there is. Filling
a 960-byte name table takes about 8,600. Two ways out, both standard:

- **Update behind the raster.** Set `IRQLINE` partway down the picture and, in
  the handler, rewrite the rows the beam has already passed. The window becomes
  as large as the part of the screen you are willing to update late.
- **Accept the tear** where it does not show — a distant background layer, or a
  cell the player is not looking at.

Nothing here is new; it is the same arithmetic every full-screen 8-bit game has
done. It is written down because the mode table makes 240 lines look free.

`IRQLINE` is eight bits and display lines run to 262, so lines 256–262 — the last
seven, deep inside the top border — cannot be selected. Nothing useful happens
there.

**Scanline interrupts are expensive on this CPU.** One compare register means one
interrupt per frame unless the handler reprograms `IRQLINE` on its way out. Entry
and exit alone cost roughly 50 cycles before the handler does anything useful;
at 1 MHz, an interrupt every eight lines costs about 10% of the machine on
overhead alone. Reserve them for a handful of raster splits — a
status bar, a palette change, a scroll seam — rather than a per-line effect.

---

15. Reset state
---------------

After `RST`:

- All registers take the reset values in §5. `VMODE` = `$0`, so the legacy
  submode is in effect and `M1`/`M2`/`M3` select the mode — which, with
  `MODE0` = `MODE1` = `$00`, is Graphics I. Display **off**, interrupts disabled,
  layer 0 enabled at 1bpp with no attribute table, layer 1 disabled, sprites
  enabled with `SPRCOUNT = 32` and the `$D0` terminator active.
- VRAM contents are **undefined** except `$FC00`–`$FDFF`, which holds the default
  palette.
- The palette cache is loaded from the default palette.
- Both port pairs: pointer 0, direction read, flip-flop cleared, `STATSEL` 0.
- `/INT` released, all interrupt flags clear.

The existing Kernal's `InitVideo` — eight register writes of
`$00 $D0 $00 $00 $01 $00 $00 $1F` followed by a 2 KB character set upload — takes
this to a working 40 × 24 black-on-white text screen with no changes.

---

16. Detection
-------------

```asm
; Returns carry set if a 6502-PICOVDP is fitted
DetectVdp:
  lda #$04                      ; select STAT4
  sta VC_REG
  lda #$8F                      ; register $0F | $80
  sta VC_REG
  lda VC_STATUS
  cmp #$AC
  beq @found
  clc
  rts
@found:
  lda #$00                      ; put STAT0 back
  sta VC_REG
  lda #$8F
  sta VC_REG
  sec
  rts
```

> On a real TMS9918 only three register bits are decoded, so `$8F` writes
> register 7 — the payload `$04` becomes transparent-on-dark-blue. The probe
> reports absence correctly but leaves the screen colors changed. Run it before
> `VideoSetColor`, or save and restore register 7 around it.

`STAT5` gives the firmware version and `STAT6` the capability bits, for software
that wants to degrade gracefully across future firmware.

---

17. BIOS impact
---------------

The Kernal touches the VDP in 32 places, all in `Kernal.asm`. BASIC, the Monitor
and Wozmon touch it nowhere.

### Works unmodified

| Routine | Why |
|---|---|
| `InitVideo` | `$D0` to register 1 selects text mode; registers 2 and 4 place the name and pattern tables where this VDP expects them |
| `InitCharacters` | Text patterns are still 1bpp, 8 bytes per character, 2 KB at `$0800` |
| `VideoClear` | 960-byte name table at `$0000` |
| `VideoSetCursor`, `VideoGetCursor` | Address arithmetic is unchanged: row × 40 + column |
| `VideoPutChar`, `VideoChroutRaw` | Command protocol unchanged |
| `VideoSetColor` | `COLOR` register semantics unchanged; the default palette makes the same nibble values the same colors |
| `VideoScroll` | Works, but see below |

That is the whole text path. **No BIOS change is required to boot.**

### Worth changing

**`VideoScroll`.** The current implementation costs ~30,000 cycles per line
scrolled — 23 rows × (40 reads + 40 writes + address setup), about 30 ms at
1 MHz. Replacing it with a hardware scroll:

```asm
; Scroll up one text line
  lda VID_SCROLL_Y
  clc
  adc #8
  cmp #192
  bcc @noWrap
  sbc #192
@noWrap:
  sta VID_SCROLL_Y
  sta VC_REG
  lda #($80 | $14)              ; register $14 = L0SCRY
  sta VC_REG
  ; then clear the row that just appeared at the bottom
```

Under 400 cycles including the row clear — roughly 75× faster. The cost is that
the Kernal must track a scroll origin and fold it into the row × 40 + column
address calculation, which is one addition and a modulo-960 wrap.

**`sei`/`cli` around VDP work.** No longer needed if interrupt handlers use port B
(`$9C02`/`$9C03`) and foreground code uses port A. Worth adopting as a convention
across the Kernal and in documentation.

**New Kernal entry points to consider.** Nothing here is required, but the
following would make the new capabilities reachable from BASIC and from ordinary
assembly without a programmer having to drive registers by hand: set mode, set a
palette entry, set layer scroll, load a tile set, place a sprite, enable a layer.

### Breaks

| What | Effect |
|---|---|
| Graphics II | Programs using it get Graphics I geometry and will draw garbage. `graphics-2.asm` and the Graphics II part of the documentation's graphics chapter need rewriting. |
| Multicolor mode | Same — Graphics I geometry, wrong picture. |
| 16 KB VRAM wrap | A pointer running off `$3FFF` now continues into `$4000` instead of wrapping to `$0000`. |

Text mode and Graphics I keep working, so the BIOS boots untouched and
`graphics-1.asm` still runs. Both should gain a note that they are legacy modes
and that Graphics and Full supersede them.

The natural replacement for `graphics-2.asm` is Graphics mode at 1bpp with the
per-pattern-row attribute source — the same technique Graphics II used for its
coloring, without the three-bank name indexing. It will not be a line-for-line
port, because it no longer needs to be: 512 tiles with 16 colors each is a
different proposition from 768 monochrome ones.

Sprites keep TMS9918 semantics — one color, `$D0` terminator, early-clock bit —
for as long as the program stays in the legacy submode, which it does by never
writing `VMODE`.

The emulator's `src/core/IO/Video.ts` needs the same treatment as the firmware,
and is the cheaper place to prove the register model before writing any ARM.

---

18. Implementation notes
------------------------

### Firmware shape

The PICO9918 structure carries over: core 1 drives VGA timing and DMA, core 0
renders one scanline at a time into a 320-byte palette-index buffer and expands
it through a 256-entry `uint32` lookup (one source pixel → two output pixels) into
the RGB line buffer. Bus accesses arrive as PIO interrupts on core 0.

What changes:

- `vrEmuTms9918` is not used. The renderer is new.
- `tmsRead.pio`: `in pins, 1` becomes `in pins, 2` to capture MODE1 alongside
  MODE. The read handler gains a port-B branch.
- `tmsWrite` needs no PIO change — MODE1 already arrives in bit 31 of the FIFO
  word. Only the handler changes.
- Two sets of pointer/prefetch/flip-flop state instead of one.
- VRAM grows from 16 KB to 64 KB. Comfortable in 520 KB.

### Suggested unpacking tables

Pre-expand, per depth, a lookup from one pattern byte plus a group number to
output bytes, so the palette group is applied for free during unpacking:

| Depth | Table | Size | Per tile row |
|:--:|---|--:|---|
| 1bpp | 256 byte-values × fg/bg pair → 8 bytes | build per cell, or 2 KB per pair | one load, two 32-bit stores |
| 2bpp | 256 byte-values × 64 groups → 4 bytes | 64 KB, or 1 KB and add the group | two loads, two 32-bit stores |
| 4bpp | 256 byte-values × 16 groups → 2 bytes | 8 KB | one 32-bit load, four `ldrb`/`ldrh`/`strh` |
| 8bpp | none | — | two 32-bit loads, two stores |

The 4bpp table at 8 KB is the one that matters and the one to build first — about
2 cycles per pixel with the sub-palette folded in.

### Estimated per-scanline budget

At 302.4 MHz the line period is 31.78 µs ≈ **9,600 cycles**. These are estimates
from instruction counts, not measurements:

| Work | Cycles |
|---|---:|
| Layer 0, 256 px, 4bpp | ~800 |
| Layer 1, 256 px, 4bpp with transparency merge | ~1,600 |
| Sprite evaluation, 64 slots | ~500 |
| Sprite composite, 32 × 16 px worst case | ~2,600 |
| Palette expansion, 320 px | ~1,300 |
| Bus interrupt service, worst case at 2 MHz | ~600 |
| **Total** | **~7,400** |
| *plus* detailed collision (`SPRCTRL` b3), when enabled | *~500* |

About 23% margin at 302.4 MHz, 34% at 352 MHz, before detailed collision. The
worst case assumes 32 magnified 16 × 16 sprites all on one line with both layers
active, which is not a typical line.

**Full mode costs about 600 cycles more** — 320 pixels of layer per line instead
of 256, across two layers — taking the margin to roughly 17% at 302.4 MHz and
29% at 352 MHz. It is the mode to time first once the renderer exists, and the
reason `SPRLIMIT` is adjustable.

Bit depth moves this number in the direction you would not guess: **8bpp is the
cheapest** to render — one byte in, one byte out, no unpacking — and 1bpp the
next cheapest, being one load per eight pixels plus a two-entry lookup. 4bpp is
the most expensive per pixel. Depth costs VRAM and upload time, not render time.

These numbers want validating early — a spike that renders two layers and 32
sprites into a dummy buffer, timed with `time_us_32` the way the current firmware
times `vrEmuTms9918ScanLine`, before any of the register interface is built.

### Build order

1. Register model and VRAM in the emulator (`Video.ts`) — cheap to iterate.
2. Scanline renderer spike on the RP2350, timed, no bus interface.
3. Bus interface: four ports, two pointer sets, PIO change.
4. Text mode via the legacy submode, and boot the unmodified BIOS.
5. `VMODE`, the remaining geometries, and the attribute sources — legacy
   Graphics I falls out here, and `graphics-1.asm` becomes the regression test.
6. Bit depths 2, 4 and 8; layer 1; scrolling.
7. Sprites.
8. Interrupts.
9. Kernal changes: hardware scroll, port B in the IRQ handler, new entry points.

Step 4 is the milestone worth reaching first: an unmodified BIOS booting to an
`OK` prompt on a VDP with none of the TMS9918 left inside it.

---

19. Deliberate omissions and future space
-----------------------------------------

**No blitter.** A fill/copy engine would be the single largest practical win for
a 1 MHz CPU — clearing a 960-byte table would go from 3.8 ms to nothing — and it
is nearly free to implement, being a `memset` on the Pico. It is left out to keep
this revision a pure VDP. Registers `$28`–`$2F` are the natural home if it is
added later; `STAT6` b6 is reserved to advertise it.

**No per-sprite size.** The attribute byte is full. A fifth attribute byte, or a
second sprite bank with a wider entry, would solve it.

**No Multicolor mode.** Its 4 × 4 blocks come from the pattern table directly
with no name indirection, which is a render path shared with nothing else.
Graphics at 4bpp does everything it did and more.

**No Graphics II.** This one was close, and was in an earlier draft. It works by
splitting the screen into thirds and giving each third its own 2 KB pattern bank,
so that all 768 cells of a 32 × 24 screen can hold a unique 8 × 8 pattern — the
TMS9918's way of faking a bitmap mode. Reproducing it needs a 10-bit pattern
index that exists nowhere else in the design, `L0PAT` and `L0ATTR` read as bit
flags rather than as base addresses, and the R3/R4 name-index masks, which are
fiddly enough to get subtly wrong. The earlier draft skipped the masks and
carried a caveat that a masked program "will render incorrectly" — and a mode
that silently mis-renders in an undocumented corner is worth less than a mode
that is honestly absent.

What it offered that the new engine does not is **768 unique monochrome cells**.
What the new engine offers instead is 512 tiles with 16 colors each, which is a
straight trade up for anything that was using Graphics II as a drawing surface.
Its coloring scheme survives as attribute source `10` (§8), available at any
geometry and any time.

If a true drawing surface is ever wanted, a linear bitmap mode is the better
answer than Graphics II was: 1bpp over 256 × 240 is 7.7 KB and 31 ms to upload,
2bpp is 15 KB and 61 ms. Both are plausible on this CPU; 4bpp at 30 KB and 123 ms
is not.

**No sprite-to-layer collision.** The NES's sprite-0 hit exists to time raster
splits; real scanline interrupts make it unnecessary here.

**No wider text mode.** 6 × 8 cells at 40 columns leave the frame 80 pixels wide
of border. An 8-pixel cell would give 40 × 30 at 320 × 240 with no border at all,
and a 6-pixel cell would give 53 columns. Either is a mode bit away — `MODE0` b1
and `MODE1` b3 are both free and currently ignored.

**No maps larger than the screen.** 32 × 30 name tables keep both modes at 960
bytes and 1 KB alignment, at the cost of making scrolling a write-the-incoming-
edge exercise. A larger map would be a `LxCTRL` bit selecting a 64 × 64 name
table at 4 KB.

**No raster/display list.** Per-scanline register changes must come from the CPU
through scanline interrupts, which are expensive here. A table of
`(line, register, value)` triples executed by the VDP would make raster effects
free.

---

Resolved design questions
-------------------------

Recorded so the reasoning does not have to be reconstructed later.

**Text mode keeps its second layer.** Layer 1 in text mode costs render time
that a single-layer text screen does not need, but it is the same code path as
everywhere else and switching it off is one bit. A status bar or a frame held on
one layer while the other scrolls is worth having available.

**Scrolling is per-pixel in both axes, in every mode.** The renderer does the
same arithmetic either way, so row granularity would be an artificial limit.
The Kernal should write multiples of 8 and ignore that the hardware is finer
(§13).

**Both list terminators are kept.** `SPRCOUNT` always bounds the sprite table —
it makes evaluation a fixed cost and is what new software should use — and
`SPRCTRL` b2 additionally re-enables the TMS9918's `$D0` terminator, which resets
active. Software using the full 240-line height clears it, because `$D0` is row
208 and therefore on screen; legacy software never touches it and never notices.
One bit, one comparison, no compromise either way.

**The default palette is 16 rows of 16** (§11): the TMS9918 colors, a grayscale
ramp, twelve hue ramps and two neutral ramps. Rows 2–15 are generated from a
published formula rather than hand-picked, so the arrangement can be regenerated
if the ramp shape turns out wrong in practice.

**Collision detection is layered.** The TMS9918's single sticky bit stays, at no
cost. Detailed per-sprite reporting — a 64-bit map across `STAT8`–`STAT15` — is
available behind `SPRCTRL` b3, off at reset, because it is the one collision
feature that costs real cycles (roughly 500 on a worst-case line, for the owner
index the sprite line buffer has to carry). Anyone who never enables it pays
nothing, and the compatible behavior is the default.

---

Still open
----------

Nothing structural. The three questions the last draft left open are resolved
above: Graphics II is cut (§19), Full mode is in (§9), and 512 tiles per layer
stay — which commits attribute bit 7 permanently and rules out using it for a
second priority level or a per-tile depth override.

What remains is measurement, not design:

1. **Time Full mode first.** It is the widest mode and therefore the worst case,
   at an estimated 17% margin on a 302.4 MHz clock (§18). If the estimate is
   optimistic, the options in order of preference are a 352 MHz clock preset, a
   lower default `SPRLIMIT`, or accepting that Full mode is a single-layer mode.
2. **Confirm the 4bpp unpacking table earns its 8 KB.** The whole per-pixel
   budget assumes the sub-palette folds into the lookup for free.
3. **Check that the palette's hue ramps are usable in practice** rather than
   merely evenly spaced. They are generated from a formula (§11) precisely so
   that the answer can be "no" cheaply.
