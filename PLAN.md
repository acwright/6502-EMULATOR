# PLAN — CLI & Remote Debugging

Status: **All phases (1–8) complete** (2026-07-29). Phase 1 shipped as v2.2.1;
Phases 2–8 are on `main`, unreleased. All §9 decisions are settled. `6502 dbg`
and `6502 attach` now drive the desktop app exactly as they drive a headless
instance — same protocol, same method table, verified against the real
packaged app, not just the headless host. `state.save`/`state.load` carry a
whole machine as JSON, and `--rtc` closes the last non-deterministic input to
the engine: three runs of the same ROM at the same cycle budget in three
different timezones now produce byte-identical machines. Phase 9 (docs) is the
only work left, and it does not block a release.

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
| `ProbeVideo` writes `$A5` to VRAM and reads it back; the existing `Empty` card returns `0` for every read | Booting with `io8 = new Empty()` makes the probe fail correctly and triggers serial-console mode. **No new emulator hardware needed** — but `Machine.configure()` hardcodes the slots (§5.7). |
| `Storage.getData()` returns `new Uint8Array(this.storage)` — a 256 MB copy — and Electron then structured-clones it across IPC | Two full-size main-thread copies per autosave. This is the documented audio hiccup, now pinned to a line (§5.12). |

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

**`Snapshot`** — whole-machine save/restore (§5.9, later phase).

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

### 4.3 Electron bridge (Phase 7) ✅

Built as designed, with one refinement `DebugServer` needed to make it
possible at all. It no longer takes a `DebugTarget` and builds its own method
table — it takes either a pre-built `methods` table (the headless launcher's
case: it calls `createMethods()` itself and hands the result over) or a
`dispatch(method, params)` function to forward calls elsewhere, plus a generic
`onEvent()` for push notifications. Main uses `dispatch`; nothing in
`DebugServer` itself knows Electron exists.

Six `DEBUG_*` IPC channels: `start`/`stop`/`status` (renderer-invoked, driving
the Settings toggle), `statusChanged` (main→renderer push), `callRequest` /
`callReply` (main→renderer request, renderer→main answer — Electron has no
built-in "main calls into the renderer and awaits a reply" primitive, so
`DebugBridgeService` in main correlates these itself with an id and a
timeout), and `event` (renderer→main, for `stopped`/`resumed`). Two more,
`readTextFile`/`readBinaryFile`, exist because the renderer has no filesystem
of its own — `sym.load` and `media.load*` need one to resolve a path — so
`DebugTarget.readTextFile`/`readBinaryFile` became `string | Promise<string>`
or Node reads through in the headless host and IPC round trips in Electron.

`RendererTarget` (`src/renderer/src/debug/`) is the Electron-side
`HeadlessTarget`: same interface, `store.session`/`store.machine` instead of a
process it owns outright, `consoleMode()` fixed at `'video'` because
`stores/emulator.ts` never populates io8 with anything else, and no serial
methods at all — the ACIA is present on the bus but nothing routes it to a
console in video mode, so `screen.*` and `input.*` (§5.8) are the real path in
here, not `serial.*`. See §5.13's follow-up below for what actually went wrong
building this.

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
during maintenance. Mitigated by a test asserting agreement for all 256 entries.
Note it checks **modes as well as mnemonics**: the mode determines instruction
length, and a wrong length desynchronises every instruction after it. The CPU's
addressing modes are bound closures, so production code cannot read them — but
`Function.prototype.bind` prefixes the target's name, which a *test* can recover.

Building this table is what surfaced three real CPU defects, since it forced a
line-by-line comparison against the WDC W65C02S datasheet: BBS was misnumbered
from bit 5 up (BBS6 unreachable), WAI sat at `$EB` instead of `$CB`, and fourteen
unused opcodes were treated as one-byte NOPs when the part defines them as two or
three. Fixed in `d77533f`; see `W65C02S.test.ts`.

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

### 5.6 The clock is a tree, not a number

`Machine.frequency` stood in for the whole machine's clock, and every card was
handed it through `tick()`. The real board doesn't work that way: a 16 MHz
oscillator is divided, a jumper selects which tap becomes PHI2 for the 65C02,
6522 and 6551, and **the SID is hard-wired to the fixed 1 MHz tap**. Switching
to 2 MHz was therefore transposing every note up an octave.

Folded in during Phase 2 rather than deferred, for one reason that is about
sequencing rather than tidiness: **Phase 3 publishes `--freq`, and Phase 5
publishes clock state in `session.info`.** Shipping those against a model where
one number means "the clock every card gets" would bake the wrong thing into a
CLI flag and a protocol field, and changing a protocol field later is expensive.

