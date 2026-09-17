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
  **`v1.6`** (`8acb4fc1d410f523a0ba64308ac1c1d9e22098a2`, 2026-09-17)
- **Version string** — `6502 BIOS v1.6`
- **SHA-256** — `4b4154afac681e26324d3f5a845e41770d977c05db1ef6516c9d2c5e210d8c56`

`v1.6` has been reissued in place more than once, always as 1.6 and always with
the same banner, so the digest is the only thing that tells the builds apart.
Earlier images this repository bundled, newest first: `f858890`
(`29ed506f…`), the serial output path dropping RTS around each byte; `27bd4e0`
(`4ec29214…`), BASIC lowering RTS as it read the buffer; and `71e1e66`
(`fc0002d0…`), 1.6 as first released. The last of those is kept as a fixture at
`src/tests/fixtures/BIOS-1.6-emulator-2.7.0.bin`, because the version 1 snapshot
in the same directory was saved against it and a snapshot is refused on any
other ROM.

## BIOS2.bin — 32 KB

The 2.x BIOS, what the **PICOVDP** boots.

- **Source** — the same repository, `BIOS.bin` on `main` at tag **`v2.0.1`**
  (`62254c130955caa76af08d2f9bf29abf3adde980`, 2026-09-17)
- **Version string** — `AC6502 BIOS v2.0`
- **SHA-256** — `f5fb454b9f407c9cbb4cb349ac833b7c92400122d44b6a5840ebe6ab9cf0d97b`

It replaced the `v2.0` tag (`b185e37`, sha256 `4702fad7…`), which deadlocked on a
long paste over the serial console.

## Serial flow control, in both

`v1.6` and `v2.0.1` are the same four fixes, one line each, found against a real
R6551 on 2026-09-17 and fixed together:

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
