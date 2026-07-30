# The debug protocol

A running emulator — headless or the desktop app — can serve a JSON-RPC 2.0
service on a loopback port. `6502 dbg` and `6502 attach` are clients of it, and
so is anything else that can make an HTTP request.

This document is the reference. For the *shape* of a useful session, see
[AGENTS.md](AGENTS.md); for scripts that really run, see
[../examples/](../examples/).

- [Turning it on](#turning-it-on)
- [Finding it](#finding-it)
- [Transport](#transport)
- [Security](#security)
- [Conventions](#conventions)
- [Methods](#methods)
- [Notifications](#notifications)
- [Errors](#errors)

---

## Turning it on

Off unless asked for. A shipped GUI never opens a socket on its own.

```sh
# Headless
6502 run --headless --debug
6502 run --headless --debug --debug-port 9000 --debug-host 127.0.0.1

# Desktop app
Settings → DEBUG SERVER → Start
```

`--pause` starts the machine stopped at its reset vector, which is how a debugger
attaches before the BIOS has run an instruction. It means *not started*, not
started-and-then-stopped.

## Finding it

A server publishes where to reach it, so a client needs no configuration:

```jsonc
// ~/.6502/session.json — mode 0600, because it holds the token
{
  "pid": 41234,
  "host": "127.0.0.1",
  "port": 51655,
  "token": "…64 hex characters…",
  "started": "2026-07-29T18:22:04.113Z",
  "version": "2.2.1",
  "host_kind": "headless",   // or "electron"
  "cwd": "/Users/you/project"
}
```

`$SIXTY5O2_HOME` moves the directory. The lock is removed on a clean shutdown,
and a stale one left by a killed process is detected — the `pid` is checked — so
a client fails with "no running emulator" rather than timing out against a dead
port.

Only one instance can own the lock. For a second, pass `--debug-port` when
launching and `--port` when connecting.

## Transport

Two shapes on one port, for two kinds of caller.

**`POST /rpc`** — one-shot. This is what an agent wants: every `6502 dbg`
invocation is a separate process with no session to resume, and making it
complete a WebSocket handshake to ask for the registers would be ceremony.

```sh
curl -X POST http://127.0.0.1:51655/rpc \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"reg.get"}'
```

**WebSocket** on the same port — for anything that stays attached, because only a
connection can receive [notifications](#notifications). Node has shipped a
standards `WebSocket` client since v22, so a client needs no dependency:

```js
const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`)
```

The token goes in the query string there because the WHATWG WebSocket API cannot
set request headers. On connect the server immediately sends an `attached`
notification carrying the protocol version, so a client learns what it is talking
to without a round trip.

Batches work: send an array, get an array back. Requests without an `id` are
notifications — they run, and nothing is returned, not even on failure.

## Security

The desktop app opens a listening socket, so this is not optional.

| Guard | Behaviour |
|---|---|
| Bind address | `127.0.0.1` unless `--debug-host` says otherwise |
| Token | Generated per session, published in the lock file. Required on any non-loopback bind; optional from loopback, where anything that could read the token could equally attach a debugger to the process |
| `Origin` | **Any request carrying one is refused** unless explicitly allowed |
| `Content-Type` | Must be `application/json` |
| Body size | Capped; a larger body is refused before being buffered |
| Off by default | `--debug`, or the Settings toggle |

The `Origin` and `Content-Type` rules are the load-bearing pair, and they are
about the browser rather than the network. A loopback port is reachable from every
page the user has open, and a page can fire a cross-origin POST whose reply it
never needs to read — enough to call `mem.write`, or to read the CF image through
a side channel. `application/json` is the one content type a page cannot set
cross-origin without a preflight, which this server never answers.

Note what the protocol deliberately does expose: `mem.write` and `media.load*`
alter the machine, and `mem.read {space:'cf'}` reads file contents off the CF
image. Loopback, opt-in and a token is the right posture for that; exposing it
beyond the machine is a deliberate act.

## Conventions

**Addresses.** Anywhere an address is accepted, all of these work — `49152`,
`"$C000"`, `"0xC000"`, and a symbol name once `sym.load` has run.

**Bytes.** Base64 on the wire. `mem.write` and friends also accept a plain array
of numbers, so a shell one-liner stays writable by hand.

**Memory spaces.** `mem.*` takes a `space`:

| Space | What it is |
|---|---|
| `cpu` | The 64K the processor sees, through the address decode — so it reflects cartridge banking and reads I/O registers as the program would. Wraps at 64K. Default. |
| `ram` | The 32K RAM chip directly. Agrees with `cpu` below `$8000`. |
| `rom` | The ROM image, offset from `$8000`. **Writable** — patching it is how you try a fix without rebuilding, which a `cpu`-space write cannot do because the hardware ignores it. |
| `vram` | The video card's 16K, bypassing the address-latch protocol. |
| `nvram` | The clock chip's 256 battery-backed bytes. |
| `cf` | The CF card image. |

The device spaces refuse an offset past their end rather than wrapping: running
off the end of VRAM is a mistake, and silently reading from the start would hide
it. They are also reached directly rather than through the CPU, because the
register protocols have side effects — a moved address latch, a refilled
read-ahead buffer — and an inspection must not disturb what it is inspecting.

**A debugger's own reads do not fire watchpoints.** `mem.read` goes around the bus
taps, so inspecting the address a watchpoint covers does not stop the machine.

**Emulated time, not wall time.** `wait.for` conditions are evaluated on the
machine's own execution cadence, so `cycles` and `expression` land at the same
point in a program however fast the host is.

---

## Methods

### session

| Method | Params | Returns |
|---|---|---|
| `session.info` | — | `protocol`, `host`, `version`, `console`, `frequency`, `baudRate?`, `cartridge`, `symbols`, plus [run state](#run-state) |
| `session.reset` | `cold?` (default `true`) | Run state |
| `session.config` | `frequency?` (1000000 or 2000000), `baudRate?` | `frequency`, `baudRate?`, `console` |
| `session.shutdown` | — | `{ok:true}`, then the host winds down |

`session.shutdown` answers before exiting, so the caller sees a result rather
than a dropped socket.

<a name="run-state"></a>Most methods return the machine's run state alongside
their own result: `mode` (`paused`/`realtime`/`turbo`), `running`, `cycles`, and
`registers` (`A X Y PC SP P`, plus `flags` broken out).

### exec

| Method | Params | Returns |
|---|---|---|
| `exec.state` | — | Run state |
| `exec.run` | `mode?` — `realtime` or `turbo` (default) | Run state |
| `exec.pause` | — | `stop` + run state |
| `exec.step` | `kind?` — `instruction` (default), `cycle`, `over`, `out`; `count?` | `stop` + run state |
| `exec.runCycles` | `cycles` | `stop` + run state |
| `exec.runTo` | `address`, `mode?`, `timeoutMs?` | `stop` + run state |

`stop` is one of:

```jsonc
{ "kind": "paused" }
{ "kind": "step" }
{ "kind": "cycle-budget", "cycles": 50000 }
{ "kind": "breakpoint",  "id": 1, "address": 49152 }
{ "kind": "watchpoint",  "id": 2, "address": 1024, "access": "write" }
{ "kind": "trap", "detail": "…" }
```

`exec.runTo` on the address the PC already sits at runs a full lap rather than
returning immediately, so run-to-cursor inside a loop does something useful. It
removes its temporary breakpoint however it exits.

`step over` and `step out` track call depth across `JSR` and `RTS`/`RTI`. Hand-rolled
stack manipulation can desynchronise that, so they are bounded and report a
`trap` rather than hanging.

### bp

| Method | Params | Returns |
|---|---|---|
| `bp.set` | `address`, `kind?` (`exec` default, `read`, `write`, `access`), `end?`, `condition?`, `ignoreCount?`, `temporary?`, `enabled?` | The breakpoint |
| `bp.clear` | `id?` — omit to clear all | `{cleared: n}` |
| `bp.list` | — | `{breakpoints: [...]}` |
| `bp.enable` / `bp.disable` | `id` | The breakpoint |

A breakpoint stops *before* the instruction at its address. `end` makes a
watchpoint cover a range.

**Conditions** are a small expression language, evaluated only after an address
has already matched — so their cost never touches the hot path:

```
A == $FF
X != 0 && [$0400] > 10
PC >= main
{$0300} == $C000        // a 16-bit little-endian read, for a pointer
```

Registers `A X Y PC SP P ST`; `[expr]` reads a byte, `{expr}` a word; `$`/`0x`
hex, bare digits decimal; the usual arithmetic, comparison, bitwise and logical
operators. Bare identifiers resolve as symbols.

**An emulator with nothing armed runs exactly as fast as one that has never heard
of breakpoints** — execution breakpoints live in a 64K bitmap and watchpoint bus
taps are attached only while a watchpoint exists.

### reg

| Method | Params | Returns |
|---|---|---|
| `reg.get` | — | `A X Y PC SP P`, `flags` |
| `reg.set` | any of `A X Y SP P PC` | The registers |

Setting `PC` abandons the instruction in flight, so the next tick does not finish
the old one against the new address.

### mem

| Method | Params | Returns |
|---|---|---|
| `mem.read` | `space?`, `address`, `length?` (default 1) | `space`, `address`, `length`, `data` (base64) |
| `mem.write` | `space?`, `address`, `data` | `written` |
| `mem.fill` | `space?`, `address`, `length`, `value` | `written` |
| `mem.search` | `space?`, `pattern`, `start?`, `end?`, `limit?` | `matches`, `truncated` |

`mem.search`'s `pattern` takes base64, a byte array, or plain text.

### disasm

| Method | Params | Returns |
|---|---|---|
| `disasm.at` | `address?` (default PC), `count?` (default 8) | `instructions` |
| `disasm.range` | `start`, `end` | `instructions` |

Each instruction carries `address`, `bytes`, `name`, `mode`, `operand`, `target?`,
`label?`, `documented`, and a pre-rendered `text` line so a client need not
reimplement formatting. `documented` is false for an opcode the W65C02S does not
define.

### sym

| Method | Params | Returns |
|---|---|---|
| `sym.load` | `path` or `text`, `format?` (`vice`/`ca65`), `merge?` | `format`, `loaded`, `total` |
| `sym.lookup` | `address` | `name?`, `offset?`, `file?`, `line?` |
| `sym.resolve` | `name` | `address` |
| `sym.list` | `prefix?`, `limit?` | `symbols`, `total`, `truncated` |

VICE label files (`al C:0800 .start`) and ca65 `.dbg` files. The format is
inferred from the extension when not given. Loaded symbols become usable
everywhere an address is accepted, including in breakpoint conditions.

### media

| Method | Params | Returns |
|---|---|---|
| `media.loadROM` | `path` or `data` | `bytes` + run state |
| `media.loadCart` | `path` or `data` | `bytes` + run state |
| `media.unloadCart` | — | Run state |
| `media.loadProgram` | `path` or `data` | `bytes`, `pointersApplied` |
| `media.loadBinary` | `address`, `path` or `data` | `address`, `bytes` |

`path` is read by the *host*, which may be a packaged app in another directory —
pass `data` when that is not what you want. Loading a ROM or cart resets the
machine, because the reset vectors just changed underneath the CPU.

`media.loadProgram` also fixes up BASIC's end-of-program pointers, which is what
stops the first variable assignment landing on top of a `.prg`'s machine code.

### serial

The primary console channel for a machine booted without a video card, which is
what `--headless` does by default.

| Method | Params | Returns |
|---|---|---|
| `serial.write` | `data`, `encoding?` (`text` default, `base64`) | `queued`, `cursor` |
| `serial.read` | `since?`, `max?`, `clear?` | `data`, `length`, `cursor`, `truncated` |
| `serial.config` | — | `console`, `baudRate?`, `frequency` |

**The cursor is the important part.** It is an absolute position in the console's
output stream, and `serial.write` returns where the stream stood when the command
went out. Pass it back as `wait.for {since}` and "wait for the reply to what I
just sent" is correct with no bookkeeping — which matters because in turbo the
machine covers hundreds of thousands of cycles between two one-shot calls, and the
reply is normally printed before a wait could even be set up. `wait.for` defaults
`since` to the last write's cursor for exactly this reason.

Text writes translate `\n` to CR, because that is what a terminal sends for Enter
and what BASIC ends a line on.

Input is paced at the serial line rate, measured in emulated cycles — so a pasted
program cannot overrun the BIOS's 256-byte input buffer, and it lands at the same
point in the program whatever speed the host runs at.

### screen

For a machine that has a video card. `--headless --console video` gives one; the
desktop app always has one.

| Method | Params | Returns |
|---|---|---|
| `screen.text` | — | `lines` — the name table decoded through CP437 |
| `screen.hash` | — | `hash` — a cheap frame digest |
| `screen.png` | — | `width`, `height`, `data` (base64 PNG) |

`screen.text` decodes through CP437 because that is what the BIOS's character
generator actually is; `$20`–`$7E` coincides with ASCII and the rest are the
box-drawing and symbol glyphs. `screen.hash` is CRC-32 — enough for "did the
screen change", and not a security claim.

### input

The HID path: for programs driven by the keyboard matrix or a joystick, and the
only console path a video-console machine has.

| Method | Params | Returns |
|---|---|---|
| `input.key` | `code` (HID code or name), `down?` (default true) | `code`, `down` |
| `input.joystick` | `side?` (`a`/`b`), `buttons` — a mask or names | `side`, `buttons` |
| `input.type` | `text`, `cps?` (default 20) | `typed` |

Button names: `up down left right a b select start`.

`input.type` paces keystrokes in emulated cycles for the same reason the serial
console does: a keyboard has no flow control, and an instantaneous make/break pair
can land between two BIOS scans and be missed. It needs a running machine.

### state

Whole-machine snapshots. See [AGENTS.md](AGENTS.md#restore-instead-of-rebooting)
for why this is the biggest lever available to a test loop.

| Method | Params | Returns |
|---|---|---|
| `state.save` | — | `state` (the snapshot), `version`, `bytes` |
| `state.load` | `state` or `path`, `force?` | `version`, `romMismatch?` + run state |

The snapshot is plain JSON, around 52 KB for the standard slot layout. No host
here can write files, so `state.save` hands the snapshot back and saving it is the
caller's business — which is also what you want, because the emulator may be a
packaged app in another directory.

A snapshot is checked before it is applied and refused rather than half-applied:
wrong `format`, a `version` this build does not read, a different slot layout, or
a ROM whose checksum does not match. `force` overrides only the ROM check —
occasionally right, when replaying a saved state against a patched BIOS.

The ROM is stored by identity (length and CRC-32) rather than content, since the
host loads it anyway; a cartridge is stored in full, because it can be swapped at
runtime and its bytes may not be findable again. Two things are deliberately
absent: the framebuffers, which are derived from VRAM and would multiply the file
by nine, and the cycle counters, which the host uses to measure elapsed time and
nothing emulated reads.

### wait

| Method | Params | Returns |
|---|---|---|
| `wait.for` | at least one of `serial`, `stopped`, `cycles`, `expression`; plus `since?`, `run?`, `timeoutMs?` (default 10000) | `matched`, `reason`, `cycles`, `elapsedCycles`, `elapsedMs`, `output?`, `stop?` + run state |

One blocking call instead of a poll loop with sleeps tuned by guesswork — which is
the flakiness that makes an agent distrust a tool.

- `serial` — a regex over console output, from `since` (default: the last write's
  cursor).
- `stopped` — a breakpoint, watchpoint or pause. **A machine that has already
  stopped satisfies this**, which for a one-shot caller is the normal case rather
  than an edge one: the breakpoint armed by one command has usually fired before
  the next command connects. Combined with `run`, it means "continue, and tell me
  when it stops again".
- `cycles` — emulated cycles from now.
- `expression` — the same language breakpoint conditions use.
- `run` — resume in this mode first, for waiting on a paused machine.

A timeout is reported as `matched: false`, not as an error.

---

## Notifications

Server to client, over WebSocket only.

| Notification | Params | When |
|---|---|---|
| `attached` | `protocol`, `host`, `version` | On connect |
| `stopped` | `stop` | The machine stopped advancing |
| `resumed` | `mode` | It started again |
| `serial.data` | `data` | The console produced output (coalesced per turn) |
| `log` | `message` | A connection-level problem |

`stopped` and `resumed` fire for transitions this client did not cause — another
client resuming the session, or a breakpoint firing — so a UI can track state
without polling. They arrive in the true order: a breakpoint that fires inside the
slice `exec.run` starts synchronously is reported *after* the `resumed` that
preceded it.

## Errors

Standard JSON-RPC codes, plus four of our own in the reserved application range.

| Code | Name | Meaning |
|---|---|---|
| `-32700` | Parse error | Not JSON |
| `-32600` | Invalid request | Not a JSON-RPC 2.0 request |
| `-32601` | Method not found | No such method |
| `-32602` | Invalid params | A bad or missing parameter — including an unresolvable symbol |
| `-32603` | Internal error | A fault in the emulator |
| `-32000` | Not supported | The method exists but this host cannot serve it — no serial console, no video card, no filesystem |
| `-32001` | Load failed | A ROM, cart, program, symbol or snapshot could not be loaded |
| `-32002` | Unauthorized | Token missing or wrong |
| `-32003` | Invalid state | The machine's current state does not allow it |

`-32000` is worth designing for: capabilities genuinely differ between hosts. A
machine booted with a video card has no serial console, and the desktop app's
renderer has no filesystem of its own. The protocol says so rather than pretending.

### CLI exit codes

`6502 dbg` and `6502 attach` map all of the above onto codes a script can branch
on without scraping text:

| Code | Meaning |
|---|---|
| `0` | Ok |
| `1` | Usage error, or an RPC error |
| `2` | A `wait` or `send --wait` timed out |
| `3` | No emulator found — no lock file, or the socket refused |
| `4` | `step`/`runto`/`runcycles` stopped on a breakpoint or watchpoint |
