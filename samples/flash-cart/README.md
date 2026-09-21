Flash Cart
==========

A 131,072-byte banked cartridge — an SST39SF010A on the AC6502 Flash Cart — that
draws two screens and stops. It is the golden fixture for the two things a 32K
ROM cart cannot do at all: **read code and data out of a switchable bank**, and
**write to its own flash**.

```sh
make                # rebuild FlashCart.crt (needs cc65)
make run            # run it in this repository's emulator
```

| Checkpoint | What is on screen |
|---|---|
| `three-banks` | three lines of text, each read from a different 8 KB bank at the same forty addresses |
| `self-programmed` | a byte programmed into the save bank by a JEDEC sequence, and read back off the chip |

The contract it is built against is **6502-VCS `PLAN.md` §§1–3**, which is the
normative copy; `flash-cart.cfg` is a byte copy of that project's
`6502-128K.cfg`, so what is booted here is what the 6502-CRT template builds.

Three banks, one window
-----------------------

`$C000–$DFFF` is eight kilobytes of whichever bank the register last had written
to it, and `$E000–$FFFF` is the primary chip's last eight kilobytes whatever it
holds. So the middle of the screen is three strings living at *the same forty
addresses*, and `DrawBankRow` reaches any of them with one store:

```
DrawBankRow:
  sta BANK                          ; $E000 — latches the register, touches no flash
  lda #<WINDOW
  ldx #>WINDOW
  jmp DrawRow
```

Each bank says its own number, so a mapper that reads the wrong one draws a
wrong picture rather than a subtle one.

**Every instruction in this program is in `FIXED`.** A `jsr` from inside a bank
returns to an address whose meaning changed while it was gone; the machine does
not fault, it executes whatever the new bank has there. The banks here hold
forty bytes of text each and nothing else.

Writing to itself
-----------------

The second screen runs the JEDEC program sequence of §3 against bank `$0E`,
which is where 6502-CRT's template tells a cartridge to keep its saves — the
highest usable bank on a 128K part, and flash sector 28. It reads `$C000` before
and after and prints both, so the screen says what came *off the chip* rather
than what the routine believed it wrote:

```
  PROGRAMMED BANK $0E, $C000, FROM RAM:
  BEFORE $FF    AFTER $5A
```

`$FF` is an erased byte, and a program clears bits only — `$FF & $5A` is `$5A`,
which is why that value and not another.

**The routine is copied into RAM and run there**, and this is the part the
golden exists to pin. While the chip is programming it answers *every* read with
status, including the instruction fetches in `$E000–$FFFF`, so a routine that
polled from flash would be executing a status register. `DESIGN.md` requires RAM
for this reason, and the emulator models the 20 µs busy window so that a cart
which got it wrong hangs here exactly as it would on the board.

Run it twice
------------

Give it a name with a size suffix and the sidecar of `PLAN.md` §4 becomes
visible on screen, because the *before* byte is read from the running cart
rather than from the file:

```sh
cp samples/flash-cart/FlashCart.crt /tmp/FlashCart-128K.crt
6502 run --headless --console video --cart /tmp/FlashCart-128K.crt \
  --max-cycles 3e6 --screenshot first.png
# 6502: wrote 1 flash sector to /tmp/FlashCart-128K.sav
6502 run --headless --console video --cart /tmp/FlashCart-128K.crt \
  --max-cycles 3e6 --screenshot second.png
```

The first run prints `BEFORE $FF`, the second `BEFORE $5A`. `FlashCart-128K.crt`
is byte for byte what it was — the emulator opens a `.crt` read-only and never
reopens it, which is the whole point of the sidecar.
