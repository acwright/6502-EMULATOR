Cartridge fixtures
==================

**These four files are not maintained here.** They are byte copies of 6502-VCS
`Firmware/FH Programmer/host/test/fixtures/`, generated there by
`tools/make-fixtures.js` and checked in CI by `npm run fixtures:check`.

They are the **shared oracle** for the Flash Cart rollout: this emulator's
mapper, the 6502-PICOCALC port, 6502-DEV's DB Emulator and `6502-flash` itself
all check against these files rather than against each other, which is the only
way four independent implementations of the same contract end up agreeing rather
than sharing a bug. The contract they test is 6502-VCS `PLAN.md` §§1–4.

A change there is a change here. `src/tests/Cart.test.ts` quotes the checksums,
so a stale copy fails rather than passing quietly against the wrong bytes.

| File | Bytes | CRC-32 |
|---|---|---|
| `legacy.crt` | 32,768 | `98a4e0fd` |
| `legacy-512K.crt` | 524,288 | `bdaa7346` |
| `banked-128K.crt` | 131,072 | `e0e4f83c` |
| `sample.sav` | 12,316 | `45c4068e` |

`legacy.crt`
------------

A 32K ROM cart image. `$8000–$BFFF` is `$00` padding; the cartridge half is
filled with the **high byte of its own CPU address**, apart from the ASCII tags
at `$C000` and `$E000` and the vectors at `$FFFA`. Any byte says where it came
from, so an off-by-one or a swapped half is visible without counting.

`banked-128K.crt`
-----------------

An SST39SF010A: sixteen 8 KB banks, **every byte of a bank being that bank's own
number**, with a 16-byte ASCII tag at each end of the bank to catch an offset
error inside one. Bank 15, at `0x1E000`, is the fixed bank `$E000–$FFFF` reads
whatever the register holds.

It is built to tell a correct mapper from a wrong one, and
`src/tests/Cart.test.ts` runs the whole table against it: ordinary bank select,
the high bank bits aliasing down on a part with no A17/A18, bit 7 latched and
going nowhere, `$FF` open bus for the unfitted U2, and the fixed region ignoring
the register entirely.

`legacy-512K.crt`
-----------------

The same 16K image laid onto an SST39SF040 — bank 0 at `0x00000`, the fixed bank
at `0x7E000`, `$FF` everywhere else. What `6502-flash layout legacy.crt --size
512K` emits. Nothing in this repository produces this layout; it is here so the
emulator can boot what the Helper will burn.

`sample.sav`
------------

A three-sector overlay against `banked-128K.crt`, in the container of 6502-VCS
`PLAN.md` §4: sectors 0, 28 and 29, deliberately non-contiguous. Sectors 28 and
29 are bank 14, the highest usable bank, where the 6502-CRT template tells a
cartridge to keep its saves.

It carries the image's size and CRC-32, which is what stops a save being laid
over code it was not written against. It is the oracle for the sidecar work of
`PLAN.md` §4; the mapper tests only check its checksum, so that a stale copy is
caught before that work starts.
