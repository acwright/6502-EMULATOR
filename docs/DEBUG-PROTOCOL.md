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
  "version": "3.0.0",
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
| `vram` | The video card's 64K, bypassing both port pairs' address latches. |
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
| `session.info` | — | `protocol`, `host`, `version`, `console`, `vdp`, `frequency`, `baudRate?`, `flowControl`, `cartridge`, `symbols`, plus [run state](#run-state) |
| `session.reset` | `cold?` (default `true`) | Run state |
| `session.config` | `frequency?` (1000000 or 2000000), `baudRate?`, `flowControl?` | `frequency`, `baudRate?`, `flowControl`, `console` |
| `session.shutdown` | — | `{ok:true}`, then the host winds down |

`vdp` is the video card in io8, by the name `--vdp` takes — `"tms9918a"` or
`"picovdp"` — or `null` when the slot is empty, as it is on a headless
serial-console machine whatever `--vdp` said. A script that needs one card should
check it here rather than infer it from the picture.

`flowControl` is whether serial input honours RTS/CTS flow control
([below](#serial)). It is `true` unless `6502 run --no-flow-control`,
`session.config` or the app's Settings turned it off. `session.config` can set it on a headless host; the app
refuses (`NOT_SUPPORTED`), because its Settings panel owns the setting.

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
{ "kind": "trap", "detail": "stp" }
```

`detail: "stp"` is the machine halting itself: the CPU executed `STP`, which
stops its clock until a RESET. The scheduler pauses, and `exec.run` or
`exec.step` from there returns the same stop again — `session.reset` is what makes
the machine runnable. The I/O cards keep ticking meanwhile, as they do on the
real board, where PHI2 comes from the oscillator rather than the CPU. `WAI` is
*not* a stop: the machine is live and waiting for an interrupt.

`exec.runCycles` stops on its budget exactly and ignores breakpoints. Serial input
queued before it with `serial.write` is delivered while it runs, as it would be on
a running machine, so a test can send a command to a paused machine and then
advance a fixed number of cycles.

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

**An emulator with something armed runs exactly the same program.** Arming a
breakpoint changes how the run loop is driven, not when anything happens in
emulated time: a run with a breakpoint that never fires is cycle-for-cycle the
run without it, down to the cycle each byte of a paste reaches the ACIA. It was
not always so — see 6502-EMULATOR#2, where one unreached breakpoint moved every
chunk boundary and decided whether a race in EhBASIC crashed.

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
| `serial.config` | — | `console`, `baudRate?`, `flowControl`, `frequency` |

**The cursor is the important part.** It is an absolute position in the console's
output stream, and `serial.write` returns where the stream stood when the command
went out. Pass it back as `wait.for {since}` and "wait for the reply to what I
just sent" is correct with no bookkeeping — which matters because in turbo the
machine covers hundreds of thousands of cycles between two one-shot calls, and the
reply is normally printed before a wait could even be set up. `wait.for` defaults
`since` to the last write's cursor for exactly this reason.

Text writes translate `\n` to CR, because that is what a terminal sends for Enter
and what BASIC ends a line on.

Input is paced at the serial line rate, measured in emulated cycles — so it lands
at the same point in the program whatever speed the host runs at.

**Flow control is on by default.** Pacing alone does not stop a long paste
overrunning the BIOS's 256-byte input buffer: crunching a line of BASIC can take
longer than a hundred characters of line time. With `flowControl` on, input also
honours RTS, as a terminal set to RTS/CTS flow control does. While the machine
holds the ACIA's RTS high — command register bits 3-2 clear and echo mode off,
which is the reset state and what the BIOS writes as `$01` when its input buffer
is nearly full — nothing more is sent: `serial.write` still queues, and the queue
resumes in order, at the line rate, when RTS drops (`$09`). Nothing is dropped.
`mem.read {address: 0x9002}` reading `0x01` (or `0x00`) is that state.

**A long paste into BASIC used to deadlock the bundled ROMs**, whatever
`flowControl` said, because on an R6551 bits 3-2 at `00` turn the transmitter
off as well as raising RTS: the BIOS raised RTS from its IRQ handler and then
echoed the next character, so `SerialChrout` spun on a TDRE that never set and
the machine stopped answering. That is what the board does, and it was the
firmware's bug.

**Neither bundled ROM does any more.** 6502-BIOS `v1.6` (`BIOS.bin`) and
`v2.0.1` (`BIOS2.bin`) lower RTS around each byte sent, decline to send while
the input buffer is over its high mark rather than reopen the gate, never lap
the input ring, and read the data register only when a byte is really there.
With `flowControl` on a long paste arrives whole; with it off nothing hangs and
lines are lost to overrun instead. A machine running an older ROM still
deadlocks, and `mem.read {address: 0x9002}` reading `0x01` with no output is how
that looks; a tokenized image through `program.load` sidesteps the console
entirely.

`session.config {flowControl: false}` (`6502 run --no-flow-control`) is a far
end that ignores RTS: everything is sent at the line rate, a long paste can
overrun the buffer, and a byte that reaches the ACIA while its receiver is
disabled — command register bit 0 clear, as after a reset — is lost, as it would
be at the board.

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

`screen.text` reads whichever grid the card is drawing. On the PICOVDP that is
40 × 24 in Text, 32 × 24 in Compact, 32 × 30 in Graphics and 40 × 30 in Full; on
the TMS9918A, 40 × 24 in Text and 32 × 24 in its other three modes, read from the
name table in order (the chip has no scrolling).

On the PICOVDP it reads layer 0's name table **as displayed**, with `L0SCRX` and `L0SCRY`
applied ([VDP-SPEC.md](VDP-SPEC.md) §13), in the legacy submode too. The first
line is map row `(L0SCRY mod H) / 8`, and each line starts at map column
`(L0SCRX mod W) / cell width`, where W × H is the picture (240 × 192 in Text) and
`L0CTRL` b6 is bit 8 of X. Both wrap round the map. A scroll that is not a whole
number of cells gives the cell the top-left pixel falls in. So a console the
Kernal scrolls in hardware (`L0SCRY` = top row × 8) reads here as it does on
screen, and with both registers at 0, as every 1.x BIOS leaves them, this is the
name table in order.

### video

The card rather than the picture. What `screen.*` shows is the result of 128
write-only registers, sixteen status registers that acknowledge when a program
reads them, and a palette stored in VRAM but drawn from a cache — none of which
6502 code can inspect without changing it. Section numbers below are
[VDP-SPEC.md](VDP-SPEC.md)'s.

Both cards answer, in the shape that fits the card, and every reply to
`video.info` says which card it describes in `vdp`. The PICOVDP's:

| Method | Params | Returns |
|---|---|---|
| `video.info` | — | `vdp`, `mode`, `displayEnabled`, `displayLine`, `status`, `ports`, `vramSize`, `paletteBase` |
| `video.registers` | — | `registers` — all 128, indexed by number |
| `video.setRegister` | `register` (0–127), `value` (0–255) | `register`, `value` |
| `video.palette` | — | `base`, `entries` — 256 of `$RGB` |

The TMS9918A's, which has eight write-only registers, one status register, 16 KB
of VRAM and a fixed palette:

| Method | Params | Returns |
|---|---|---|
| `video.info` | — | `vdp`, `mode` (`"TEXT"`, `"GRAPHICS_I"`, `"GRAPHICS_II"` or `"MULTICOLOR"`), `displayEnabled`, `status` (one byte, peeked, in an array), `vramSize` (16384) |
| `video.registers` | — | `registers` — all 8 |
| `video.setRegister` | `register` (0–7), `value` (0–255) | `register`, `value` |
| `video.palette` | — | error `-32000`: `video.palette: the TMS9918A has a fixed palette` |

The rest of this section is the PICOVDP's.

`mode` is §9's: `geometry` (`text`/`compact`/`graphics`/`full`) and its cell grid,
pixel size and position in the frame, `vmode` as written, and `legacy` — the
TMS9918 mode `M1`/`M2`/`M3` select while `VMODE` is `$0`, or `null`. A legacy
program asking for Graphics II reports `legacy: "graphics-ii"` beside `geometry:
"compact"`, because that is what it gets.

`status` is `STAT0`–`STAT15` **peeked**: a program reading `STAT0` clears its
flags and the interrupts they stand for, and reading `STAT1` acknowledges every
latched interrupt, and `video.info` does neither. `STAT5` is the firmware
version in BCD (`$05`, the spec draft the emulator implements) and `STAT6` the
capability bits: `$BF`, where b7 is the built-in font of §7; `dbg video` spells
both out. `ports` holds `a` and `b`, each with `pointer`, `readMode`, `readAhead`,
`awaitingCommand` and `payload` — what tells a program that lost track of the
command flip-flop apart from one whose interrupt handler moved the pointer.

`video.setRegister` writes through the card, so it has the side effects a program
writing the same byte would get: the aliases of §5, the vertical blank enable's
second home in `IRQEN`, a palette reload on `PALBASE`, a mode change, and a
font load on `FONT` (`$30`), which lands at the next vertical blank (§7).

`video.palette` returns the colors the card draws with, which is not necessarily
what VRAM holds at `base`: the two copies part company exactly when the snoop of
§11 has missed a write. Read the stored copy with `mem.read {space: "vram",
address: base, length: 512}` to compare.

### input

The HID path: for programs driven by the keyboard matrix or a joystick, and the
only console path a video-console machine has.

| Method | Params | Returns |
|---|---|---|
| `input.key` | `code` (HID code or name), `down?` (default true) | `code`, `down` |
| `input.joystick` | `side?` (`a`/`b`), `buttons` — a mask or names | `side`, `buttons` |
| `input.type` | `text`, `cps?` (default 20) | `typed` |

Button names: `up down left right a b x y`. `side` `a` is the joystick on VIA
port A, `b` the one on port B — which the BIOS reads as `JOY(2)` and `JOY(1)`
respectively.

A mask is the raw port bit order, wired `P7` RIGHT, `P6` LEFT, `P5` DOWN, `P4`
UP, `P3` Y, `P2` X, `P1` B, `P0` A/FIRE. Set a bit here to mean *held*; the
lines are active low on the hardware, so the attachment inverts on the way to
the port and the BIOS sees a held button as a 0.

A program only sees the stick while the keyboard encoders are disabled and have
released the ports — which for BASIC means during a `JOY()` read, when the
Kernal raises `CB2`/`CA2`, waits out the encoder's settle, and reads the raw
port. `input.joystick` sets the held state at any time; it just is not visible
to 6502 code until that window. Setting it and then reading a port with the
encoders still enabled reads the encoder, not the stick.

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

The snapshot is plain JSON: around 52 KB for a headless machine, and 140 KB with a
video card, whose 64 KB of VRAM it holds in full. No host here can write files, so `state.save` hands the snapshot back and saving it is the
caller's business — which is also what you want, because the emulator may be a
packaged app in another directory.

A snapshot is checked before it is applied and refused rather than half-applied:
wrong `format`, a `version` this build does not read, a different video card, a
different slot layout, or a ROM whose checksum does not match. Those refusals end
in `The machine is unchanged.` A card whose own fields turn out to be malformed
can only be found while it is being applied, so that failure ends instead in
`The machine may be in a partial state; session.reset to recover.`

This build writes `version` 3, and reads versions 1, 2 and 3. A version 3 snapshot
names its video card in a top-level `vdp` — `"tms9918a"`, `"picovdp"`, or `null`
when io8 is empty — and the older versions imply it: version 1, every snapshot a
2.x emulator saved, holds a TMS9918A, and version 2 a 6502-PICOVDP. `state.load`
returns the `version` it read.

A snapshot only restores onto the card it was taken with. The card is checked
before the ROM, and `force` does not override it, because one card's state cannot
be applied to the other at all:

```
snapshot: taken with the tms9918a video card; this machine has picovdp — relaunch with --vdp tms9918a (or choose it in Settings)
```

So a version 1 snapshot from 2.7.0, which bundled BIOS 1.6, restores on
`--vdp tms9918a` once it is given the 1.6 it was taken on: that 1.6 has been
rebuilt three times since (6502-BIOS `27bd4e0`, `f858890` and the `v1.6` tag as
it now stands), and the bundled `BIOS.bin` is the newest of those, so without
`--rom` it needs `force`.
`src/tests/fixtures/BIOS-1.6-emulator-2.7.0.bin` is the original image. One from
2.6.x (BIOS 1.5) needs `force` as well, as it did in 2.7.0. `force` overrides
only the ROM check — occasionally right, when replaying a saved state against a
patched BIOS.

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
  when it stops again" — *unless no client has been told about the stop it is
  sitting on*, in which case that stop is the answer and the machine is left
  where it is. A stop counts as told once it has gone out in the result of an
  `exec.*` call or an earlier `wait.for`, so "continue" keeps working for a
  debugger that has just been handed one, and a one-shot client that armed a
  watchpoint, triggered it and then asked to run on is given the stop it
  actually wanted rather than waiting out its timeout for a second one that may
  never come.
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
