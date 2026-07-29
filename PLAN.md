# PLAN — CLI & Remote Debugging

Status: **Phase 1 shipped as v2.2.1** (2026-07-29). All §9 decisions are settled.
Written against v2.2.0. Next action is Phase 2 — session extraction (§4.2).

## 1. Goals

Two audiences, one machine:

1. **Cross-development from an editor.** Write assembly or BASIC in VSCode, launch
   the emulator already loaded with the build output, set breakpoints in the
   source, inspect registers and memory, and iterate — without touching the
   Settings panel.
2. **AI agents as first-class users.** An agent working on 6502 code should
   end-to-end test *through this emulator* instead of writing a throwaway
   simulator. That means the emulator must be launchable, drivable, observable
   and assertable from a shell, deterministically and fast.

These two needs overlap almost completely; both are "control the machine from
outside the window." The difference is only the presentation layer, which is why
this plan builds **one service** and leaves the UIs to separate apps.

### Non-goals for this work

- No debugger GUI. A standalone debugger app and a VSCode extension are separate
  projects that consume the service built here.
- No MCP server yet. See §9 — the CLI is deliberately designed so agents are
  useful *without* it, and an MCP server later is a thin shim.
- No assembler. The emulator consumes build output; it does not produce it.

---

## 2. What the codebase already gives us

Grounding the design in what's actually there:

| Fact | Consequence |
|---|---|
| `src/core/` has no browser or Node dependencies (Jest runs it under `testEnvironment: 'node'`) | The engine can run headless in Node **today**. This is the single most important enabling fact in this plan. |
| The `Machine` owns its own real-time loop (`Machine.loop()`, `setImmediate` + `performance.now()`) | Pacing is entangled with the engine. It must come out before the machine can be stepped, run at unlimited speed, or run deterministically. |
| The `Machine` instance lives in the **renderer** (`stores/emulator.ts`), driven from Vue | A socket server can't reach it directly — Electron sockets live in the main process. Requires an IPC bridge (§4.3). |
| `ProgramImage.ts` already separates "write the bytes" from "fix up BASIC's pointers", and retries the fixup as the machine boots | Preload-then-boot — exactly the shape a CLI launcher needs — already works. Its own doc comment anticipates this. **No new work here.** |
| `CPU` exposes `a/x/y/pc/sp/st/cycles/cyclesRem` as public fields, and `step()` returns cycles | Register inspection and instruction stepping are nearly free. |
| `CPU.instructionTable` carries opcode `name` and `cycles`, but addressing modes are unnamed closures | A disassembler needs a **separate** opcode metadata table (name, mode, byte length). §5.2. |
| `Video` exposes `buffer` (320×240 RGBA), `getVramByte()`, `getRegister()`, `getMode()` | Screen capture and text-mode screen scraping are straightforward. |
| Emulated I/O timing is driven by **cycle accumulators**, not wall clock | The machine is already deterministic given a cycle stream — except `RTC` (`new Date()`) and `Machine`'s loop. Two fixable leaks. |
| Keystroke injection already exists (`usePaste.injectText`, HID scancodes) | "Type this into BASIC" is a port, not an invention — but the 20 ms sleeps must become cycle-based (§5.4). |
| **The BIOS auto-detects its console**: `KernalInit` probes video, and if video is absent but serial is present it sets `IO_MODE = 1` and routes the console to the ACIA (`Kernal.asm`, console auto-detection) | **A headless machine gets a real text console for free.** See §5.5 — this is the single biggest change to the original plan. |
| The BIOS IRQ handler pushes serial RX bytes into the same `INPUT_BUFFER` the keyboard feeds, and `Chrin` reads from it | Console input over serial needs no firmware work and no HID emulation. Bidirectional, confirmed. |
| `ProbeVideo` writes `$A5` to VRAM and reads it back; the existing `Empty` card returns `0` for every read | Booting with `io8 = new Empty()` makes the probe fail correctly and triggers serial-console mode. **No new emulator hardware needed** — but `Machine.configure()` hardcodes the slots (§5.6). |
| `Storage.getData()` returns `new Uint8Array(this.storage)` — a 256 MB copy — and Electron then structured-clones it across IPC | Two full-size main-thread copies per autosave. This is the documented audio hiccup, now pinned to a line (§5.11). |

---

## 3. The three decisions that shape everything

### 3.1 Headless Node host first, Electron second — build both

The engine already runs in Node. A headless host is a few hundred lines: construct
a `Machine`, sink audio, keep the framebuffer in memory, drive the loop. No IPC,
no window, no Chromium.

This is the right thing to build first for three reasons:

- It's where the agent value is. Agents don't need pixels on a display; they need
  a process they can spawn, drive and kill in under a second.
- It runs at unlimited speed. Wall-clock pacing is a *feature of the GUI*, not of
  the machine. Headless can boot BASIC in a fraction of a second instead of the
  BIOS's real 5-second countdown.
- Building it **forces** the debug layer to be platform-agnostic, which is what
  makes the Electron path afterward a bridging exercise rather than a rewrite.

The GUI path still matters — the human developer wants to watch their sprites
move — so Electron gets the same service in Phase 7, hosted in the main process
and bridged over IPC.

### 3.2 One native protocol; DAP and MCP are adapters, later, elsewhere

Candidates considered:

- **DAP (Debug Adapter Protocol)** — what VSCode speaks natively. Rejected as the
  *native* protocol: DAP is source-line-centric, assumes a single client over
  stdio, and its lifecycle would constrain the emulator's own API. Half of what
  we want (peek/poke VRAM, screen scraping, key injection, snapshots) has no DAP
  representation and would end up in `evaluate` string hacks anyway.
- **GDB Remote Serial Protocol** — broad tool support, but a poor fit for custom
  memory-mapped hardware and an unpleasant protocol to extend.
- **MCP** — the natural agent interface, but it is a *transport for tools*, not a
  debugger. It needs the same underlying operations regardless.

**Recommendation: JSON-RPC 2.0, native to this machine, over WebSocket, with an
HTTP one-shot endpoint on the same port.**

- WebSocket for persistent sessions with server→client events (stopped,
  serial data, log output) — and it works from a browser, so a future web-based
  debugger app needs no gateway.
- Plain HTTP `POST /rpc` for one-shot calls, so the CLI and `curl` work without
  a persistent connection. **This is the agent-friendliness lever**: `6502 dbg
  regs` must be a single fast command, not a session.

DAP and MCP then become thin adapters over this, living in whatever app needs
them. Neither is in scope here.

### 3.3 The Electron machine stays in the renderer

The tempting alternative is to move the `Machine` into the main process (or a
utility process) so there is exactly one host. Rejected for now: the framebuffer
is 320×240×4 = 300 KB per frame at 60 fps, plus the audio stream, and pushing
both across IPC risks regressing a renderer loop that already has a documented
audio-starvation problem (see README, *Known Issues*).

Instead: main process owns the socket, renderer owns the machine, debug commands
cross via IPC. Latency is fine — debug ops are human/agent-paced, not per-cycle.

Revisit if the autosave/audio work ever moves the emulation loop to a worker
anyway; at that point one host becomes cheap.

---

## 4. Architecture

```
                    ┌──────────────────────────────────┐
                    │  src/core/     engine (unchanged) │
                    │  Machine · CPU · RAM · ROM · IO   │
                    └────────────────┬─────────────────┘
                                     │
                    ┌────────────────▼─────────────────┐
                    │  src/debug/    platform-agnostic  │
                    │  Session · Scheduler · Breakpoints│
                    │  Disassembler · Symbols · Screen  │
                    │  Snapshot · WaitConditions        │
                    └───┬──────────────────────────┬────┘
                        │                          │
        ┌───────────────▼──────────┐   ┌───────────▼──────────────┐
        │ src/host/headless        │   │ Electron                  │
        │ Node process, no window  │   │ renderer holds Machine     │
        │                          │   │ main holds server (IPC)    │
        └───────────────┬──────────┘   └───────────┬──────────────┘
                        │                          │
                    ┌───▼──────────────────────────▼───┐
                    │ src/debug/server                  │
                    │ JSON-RPC · WS + HTTP · loopback    │
                    └───┬───────────────────────────┬───┘
                        │                           │
              ┌─────────▼────────┐        ┌─────────▼──────────────┐
              │ src/cli          │        │ FUTURE, separate apps:  │
              │ launcher +       │        │ VSCode ext (DAP adapter)│
              │ debug client     │        │ GUI debugger            │
              │ ← agents use this│        │ MCP server              │
              └──────────────────┘        └────────────────────────┘
```

### 4.1 `src/debug/` — the layer that does not exist yet

Everything genuinely new lives here, and it is all pure TypeScript with no
platform imports, so it is unit-testable under the existing Jest setup.

**`Session`** owns a `Machine` plus execution state. It is the *only* thing that
drives the machine forward. Public surface, roughly:

```ts
type StopReason =
  | { kind: 'paused' }
  | { kind: 'step' }
  | { kind: 'breakpoint'; id: number; address: number }
  | { kind: 'watchpoint'; id: number; address: number; access: 'read' | 'write' }
  | { kind: 'cycle-budget' }
  | { kind: 'condition'; label: string }   // a wait.for predicate matched
  | { kind: 'trap'; detail: string }       // e.g. JAM / illegal state

class Session {
  mode: 'paused' | 'realtime' | 'turbo'
  run(mode?: 'realtime' | 'turbo'): void
  pause(): StopReason
  step(kind: 'instruction' | 'cycle' | 'over' | 'out', count = 1): StopReason
  runTo(address: number): Promise<StopReason>
  runCycles(n: number): StopReason
  onStop(cb: (r: StopReason) => void): () => void
}
```

**`Scheduler`** — pacing, lifted out of `Machine.loop()`:
- `realtime` — today's behaviour, wall-clock accumulator, `setImmediate`.
- `turbo` — run flat out in bounded slices, yielding often enough not to block
  the host. **This is what makes agent test loops fast.**
- `paused` — the machine does not advance; the debugger reads freely.

**`Breakpoints`** — see §5.1.

**`Disassembler`** — see §5.2.

**`Symbols`** — see §5.3.

**`Screen`** — framebuffer → PNG, and nametable → ASCII text grid (§5.5).

**`Snapshot`** — whole-machine save/restore (§5.6, later phase).

### 4.2 Required refactor: pacing comes out of `Machine`

`Machine.run()` / `stop()` / `loop()` / `previousTime` / `_accumulatorMs` move to
`Scheduler`. `Machine` keeps `tick()`, `step()`, `reset()` — the pure primitives —
and keeps `isRunning` only if the renderer still wants it for display.

Impact is small and known:
- `stores/emulator.ts` (`run`/`stop`/`reset`) delegates to a `Session` instead of
  calling `Machine` directly. The store keeps its current public shape so
  `ControlBar.vue` and `SettingsPanel.vue` are untouched.
- `src/tests/Machine.test.ts` — the `run()`/`stop()`/`isRunning` cases move to a
  new `Session.test.ts`. Roughly 4 tests; everything else is unaffected.

This refactor is Phase 2 and lands on its own, green, before anything else
starts.

### 4.3 Electron bridge (Phase 7)

New IPC channels under a `DEBUG_*` prefix in `shared/types.ts`, one per RPC
family, plus a renderer→main event channel for stop notifications. The main
process server becomes a proxy: RPC in → IPC → renderer `Session` → IPC → RPC
out. The renderer registers a single handler that dispatches to the same
`Session` method table the headless host uses, so the two hosts cannot drift.

---

## 5. Feature design notes

### 5.1 Breakpoints without wrecking the hot loop

The loop runs 1–2 million iterations per second; a naive per-cycle check on a
breakpoint list is not acceptable.

- **Execution breakpoints** only need testing at instruction boundaries
  (`cpu.cyclesRem === 0`). Keep a `Uint8Array(0x10000)` bitmap — O(1), no
  allocation, no list walk.
- **Watchpoints** need bus interception. Add optional hooks to
  `Machine.read`/`write`: when unset the cost is one `undefined` check per
  access, which is noise next to the switch already there. Set only while
  watchpoints exist.
- A `hasBreakpoints` boolean lets `Scheduler` pick an uninstrumented fast path
  when nothing is armed — so **an emulator with no breakpoints set runs exactly
  as fast as it does today.** This must be verified with a benchmark, not
  assumed (§8).
- Conditions (`A == $FF`, `$0400 > 10`, hit counts, temporary/one-shot) are
  evaluated only *after* a bitmap hit, so their cost is irrelevant.

**Step-over / step-out** need call-depth tracking: watch for `JSR` (depth+1) and
`RTS`/`RTI` (depth−1) at instruction boundaries, then run until depth returns to
the entry level. Note the 6502 caveat that hand-rolled stack manipulation can
desynchronise this; bound it with a cycle budget and report `cycle-budget` rather
than hanging.

### 5.2 Disassembler and the opcode metadata table

`CPU.instructionTable` has names and cycle counts but its `addrMode` entries are
anonymous closures, so instruction *length* isn't recoverable from it. Add a
parallel static table:

```ts
CPU.OPCODES: readonly { name: string; mode: AddrMode; bytes: 1 | 2 | 3 }[]  // 256 entries
```

**Drift risk is real** — two tables describing the same 256 opcodes will diverge
during maintenance. Mitigate with a test that asserts `OPCODES[i].name ===
instructionTable[i].name` for all 256, so a rename in one breaks CI.