Cards now receive PHI2 and are responsible for dividing it to their own rate.
The SID's default clock is `SID_CLOCK_ACE` — exactly 1,000,000 Hz (16 MHz ÷ 16),
not the C64 NTSC constant it had been using, which was a further 2.3% sharp.

**Machine variants are deliberately not in scope.** ACE, COB, DEV, KIM and VCS
differ in slot population and clock capability — only ACE supports 2 MHz at all
— which makes them a natural extension of §5.7's slot config rather than part of
this fix. Specced as a candidate phase once the per-build details are settled;
until then the emulator models an ACE, and the SID fix is correct for every
build (on the 1 MHz-only boards the divider is simply a no-op).

### 5.7 Slot configuration must become data

`Machine.configure()` hardcodes all eight slots. `--console serial` needs io8
empty, and "does my program handle a missing sound card?" is a legitimate thing to
test against a machine whose real slots are physically populated by the user.

Change `configure()` to take a slot map with the current layout as the default.
Small, mechanical, no behaviour change for existing callers — and it is what makes
§5.5's headless default expressible at all.

### 5.8 Screen scraping and input injection ✅ — the Electron console path

With §5.5 in place these cover the cases where pixels or the video console
genuinely matter: sprites, graphics modes, and — since the desktop app always
populates io8 with a `Video` card (§4.3) — the *only* console path an
Electron-hosted machine has. `screen.*`/`input.*` needed no Electron-specific
plumbing at all in the end: both are ordinary `Methods.ts` functions over
`machine.video()` / `machine.onKeyDown` / `onKeyUp` / `onJoystickA/B`, exactly
like `mem.read {space:'vram'}` already was, so they work identically headless
(`--console video`) and in the desktop app.

- **`screen.text`** — `Video.textGrid()`, a new public method: walks the name
  table at the current mode's column count (40 for text, 32 otherwise) and
  decodes each byte through a **CP437** table (`core/IO/CP437.ts`) — the BIOS's
  actual character generator (`Chars.asm`), confirmed against the BIOS source
  rather than assumed to be plain ASCII. $20-$7E coincides with ASCII; the rest
  ($00-$1F, $80-$FF) are the box-drawing and symbol glyphs CP437 defines there.
- **`screen.hash`** — a cheap frame digest so "wait until the screen changes"
  doesn't require shipping frames. Not a cryptographic hash — see §5.13.
- **`screen.png`** — encodes `Video.buffer`. Also not what §5.8 originally
  specced — see §5.13 for why `node:zlib` didn't survive contact with the
  renderer.
- **`input.key {code, down}`** — raw HID make/break, matching what a real
  keyboard asserts. `input.joystick {side, buttons}`.
- **`input.type {text, cps}`** — text as a paced sequence of keystrokes.
  Needed pacing for the same reason `SerialConsole` does: a keyboard has no
  flow control, and an instantaneous make/break pair can land between two BIOS
  scans and be missed. Paced on the session's chunk cadence, same mechanism,
  new clock (characters per second instead of a baud rate). `ASCII_TO_KEY`
  (`debug/KeyCodes.ts`) is the standard US-QWERTY shift map; a character with
  no US-keyboard key is a parameter error, not a silent wrong keystroke.
  `HID_NAMES` in the same file is now the one copy of the scancode table —
  `useKeyboard.ts` imports it instead of keeping its own.

Demoted from Phase 4 to Phase 7, alongside the GUI work. Done.

### 5.9 Snapshots turn a 5-second boot into a 5-millisecond restore ✅

`state.save` / `state.load` carry CPU registers, RAM, ROM identity, cart, VRAM,
VDP registers, RTC/NVRAM, SID state and the CF card's changed sectors. Built as
designed; the format is plain JSON so it travels over the protocol unchanged and
a person can read one in an editor, and it comes to **about 52 KB** for the
standard slot layout at the BASIC prompt.

`serialize()`/`deserialize()` are **required** members of `IO`, not optional
ones, so a card added later cannot quietly omit snapshot support — a machine
that silently restores seven of its eight slots is worse than one that will not
compile. The shared vocabulary is `core/DeviceState.ts`: base64 for byte arrays,
and readers that refuse a missing or wrong-typed field rather than defaulting
it, because a snapshot is untrusted input and a card that took `undefined` for a
register would leave the machine in a state no real board can be in.

Two things stay out of the file deliberately. The **framebuffers** — 300 KB each,
and every pixel in them is derived from VRAM and the registers, which are in
there; the cost is that `screen.png` shows the previous picture until the machine
has run one more frame, while `screen.text` is right immediately because it reads
the name table. And the **cycle counters**, `Machine.cycles` and `CPU.cycles`:
nothing the machine emulates reads them, they are how the host measures elapsed
time, and rewinding them would make every cycle budget and `wait.for {cycles}`
report negative progress across a restore.

