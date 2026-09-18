Test fixtures
=============

Binaries that are not built here, committed so the golden suite has something
fixed to boot. Rebuilding one changes every golden captured from it, so treat a
change here the way a golden is treated. A golden is never edited to make a red
test green: one that moves is either a bug or an intended change, and an intended
change goes in a commit of its own, with the reason in the message.

`WizardsLab.crt`
----------------

The `WL_DEBUG=1` build of Wizards Lab for the AC6502 — the title screen is
skipped and the game starts playing, so a headless machine with no input
attached gets past it and the board is on screen within a second of a cold
reset. The shipping cartridge waits on a keypress forever and is useless as a
fixture.

| | |
|---|---|
| Source | `Developer/Assembly/WIZARDSLAB`, `v1.0.0-3-g7b8f08c` |
| Built with | `make DEBUG=1 -C AC6502` (cc65 `cl65` V2.19 — Git 547d92358) |
| SHA-256 | `4259b0aa96ecb0b7fd2057d04acbd2d943687cfe09095f963f69f36bba4b9388` |
| Size | 32768 bytes |

It is one of the two acceptance targets for the VDP work, with the BIOS: it must
run **unaltered**. Wizards Lab uses Graphics I, 1bpp patterns with
per-pattern-group coloring, palette row 0, `STAT0` b7 polled for vertical blank,
and the `$D0` sprite-list terminator — between it and the BIOS's Text mode
console, everything the legacy submode has to get right.

`snapshot-v1-tms9918a.json`
---------------------------

A version 1 snapshot, saved by emulator 2.7.0 — the TMS9918A card — at BASIC's
`OK` prompt, for `src/tests/debug/Snapshot.test.ts` to prove that one still
restores onto `--vdp tms9918a` with no `force`.

| | |
|---|---|
| Saved by | 6502-EMULATOR `v2.7.0`, `tsc -p tsconfig.cli.json` |
| Command | `6502 run --headless --console video --cf <64 KB of zeros> --rtc 2026-01-01T00:00:00 --debug --pause`, then `6502 dbg runcycles 7000000` and `6502 dbg state save` |
| ROM | the bundled BIOS 1.6 (`crc32` `cf427859`) |
| SHA-256 | `186395997f42fc9aa5911e403a91257decf4cf2bf7412ba2a7889ce17e85a774` |
| Size | 74,485 bytes |

It cannot be re-saved by anything in this repository: only a 2.x build writes
version 1.

`BIOS-1.6-emulator-2.7.0.bin`
-----------------------------

The BIOS 1.6 that emulator 2.7.0 through 3.1.1 bundled, which
`snapshot-v1-tms9918a.json` was saved against. A snapshot is refused on any other
ROM, and the bundled 1.6 has since been rebuilt, so the snapshot test boots this.

| | |
|---|---|
| Source | 6502-BIOS tag `v1.6` as first released (`71e1e66`) |
| SHA-256 | `fc0002d0ae25240ed36cfa4bea12735ee71fb05017651bf726520af0658be0a0` |
| `crc32` | `cf427859` |
| Size | 32768 bytes |

The current BIOS fixtures are not here: `src/renderer/public/roms/BIOS.bin` and
`BIOS2.bin` are already committed, are what the app ships, and are
byte-identical with the `BIOS.bin` at 6502-BIOS tags `v1.6` (`8acb4fc`, sha256
`4b4154af…d8c56`, still `v1.6` in every visible string) and `v2.0.2`
(`bd476a8`, sha256 `7a71252d…1d70e`, still `v2.0` in every visible string).
`assets/roms/README.md` is the record of both.

Neither is the `VdpModes.crt` the golden suite also boots. That one *is* built
here, from source in [`samples/vdp-modes/`](../../../samples/vdp-modes/), and
lives beside the source it is built from rather than in this directory, which is
for binaries that come from somewhere else.
