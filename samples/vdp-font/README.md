VDP Font
========

An AC6502 cartridge that draws all 256 characters of the 6502-PICOVDP's built-in
font in Text mode, three times over. It is the fixture VDP-SPEC draft 0.5 called
for: every other golden boots BIOS 1.x, whose `InitCharacters` uploads the same
2,048 bytes to `$0800` before the first checkpoint, so none of them can tell the
font reset installs from the one the Kernal copies. This one never calls
`KernalInit` and never uploads a character set, so the only font on its screens
is one the card put there itself (§7).

```sh
brew install cc65
make            # rebuild VdpFont.crt
make run        # run it in this repository's emulator
make view       # hexdump
```

The screens
-----------

All three are Text (`VMODE` `$1`, 40 × 24 of 6 × 8) at 1bpp with a colour byte
per cell (`L0CTRL` `$30`): a title on row 1, white on dark blue, and the 256
characters in a 16 × 16 grid, one of eight inks on black a row. The name table
is at `$0000` and the attribute table at `$0400`, both below the font.

| | `L0PAT` | What happens first | What it proves |
|---|:--:|---|---|
| **reset** | `$01` | nothing | reset puts font `$00` at `$0800`–`$0FFF` |
| **loaded** | `$01` | `$0800`–`$0FFF` filled with `$FF`, then `FONT` = `$00` | the load command copies the font into layer 0's pattern table |
| **relocated** | `$02` | `$1000`–`$17FF` filled with `$FF`, `L0PAT` = `$02`, then `FONT` = `$00` | the destination is `L0PAT` × `$800` at the write |

Each load follows §7's recipe: read `STAT0` to clear F, write `FONT`, and poll
for F. The load lands at the line start where vertical blank fires, before F
sets, so the first F after the command finds it complete.

Sprites are off, and interrupts are never enabled: the poll owns `STAT0`.

Timing
------

Screens 1 and 2 turn the display on and hold for 60 vertical blanks; screen 3
turns it on and stays. From a cold reset:

| Screen | Display on | Captured at |
|---|---|:--:|
| reset | 4–62 | 33 |
| loaded | 69–126 | 97 |
| relocated | 133 on | 161 |

The first two captures sit in the middle of their windows, about 28 frames from
either edge, as `vdp-modes`' do.

Rebuilding
----------

`VdpFont.crt` is committed, so the golden suite boots it from a clean checkout
with no toolchain installed. Rebuilding it moves all three golden checkpoints:
re-capture them in a commit of their own that says what changed and why, exactly
as for any golden, which is never edited to pass.

| | |
|---|---|
| Built with | cc65 `cl65` |
| Layout | `vdp-font.cfg` — `$8000` padding, `$C000` code, `$FFFA` vectors |
| Size | 32768 bytes, which is what the emulator's `Cart` takes and what an EEPROM wants |