The payoff, measured rather than assumed. Booting to `READY.` costs **5,359,120
cycles** — 5.36 s paced against the wall clock, as the desktop app runs, and
555 ms headless in turbo. A restore is about a millisecond of emulation. So the
"5 seconds to 5 milliseconds" claim holds exactly for the GUI, and for any state
a cold boot cannot reach without replaying all the input. It is worth being
straight about the case where it does not: a headless turbo boot with a leading
CR to skip the BIOS countdown is only 430,560 cycles (51 ms), and a one-shot
`6502 dbg` process spends ~65 ms starting Node either way — so for the shortest
possible test the saving is real but modest, and the win comes from deeper
states, not from the boot.

The CF card was the awkward member, and more awkward than expected — see §5.16.

### 5.10 `wait.for` — the primitive that makes agent scripts non-flaky

A single blocking call with a timeout, matching on any of: breakpoint hit, screen
text matching a regex, serial output matching, N cycles elapsed, PC reaching an
address.

Without this, every agent script becomes a poll loop with `sleep` calls tuned by
guesswork, which is precisely the flakiness that makes agents distrust a tool.
With it, `wait for the screen to show "READY." or fail after 5 emulated seconds`
is one deterministic call. **Design the CLI so the obvious thing to write is the
robust thing.**

### 5.11 Determinism ✅ — both leaks closed

- `Machine`'s `performance.now()` pacing left in the §4.2 refactor (Phase 2).
- `RTC` called `new Date()`. Now takes an injectable clock, and `6502 run --rtc`
  supplies a fixed one. Default stays the host's wall clock, because that is what
  a person using the desktop app expects their clock to say.

**The clock is not a `Date`.** That was the first design, and it was wrong: a
Date is an *instant*, and turning one into the digits a wall clock shows needs a
timezone. Measured directly — `--rtc 2026-03-04T05:06:07Z` on a UTC-6 host gave
an RTC reading 23:06, and would have given something else again on a UTC runner,
so the flag whose entire purpose is reproducibility was itself
timezone-dependent. The injected clock now returns a `ClockReading`: year,
month, date, hours, minutes, seconds, and no timezone at all. `--rtc` refuses a
trailing `Z` or offset rather than silently ignoring it — the emulated clock is a
clock on a desk, not a moment in history.

With both closed, a given ROM + input sequence + cycle budget produces
byte-identical results across runs and machines. Verified end to end rather than
argued: three `6502 run --headless --pause --rtc …` instances driven to exactly
6,000,000 cycles under `TZ=UTC`, `TZ=Asia/Tokyo` and `TZ=America/Chicago`
produced identical snapshots, and the same three runs *without* `--rtc` did not
— which is also the proof that the clock really was the remaining leak.

### 5.12 The autosave audio hiccup — yes, roll it into this work

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
prerequisite for two things this plan needs anyway. Snapshots (§5.9) can't carry a
256 MB CF image and want exactly these deltas. And the headless host will do its
own CF persistence, so it would inherit the identical stall — fixing it later
means fixing it twice. It also derisks Phase 2, which touches the same pacing code
that produces the symptom: fixing the cause first means the Phase 2 refactor is
verified against a machine that isn't already hiccuping.

Sequenced as Phase 1, before the pacing refactor.

### 5.13 What building the server actually taught us

Three things the protocol design in §6.2 did not anticipate. All are settled in
code; they are recorded because Phase 6 is built directly on top of them.

**Waiting on serial output needs a stream cursor, not "from now on".** The
obvious semantic for `wait.for {serial}` — match output produced after the call
— is unusable for the caller this whole plan exists to serve. Each `6502 dbg` is
a separate process, and between the one that writes a command and the one that
waits for its reply the machine runs *hundreds of thousands of emulated cycles*
in turbo. The reply is normally printed, and scrolled out of any "from now"
window, before the wait is even set up. Measured directly: `serial.write` of
`PRINT 2+2` followed by a separate `wait.for OK` timed out at 8 s having seen no
output at all, while `serial.read` showed the machine had answered ` 4` long
before.

The fix is an absolute position in the console stream. The host counts every
byte it has ever emitted; `serial.write` returns the cursor as it stood when the
command went out, `serial.read` accepts `since`, and `wait.for` defaults `since`
to the cursor of the last write. So "wait for the reply to what I just sent" is
correct with no bookkeeping by the caller, and cannot match a prompt printed
before the command. **Phase 6's `6502 dbg send --wait` depends on this**; it must
pass the cursor through rather than re-deriving it.

