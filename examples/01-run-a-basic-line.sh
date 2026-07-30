#!/usr/bin/env bash
#
# The simplest useful thing: boot a machine, run a line of BASIC, read the
# answer. No debug server, no session — one process in and out.
#
# The machine's console is a real terminal session over the emulated 6551 ACIA.
# The BIOS probes for a video card on boot, finds none, and routes its console to
# serial by itself — so stdin and stdout *are* the machine's terminal, with no
# firmware changes and no screen scraping.

source "$(dirname "$0")/lib.sh"

say '1. Run a line of BASIC and read the result'

# Three things are load-bearing in this one command:
#
#   \r first     The BIOS splash takes ENTER for BASIC or ESC for the Monitor and
#                acts at once. A leading CR skips the 5-second countdown — and
#                anything sent *before* that choice is made gets swallowed.
#   \r at the end BASIC ends a line on CR, not LF. The CLI translates \n to \r on
#                the way in for exactly this reason.
#   --exit-on    Stop when the output matches, rather than guessing at a
#                duration. Two OK prompts means the line has been run.
show "printf '\\rPRINT 6*7\\r' | 6502 run --headless --exit-on 'OK[\\s\\S]*OK'"
output=$(printf '\rPRINT 6*7\r' | $SIXTY502 run --headless --quiet --exit-on 'OK[\s\S]*OK' --timeout 20s)

printf '%s\n' "$output"
expect_match 'BASIC answered 42' "$output" '^ 42$'

say '2. The same run, reporting where it stopped and what it cost'

# --json puts a machine-readable result on stderr, which is what a test harness
# should branch on rather than parsing the console text.
result=$(printf '\rPRINT 6*7\r' | $SIXTY502 run --headless --quiet \
  --exit-on 'OK[\s\S]*OK' --timeout 20s --json 2>&1 >/dev/null | tail -1)

printf '%s\n' "$result"
expect_match 'stopped because the output matched' "$result" '"reason":"exit-on"'

say '3. Exit codes carry the outcome, so a script can branch without scraping'

# Nothing will ever match this, so the run times out: exit 2, not 0.
set +e
$SIXTY502 run --headless --quiet --exit-on 'THIS NEVER APPEARS' --timeout 2s >/dev/null 2>&1
code=$?
set -e
expect 'exit code for a timeout' "$code" 2

say 'Example 1 passed'
