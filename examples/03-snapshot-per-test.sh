#!/usr/bin/env bash
#
# The shape of an agent's inner loop: boot once, save the machine at the prompt,
# then restore before each test case instead of re-booting.
#
# Booting to the BASIC prompt costs 5,359,120 emulated cycles — five and a third
# seconds on the real machine, and half a second even flat out. A restore costs
# about a millisecond of emulated time. More importantly it is *exact*: the
# variable table, the program area and the CF card all go back to where they
# were, so one test case cannot leak into the next.

source "$(dirname "$0")/lib.sh"

say '1. Boot once, and wait for a prompt that is actually ready for input'

start_emulator
dbg wait --serial 'OK' --run turbo --timeout 30s >/dev/null
expect 'at the BASIC prompt' "$(dbg info --json | json running)" true

say '2. Save the machine'

show '6502 dbg state save ready.state'
dbg state save "$WORK/ready.state"

# Small because almost nothing is stored in full: RAM and VRAM are, but the
# banked RAM cards and the 256 MB CF image carry only what has been touched.
bytes=$(wc -c < "$WORK/ready.state" | tr -d ' ')
printf '   snapshot is %s bytes\n' "$bytes"
expect_match 'it is a snapshot' "$(head -c 80 "$WORK/ready.state")" '6502-emulator-snapshot'

say '3. Dirty the machine — define a variable and a program line'

# The program line goes in first, deliberately: editing a program clears BASIC's
# variables, so setting A before this would silently undo it.
#
# Storing a line also prints nothing — BASIC answers OK to a *statement*, not to
# a line it has filed away — so the thing to wait for is the echo of the line
# itself. Waiting for OK here would sit until the timeout.
dbg send '10 PRINT "HELLO"\r' --wait '10 PRINT' --timeout 20s >/dev/null
dbg send 'A=5\r' --wait 'OK' --timeout 20s >/dev/null

out=$(dbg send 'PRINT A\r' --wait 'OK' --timeout 20s)
expect_match 'A is 5' "$out" '^ 5$'

out=$(dbg send 'LIST\r' --wait 'OK' --timeout 20s)
expect_match 'the program is there' "$out" 'PRINT "HELLO"'

say '4. Restore, and check the machine really did roll back'

show '6502 dbg state load ready.state'
dbg state load "$WORK/ready.state"
dbg run >/dev/null

# BASIC's variable table went back with the rest of RAM, so A is undefined —
# which in BASIC means 0. This is the assertion that matters: a restore that
# only put the registers back would still report 5 here.
out=$(dbg send 'PRINT A\r' --wait 'OK' --timeout 20s)
expect_match 'A is undefined again' "$out" '^ 0$'

out=$(dbg send 'LIST\r' --wait 'OK' --timeout 20s)
if printf '%s' "$out" | tr -d '\r' | grep -q 'PRINT "HELLO"'; then
  printf '\n!! the program survived the restore\n%s\n' "$out" >&2
  exit 1
fi
printf '   ✓ the program is gone\n'

say '5. Restore repeatedly — every case starts from the same machine'

for case_number in 1 2 3; do
  dbg state load "$WORK/ready.state" >/dev/null
  dbg run >/dev/null
  dbg send "B=$case_number*11\r" --wait 'OK' --timeout 20s >/dev/null
  out=$(dbg send 'PRINT B\r' --wait 'OK' --timeout 20s)
  expect_match "case $case_number computed $((case_number * 11))" "$out" "^ $((case_number * 11))$"

  # And nothing from the previous case is left behind.
  out=$(dbg send 'PRINT A\r' --wait 'OK' --timeout 20s)
  expect_match "case $case_number started clean" "$out" '^ 0$'
done

say '6. A snapshot is refused rather than half-applied'

# The ROM is stored by identity, not by content — a snapshot is worthless without
# the BIOS its PC points into, so a mismatch is an error rather than a machine
# that crashes somewhere unrelated later.
cp "$WORK/ready.state" "$WORK/wrong-rom.state"
node -e '
  const fs = require("fs")
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  state.rom.crc32 = "00000000"
  fs.writeFileSync(process.argv[1], JSON.stringify(state))
' "$WORK/wrong-rom.state"

set +e
err=$(dbg state load "$WORK/wrong-rom.state" 2>&1)
code=$?
set -e
expect 'exit code for a refused snapshot' "$code" 1
expect_match 'and it says why' "$err" 'different ROM'

say 'Example 3 passed'