**A debugger's own reads must not fire the program's watchpoints.** `mem.read`
goes through the bus, and the bus taps are what implement watchpoints — so
inspecting the address a watchpoint covers would stop the machine. `Machine`
gained `peek`/`poke`, tap-free bus access, and every debug path uses them.
The same reasoning gave the CF, VRAM and NVRAM spaces direct accessors: reaching
them through the CPU means a register protocol whose side effects (a moved
address latch, a refilled read-ahead buffer) disturb the thing being inspected.

**Loopback is not a trust boundary against a browser.** §6.4 reasoned about the
network but not about the user's own machine: a listening loopback port is
reachable from every page the browser has open, and a page can fire a
cross-origin POST it never needs to read the reply to — enough for `mem.write`,
or to read the CF image via a side channel. Two guards, both cheap: any request
carrying an `Origin` header is refused unless explicitly allowed, and
`Content-Type: application/json` is required, since that is the one content type
a page cannot set cross-origin without a preflight we never answer.

Two smaller notes. `--pause` has to mean *not started*, because
`Scheduler.start()` runs a whole turbo slice synchronously — pausing after
`run()` returned left the machine 37,000 cycles into the BIOS instead of at the
reset vector. And `Session` grew a listener **set** for the chunk cadence
rather than the single callback it had: the headless host feeds paced input on
it and the server evaluates `wait.for` on it, and forcing one of them onto a
wall-clock timer would have cost the determinism §5.11 is built on.

No dependency was added. The WebSocket server is ~200 lines of RFC 6455, which
is worth it because the client side is free — Node has shipped a standards
`WebSocket` client global since v22, so the CLI in Phase 6 needs nothing either.

### 5.14 What building the CLI client actually taught us

`src/cli/dbg/` — `Connection.ts` (lock file + `--port`/`--host`/`--token`
resolution, `httpCall`), `format.ts`, `Commands.ts` (every method family from
§6.2 except `screen`), plus `src/cli/dbg.ts` and `src/cli/attach.ts`. `dbg` is
one-shot HTTP throughout; `attach` opens one WebSocket for push notifications
(`stopped`/`resumed`/`serial.data`/`log`) and otherwise reuses the exact same
`dispatch()` per typed line, so the two never drift into different behaviour.

Two real bugs, both caught by driving the actual built CLI against a live
server rather than trusting the unit tests alone:

**A two-level command's own sub-command parsing broke as soon as a flag came
first.** `mem write`, `break list`, `sym load` and the rest read their second
word — `write`, `list`, `load` — by destructuring `argv[0]`. That is exactly
what `attach` hands them: `--port 45060 --host 127.0.0.1 --token … list` for
a typed `break list`, since the connection is resolved once and prepended to
every line. `break list` came back "no symbol named \"list\"" — it had fallen
through to *setting* a breakpoint at an address called `list`. Fixed with
`extractSubcommand()`, which skips known connection flags (and their values)
to find the real sub-command wherever it sits, rather than assuming position
0. This means every two-level command in `attach` was non-functional until a
live REPL session was actually driven end-to-end; nothing in the unit tests
caught it, because those called `dispatch()` with arguments already in the
right order.

**`attach`'s live-notification listener crashed the process on exit.**
Closing a `WebSocket` still mid-handshake fires an asynchronous `error` event
of its own — a self-inflicted abort, not a real connectivity problem — and
that event was arriving *after* readline had already closed, from typing
`exit` while a slow `wait.for` was still in flight. Redrawing a prompt on a
closed interface throws `ERR_USE_AFTER_CLOSE` and takes the process down.
Fixed two ways: a `stopping` flag that every async callback checks before
touching the interface, and pausing the interface while a command is running
so a later `exit` can't fire mid-command in the first place — which also
makes `attach` do the right thing generally, not just avoid a crash: commands
now run one at a time, the way a person typing them would get by construction.

The exit codes are as specified: `0` ok, `1` usage or RPC error, `2`
`wait.for`/`send --wait` timed out, `3` no emulator found, `4` `step`/`run`/
`runTo`/`runCycles` stopped on a breakpoint or watchpoint. `screen`/`input` CLI
commands were added in Phase 7 alongside the protocol methods themselves.

### 5.15 What building the Electron bridge actually taught us

