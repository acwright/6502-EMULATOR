# Bundled ROMs

Two images, both build artifacts of 6502-BIOS. **They are never edited here.**
When either changes upstream, re-copy it, update the table below, and re-run the
tests.

Each ships twice, because two builds load it from two places:

| Path | Loaded by |
|---|---|
| `assets/roms/` | Electron and the CLI, via `extraResources` |
| `src/renderer/public/roms/` | the web build, fetched from `BASE_URL + roms/…` |

The copies must stay byte-identical; `src/tests/BundledROM.test.ts` is what holds
them to it, digests and all. Updating one and not the other ships a desktop app
running a different ROM from the browser build, and the end-to-end tests — which
read whichever copy they were pointed at — would go on passing.

Which card boots which is `BUNDLED_ROM` in `src/shared/vdp.ts`, not a choice
made here.

## BIOS.bin — 32 KB

The 1.x BIOS, what a **TMS9918A** machine boots. Also what the headless serial
console boots, since the BIOS's own console auto-detection finds no video card
and routes everything to the ACIA.

- **Source** — `/Users/acwright/Developer/Assembly/6502-BIOS`, `BIOS.bin` at tag
  **`v1.7`** (`387d29d5396b821568e7b9a41fa7e7fccf6d1b76`, 2026-11-11), branch
  `v1.x`
- **Version string** — `6502 BIOS v1.7`
- **SHA-256** — `49be5865bde74220f37ad10bd773619b17f052b37c89f79c1a3564b7da51d799`

1.7 is the two probes below, on top of 1.6; every 1.6 routine address holds.
Earlier images this repository bundled, newest first: 1.6 at `8acb4fc`
(`4b4154af…`), the last of its in-place reissues, always as 1.6 and always with
the same banner; `f858890`
(`29ed506f…`), the serial output path dropping RTS around each byte; `27bd4e0`
(`4ec29214…`), BASIC lowering RTS as it read the buffer; and `71e1e66`
(`fc0002d0…`), 1.6 as first released. The last of those is kept as a fixture at
`src/tests/fixtures/BIOS-1.6-emulator-2.7.0.bin`, because the version 1 snapshot
in the same directory was saved against it and a snapshot is refused on any
other ROM.

## BIOS2.bin — 32 KB

The 2.x BIOS, what the **PICOVDP** boots.

- **Source** — the same repository, `BIOS.bin` on `main` at tag **`v2.1.0`**
  (`6f9e137607eb4fc6471e7d1bfc877cbc2804e96b`, 2026-11-11)
- **Version string** — `AC6502 BIOS v2.1`
- **SHA-256** — `991ba3c258caec56824ef46ed9dbae5224d824f292cc6a41de9c9e4bf79e8543`

The banner has no patch field, so `v2.0`, `v2.0.1` and `v2.0.2` all read `v2.0`
and only the digest told them apart. Earlier images this repository bundled,
newest first: `v2.0.2` (`bd476a8`, sha256 `7a71252d…`), the border a first
`COLOR` shows (below); `v2.0.1` (`62254c1`, sha256 `f5fb454b…`), which fixed
serial flow control; and `v2.0` (`b185e37`, sha256 `4702fad7…`), which
deadlocked on a long paste over the serial console.

## Two probes, in both, and a shorter settle in 2.x

`v1.7` and `v2.1.0` fix two boot probes that a real KIM showed wrong, and both
are reachable here because an empty slot now reads open bus, as on the board:

- **An empty sound slot is not a SID.** It reads `$98` at `SID_OSC3`, which the
  old probe took for a SID's noise. The probe now wants voice 3 to change
  between reads. `--empty sound` shows it: `HW_PRESENT` 63, not 127.
- **The CF probe skips an empty slot**, which reads `$8C` at `$8C07` and `$8F` at
  `$8F07`, and otherwise waits up to 3.0 s for a card (it was 0.85 s), leaving
  how long it took at `$0376–$0378`. `--cf-busy` makes the card take as long as
  a real one.

`v2.1.0` also cuts the keyboard encoders' settle in `KBDisable` from 80 loops to
50: `JOY()` waits about 250 µs, not 400.

## The border a first `COLOR` shows, in 2.x

`v2.0.2` is one change on top of `v2.0.1`. The Text console comes up on first
use rather than in `KernalInit`, and that bring-up is `InitVideo` followed by a
clear. `InitVideo` writes register 7 with the display off, and a blanked PICOVDP
shows that register's low nibble over the whole screen for as long as the font
load takes, so `COLOR 2,5,12` as the console's first use showed the *old* pen's
background before settling on border 12 — one frame of the wrong colour.

Register 7 is write-only, so the Kernal keeps a copy: **`VID_BORDER` at `$039C`**
is the border the console shows, `$0F` from `KernalInit`, and `InitVideo` writes
`VID_PEN`'s foreground over it. `VideoSetPen` now stores the pen and the border
*before* the console is brought up.

Two deliberate behaviour changes follow, and a PICOVDP golden frame may move
with them:

- The screen a first `COLOR` brings up is cleared in **that** `COLOR`'s pen, so
  border and background agree, where it used to be cleared in the old one.
- A border given to `COLOR fg,bg,border` **survives a program returning to the
  Text console**, since `InitVideo` no longer takes the border from the pen.

The 85 Kernal jump slots are unchanged; 48 of their targets moved.

## Serial flow control, in both

`v1.6` and `v2.0.1` — which `v2.0.2` carries forward — are the same four fixes,
one line each, found against a real R6551 on 2026-09-17 and fixed together:

- **The transmitter stops while RTS is up.** TIC `00` raises RTS *and* turns the
  transmitter off, so firmware that raised RTS on a full buffer and then echoed
  the next character spun on a TDRE that never set — a dead machine, whatever the
  terminal's flow control was set to, because the firmware raised RTS on itself.
  `ScRts` now owns the command register, and `SerialChrout` lowers RTS around
  each byte it sends.
- **The input ring no longer laps itself.** `WriteBuffer` stored without checking
  for full, so 256 unread bytes wrapped `BufferSize` to zero, the buffer looked
  empty, RTS dropped and a whole ring was overwritten. It drops the arriving byte
  instead: one character lost rather than 256.
- **The IRQ handler only reads a byte that is there.** It read the data register
  on any interrupt without checking `RDRF`, so a character could be stored twice.
- **The console goes quiet rather than reopening the gate.** Since sending means
  lowering RTS, every echo let another byte in, and a flooded buffer never
  recovered. At or above the high mark `SerialChrout` now drops the outgoing byte
  and leaves RTS up.

On the bench, pastes to 14 KB arrive byte-perfect with flow control on. Here,
`src/tests/host/HeadlessHost.test.ts` pastes 42 lines into each ROM: whole with
flow control on, lossy but never hung with it off.
