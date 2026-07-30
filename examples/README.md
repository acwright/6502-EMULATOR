# Worked examples

Runnable scripts, not fragments. CI runs `run-all.sh` on every push, so a command
here that stops working stops the build rather than quietly misleading whoever
copies it out.

```sh
npm run build:cli
bash examples/run-all.sh          # everything
bash examples/03-snapshot-per-test.sh   # or just one
```

Each script asserts on what it gets back, so a pass means the emulator really did
the thing described — not merely that the command exited zero.

| Example | What it shows |
|---|---|
| [01-run-a-basic-line.sh](01-run-a-basic-line.sh) | One process in and out: boot, run a line of BASIC, read the answer, branch on the exit code |
| [02-debug-a-program.sh](02-debug-a-program.sh) | Load a routine, break on it, step through it, then patch it in place and watch the behaviour change |
| [03-snapshot-per-test.sh](03-snapshot-per-test.sh) | Boot once, save at the prompt, restore before each test case — and prove the rollback is real |
| [04-deterministic-run.sh](04-deterministic-run.sh) | `--rtc` plus an exact cycle budget: byte-identical machines across runs and timezones |
| [05-raw-protocol.sh](05-raw-protocol.sh) | The same machine driven by `curl`, with no CLI — plus the security guards |
| [06-test-suite.sh](06-test-suite.sh) | All of the above put together: a real BASIC test suite over [tests/](tests/), including a case that is meant to fail |

Everything shared lives in [lib.sh](lib.sh): starting and stopping an emulator,
pulling a field out of a `--json` result without needing `jq`, and the `expect`
helpers that make a failure say what it wanted and what it got.

To point the examples at an installed `6502` instead of the repo build:

```sh
SIXTY502=6502 bash examples/run-all.sh
```

Two notes that will save time, both of them real machine behaviour rather than
emulator quirks — see [../docs/AGENTS.md](../docs/AGENTS.md) for the rest:

- **Wait for a prompt before typing.** Input delivered to a machine that has not
  finished booting arrives before the BIOS has set up a console, and the byte
  then sits unread in the ACIA's receive register, blocking everything behind it.
- **BASIC answers `OK` to a statement, not to a stored program line.** Waiting
  for `OK` after `10 PRINT "HI"` waits forever; wait for the echo instead.