**`createMethods()` running in the renderer meant it had to be browser-safe,
and it wasn't.** `screen.png` used `node:zlib`'s `deflateSync`, and
`screen.hash` used `node:crypto`'s `createHash` — both fine under the headless
host's plain Node, both unavailable in a browser context. `npm run build`
failed outright (Rollup couldn't resolve `node:zlib`) the first time the
renderer actually tried to import `Methods.ts` through `RendererTarget`. Fixing
it by widening the renderer's `vite-plugin-node-polyfills` config was the
obvious move and the one *not* taken: those polyfills wrap old, arguably
unmaintained shims of uncertain API surface, and `zlib.crc32` in particular is
recent enough in Node itself that a polyfill package carrying it was a real
question, not a formality. Wrote it out instead — `debug/Checksums.ts` (CRC-32
and Adler-32, ~40 lines) and rewrote `PNG.ts`'s zlib stream as hand-assembled
DEFLATE "stored" (uncompressed) blocks per RFC 1951 §3.2.4, which a real
decoder reads identically to a compressed one. `screen.hash` moved to the same
CRC-32 — it was never a security-relevant digest, just "did the screen
change," so losing SHA-1 cost nothing. Net effect: `Methods.ts` now imports
zero Node built-ins, works unmodified in Node and in a browser bundle, and the
CRC-32 implementation is cross-checked in its own test against `node:zlib`'s —
same algorithm, independently written, so the test is a real assertion and not
tautological.

**The CLI silently shipped without the CLI in it.** `npm run pack` succeeded,
the app launched, `6502 --version` even ran — but `Install '6502' command in
PATH` installed a shim pointing at a file that didn't exist in the package,
because `electron-vite build` clears `out/` and nothing rebuilt `out/cli`
afterward. Only caught by actually listing the packed asar's contents
(`asar list app.asar | grep cli`) and finding nothing — every earlier signal
(the build succeeding, the app running) looked fine. `build` now chains
`build:cli` after `electron-vite build`, not before.

**Vue's lifecycle hooks are sensitive to `await` in a way that bit
`useDebugBridge`.** `onUnmounted()` — needed to tear down the IPC listener and
session subscriptions — only registers correctly while a component's setup is
still synchronously "active"; called from inside an `async` function after its
first `await`, Vue has already moved on and the registration silently no-ops
(a dev-mode warning, easy to miss). The composable calls `onUnmounted` exactly
once, synchronously, at the top level — the same place `useKeyboard()` already
does it — and defers the actual wiring (which needs `store.session`, not yet
set at that point) to a `watch()` callback, collecting its cleanups into an
array the one `onUnmounted` closes over.

**`input.type` needs the same "don't send until the machine is actually
listening" discipline `serial.write` does, and for the same reason.** Typing
`PRINT 2+2` immediately after boot, with no gate, delivered `INT 2+2` — the
first two characters lost to the BIOS splash's own input-swallowing window
(§5.5), just on the keyboard/encoder path instead of the ACIA's. Not a pacing
bug in `input.type` itself: sending the same text *after* polling `screen.text`
for the prompt to actually appear (the keyboard-path equivalent of
`--input-after`) delivered every character correctly, confirmed by pressing
Enter afterward and reading back the computed result. Recorded here because it
is easy to mistake for a bug in the new code when it is really the established
boot-sequence behaviour showing up on a second input path.

Verification for this phase went further than usual because so much of it is
OS integration that a unit test cannot reach: packaged the app for real
(`electron-builder --dir`), launched the actual binary, drove it over CDP to
call `window.api.debug.start()`, then pointed the real `6502 dbg`/`6502
attach` at the resulting port — registers, breakpoints, memory, `screen.text`,
a real `screen.png` opened and visually confirmed, `input.type` typing into
the live on-screen BASIC prompt and reading the result back, `attach`'s push
notifications firing from the real session, then the CLI shim installed from
the Settings action, run from `/usr/local/bin/6502` in a clean shell, and
uninstalled again.

### 5.16 What building snapshots actually taught us

**A dirty-sector set is not enough for the CF card; it needs a copy-on-write
baseline.** §5.9 assumed Phase 1's delta mechanism would carry straight over. It
does not, for two independent reasons. Phase 1's dirty set is *cleared every time
a save succeeds*, so it cannot answer the question a snapshot asks — which
sectors differ from the image this card was loaded with. And even a set that was
never cleared would not be enough to make a restore mean isolation: a test case
that writes sector 900 *after* the snapshot was taken leaves that sector out of
the snapshot entirely, so re-applying only the snapshot's sectors keeps the later
contents and the next test case starts from a card the previous one dirtied.
Restoring per test case would then be worse than not snapshotting at all, because
the contamination is invisible. The fix is a journal of each sector's contents
*before* its first write, so a restore can revert the union of what the snapshot
knows about and what has happened since. It is bounded by how much the program
actually writes — a BASIC session that never touches disk journals nothing — and
it means every mutation path has to go through one function, which is now
`touchSector()`, called before the mutation rather than after.

**Making `serialize`/`deserialize` required immediately proved its worth.**
Adding them to the `IO` and `Attachment` interfaces as required members broke two
test fakes on the spot. That is the mechanism working: the same compile error will
find a real card that forgets snapshot support, which is exactly the failure mode
that would otherwise ship as "restores fine except for the sound".

**The slot layout has to be checked before anything is written.** Each card's
`deserialize` validates its own `kind`, but discovering the mismatch at io8 means
io1–io7, RAM and the CPU have already been replaced. The check is hoisted, and
`kind` became a `readonly` field on `IO` rather than something recovered by
serializing a card to see what comes out — partly so the check is free, partly
because a bundler is free to mangle a class name and a snapshot taken by the
desktop app has to be readable by the headless host.

**A restore cannot happen under a running scheduler.** `Scheduler.start()` runs a
whole slice synchronously, and a slice part-way through an instruction would
finish that instruction against the restored state. `Session.loadState()` stops
first and resumes in whatever mode it found, the same contract `reset()` already
had — and it drops any breakpoint hit that was noticed but not yet delivered,
because that hit belongs to the program that was running a moment ago and its
address means something else now.

**The day-of-week register was wrong, and a fixed clock is what exposed it.**
`RTC` computed it as `getDay() === 0 ? 1 : getDay()`, which puts Sunday and Monday
both at 1 and leaves every other day one short of the DS1511's documented
numbering. Invisible while the clock came from `new Date()`, because nothing could
assert on a weekday that changed daily; obvious the moment `--rtc` made the date
fixed. Now derived from the calendar date through `Date.UTC`, so it is
timezone-free and cannot disagree with the date beside it.

Verification went beyond the unit tests again, because the claims are about a
real BIOS rather than about the code: booted the actual CLI to the BASIC prompt,
saved, set `A=5` and read it back, restored, and confirmed `PRINT A` gave `0` —
BASIC's variable table genuinely rolled back, not just the registers. Then the
determinism runs in §5.11, and the boot-cost measurements in §5.9.

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

# Boot once, then restore per test case rather than re-booting (§5.9)
6502 dbg state save ready.state
6502 dbg state load ready.state

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
| `serial` | `write`, `read`, `config` (+ `serial.data` notification) — **the primary console channel, §5.5** |
| `trace` | `start`, `stop`, `read` |
| `state` | `save`, `load` |
| `wait` | `for` |

Server→client notifications: `stopped`, `resumed`, `serial.data`, `screen.frame`
(opt-in), `log`.

**Shipped in Phase 5:** `session`, `exec`, `bp`, `reg`, `mem`, `disasm`, `sym`,
`media`, `serial`, `wait` — plus the `attached`, `stopped`, `resumed`,
`serial.data` and `log` notifications. **Shipped in Phase 7:** `screen`
(`text`/`hash`/`png` — `png` shipped, `screen.frame` push did not, nothing
needed it yet) and `input` (`key`/`joystick`/`type`). **Shipped in Phase 8:**
`state` (`save`/`load`). Still deferred: `trace` (no phase yet — nothing has
asked for it). `serial.setConsole` was dropped — the console device is decided by whether a video card is in io8
at boot (§5.5), so changing it at runtime would mean re-seating a card while
the BIOS is running.

Two conventions worth stating because clients depend on them. Byte payloads are
**base64** on the wire (`mem.read`, `mem.write`, `serial.write` with
`encoding: base64`), with `mem.write` also accepting a plain array so a shell
one-liner stays writable by hand. And **anywhere an address is accepted**, all of
`49152`, `"$C000"`, `"0xC000"` and a symbol name work.

### 6.3 CLI packaging — shipped inside the app, installed as a shim ✅

**Decided: the CLI comes with the emulator download.** No separate install, no npm
package. The app installs a `6502` shim into `PATH`, the way VSCode installs `code`.

The mechanism that makes this clean: **Electron already bundles Node.** Launching
the app binary with `ELECTRON_RUN_AS_NODE=1` runs it as a plain Node interpreter,
so the shim is:

```sh
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "/Applications/6502 Emulator.app/Contents/MacOS/6502 Emulator" \
  "/Applications/6502 Emulator.app/Contents/Resources/app.asar/out/cli/index.js" "$@"
```

One path corrected from the original sketch: the CLI entry is at
`Resources/app.asar/out/cli/index.js`, **with the `out/` segment**, not
`Resources/cli/index.js`. `electron-builder.yml`'s `files: [out/**/*]` packs
`out/` into the asar preserving that path — confirmed by listing the actual
archive (`asar list`) against where `main`'s own entry provably lands (Electron
already loads it correctly), rather than assumed.

