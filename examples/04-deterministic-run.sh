#!/usr/bin/env bash
#
# Make a run reproducible, so an emulator-based test can be trusted in CI.
#
# The engine is driven entirely by cycle accumulators, which means it is already
# deterministic given a cycle stream — with one exception: the real-time clock
# reads the host's clock at boot. `--rtc` fixes that, and with it fixed the same
# ROM plus the same input plus the same cycle budget produces a byte-identical
# machine on every run and every host.
#
# Two things make the difference between "reproducible" and "usually the same":
#
#   --pause + runcycles   An exact cycle budget. Sleeping for a second instead
#                         stops wherever the host's speed happened to reach.
#   --rtc                 A fixed clock. No timezone: it is the reading on the
#                         emulated clock's face, not an instant, so the same
#                         value means the same thing everywhere.

source "$(dirname "$0")/lib.sh"

CYCLES=6000000
CLOCK='2026-03-04T05:06:07'

# One run, driven to an exact cycle budget, saved.
snapshot_at_budget() {
  local out="$1"
  shift
  start_emulator --pause "$@"
  dbg runcycles "$CYCLES" >/dev/null
  dbg state save "$out" >/dev/null
  stop_emulator
}

# The snapshot minus the fields that are *meant* to differ: when it was taken.
canonical() {
  node -e '
    const fs = require("fs")
    const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    delete state.createdAt
    process.stdout.write(JSON.stringify(state))
  ' "$1"
}

say "1. Two runs with a fixed clock, each stopped at exactly $CYCLES cycles"

show "6502 run --headless --debug --pause --rtc $CLOCK   # then: dbg runcycles $CYCLES"
snapshot_at_budget "$WORK/a.state" --rtc "$CLOCK"
snapshot_at_budget "$WORK/b.state" --rtc "$CLOCK"

if [ "$(canonical "$WORK/a.state")" = "$(canonical "$WORK/b.state")" ]; then
  printf '   ✓ byte-identical machines\n'
else
  printf '\n!! the two runs diverged\n' >&2
  exit 1
fi

say '2. The same, in three different host timezones'

# The reading is digits, not an instant, so TZ cannot reach it. Passing a Date
# through here instead would need a timezone to turn it back into digits, and the
# same flag would then mean 23:06 on a developer's laptop and 05:06 on CI.
for zone in UTC Asia/Tokyo America/Chicago; do
  TZ="$zone" snapshot_at_budget "$WORK/tz-$(echo "$zone" | tr / -).state" --rtc "$CLOCK"
done

first=$(canonical "$WORK/tz-UTC.state")
for zone in Asia/Tokyo America/Chicago; do
  if [ "$(canonical "$WORK/tz-$(echo "$zone" | tr / -).state")" != "$first" ]; then
    printf '\n!! TZ=%s produced a different machine\n' "$zone" >&2
    exit 1
  fi
  printf '   ✓ TZ=%s matches UTC\n' "$zone"
done

say '3. Without --rtc, the same two runs do not match — the clock was the leak'

snapshot_at_budget "$WORK/wall-a.state"
sleep 1.1   # long enough for the host clock to have moved on
snapshot_at_budget "$WORK/wall-b.state"

if [ "$(canonical "$WORK/wall-a.state")" = "$(canonical "$WORK/wall-b.state")" ]; then
  printf '\n!! expected these to differ; is the RTC still reading the host clock?\n' >&2
  exit 1
fi
printf '   ✓ they differ, and only in the clock chip\n'

# Show that it really is only the RTC that moved, which is what makes --rtc a
# complete fix rather than a partial one.
differing=$(node -e '
  const fs = require("fs")
  const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"))
  const a = read(process.argv[1])
  const b = read(process.argv[2])
  const names = []
  if (JSON.stringify(a.cpu) !== JSON.stringify(b.cpu)) names.push("cpu")
  if (JSON.stringify(a.ram) !== JSON.stringify(b.ram)) names.push("ram")
  a.slots.forEach((slot, i) => {
    if (JSON.stringify(slot) !== JSON.stringify(b.slots[i])) names.push(slot.kind)
  })
  process.stdout.write(names.join(",") || "(nothing)")
' "$WORK/wall-a.state" "$WORK/wall-b.state")

expect 'what differed between the two wall-clock runs' "$differing" rtc

say 'Example 4 passed'
