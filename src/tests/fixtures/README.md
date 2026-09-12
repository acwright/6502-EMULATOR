Test fixtures
=============

Binaries that are not built here, committed so the golden suite has something
fixed to boot. Rebuilding one changes every golden captured from it, so treat a
change here the way PLAN.md ground rule 4 treats a golden: intended, in its own
commit, with the reason in the message.

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

It is one of the two acceptance targets for the VDP work (PLAN.md §1): it must
run **unaltered**. Wizards Lab uses Graphics I, 1bpp patterns with
per-pattern-group coloring, palette row 0, `STAT0` b7 polled for vertical blank,
and the `$D0` sprite-list terminator — between it and the BIOS's Text mode
console, everything the legacy submode has to get right.

The BIOS fixture is not here: `src/renderer/public/roms/BIOS.bin` is already
committed, is what the app ships, and is byte-identical with the `BIOS.bin` in
`Developer/Assembly/6502-BIOS`.