The disassembler is then straightforward, and gains symbol substitution
(`JSR $C012` → `JSR PrintChar`) once §5.3 lands.

### 5.3 Symbols

Source-level debugging needs address↔source mapping. Support, in priority order:

1. **VICE label format** (`al C:0800 .start`) — the lowest common denominator;
   ca65, 64tass and ACME can all emit it. Enough for symbolic disassembly,
   `break main`, and named memory reads.
2. **ca65 `.dbg`** — full file/line mapping, which is what a future DAP adapter
   needs for source breakpoints.

Parsers live in `src/debug/symbols/`, are pure functions over strings, and are
trivially unit-tested. The CLI accepts `--symbols <file>` and infers format from
extension.

### 5.4 Input injection must be cycle-based

`usePaste.injectText` sleeps 20 ms per key transition in wall-clock time. Under
`turbo` that is both wrong and pointlessly slow. Port it into `src/debug/` with
the delay expressed in **CPU cycles** (20 ms at 1 MHz = 20 000 cycles), so a
typed string takes the same emulated time regardless of host speed, and takes
milliseconds of real time in turbo.

The renderer's paste modal then switches to the shared implementation, deleting
the duplicate — a small net simplification.

Note that §5.5 demotes this: HID injection is no longer the *console* input path
for headless runs, only the path for testing keyboard-driven programs and for the
GUI's own paste button.

### 5.5 The serial console — confirmed, and it changes the agent design

**The BIOS already does the hard part.** `KernalInit` probes for video; if video
is absent and serial is present it sets `IO_MODE = 1` and routes `Chrout` to the
ACIA. On the input side the IRQ handler reads `SC_DATA` and pushes the byte into
the same `INPUT_BUFFER` the keyboard feeds, which `Chrin` then drains. The
console is therefore **fully bidirectional over serial with no firmware changes.**

Three ways to select it, all available:

| Method | How | Use |
|---|---|---|
| Video absent | boot with `io8 = new Empty()`; `ProbeVideo`'s `$A5` read-back fails, auto-detection picks serial | Default for headless. Truest to a real serial-only machine. |
| Force at runtime | write `1` to `IO_MODE` (`$0306`), or call `SetIOMode` (`$A00F`) | Video present but output mirrored/redirected — e.g. GUI running with an agent watching the text. |
| Firmware-native transfer | `LOAD`/`SAVE` with no filename run XModem over serial | Round-trip a program out of the machine and diff it. |

Wiring is trivial: `ACIA.transmit` (machine→host) and `ACIA.onData()` (host→machine)
already exist and are already used by the GUI's serial service. Headless binds
them to stdio or to the debug protocol's `serial.*` methods.

**Why this matters more than anything else in the plan.** The original design had
agents polling a character grid and reverse-mapping glyphs to ASCII. Instead they
get a **byte-exact, line-oriented text stream** — the machine's actual `PRINT`
output, in order, with no rendering round-trip. Everything downstream gets
simpler:

- `wait.for --serial 'READY\.'` beats matching against a scraped 40×24 grid.
- No HID scancode timing in the common path, so no dropped-keystroke class of bug.
- BASIC's `INPUT`, the Monitor prompt, and XModem all work unmodified.

**Caveat to design around:** a video-absent boot is *not* behaviourally identical
to a video boot. Per the BIOS README, `CLS`, `LOCATE` and `COLOR` silently skip
when video is absent (arguments still consumed), and the splash/boot menu goes to
serial. So the CLI needs both, explicitly:

```sh
6502 run prog.bas --console serial   # video slot empty; stdio is the console
6502 run prog.bas --console video    # video present; observe via screen.text
6502 run prog.bas --console both     # video present, IO_MODE forced to serial
```

### 5.6 Slot configuration must become data

`Machine.configure()` hardcodes all eight slots. `--console serial` needs io8
empty, and "does my program handle a missing sound card?" is a legitimate thing to
test against a machine whose real slots are physically populated by the user.

Change `configure()` to take a slot map with the current layout as the default.
Small, mechanical, no behaviour change for existing callers — and it is what makes
§5.5's headless default expressible at all.

### 5.7 Screen scraping — still needed, no longer primary

With §5.5 in place this covers only the cases where pixels or the video console
genuinely matter: sprites, graphics modes, and verifying what a video-mode user
actually sees.

- **`screen.text`** — walk the VDP nametable, return the character grid as lines.
  Needs a public accessor for the nametable base (`Video.nameTableAddr()` is
  private) plus a character-code→ASCII map.
- **`screen.hash`** — cheap frame digest, so "wait until the screen changes"
  doesn't require shipping frames.