**The user needs no Node installed at all**, and the CLI version can never drift
from the app version — literally the same file both ways now: the CLI's
`--version` used to read `npm_package_version`, an env var that exists only
under `npm run` and printed `dev` for anyone using the installed shim. Fixed by
reading `package.json` next to the compiled file instead (`cli/version.ts`),
which resolves correctly in a checkout and inside the asar for the same reason
the shim path does.

Two useful consequences fall out of this:

- The CLI knows its own location, so it can resolve the app binary **relative to
  itself** and `exec` it directly with argv. That sidesteps the per-platform
  "launch an installed app with arguments" problem entirely — no `open -a` on
  macOS mangling arguments, no protocol handler.
- The headless host runs under Electron's Node, so `src/core/` needing no Node
  built-ins beyond the basics stays a hard requirement, not a preference — and
  turned out to matter more than expected once `createMethods()` also had to
  run in the *renderer*, a browser context with no Node at all. See §5.13.

Per-platform install, since the desktop conventions differ:

| Platform | Where the shim goes | When | Status |
|---|---|---|---|
| macOS | `/usr/local/bin/6502`, falling back to `~/.local/bin/6502` with a PATH hint if unprivileged | In-app action — a DMG drag-install runs no installer, so it can't happen automatically | ✅ Built and verified end to end: installed from a live packaged app, ran `6502 dbg`/`6502 --version` from the installed path, uninstalled cleanly. |
| Windows | `6502.cmd` in the install dir; NSIS adds that dir to `PATH` | Install time, opt-in checkbox (`nsis.include` custom script) | Not implemented. `CliShimService.status()` reports `managedByInstaller: true` so the Settings action correctly shows nothing to do rather than a broken button; the NSIS script itself is future work. |
| Linux `.deb` | symlink in `/usr/bin` from `postinst` | Install time | Not implemented, same reasoning as Windows. |
| Linux AppImage | In-app action — an AppImage has no install step | On demand | `CliShimService` writes the same shim shape as macOS and should work unmodified (`process.resourcesPath` resolves the same way inside an AppImage's mount), but this has not been run on Linux — no `arm64`/`x64` Linux environment available in this session. |

So: a **Settings panel action** (`Install '6502' command in PATH`, with status
text and a matching uninstall) — done for macOS, honest about the rest.

Build changes: `build:cli` now runs as part of `npm run build` (`"build":
"electron-vite build && npm run build:cli"`), not a separate step to remember.
It has to run *after* `electron-vite build`, not before or in parallel —
electron-vite clears `out/` on its way in, and building the CLI first just
meant packaging silently shipped an app with no `6502 dbg` inside it at all,
caught by listing the packed asar rather than assuming the build graph was
right. `pack`/`dist:mac`/`dist:win` already relied on a prior `npm run build`
(an existing, undocumented convention this repo already had); `dist-linux.sh`
calls `npm run build` itself inside its Docker container. One change covers
all four. Dev workflow stays direct — `npm run cli -- run foo.prg`.

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
- **Refuse any request carrying an `Origin`**, and require
  `Content-Type: application/json`. Added in Phase 5 — see §5.13. Loopback is not
  a trust boundary against the browser the user already has open.
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
| **1** ✅ | **Persistence fix → released as v2.2.1** | Dirty-sector tracking in `Storage`, skip-when-clean, `STORAGE_SAVE_CF_SECTORS` + coalesced positional writes, web path gated on dirty — plus the previously unreleased focus-outline fix (`b7b3ce4`) | §5.12. Shipped 2026-07-29 in `64aacc8`. Closed the audio hiccup and laid the CF delta mechanism snapshots need. |
| **2** ✅ | **Session extraction** | `src/debug/Session.ts` + `Scheduler`; pacing out of `Machine`; store delegates; `turbo` mode; `runCycles()`; slot config (§5.7); SID clock tree (§5.6) | Done in `698044b` + `1a19c95`. Engine measured at ~9.7 MHz — roughly 5x realtime headroom at 2 MHz. |
| **3** ✅ | **Headless host + CLI launcher** | `src/host/headless`, `bin/6502`, `6502 run --headless --console serial` with stdio wired to the ACIA, all load verbs, `--turbo`, `--max-cycles`, exit conditions | Done. Boot to the BASIC prompt in ~50 ms / 450k cycles. Two things the spec missed: input has to be **baud-paced in emulated cycles** or it overruns the BIOS's 256-byte input buffer, and **LF must be translated to CR** or BASIC never sees a line ending. |
| **4** ✅ | **Debug core** | Breakpoints, watchpoints, step over/out, disassembler + opcode table + drift test, symbol loaders (VICE, ca65 `.dbg`), condition expressions | Done. Unarmed throughput measured unchanged at 10.6 MHz. Building the opcode table surfaced three real CPU defects (§5.2). |
| **5** ✅ | **Server + protocol** | JSON-RPC over WS + HTTP one-shot, notifications, token auth, lock file | Done. Headless host only. Three things the spec missed — see §5.13. |
| **6** ✅ | **CLI as debug client** | `6502 dbg <cmd>` one-shots, `6502 attach` REPL, `--json`, exit codes, `wait.for` | Done. **The milestone agents actually use.** Two real bugs found in testing — see §5.13's follow-up below. |
| **7** ✅ | **Electron integration + packaging** | `DEBUG_*` IPC bridge, server in main process, Settings toggle + "listening on :N"; `screen.text/hash/png` + `input.key/joystick/type` (§5.8); **CLI shim packaging (§6.3)** — `cli` build entry, Settings "Install CLI" action | Done. Human-in-the-loop debugging, and the first build where `6502` exists on a user's `PATH` — macOS verified end to end; Windows/Linux installer hooks not built (§6.3). Three things the design missed — see §5.15. |
| **8** ✅ | **Snapshots + determinism** | `serialize()`/`deserialize()` on all I/O cards and VIA attachments, versioned JSON format, `state.save/load` (CF as sector deltas over a copy-on-write baseline), injectable RTC clock, `--rtc` | Done. ~52 KB per snapshot; a 5.36 s boot becomes a ~1 ms restore. Determinism verified across three timezones. Three things the design missed — see §5.16. |
| **9** | **Docs & recipes** | README section, `docs/DEBUG-PROTOCOL.md`, a `CLAUDE.md`-style agent recipe file, worked examples | An agent-facing usage guide is part of the product here, not an afterthought. |

Phase 1 ships on its own as **v2.2.1**, a bug-fix release. Phases 1–3 are a
meaningful feature release. Phases 1–6 are the whole point.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| **Breakpoint checks slow the emulator for everyone** | Fast path when nothing is armed; benchmark before/after in Phase 4 and treat a regression as a blocker. |
| **Session extraction regresses the GUI** (audio timing is already delicate) | Sequencing Phase 1 first removes the existing hiccup, so the Phase 2 refactor is verified against a clean baseline. Keep `realtime` behaviour byte-identical; confirm with the existing queue-trim logging before adding `turbo`. |
| **Dirty-sector tracking loses CF writes** — a silent data-loss bug is far worse than an audio glitch | Every mutation path in `Storage` must mark dirty; they now all funnel through `touchSector()`, which marks dirty *and* journals the baseline (§5.16), so a new path that forgot both would fail the same test. Test: random write pattern → save → reload → full-image compare. |
| **Video-absent boot diverges from video boot** (`CLS`/`LOCATE`/`COLOR` no-op) | CLI announces the console mode on startup; `--console both` available when a test needs video present *and* serial output. |
| **Two opcode tables drift** | Equality test across all 256 entries. |
| **Protocol churn once a real client exists** | Version `session.info` from day one; the first client is our own CLI, so breaking changes are cheap until an external app ships. |
| **Snapshot format instability** | ✅ `format` and `version` fields, checked before anything is applied, and an exact-match reject rather than a best effort — a machine assembled from most of a snapshot fails in ways nobody can reason about. |
| **A snapshot restore silently leaves the CF card dirtied by the previous test**, so per-test-case restores stop meaning isolation | ✅ Copy-on-write baseline journal, so a restore reverts sectors written *after* the snapshot as well as re-applying the ones in it (§5.16). Test: write, snapshot, write more, restore, compare the whole image. |
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

## 10. Next step

**Phase 9 — docs and recipes.** Everything in §1 is built; what is missing is
the part that makes it findable. Three pieces:

1. A README section, and `docs/DEBUG-PROTOCOL.md` covering the method families in
   §6.2 — the address/base64 conventions, the `serial.write` → `wait.for` cursor
   contract (§5.13), and the exit codes.
2. An agent-facing recipe file, which §7 calls part of the product rather than an
   afterthought. The two flows worth writing out in full are boot-snapshot-restore
   per test case (§5.9) and `--rtc` for a reproducible run (§5.11), because both
   are the difference between a test suite an agent trusts and one it doesn't.
3. Worked examples in the repo, exercised by CI so they cannot rot.

Then a release. Phases 2–8 are all on `main` unreleased, and together they are a
feature release rather than a bug fix: the CLI, the debug protocol, the desktop
app's debug server and the `6502` shim on `PATH` are all new since v2.2.1.

Still deliberately unbuilt, and recorded so the gaps are not mistaken for
oversights: `trace` (§6.2 — nothing has asked for it), the Windows NSIS and
Linux `.deb` shim hooks (§6.3), machine variants beyond ACE (§5.6), and the
MCP server and GUI debugger, which §9 keeps out of this repo on purpose.
