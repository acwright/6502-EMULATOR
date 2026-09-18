# Driving the emulator from an agent

This file is written to be **copied into your own 6502 project** — into its
`AGENTS.md` or `CLAUDE.md`, or kept beside it — so that an agent working on 6502
code knows how to test that code on a real emulated machine instead of writing a
throwaway simulator.

Everything here is exercised by CI as runnable scripts in
[../examples/](../examples/). The full method reference is
[DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md).

---

## What you get

A complete AC6502 machine — 65C02, BASIC and a machine-code monitor in
ROM, banked RAM, a 6551 ACIA, a 6522 VIA, a 6581 SID, a DS1511 real-time clock, a
CF card and a video card — that you can boot, drive, inspect and assert on from a
shell.

The video card is either of two, picked with `--vdp`: the **TMS9918A**
(`--vdp tms9918a`, the default), which is what a real ACE runs today, or the
**6502-PICOVDP** of [VDP-SPEC.md](VDP-SPEC.md) (`--vdp picovdp`), which runs
TMS9918A Text and Graphics I code unmodified but is ahead of the real hardware.
Each boots its own bundled BIOS: 1.6 on the TMS9918A, and since 3.1 2.0 on the
PICOVDP, which boots straight to BASIC with no splash or Monitor. The examples
here use the default card, and so BIOS 1.6. Name the card your program is
written for — the default will change to `picovdp` in a later release — and see
[Testing things that draw](#testing-things-that-draw) before trusting a PICOVDP
picture as evidence that something works on the board. `6502 dbg info` names
the card, as `session.info`'s `vdp` does.

`--headless` leaves the video slot *empty* by default, and that is a feature
rather than a limitation: the BIOS probes for a video card, finds none, and routes
its console to the serial port. Pass `--console video` when you are testing
something that draws.

Three properties make it usable as a test target rather than a toy:

- **The console is a byte stream.** Booted without a video card, the BIOS routes
  its console to the serial port by itself, so stdin and stdout *are* the
  machine's terminal. You get the machine's actual `PRINT` output, in order, with
  no screen scraping.
- **It is deterministic.** Given the same ROM, the same input and the same cycle
  budget, it lands in the same state every time — see
  [Reproducible runs](#reproducible-runs).
- **It is fast, and can skip its own boot.** Around 11 MHz unpaced, and a snapshot
  turns a five-second boot into a millisecond restore.

## Installing

```sh
6502 --version              # if the app installed the shim (Settings → COMMAND LINE)
node out/cli/index.js       # from a checkout — always works, and what CI should use
```

Substitute whichever works for `6502` below. No separate npm install; the CLI
ships inside the app and Electron's bundled Node runs it, so nothing needs a Node
runtime of its own.

---

## The shortest useful thing

One process in, one answer out. No server, no session.

```sh
printf '\rPRINT 6*7\r' | 6502 run --headless --exit-on 'OK[\s\S]*OK' --timeout 20s
#   6502 BASIC V2.0
#   30718 BYTES FREE
#
#   OK
#   PRINT 6*7
#    42
#
#   OK
```

Three details in that command earn their place:

- **The leading `\r`** answers BIOS 1.6's splash, which takes ENTER for BASIC or ESC
  for the Monitor. Without it you wait out a five-second countdown. (BIOS 2.0, on
  `--vdp picovdp`, has no splash.)
- **`--exit-on`** stops on a pattern instead of a guessed duration. Two `OK`
  prompts means the line has been run.
- **`--timeout`** bounds it. Exit code `2` means it timed out — always give a
  budget so a broken program fails instead of hanging.

Add `--json` for a machine-readable result on stderr:

```sh
{"reason":"exit-on","cycles":445120,"wallMs":53,"output":"-- 6502 BIOS v1.6 --\r\nENTER=BASIC  ESC=MONITOR\r\n\r\n6502 BASIC V2.0\r\n30718 BYTES FREE\r\n\r\nOK\r\nPRINT 6*7\r\n 42\r\n\r\nOK\r\n"}
```

With `--exit-on`, `output` holds everything the console printed on the way, so a
caller can check it without capturing stdout as well.

Branch on `reason` and the exit code, not on the console text.

## Loading your build output

```sh
6502 run --headless build/game.prg          # BASIC program or .prg at $0800
6502 run --headless --bin 0x7F00=code.bin   # raw bytes at an address
6502 run --headless --cart build/game.crt   # cartridge
6502 run --headless --rom custom.bin        # replace the BIOS
6502 run --headless --cf build/disk.img     # CF card image
6502 run --headless --nvram saved.bin       # the clock card's battery-backed bytes
6502 run --headless --symbols build/game.lbl   # VICE labels or ca65 .dbg
6502 run --headless --empty storage         # leave a slot unpopulated
```

`--empty` is how a test reaches the BIOS's graceful-degradation paths, which are
otherwise unreachable because every slot is filled by default: `--empty storage`
makes `DIR` and `LOAD "name"` raise `?NO DEVICE ERROR`, `--empty sound` makes
`SOUND` and `VOL` return silently after range-checking their arguments. Names are
`ram1`, `ram2`, `rtc`, `storage`, `serial`, `via`, `sound`, `video`, or
`io1`..`io8`, comma-separated; `MEM`'s `HW=$xx` reports what the probe found.

`--bin` writes before the machine boots. At `$0800` that is BASIC's program area
and its cold start will read those bytes as a tokenized program — use `--program`
(or the positional argument) for images that belong there.

Drop `--headless` and the same flags open the desktop app with the same machine
in it, waiting until the window is closed. That is the one to reach for when the
person you are working with asks to *see* it run rather than be told about it —
add `--detach` to get the shell back immediately, and `--debug` to keep driving
the window with `6502 dbg` while they watch.

## Debugging a program

Start a server, then drive it with one-shot commands. Each `6502 dbg` is a
separate process that connects, calls, prints and exits — there is no session for
you to manage, which is the whole point: an agent has nowhere to keep a port
number between shell calls, so the emulator publishes one in `~/.6502/session.json`
and every command finds it.

```sh
6502 run --headless --debug --pause --bin 0x7F00=code.bin &

6502 dbg break 0x7F00                  # or: break main, once symbols are loaded
6502 dbg wait --serial 'OK' --run turbo   # boot, then stop at the prompt
6502 dbg send 'SYS 32512\r'            # call it
6502 dbg wait --stopped                # returns when (or if) it stopped

6502 dbg regs
6502 dbg disasm 0x7F00 3
6502 dbg mem 0x0300 16
6502 dbg step --over
6502 dbg mem write 0x7F01 59           # patch it, no rebuild
6502 dbg run
```

Useful extras: `break <addr> --condition 'A == $FF'`, `break <addr> --watch write`
for a watchpoint, `step --out`, `runto <addr>`, `runcycles <n>`, `sym load`,
`screen text`, `screen png` and `video` when there is a video card, `input type` to
drive a program through the keyboard rather than the console.

`6502 attach` is the same command set as an interactive REPL, with console output
and stop/resume events streaming live. Useful for a human; not for a script.

<a name="restore-instead-of-rebooting"></a>

## Restore instead of rebooting

This is the biggest lever available to a test loop. Booting to the BASIC prompt
costs 5,354,440 emulated cycles; a restore costs about a millisecond. More
importantly it is *exact* — RAM, the variable table, the program area, VRAM, the
clock chip and the CF card's changed sectors all go back — so one test case cannot
leak into the next.

```sh
# Once
6502 dbg wait --serial 'OK' --run turbo
6502 dbg state save ready.state

# Per test case
6502 dbg state load ready.state
6502 dbg run
6502 dbg send 'A=5:PRINT A*2\r' --wait 'OK'
```

A snapshot is around 52 KB of JSON — 140 KB with a video card, whose 64 KB of VRAM
it carries whole — and is refused rather than half-applied if it does not match the
machine: wrong version, different slot layout, or a different ROM. Keep it next to
the ROM it was taken against. A snapshot saved by a 2.x emulator is always refused,
because it describes a video card this one does not have; re-record it.

## Reproducible runs

Two things separate "reproducible" from "usually the same":

**A fixed clock.** The real-time clock is the only part of the engine that reads
the host's clock. `--rtc` pins it:

```sh
6502 run --headless --rtc 2026-01-01T00:00:00 ...
```

It takes no timezone — it is the reading on the emulated clock's face, not an
instant — so the same value means the same thing on a laptop and on a UTC CI
runner. The clock still advances from there in emulated time.

**An exact cycle budget**, rather than however far a `sleep` happened to get:

```sh
6502 run --headless --debug --pause --rtc 2026-01-01T00:00:00 &
6502 dbg runcycles 6000000
6502 dbg state save run.state     # byte-identical, every run, every host
```

With both, three runs under `TZ=UTC`, `TZ=Asia/Tokyo` and `TZ=America/Chicago`
produce identical machines. Without `--rtc` they differ, and the clock chip is the
only thing that differs.

## Waiting, not sleeping

`sleep` in a test loop is how a suite becomes flaky. Every wait here is a blocking
call with a timeout:

```sh
6502 dbg wait --serial 'READY\.' --timeout 5s
6502 dbg wait --expression 'PC >= main && A == 0' --timeout 5s
6502 dbg wait --cycles 100000          # emulated cycles, so host speed is irrelevant
6502 dbg wait --stopped
6502 dbg send 'LIST\r' --wait 'OK'     # send and wait in one call
```

`send --wait` is the one to reach for. It passes the console's stream position
from the write into the wait, so the reply cannot be missed however many cycles
pass between them — and in turbo that is hundreds of thousands, which is why
"wait for output from now on" does not work for one-shot callers.

**What you get back is everything that arrived, plus where the match ended.** A
wait returns the console output as it came, so nothing that followed the match in
the same flush is taken away from you. `--json` gives you two positions with it:
`matchEnd`, the index in that transcript where the pattern matched — slice there
if you want the same transcript every run rather than however much of the line
the host happened to flush — and `cursor`, the stream position the transcript
ends on. Hand `cursor` to the next call as `--since` and you get everything the
machine printed in between, with nothing lost and nothing repeated.

```sh
first=$(6502 dbg send 'RUN\r' --wait 'PRESS' --timeout 20s --json)
at=$(printf '%s' "$first" | python3 -c 'import json,sys; print(json.load(sys.stdin)["cursor"])')

# The rest of that line and the prompt after it, with no gap from the first call.
6502 dbg wait --serial 'OK' --since "$at" --timeout 20s
6502 dbg send 'LIST\r' --wait 'OK' --since "$at" --timeout 20s   # or carry on typing
```

Without `--since`, a wait looks back only as far as its own write, which is right
for "send this, wait for its reply" and wrong for picking up where a previous call
stopped.

`wait --stopped` answers with the stop the machine is already sitting on, which
for a one-shot caller is the usual case: the breakpoint fired while the previous
command's process was exiting. Adding `--run turbo` means *continue* — but only
once you have been told what you are continuing from, so the same command is
safe either way. The first `wait --stopped --run turbo` after a breakpoint or
watchpoint fires returns it; the next one runs on to the following stop.

## Ending the run from inside the program

`--timeout`, `--exit-on` and `--max-cycles` all end a run from the outside, by
guessing when the program is finished. A program that knows can say so: **`STP`
($DB) halts the processor**, and the emulator treats that as the run being over.

```asm
        jsr test_everything
        jsr print_result        ; say what happened on the console first
        stp                     ; done — nothing after this executes
```

```sh
printf '\rSYS 32512\r' | 6502 run --headless --bin 0x7F00=tests.bin --json
# {"reason":"halted","cycles":441480,"wallMs":55}
```

`reason` is `halted` rather than `timeout`, the exit code is `0`, and the run
ends the moment the instruction retires instead of burning the rest of a budget
or waiting out a pattern that may never match.

**The run is over when the halt lands**, so print the result before the `STP`
rather than leaving it in memory for something to read afterwards — with
`--headless` there is no afterwards, and with `--headless --debug` the server
goes down with the process. To poke at a halted machine, drive the desktop app's
debug server (Settings → DEBUG SERVER), which nothing tears down.

Under a debug server the halt is an ordinary stop:
`{"kind": "trap", "detail": "stp"}`, which `6502 dbg wait --stopped` returns on.
The machine stays halted until it is reset — see
[DEBUG-PROTOCOL.md](DEBUG-PROTOCOL.md#exec) for the stop shapes. `WAI` is not
this: it sleeps until an interrupt arrives and the machine is still running, so
it never ends a run.

---

## Exit codes

Branch on these rather than parsing output.

| Code | `6502 run` | `6502 dbg` / `attach` |
|---|---|---|
| `0` | Ran to completion | Ok |
| `1` | Usage or load error | Usage error, or an RPC error |
| `2` | Timed out | A `wait` timed out |
| `3` | — | No emulator found |
| `4` | — | Stopped on a breakpoint or watchpoint |
| `130` | Interrupted | — |

Add `--json` to any `dbg` command for the raw result.

---

## Traps

Every one of these is real machine or firmware behaviour rather than an emulator
quirk, and every one has cost someone an hour.

**Wait for a prompt before typing.** Input sent to a machine that has not
finished booting waits (flow control is on by default, and RTS is high until the
BIOS programs the ACIA), but once it goes in, a boot menu can swallow it, and
with `--no-flow-control` it is lost to a receiver that is still off. Symptom:
your first command is never echoed. The leading `\r` in the one-shot form above
is fine because it is meant for the splash; with `--pause`, or with a debug
server, wait for output first:

```sh
6502 dbg wait --serial 'OK' --run turbo    # do this
6502 dbg send 'PRINT 1\r'                  # then this
```

`6502 run --headless --input-after 'OK'` does the same for piped stdin.

**The splash swallows keystrokes.** BIOS 1.6's takes ENTER or ESC and acts at once;
anything else sent before that choice is made is discarded. Lead with the CR, or
gate on a prompt.

**Both bundled BIOSes are safe to paste into.** With flow control on, a long
program pasted into BASIC arrives whole; with it off, lines are lost to overrun
and the machine stays up. That is 6502-BIOS `v1.6` (`BIOS.bin`, the TMS9918A's)
and `v2.0.2` (`BIOS2.bin`, the PICOVDP's), which are what is bundled.

It used to deadlock, and a machine running an older ROM still will. Raising RTS
(command register `$01`) turns an R6551's transmitter off as well as raising the
pin, so firmware that raised RTS on a full input buffer and then echoed the next
character left `SerialChrout` spinning on a TDRE that never set, with nothing
more going in or out. Flow control made no difference — the firmware was raising
RTS on itself. `mem.read {address: 0x9002}` reading `0x01` with no output is the
symptom, and it means the ROM is older than those tags.

Pasting is still the slow way in. A line at a time waiting for each echo, as the
test-suite loop below does, is no faster, but `6502 dbg load program` with a
tokenized image is.

**The ACIA is an R6551, reset disabled.** Its command register reads `$00` after
a reset, which turns off the receiver, the transmitter and its interrupts. Code
that drives the ACIA directly, rather than through the BIOS, must write the
command register first (`$09`: receiver and IRQ on, RTS low; or `$0B` to poll
with the IRQ off) or it sends and receives nothing. Bits 3-2 at `00` raise RTS
*and* turn the transmitter off, so `$01` is not a way to say "stop sending" and
keep printing: a byte written after it is never sent and TDRE never sets.

**BASIC answers `OK` to a statement, not to a stored program line.**
`--wait 'OK'` after `10 PRINT "HI"` waits until the timeout. Wait for the echo of
the line instead.

**Editing a program clears BASIC's variables.** Set variables *after* entering
program lines, or the assignment silently disappears.

**Console output is CRLF**, as a real serial terminal sends. Strip `\r` before
matching with an anchored pattern.

**Newlines become CR on the way in.** BASIC ends a line on CR and would never see
an LF, so the CLI translates. Nothing to do — just don't be surprised.

**A picture from the emulator is not proof about the board.** See
[Testing things that draw](#testing-things-that-draw).

**A video-absent boot is not identical to a video boot.** `CLS`, `LOCATE` and
`COLOR` silently do nothing when there is no video card (their arguments are still
consumed). If you are testing those, use `--console video` and read the screen with
`6502 dbg screen text`.

**One instance owns the lock file.** For a second machine, pass `--debug-port` to
`run` and `--port` to `dbg`.

**`--pause` means not started**, not started-then-stopped. The machine sits at its
reset vector, which is what you want when attaching before boot — and it means
nothing runs until something calls `exec.run`, including your exit conditions.

## Testing things that draw

Three ways to see the screen, from cheapest to most complete:

```sh
6502 dbg screen text        # the name table through CP437 — assert on this
6502 dbg screen png out.png # the picture
6502 dbg video              # what the card is doing: mode, status, ports

# One shot, no server: the frame as it stood when the run ended.
6502 run --headless --console video --rtc 2026-01-01T00:00:00 \
  --cart build/game.crt --max-cycles 5e6 --screenshot game.png
```

Prefer `screen text` for assertions. It is exact, it survives a palette change, and
it reads whichever grid the card is drawing — 40 × 24, 32 × 24, and on the
PICOVDP also 32 × 30 or 40 × 30.
A PNG with `--rtc` and a cycle budget is byte-identical run to run, so it is fine
to diff, but a diff says *that* something moved and not what.

When a picture is wrong, `6502 dbg video` is where to look before reading the
program: it shows the display mode the registers resolve to, the status registers
without acknowledging them (a program's own read of the status port clears the
interrupt flags — a debugger's does not), and both port pairs' address pointers
and command flip-flops. A program that lost track of the flip-flop and one whose
interrupt handler moved the pointer both look like a garbled screen, and nothing
else tells them apart. `6502 dbg video regs` lists all 128 registers. On the
TMS9918A, `dbg video` shows its mode, display enable and single status byte,
`video regs` its eight registers, and `video palette` is refused: that palette is
fixed.

**The PICOVDP is ahead of the board.** A real ACE runs a Pico9918 as a TMS9918A,
which is what `--vdp tms9918a` emulates; the 6502-PICOVDP is a specification
whose firmware is not yet proven on the board. For code
that must run on today's hardware, stay in Text or Graphics I, never write a
register above `$07`, and keep four sprites or fewer to a line — beyond four, this
card draws what the board drops. [MIGRATING.md](MIGRATING.md) has the full list.

## A worked test loop

```sh
#!/usr/bin/env bash
set -euo pipefail

# One machine, one boot, a fixed clock.
6502 run --headless --debug --quiet --rtc 2026-01-01T00:00:00 --timeout 120s &
emulator=$!
trap 'kill $emulator 2>/dev/null || true' EXIT

until 6502 dbg info >/dev/null 2>&1; do sleep 0.1; done
6502 dbg wait --serial 'OK' --run turbo --timeout 30s
6502 dbg state save /tmp/ready.state

failed=0
for case in tests/*.bas; do
  # Back to the prompt: ~1 ms, and exact, so the previous case cannot leak in.
  6502 dbg state load /tmp/ready.state
  6502 dbg run

  # Type the case in. A stored program line prints nothing back, so each line
  # waits for its own echo rather than for OK.
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    6502 dbg send "$line\r" --wait "^${line%% *}" --timeout 20s >/dev/null
  done < "$case"

  if output=$(6502 dbg send 'RUN\r' --wait 'OK' --timeout 20s) &&
     printf '%s' "$output" | tr -d '\r' | grep -qx PASS; then
    echo "ok   $case"
  else
    echo "FAIL $case"; printf '%s\n' "$output"; failed=1
  fi
done
exit $failed
```

Each case is BASIC source ending in something that prints `PASS` or `FAIL`:

```basic
10 A = 6 * 7
20 IF A = 42 THEN PRINT "PASS"
30 IF A <> 42 THEN PRINT "FAIL"
```

The running version of this, with the cases, is
[../examples/06-test-suite.sh](../examples/06-test-suite.sh) — CI runs it, and it
includes a deliberately failing case so the suite is proved able to fail.

Note that the cases are *source*, not tokenized images. `6502 dbg load program`
takes an image — what the Settings panel loads and what BASIC's own `SAVE`
produces — and is the faster path for a large program, but it cannot take a `.bas`
text file. Source is what a person edits and a diff can review.

Boot once, restore per case, wait rather than sleep, bound everything, and branch
on exit codes. That is the whole method.