- **`screen.png`** — encode `Video.buffer`. PNG without a dependency is ~80 lines
  over `node:zlib` deflate.

Demoted from Phase 4 to Phase 7, alongside the GUI work.

### 5.8 Snapshots turn a 5-second boot into a 5-millisecond restore

`state.save` / `state.load` serialise CPU registers, RAM, ROM identity, cart,
VRAM, VDP registers, RTC/NVRAM, SID state and CF card dirty pages.

The payoff for agents is large and worth stating plainly: today, every test run
pays the BIOS countdown and BASIC cold-start. With snapshots, an agent boots
once, snapshots at the `READY.` prompt, and restores per test case. It also gives
humans reproducible bug reports ("here's the machine state one instruction before
it breaks").

Cost: each I/O card needs `serialize()`/`deserialize()`. Mechanical but touches
eight files, so it is its own phase rather than a rider on another. Version the
format from day one.

The CF card is the awkward member — 256 MB is not something to put in a snapshot
whole. It wants **dirty-sector deltas**, which is exactly the mechanism §5.11
builds for the autosave fix. Sequencing §5.11 first makes snapshots cheaper.

### 5.9 `wait.for` — the primitive that makes agent scripts non-flaky

A single blocking call with a timeout, matching on any of: breakpoint hit, screen
text matching a regex, serial output matching, N cycles elapsed, PC reaching an
address.

Without this, every agent script becomes a poll loop with `sleep` calls tuned by
guesswork, which is precisely the flakiness that makes agents distrust a tool.
With it, `wait for the screen to show "READY." or fail after 5 emulated seconds`
is one deterministic call. **Design the CLI so the obvious thing to write is the
robust thing.**

### 5.10 Determinism

Two leaks to close, both small:
- `RTC` calls `new Date()`. Add an injectable clock; CLI flag `--rtc <iso8601>`
  freezes or offsets it. Default stays wall clock.
- `Machine`'s `performance.now()` pacing — already leaving in the §4.2 refactor.

With those closed, a given ROM + input sequence + cycle budget produces
byte-identical results across runs and machines. That is what makes emulator-based
tests trustworthy in CI.

### 5.11 The autosave audio hiccup — yes, roll it into this work

The README describes this as a known issue with the fix "in persistence — make it
incremental." Reading the actual path pins it precisely. Every 30 s,
`usePersistence.save()` does:

1. `Storage.getData()` → `return new Uint8Array(this.storage)` — **allocates and
   copies 256 MB on the renderer main thread**, synchronously.
2. `window.api.storage.saveCF(data)` → **structured-clones 256 MB across the IPC
   boundary**, serialisation side on the renderer thread.
3. Main writes the file (async, off the renderer — this part is fine).

So it is two full-size main-thread copies per save, not one. The emulation loop
and the audio producer share that thread, hence the starve-then-burst that fades
the worklet and then overruns its latency ceiling.

**The fix is dirty-sector tracking**, and it is small because sector writes and
sector erases are the only mutation paths:

- `Storage`: mark the sector dirty on write and on erase; add `isDirty()`,
  `getDelta()` and `clearDirty()`.
- **Skip the save entirely when nothing is dirty.** A BASIC session that never
  touches disk — the overwhelmingly common case — then does *zero* work every
  30 s. This alone removes the hiccup for most users and is a handful of lines.
- New `STORAGE_SAVE_CF_SECTORS` IPC channel; `StorageService` writes the sectors
  in place through a positional handle instead of rewriting 256 MB.
- Web path: per-sector IndexedDB records, or keep the whole-image `put` but gate
  it behind the dirty check.

Bytes moved per save drop from 256 MB to, typically, zero — and to a few KB when
the machine really did write to disk.

Two things worth getting right, both found while building it:

- The delta must **pack its sectors into one contiguous buffer**. Structured
  clone copies a TypedArray's *entire* backing ArrayBuffer, so handing IPC an
  array of per-sector views of a 256 MB image would send 256 MB per sector —
  worse than the bug being fixed.
- **No dirty-count threshold that falls back to a full save.** A delta is never
  larger than the image, so a fallback can only ever move more bytes. Large
  deltas are the writer's problem, solved by coalescing contiguous sector runs
  into single writes.

**Why it belongs in this release rather than as a separate bug fix:** it is a
prerequisite for two things this plan needs anyway. Snapshots (§5.8) can't carry a
256 MB CF image and want exactly these deltas. And the headless host will do its
own CF persistence, so it would inherit the identical stall — fixing it later
means fixing it twice. It also derisks Phase 2, which touches the same pacing code
that produces the symptom: fixing the cause first means the Phase 2 refactor is
verified against a machine that isn't already hiccuping.

Sequenced as Phase 1, before the pacing refactor.

---

## 6. Interfaces

### 6.1 CLI

Two roles in one binary: **launcher** and **debug client**.

```sh
# Launch (GUI) — the VSCode "run my project" case
6502 run build/game.prg --symbols build/game.lbl --debug

# Launch (headless) — the agent / CI case. stdio *is* the machine's console.
6502 run build/game.prg --headless --turbo --max-cycles 10000000

# The console is a real terminal session over the emulated ACIA (§5.5)
echo 'PRINT 2+2' | 6502 run --headless --console serial --turbo
#   → 4
#     READY.

# Load verbs mirror the Settings panel exactly
6502 run --rom custom.bin --cart game.crt --bin 0x0800=sprites.bin

# One-shot debug commands against a running emulator (GUI or headless)
6502 dbg regs
6502 dbg mem 0x0800 64
6502 dbg disasm main 20
6502 dbg break main --condition 'A == 0xFF'
6502 dbg step --over
6502 dbg send 'LIST\r'                      # over the serial console
6502 dbg wait --serial 'READY\.' --timeout 5s
6502 dbg screen --text                      # only when video is the console

# Interactive monitor
6502 attach
```

Design rules, chosen for agent ergonomics:

- **Every `dbg` subcommand is a one-shot process** that connects, calls, prints,
  exits. No session state for the caller to manage — agents are stateless between
  bash calls and anything else fights them.
- **`--json` on everything.** Human-readable by default, machine-readable on
  request.
- **Exit codes carry meaning**: 0 = ok, 1 = error, 2 = timeout, 3 = target not
  running, 4 = breakpoint/assertion hit. Agents branch on these.
- **Address arguments accept `0x0800`, `$0800`, or a symbol name** everywhere.
- **Port discovery**: `6502 run` writes a lock file (`~/.6502/session.json`) with
  port and token, so `6502 dbg` needs no arguments in the common single-instance
  case. `--port` overrides.
- Argument parsing uses `node:util.parseArgs` — **no new dependency.**

### 6.2 Protocol surface

| Family | Methods |
|---|---|
| `session` | `info`, `reset`, `config`, `shutdown` |
| `exec` | `run`, `pause`, `step`, `runTo`, `runCycles`, `state` |
| `bp` | `set`, `clear`, `list`, `enable`, `disable` |
| `reg` | `get`, `set` |
| `mem` | `read`, `write`, `fill`, `search` — with a `space` param (`cpu`/`ram`/`rom`/`vram`/`nvram`/`cf`) |
| `disasm` | `at`, `range` |
| `sym` | `load`, `lookup`, `resolve`, `list` |
| `media` | `loadROM`, `loadCart`, `loadProgram`, `loadBinary`, `unload*` |
| `input` | `type`, `key`, `joystick` — HID path, for keyboard-driven programs |
| `screen` | `text`, `png`, `hash` |
| `serial` | `write`, `read`, `config`, `setConsole` (+ `serial.data` notification) — **the primary console channel, §5.5** |
| `trace` | `start`, `stop`, `read` |
| `state` | `save`, `load` (Phase 8) |
| `wait` | `for` |

Server→client notifications: `stopped`, `resumed`, `serial.data`, `screen.frame`
(opt-in), `log`.

### 6.3 CLI packaging — shipped inside the app, installed as a shim

**Decided: the CLI comes with the emulator download.** No separate install, no npm
package. The app installs a `6502` shim into `PATH`, the way VSCode installs `code`.

The mechanism that makes this clean: **Electron already bundles Node.** Launching
the app binary with `ELECTRON_RUN_AS_NODE=1` runs it as a plain Node interpreter,
so the shim is:

```sh
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "/Applications/6502 Emulator.app/Contents/MacOS/6502 Emulator" \
  "/Applications/6502 Emulator.app/Contents/Resources/cli/index.js" "$@"
```

**The user needs no Node installed at all**, and the CLI version can never drift
from the app version.

Two useful consequences fall out of this:

- The CLI knows its own location, so it can resolve the app binary **relative to
  itself** and `exec` it directly with argv. That sidesteps the per-platform
  "launch an installed app with arguments" problem entirely — no `open -a` on
  macOS mangling arguments, no protocol handler.
- The headless host runs under Electron's Node, so `src/core/` needing no Node
  built-ins beyond the basics stays a hard requirement, not a preference.

Per-platform install, since the desktop conventions differ:

| Platform | Where the shim goes | When |
|---|---|---|
| macOS | `/usr/local/bin/6502`, falling back to `~/.local/bin/6502` with a PATH hint if unprivileged | In-app action — a DMG drag-install runs no installer, so it can't happen automatically |
| Windows | `6502.cmd` in the install dir; NSIS adds that dir to `PATH` | Install time, opt-in checkbox (`nsis.include` custom script) |
| Linux `.deb` | symlink in `/usr/bin` from `postinst` | Install time |
| Linux AppImage | In-app action — an AppImage has no install step | On demand |

So: a **Settings panel action** (`Install '6502' command in PATH`) plus
`6502 --uninstall-cli`, with the Windows and `.deb` installers doing it up front.

Build changes: a new `cli` entry in `electron.vite.config.ts` emitting to
`out/cli/`, added to `electron-builder.yml`'s `files`. Dev workflow stays direct —
`npm run cli -- run foo.prg` — so Phases 3–6 need none of this packaging work.

**The one honest cost of this choice** versus an npm package: a CI runner or a
remote agent sandbox without the desktop app installed has no `6502` command.
Mitigations, in order — the repo path (`node out/cli/index.js`) always works for
CI; and publishing to npm later is purely additive if that becomes a real need.

### 6.4 Security

The desktop app is opening a listening socket, so this is not optional:

- Bind `127.0.0.1` by default. Binding elsewhere requires an explicit
  `--debug-host` **and** a token.
- Generate a per-session token; the CLI reads it from the lock file. Non-loopback
  connections without it are refused.
- The server is **off unless requested** — `--debug` on the CLI, or an explicit
  toggle in the Settings panel. Never on by default in a shipped GUI build.
- `mem.write` and `media.load*` can obviously alter the machine; that is the
  point. But note the server also exposes `mem.read` of the CF card, i.e. file
  contents. Loopback + opt-in + token is the right posture.

---

## 7. Phases

Each phase ends green (typecheck + tests) and is independently useful.

| # | Phase | Deliverable | Notes |
|---|---|---|---|
| **1** ✅ | **Persistence fix → released as v2.2.1** | Dirty-sector tracking in `Storage`, skip-when-clean, `STORAGE_SAVE_CF_SECTORS` + coalesced positional writes, web path gated on dirty — plus the previously unreleased focus-outline fix (`b7b3ce4`) | §5.11. Shipped 2026-07-29 in `64aacc8`. Closed the audio hiccup and laid the CF delta mechanism snapshots need. |
| **2** | **Session extraction** | `src/debug/Session.ts` + `Scheduler`; pacing out of `Machine`; store delegates; `turbo` mode; `runCycles()`; slot config (§5.6) | Pure refactor + two new capabilities. No sockets. Migrate ~4 tests. |
| **3** | **Headless host + CLI launcher** | `src/host/headless`, `bin/6502`, `6502 run --headless --console serial` with stdio wired to the ACIA, all load verbs, `--turbo`, `--max-cycles`, exit conditions | **First agent-usable milestone, and now a much stronger one**: a real interactive text console, not a screen dump. Deliberately before the debugger. |
| **4** | **Debug core** | Breakpoints, watchpoints, step over/out, disassembler + `CPU.OPCODES` + drift test, symbol loaders (VICE, ca65 `.dbg`), condition expressions | All unit-tested; no transport yet. |
| **5** | **Server + protocol** | JSON-RPC over WS + HTTP one-shot, notifications, token auth, lock file | Headless host only. |
| **6** | **CLI as debug client** | `6502 dbg <cmd>` one-shots, `6502 attach` REPL, `--json`, exit codes, `wait.for` | **The milestone agents actually use.** |
| **7** | **Electron integration + packaging** | `DEBUG_*` IPC bridge, server in main process, Settings toggle + "listening on :N"; `screen.text/hash/png` (§5.7); **CLI shim packaging (§6.3)** — `cli` build entry, installer hooks, Settings "Install CLI" action | Human-in-the-loop debugging, and the first build where `6502` exists on a user's `PATH`. |
| **8** | **Snapshots + determinism** | `serialize()`/`deserialize()` on all I/O cards, versioned format, `state.save/load` (CF as deltas over Phase 1), injectable RTC clock, `--rtc` | Biggest single speedup for agent loops. |
| **9** | **Docs & recipes** | README section, `docs/DEBUG-PROTOCOL.md`, a `CLAUDE.md`-style agent recipe file, worked examples | An agent-facing usage guide is part of the product here, not an afterthought. |

Phase 1 ships on its own as **v2.2.1**, a bug-fix release. Phases 1–3 are a
meaningful feature release. Phases 1–6 are the whole point.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| **Breakpoint checks slow the emulator for everyone** | Fast path when nothing is armed; benchmark before/after in Phase 4 and treat a regression as a blocker. |
| **Session extraction regresses the GUI** (audio timing is already delicate) | Sequencing Phase 1 first removes the existing hiccup, so the Phase 2 refactor is verified against a clean baseline. Keep `realtime` behaviour byte-identical; confirm with the existing queue-trim logging before adding `turbo`. |
| **Dirty-sector tracking loses CF writes** — a silent data-loss bug is far worse than an audio glitch | Every mutation path in `Storage` must mark dirty; `write()` is the only one today, but assert it. Test: random write pattern → save → reload → full-image compare. Keep a `--full-save` escape hatch. |
| **Video-absent boot diverges from video boot** (`CLS`/`LOCATE`/`COLOR` no-op) | CLI announces the console mode on startup; `--console both` available when a test needs video present *and* serial output. |
| **Two opcode tables drift** | Equality test across all 256 entries. |
| **Protocol churn once a real client exists** | Version `session.info` from day one; the first client is our own CLI, so breaking changes are cheap until an external app ships. |
| **Snapshot format instability** | Version field + explicit reject on mismatch. Never silently load an old snapshot. |
| **CLI unavailable where the app isn't installed** (CI, remote agent sandboxes) — the accepted cost of shim distribution | `node out/cli/index.js` from the repo always works for CI. npm publishing stays available later as a purely additive option. |
| **Shim install needs elevated privileges on macOS** | Fall back to `~/.local/bin` with a PATH hint rather than failing; never silently no-op. |
| **Scope creep toward building the GUI debugger** | Explicitly out of scope. If the service is right, the UI is someone else's afternoon. |

---

## 9. Decisions — all settled

Recorded here with rationale so the reasoning survives the choice.

1. ~~**CLI distribution.**~~ **Resolved — shim installation.** The CLI ships inside
   the app download and installs a `6502` shim into `PATH`; no separate install,
   no npm package. Mechanics in §6.3. Better than the npm route I originally
   recommended in one way I'd underweighted: the user needs **no Node runtime at
   all**, because Electron's bundled Node runs the CLI via `ELECTRON_RUN_AS_NODE`.

2. **Repo layout — stay in this repo.** The alternative was a `6502-tools` split. It shares `src/core/`
   It shares `src/core/` directly, and a split would force publishing the core as
   a package before there's any reason to — doubly so now that the CLI ships
   inside the app bundle (§6.3).

3. **MCP server — later, and out of this repo.** The CLI design in §6.1 is
   deliberately agent-usable without MCP: one-shot commands, `--json`, meaningful
   exit codes. Ship that, use it with agents, and let real usage tell us which
   operations deserve to be MCP tools. Building it first would be guessing.

4. **`6502 run` (GUI) detaches by default, `--wait` to block.** Blocking suits
   `npm run` and CI; detaching suits an editor "Run" button, and handing control
   back to the editor is the launcher's main job.

5. ~~**Serial as a second console.**~~ **Resolved — yes.** Confirmed against
   `6502-BIOS/Kernal.asm`: console auto-detection routes to serial when video is
   absent, and serial RX feeds the same input buffer as the keyboard. Folded into
   the design as §5.5; no firmware work needed. This is the largest single
   simplification to the plan.

6. **`--headless` defaults to `--console serial`, and says so on startup.** It's
   the point of headless, but it changes emulated behaviour versus a video boot —
   `CLS`/`LOCATE`/`COLOR` become no-ops — so the CLI announces the mode rather
   than letting someone debug a phantom `CLS` bug. `--console video` and
   `--console both` stay available.

---

## 10. First step

**Phase 1 — release v2.2.1.** Two things, one release:

1. Dirty-sector tracking in `Storage`, skip-the-save-when-clean, sector-granular
   IPC + positional writes in `StorageService`, web path gated on the dirty check.
   Closes the documented audio hiccup and puts the CF delta mechanism in place
   that snapshots need later.
2. `b7b3ce4` (focus-outline CSS fix) is committed but unreleased — it goes out
   with this. Version bump, README *Known Issues* entry removed, tag, and the
   three `dist:*` builds.

Nothing else on `main` is unreleased, so v2.2.1 is exactly these two changes.

Then **Phase 2**: extract `Session` + `Scheduler`, move pacing out of `Machine`,
make slot configuration data, repoint the store, migrate the loop tests, add
`turbo` and `runCycles()`. Nothing user-visible changes; everything after it
becomes possible.
