#!/usr/bin/env bash
#
# Debug a machine-code routine: load it, break on it, step through it, read the
# registers, then patch it and watch the behaviour change — with no rebuild and
# no restart.
#
# The emulator serves a JSON-RPC protocol on a loopback port and publishes where
# to reach it in ~/.6502/session.json, so every `6502 dbg` below takes no
# connection arguments at all. That matters more than it looks: each invocation
# is a separate process, and an agent calling a CLI from a shell has nowhere to
# keep a port number between calls.

source "$(dirname "$0")/lib.sh"

say '1. A routine to debug'

# LDA #$58 ('X'); JSR $A000 (the BIOS's Chrout); RTS
#
# $7F00 is the top of RAM — above BASIC's program area and clear of its
# workspace, so BASIC can call it with SYS 32512 without either treading on the
# other.
printf '\xa9\x58\x20\x00\xa0\x60' > "$WORK/hello.bin"
show 'od -An -tx1 hello.bin'
od -An -tx1 "$WORK/hello.bin"

say '2. Boot with it loaded, paused at the reset vector'

# --pause means *not started*, not started-and-then-stopped: the machine sits at
# the reset vector so a debugger sees the very first instruction. Without it the
# scheduler runs a whole slice — tens of thousands of cycles — before anything
# could stop it.
show '6502 run --headless --debug --pause --bin 0x7F00=hello.bin'
start_emulator --pause --bin "0x7F00=$WORK/hello.bin"

dbg info
expect 'cycles run before anything asked' "$(dbg info --json | json cycles)" 0

say '3. Break on the routine, then boot to the BASIC prompt'

show '6502 dbg break 0x7F00'
dbg break 0x7F00
dbg break list

# Nothing calls $7F00 during boot, so this just reaches the prompt. `--run turbo`
# is what starts the paused machine; the wait then blocks until the output
# matches rather than sleeping for a guessed duration.
#
# Note what is *not* here: a leading CR to skip the BIOS countdown. Input sent
# to a machine that has not booted yet is delivered before the BIOS has probed
# its hardware and set up a console, and the byte then sits unread in the ACIA's
# receive register — where it blocks every byte behind it. Wait for a prompt
# before typing; see docs/AGENTS.md.
show "6502 dbg wait --serial 'OK' --run turbo"
dbg wait --serial 'OK' --run turbo --timeout 30s >/dev/null

say '4. Call it from BASIC and catch the breakpoint'

show "6502 dbg send 'SYS 32512\\r'"
dbg send 'SYS 32512\r' >/dev/null

stopped=$(dbg wait --stopped --timeout 20s --json)
expect 'stop reason' "$(printf '%s' "$stopped" | json stop.kind)" breakpoint
expect 'stopped at' "$(printf '%s' "$stopped" | json stop.address)" 32512   # $7F00
expect 'and the machine really is stopped' "$(dbg info --json | json running)" false

say '5. Read the state at the stop'

show '6502 dbg regs'
dbg regs

show '6502 dbg disasm 0x7F00 3'
dbg disasm 0x7F00 3

say '6. Step through it, watching A change'

# A breakpoint stops *before* the instruction at its address, so the LDA has not
# run yet and A still holds whatever BASIC left there.
show '6502 dbg step        # over the LDA #$58'
dbg step
expect 'A after LDA #$58' "$(dbg regs --json | json A)" 88   # $58 = 'X'

# --over runs the whole subroutine call rather than descending into Chrout.
show '6502 dbg step --over # over the JSR, running Chrout to completion'
dbg step --over

# The character has been transmitted by now. `wait --serial` looks back to the
# cursor of the last send, so it finds output the machine produced before the
# wait was even set up — which is the only thing that works when each command is
# a separate process.
printed=$(dbg wait --serial 'X' --timeout 5s --json)
expect 'the routine printed X' "$(printf '%s' "$printed" | json matched)" true

say '7. Patch the routine in place and watch the behaviour change'

show '6502 dbg mem write 0x7F01 59   # $59 = "Y"'
dbg mem write 0x7F01 59
dbg mem 0x7F00 6

dbg break clear >/dev/null
dbg run >/dev/null

show "6502 dbg send 'SYS 32512\\r' --wait 'Y'"
out=$(dbg send 'SYS 32512\r' --wait 'Y' --timeout 20s)
expect_match 'the patched routine printed Y' "$out" 'Y'

say 'Example 2 passed'
