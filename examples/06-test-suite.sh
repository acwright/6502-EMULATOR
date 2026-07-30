#!/usr/bin/env bash
#
# A whole test suite, the way you would actually write one: boot once, restore
# before each case, type the case in, assert on what it prints.
#
# This is examples 01–04 put together. Everything that matters about the method is
# visible here — boot once, restore per case, wait rather than sleep, bound
# everything, and branch on exit codes.
#
# The cases in tests/ are BASIC *source*, not tokenized images. That is on
# purpose: source is what a person edits and a diff can review. `6502 dbg load
# program` exists for tokenized images — what the Settings panel loads and what
# BASIC's own SAVE produces — and would be the faster path for a large program,
# but it cannot take a .bas text file.

source "$(dirname "$0")/lib.sh"

say '1. Boot one machine, and save it at the prompt'

# --rtc so the run is reproducible; every case starts from the same clock too,
# since the snapshot carries it.
start_emulator --rtc '2026-01-01T00:00:00'
dbg wait --serial 'OK' --run turbo --timeout 30s >/dev/null
dbg state save "$WORK/ready.state" >/dev/null
printf '   ready at %s cycles\n' "$(dbg info --json | json cycles)"

# Type a BASIC source file into the machine, line by line.
#
# A stored program line prints nothing back, so each line waits for its own echo
# rather than for OK — and waiting for *something* rather than sleeping is what
# keeps this from being flaky. Blank lines and REM-only files are fine.
type_program() {
  local file="$1"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    # The echo of the first word is enough to know the line landed.
    dbg send "$line\\r" --wait "^${line%% *}" --timeout 20s >/dev/null
  done < "$file"
}

say '2. Run every case from the same starting machine'

passed=0
failed=0

for case_file in "$(dirname "$0")"/tests/*.bas; do
  name=$(basename "$case_file" .bas)

  # Back to the prompt. ~1 ms of emulated time, against 5.36 million cycles to
  # boot — and exact, so nothing from the previous case is left behind.
  dbg state load "$WORK/ready.state" >/dev/null
  dbg run >/dev/null

  type_program "$case_file"

  if ! output=$(dbg send 'RUN\r' --wait 'OK' --timeout 20s); then
    printf '   \033[31m✗ %s — timed out\033[0m\n' "$name"
    failed=$((failed + 1))
    continue
  fi

  # tr -d '\r': the console sends CRLF, as a real serial terminal does.
  verdict=$(printf '%s' "$output" | tr -d '\r' | grep -E '^(PASS|FAIL)$' | head -1)

  case "$verdict" in
    PASS)
      printf '   \033[32m✓ %s\033[0m\n' "$name"
      passed=$((passed + 1))
      ;;
    FAIL)
      printf '   \033[31m✗ %s\033[0m\n' "$name"
      failed=$((failed + 1))
      ;;
    *)
      printf '   \033[31m✗ %s — said neither PASS nor FAIL:\033[0m\n' "$name"
      printf '%s\n' "$output" | sed 's/^/       /'
      failed=$((failed + 1))
      ;;
  esac
done

printf '\n   %d passed, %d failed\n' "$passed" "$failed"

say '3. Check the suite itself is working'

# tests/failing.bas asserts something untrue, so a suite that reports it as a
# pass is broken. A test suite that cannot fail is not testing anything.
expect 'cases that passed' "$passed" 2
expect 'cases that failed' "$failed" 1

say 'Example 6 passed'
