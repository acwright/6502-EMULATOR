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

A complete A.C. Wright 6502 machine — 65C02, BASIC and a machine-code monitor in
ROM, banked RAM, a 6551 ACIA, a 6522 VIA, a 6581 SID, a DS1511 real-time clock, a
CF card and a TMS9918 video card — that you can boot, drive, inspect and assert on
from a shell.

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

- **The leading `\r`** answers the BIOS splash, which takes ENTER for BASIC or ESC
  for the Monitor. Without it you wait out a five-second countdown.
- **`--exit-on`** stops on a pattern instead of a guessed duration. Two `OK`
  prompts means the line has been run.
- **`--timeout`** bounds it. Exit code `2` means it timed out — always give a
  budget so a broken program fails instead of hanging.

Add `--json` for a machine-readable result on stderr:

```sh
{"reason":"exit-on","cycles":449280,"wallMs":53}
```

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
`screen text` and `screen png` when there is a video card, `input type` to drive a
program through the keyboard rather than the console.

`6502 attach` is the same command set as an interactive REPL, with console output
and stop/resume events streaming live. Useful for a human; not for a script.

<a name="restore-instead-of-rebooting"></a>

## Restore instead of rebooting

This is the biggest lever available to a test loop. Booting to the BASIC prompt
costs 5,359,120 emulated cycles; a restore costs about a millisecond. More
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

A snapshot is around 52 KB of JSON and is refused rather than half-applied if it
does not match the machine — wrong version, different slot layout, or a different
ROM. Keep it next to the ROM it was taken against.

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

**Wait for a prompt before typing.** Input delivered to a machine that has not
finished booting arrives before the BIOS has probed its hardware and set up a
console. The byte then sits unread in the ACIA's receive register, where it blocks
every byte queued behind it — so the console appears to die. Symptom: your first
command is never echoed. The leading `\r` in the one-shot form above is fine
because the machine starts immediately; with `--pause`, or with a debug server,
wait for output first:

```sh
6502 dbg wait --serial 'OK' --run turbo    # do this
6502 dbg send 'PRINT 1\r'                  # then this
```

`6502 run --headless --input-after 'OK'` does the same for piped stdin.

**The splash swallows keystrokes.** It takes ENTER or ESC and acts at once;
anything else sent before that choice is made is discarded. Lead with the CR, or
gate on a prompt.

**BASIC answers `OK` to a statement, not to a stored program line.**
`--wait 'OK'` after `10 PRINT "HI"` waits until the timeout. Wait for the echo of
the line instead.

**Editing a program clears BASIC's variables.** Set variables *after* entering
program lines, or the assignment silently disappears.

**Console output is CRLF**, as a real serial terminal sends. Strip `\r` before
matching with an anchored pattern.

**Newlines become CR on the way in.** BASIC ends a line on CR and would never see
an LF, so the CLI translates. Nothing to do — just don't be surprised.

**A video-absent boot is not identical to a video boot.** `CLS`, `LOCATE` and
`COLOR` silently do nothing when there is no video card (their arguments are still
consumed). If you are testing those, use `--console video` and read the screen with
`6502 dbg screen text`.

**One instance owns the lock file.** For a second machine, pass `--debug-port` to
`run` and `--port` to `dbg`.

**`--pause` means not started**, not started-then-stopped. The machine sits at its
reset vector, which is what you want when attaching before boot — and it means
nothing runs until something calls `exec.run`, including your exit conditions.

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
