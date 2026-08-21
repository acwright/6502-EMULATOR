/**
 * Give every test file its own `~/.6502`.
 *
 * The debug server records the live session in a single lock file —
 * `LockFile.ts` puts it at `$SIXTY5O2_HOME/session.json`, defaulting to
 * `~/.6502`. That is right for the product: there is one machine, so there is
 * one session, and `6502 dbg` finds it without being told where to look.
 *
 * It is wrong for a test run. Jest gives each test file its own worker and runs
 * several at once, so the four files that start a real server —
 * `main/debugBridge`, `debug/server/DebugServer`, `host/HeadlessHost` and
 * `cli/dbg/Commands` — were all writing and clearing the same path at the same
 * time, and taking each other's lock out from under them. It also meant a test
 * run trod on a real emulator session the developer had open, and that a real
 * session could fail the suite.
 *
 * Two of the files already worked around it by pointing the variable at a temp
 * directory themselves. This does it once, for all of them, before any module
 * is loaded — so a test added later inherits the isolation instead of having to
 * know about it.
 */
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

process.env.SIXTY5O2_HOME = mkdtempSync(join(tmpdir(), '6502-test-'))
