# 6502 Emulator

Desktop and web emulator for the [A.C. Wright 6502](https://github.com/acwright/6502-ACE) family of computer systems.

Runs on **macOS, Windows, and Linux** as a native Electron application, and in any modern browser via **[GitHub Pages](https://acwright.github.io/6502-EMULATOR/)**.

## Try It in the Browser

[https://acwright.github.io/6502-EMULATOR/](https://acwright.github.io/6502-EMULATOR/)

---

## Default Boot Experience

When the emulator starts it behaves exactly like the real machine being powered on:

1. The bundled **BIOS ROM** loads and probes all I/O slots.
2. A splash screen is displayed on the TMS9918 VDP: `-- 6502 BIOS v1.4 --`
3. After a 5-second countdown the system auto-boots to the built-in **BASIC** interpreter.
4. Pressing **ESC** at the splash screen drops into the machine-code **Monitor** instead.

---

## Hardware Emulation

| Component | Details |
|---|---|
| **CPU** | 65C02, cycle-accurate, IRQ / NMI |
| **RAM** | 32 KB system RAM + 2 × optional expansion banks |
| **ROM** | 32 KB (BIOS bundled; replaceable via Load ROM) |
| **Video** | TMS9918 VDP — 320×240 display, 16-colour, hardware sprites |
| **Audio** | MOS 6581 SID — 3 voices, 44.1 kHz |
| **Serial** | 6551 ACIA — configurable baud/parity/data/stop |
| **Storage** | CompactFlash 8-bit IDE — 256 × 1 MB banks (256 MB total, `DISK n`) |
| **RTC / NVRAM** | DS1511Y+ — real-time clock + 256 B battery-backed NVRAM |
| **GPIO** | 6522 VIA — two 8-bit ports, two 16-bit timers, matrix keyboard |

---

## Controls

### Primary Toolbar

| Button | Action |
|---|---|
| **CPU chip** | Load ROM (`.bin` / `.rom`) — replaces the default BIOS |
| **Document+** | Load Cartridge (`.bin` / `.crt` / `.cart`) |
| **Document$** | Load Program into RAM at `$0800` (`.prg` / `.bas`) |
| **▶ / ■** | Run / Stop emulation |
| **↺** | Reset CPU |
| **`1 MHz` / `2 MHz`** | Toggle CPU clock speed (persisted) |
| **Clipboard** | Paste text — opens a modal that types the pasted text into the machine as keystrokes (e.g. to enter a BASIC program) |
| **⚙** | Open / close the Settings panel |

Because the emulator captures all keystrokes as emulated keyboard input, a normal ⌘V / Ctrl+V paste won't reach the terminal — use the **Clipboard** button and paste into the modal instead.

### Settings Panel

**Files** (ROM / Cart / Program / Binary)  
- Each row shows the currently loaded file and a **Load** button.
- When a non-default file is loaded, an **✕** button appears to unload it and return to the default: ROM reverts to the bundled BIOS, Cart is ejected, and Program is cleared (the machine resets to wipe it from RAM).
- **BIN** loads raw bytes at an explicit hex address — the emulator's equivalent of BASIC's `BLOAD`. Enter the address first; the **Load** button stays disabled until it is a valid RAM address. BASIC's state is left untouched, so run the code with `SYS` (or from the Monitor).

### Program Images

`.prg` and `.bas` are the same format: the raw bytes that belong at `$0800` upward — a tokenized BASIC line chain. A `.prg` is simply an image whose BASIC part is a one-line stub (`10 SYS 2060`) carrying machine code after the end-of-program marker. The extension is a note to yourself; nothing in the emulator or the BIOS inspects it.

Loading a program mirrors BASIC's own `LOAD`: the bytes are written to `$0800` and BASIC's end-of-program pointers (`VARTAB`, `ARYTAB`, `STREND`) are moved past the **whole image**. That last part matters — BASIC allocates variables from those pointers, so without the fixup the first variable assignment lands on top of the program, and for a `.prg` the extent has to cover the trailing machine code, which a line-chain walk would miss.

A program can be loaded at any time, including before the machine has booted. BASIC's startup rewrites those pointers unconditionally, so when the machine is reset or stopped the fixup cannot be applied up front; the emulator keeps the image pending and applies it the moment BASIC finishes initialising. The Settings panel shows that it is waiting. This is what makes preloading a program and then booting — the shape a command-line launcher needs — come out correct rather than depending on BASIC's own chain walk, which stops at the end-of-program marker and would leave a `.prg`'s machine code exposed.

One constraint worth knowing: **don't edit a `.prg`'s BASIC stub.** Inserting or deleting a line block-moves everything above it, which shifts the attached machine code out from under its own absolute addresses. `LIST`, `RUN` and `SAVE` are fine. (The real machine has the same constraint.)

Raw machine code with no BASIC stub belongs in the **BIN** row with an explicit address, not in the program loader.

**Serial Port**  
- Electron: choose port from the detected list, configure baud rate, data bits, parity, stop bits, then click **Connect**.  
- Web: click **Connect** — the browser's port-picker dialog opens.  
- Default: 19200 8-N-1 (matches the real machine's boot configuration). Serial is not connected on startup.

**CF Card**  
- Electron: **Select…** opens a file dialog; the chosen `.img` or `.bin` is loaded into the emulator immediately and persisted across restarts. When a custom image is selected, an **✕** button reverts to the default image (the selected file is left untouched on disk).  
- Web: **Load** uploads a file from disk; **Export** downloads the current CF image.  
- Default: a 256 MB blank image created in the app's data directory on first launch.

**NVRAM**  
- Same pattern as CF Card (256 bytes, DS1511Y+ battery-backed registers).

**Debug Server** (Electron only)  
- **Start** opens a JSON-RPC service on a loopback port so `6502 dbg` and
  `6502 attach` can drive *this* running machine — the same protocol and the same
  commands as a headless instance. The panel shows the address it is listening on
  and the session token, with a copy button.
- Off until you start it. A shipped build never opens a socket on its own.

**Command Line** (Electron only)  
- **Install** adds the `6502` command to your `PATH` — `/usr/local/bin` where
  permitted, falling back to `~/.local/bin` with a hint if not. **Uninstall**
  removes it. The panel shows where it landed.
- Once installed, `6502 run build/game.prg` opens *this* app with the build
  already loaded — see [With a window, or without](#with-a-window-or-without).
- On Windows and Linux `.deb` the platform installer owns this, so the action
  reports that there is nothing to do rather than offering a broken button.

### Fullscreen

Press **F11** (or **⌘ Return** on macOS) to toggle fullscreen. The 4:3 VDP aspect ratio is always maintained via CSS letterboxing.

---

## Command Line

`6502 run` boots a machine with your build output already attached — in the
desktop app, or without a window at all, with its console wired to stdin/stdout.
Either way it can be driven and inspected from a shell. That covers both ends of
the job: seeing a fresh build run, and having a build script, CI run or AI agent
test 6502 code end to end.

```sh
6502 run     # boot a machine, optionally loaded with your build output
6502 dbg     # one-shot debug commands against a running emulator
6502 attach  # an interactive monitor session
```

Three ways to get the command, in order of convenience:

```sh
# 1. Installed by the app: Settings → COMMAND LINE → Install
6502 --version

# 2. From a checkout — always works, and what CI should use
npm run build:cli          # compiles to out/cli/
node out/cli/index.js run --help

# 3. During development
npm run cli -- run --headless --help
```

The shim works because Electron already bundles Node: it runs the app binary with
`ELECTRON_RUN_AS_NODE=1`, so **no Node runtime of your own is needed** and the CLI
can never drift from the app version — it is the same file either way.

Further reading:

- **[docs/AGENTS.md](docs/AGENTS.md)** — how to drive the machine from an agent or
  a test script, written to be copied into your own 6502 project
- **[docs/DEBUG-PROTOCOL.md](docs/DEBUG-PROTOCOL.md)** — the JSON-RPC reference
- **[examples/](examples/)** — runnable scripts, exercised by CI

### With a window, or without

`6502 run` opens the desktop app with your build already loaded. `--headless`
runs the same machine with no window at all, its console wired to stdin and
stdout.

```sh
6502 run build/game.prg              # in the app: video, sound, keyboard
6502 run --headless build/game.prg   # no window: the console is a byte stream
```

The media flags are the same either way — `--rom`, `--cart`, `--program`,
`--bin`, `--cf`, `--nvram` — as are `--freq`, `--baud`, `--rtc`, `--pause`,
`--debug` and `--symbols`. What differs is everything that only makes sense for
one of them:

|             | Window                                        | `--headless`                                  |
|-------------|-----------------------------------------------|-----------------------------------------------|
| Console     | The video card and the keyboard               | stdin/stdout, or `--console video`            |
| Speed       | Real time                                     | Flat out, unless `--realtime`                 |
| Ends when   | The window is closed                          | `--timeout`, `--exit-on`, `--max-cycles`, ^C  |
| Also has    | `--fullscreen`, `--detach`, `--serial <port>` | `--console`, `--input-after`, `--json`        |

Flags from the wrong column are refused with the reason, rather than accepted
and quietly ignored.

A windowed run does not return until the window closes, which is what makes it
usable as a build step — assemble, look at it, close it, back to the shell.
`--detach` hands the terminal straight back instead.

```sh
6502 run --cart build/game.crt --fullscreen
6502 run --debug --pause --symbols build/game.lbl build/game.prg
6502 run --serial /dev/tty.usbserial-1420 --baud 9600   # ACIA out to real hardware
```

**Anything the Settings panel configures, the command line can set too** —
`--freq`, `--cf`, `--nvram`, `--baud` and `--serial-config` (framing, as `8N1`
or `7E2`). They show up in the panel as the values in effect, but apply to that
launch alone: nothing is written to your saved settings, and what you change in
the panel afterwards persists exactly as it always did. The machine does write
back to a `--cf` or `--nvram` image as it would to any card, so point those at a
copy of anything you want kept byte for byte.

The app it opens is the one that installed the command: the shim runs the CLI
inside the app's own Electron, so `process.execPath` *is* the app and the two
can never be different versions. From a checkout it launches the build in
`out/`; `--app <path>` or `SIXTY5O2_APP` override both.

### Why there is a console at all

The BIOS probes for a video card on boot, and finding none it sets `IO_MODE` to
serial and routes the console to the 6551 ACIA — and its IRQ handler feeds
received bytes into the same input buffer the keyboard uses. So a machine booted
with an empty video slot is a complete, bidirectional terminal session with **no
firmware changes**. `--console serial` (the default) is exactly that.

### Examples

```sh
# Open the desktop app with a fresh build in it.
./bin/6502 run build/game.prg

# Boot to BASIC and run a line. ENTER at the splash skips the countdown.
printf '\rPRINT 2+2\r' | ./bin/6502 run --headless --exit-on 'OK[^]*OK'
#   6502 BASIC V2.1
#   30718 BYTES FREE
#
#   OK
#   PRINT 2+2
#    4

# Drop straight into the machine-code Monitor.
printf '\x1b' | ./bin/6502 run --headless --timeout 5s

# Load build output and give it a cycle budget.
./bin/6502 run --headless build/game.prg --max-cycles 5e6

# Raw bytes at an address, the equivalent of BASIC's BLOAD.
./bin/6502 run --headless --bin 0x7F00=code.bin
```

A full boot to the `OK` prompt takes roughly **50 ms** and 450,000 cycles, against
five seconds on the real machine — the emulator runs at about 11 MHz when it is
not pacing itself against the wall clock. (That is with a leading CR to answer the
splash. Letting the countdown expire costs 5,359,120 cycles, which is where
snapshots earn their keep.)

### Debugging a running machine

`6502 run --headless --debug` — or **Settings → DEBUG SERVER → Start** in the
desktop app — serves JSON-RPC over a loopback port and publishes the port and
token in `~/.6502/session.json`. Every `6502 dbg` command then needs no arguments:

```sh
6502 dbg regs                             # registers
6502 dbg mem 0x0300 32                    # memory, any space: cpu/ram/rom/vram/nvram/cf
6502 dbg disasm main 20                    # symbols work anywhere an address does
6502 dbg break main --condition 'A == $FF'
6502 dbg step --over
6502 dbg send 'PRINT 2+2\r' --wait 'OK'   # over the serial console
6502 dbg wait --serial 'READY\.' --timeout 5s
6502 dbg screen png shot.png              # when a video card is present
6502 dbg state save ready.state           # snapshot the whole machine
6502 dbg state load ready.state           # ... and restore it in ~1 ms

6502 attach                               # the same commands, interactively
```

Each `dbg` invocation is a separate process that connects, calls, prints and
exits, so there is no session to manage — which is what makes this usable from a
shell script or an agent. Exit codes carry the outcome (`0` ok, `1` error, `2`
timed out, `3` no emulator, `4` breakpoint hit), and `--json` gives the raw result.

The server is **off unless asked for**, binds loopback, requires a token off
loopback, and refuses any request carrying a browser `Origin` — a loopback port is
reachable from every page the user has open. See
[docs/DEBUG-PROTOCOL.md](docs/DEBUG-PROTOCOL.md#security).

### Notes

- **The splash consumes keystrokes.** It takes ENTER for BASIC or ESC for the
  Monitor and acts immediately; anything else sent before that choice is made is
  swallowed. Lead with a CR, or use `--input-after <regex>` to hold input until a
  prompt appears.
- **Input is paced at the serial line rate**, measured in emulated cycles rather
  than wall time. Without that, a pasted program overruns the BIOS's 256-byte
  input buffer — and pacing in emulated time means input lands at the same point
  in the program whether the machine is running flat out or in real time.
- **Newlines are translated to CR** on the way in, which is what a serial
  terminal sends for Enter. BASIC ends a line on CR and would otherwise never
  see one.
- **`--bin` writes before the machine boots.** At `$0800` that is BASIC's program
  area and its cold start will read those bytes as a tokenized program; use
  `--program` for images that belong there.
- **`--rtc <iso8601>` makes a run reproducible.** The real-time clock is the only
  part of the engine that reads the host's clock; fix it and the same ROM, input
  and cycle budget produce a byte-identical machine every time. It takes no
  timezone — it is the reading on the emulated clock's face, not an instant.
- **Don't type at a machine that hasn't booted.** Input delivered before the BIOS
  has set up a console sits unread in the ACIA and blocks everything behind it.
  The leading CR above is fine because the machine starts immediately; with
  `--pause` or a debug server, wait for a prompt first. More traps in
  [docs/AGENTS.md](docs/AGENTS.md#traps).

Exit codes: `0` ran to completion, `1` usage or load error, `2` timed out,
`130` interrupted.

---

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [ImageMagick](https://imagemagick.org/) + `iconutil` (macOS) — only needed to regenerate app icons

### Install

```sh
git clone https://github.com/acwright/6502-EMULATOR.git
cd 6502-EMULATOR
npm install
```

### Run (Electron dev)

```sh
npm run dev
```

Hot-reloads the renderer; the Electron window opens automatically.

### Run (Web dev)

```sh
npm run build:web
npm run preview:web
```

### Type-check

```sh
npm run typecheck
```

### Tests

```sh
npm test
npm run test:coverage
bash examples/run-all.sh     # the worked examples, against a real BIOS
```

The Jest suite covers the emulator core (CPU, RAM, ROM, Cart, all I/O cards and
attachments), the debug layer (session, breakpoints, disassembler, snapshots,
symbols, the protocol method table and the WebSocket implementation), the headless
host and the CLI. Several suites boot the real bundled BIOS rather than a stub, so
a firmware-facing regression fails them.

`examples/` holds runnable scripts rather than documentation fragments, and CI runs
them — a documented command that stops working stops the build.

---

## Build & Distribution

### Electron (all platforms)

```sh
npm run build        # compile TypeScript + bundle renderer
```

### macOS DMG

```sh
npm run dist:mac     # requires Apple Developer ID cert in Keychain
```

Produces `dist/6502-emulator-<version>-mac-arm64.dmg` (notarized).

### Windows NSIS

```sh
npm run dist:win     # requires Wine installed on macOS
```

Produces `dist/6502-emulator-<version>-win-x64.exe`.

### Linux AppImage + deb

```sh
npm run dist:linux   # requires Docker running
```

Produces `dist/6502-emulator-<version>-linux-x64.AppImage` and `.deb`.

### Web (GitHub Pages)

```sh
npm run build:web    # output → dist/web/
```

GitHub Actions deploys automatically on every push to `main`  
(workflow: `.github/workflows/deploy.yml`).

### Regenerate App Icons

```sh
npm run icons        # reads build/6502.png, writes build/icon.icns|ico|png
```

Requires ImageMagick (`magick`) and `iconutil` (macOS).

---

## Project Structure

```
src/
  core/          Emulator engine (CPU, RAM, ROM, all I/O cards) — no browser/Node deps
  debug/         Platform-agnostic debug layer:
                   Session + Scheduler — own execution and pacing
                   Breakpoints, Disassembler, Snapshot, Symbols, Expression
                   server/ — JSON-RPC method table, WebSocket, HTTP, lock file
  host/headless/ Windowless host; wires the console to a byte stream
  cli/           `6502` command line — run, dbg, attach
  main/          Electron main process (serial, storage, settings, debug bridge, CLI shim)
  preload/       contextBridge — exposes window.api to the renderer
  renderer/      Vue 3 UI (shared by Electron and web builds)
  shared/        Types, IPC channel constants, AppApi interface
docs/            AGENTS.md (agent recipes), DEBUG-PROTOCOL.md (protocol reference)
examples/        Runnable worked examples, exercised by CI
assets/
  roms/          Bundled BIOS binary (included in Electron extraResources)
bin/             `6502` CLI entry point
build/           electron-builder resources (icons, gen-icon.mjs)
scripts/         dist-win.sh, dist-linux.sh
```

Nothing in `core/` or `debug/` imports a browser or Node built-in, which is what
lets the same engine and the same debug protocol run in a bare Node process, in an
Electron renderer, and in a browser tab.

---

## Related

- [A.C. Wright 6502 Hardware](https://github.com/acwright/6502-ACE) — the real machine, and the index of the whole family
- [6502 BIOS](https://github.com/acwright/6502-BIOS) — firmware source; the bundled ROM is built from it
- [6502-PRG](https://github.com/acwright/6502-PRG) / [6502-CRT](https://github.com/acwright/6502-CRT) — templates for programs and cartridges; both have a `make run` that launches this app
- [6502-ASM](https://github.com/acwright/6502-ASM) / [6502-BAS](https://github.com/acwright/6502-BAS) — example programs and BASIC listings to run
- [cffs](https://github.com/acwright/cffs) — builds the CompactFlash images the CF card accepts
- [bastok](https://github.com/acwright/bastok) — tokenizes BASIC listings into the `.prg` images the program loader accepts
- [docs/AGENTS.md](docs/AGENTS.md) — driving the emulator from an agent or a test script
- [docs/DEBUG-PROTOCOL.md](docs/DEBUG-PROTOCOL.md) — the debug protocol reference
- [examples/](examples/) — worked examples that CI runs


## Architecture

The system uses 8 memory-mapped I/O slots:

```
IO1   RAM Card (Expansion)
IO2   RAM Card (Expansion)
IO3   RTC Card (DS1511Y+ Real-Time Clock)
IO4   Storage Card (Compact Flash 8-bit IDE Mode)
IO5   Serial Card (6551 ACIA)
IO6   VIA Card (6522 GPIO)
IO7   Sound Card (6581 SID)
IO8   Video Card (TMS9918)
```

**VIA (GPIO) Attachments** — the VIA card supports pluggable inputs: Keyboard Matrix, Keyboard Encoder, and dual Joystick (A/B).

---

## Known Issues

**Linux packaging metadata is incomplete.** `electron-builder` warns on every
Linux build:

- `linux.category` is unset and can't be mapped from the macOS config, so the
  app lands in the desktop menu under the default `Utility`. Something like
  `Development` or `Game` would place it more sensibly.
- `desktopName` is unset, so Electron has no `app_id` / `WM_CLASS` to associate
  a running window with the installed `.desktop` entry. Desktop environments may
  show the window as a separate, unnamed entry rather than linking it to the
  launcher (affects the taskbar icon and pinning). Fixing it needs `desktopName`
  in `package.json` plus `linux.syncDesktopName: true`.

Both are cosmetic — the AppImage and `.deb` install and run correctly — and
neither is verifiable from macOS, so any change wants testing on an actual
Linux desktop. See the [electron-builder Linux docs](https://www.electron.build/linux).

**The CLI shim installer is macOS-only; verified end to end there.** On Windows
and Linux the platform installer already owns `PATH`, so Settings → COMMAND LINE
reports there is nothing to do rather than offering a button that would do the
wrong thing. The Linux AppImage should work unmodified once its installer wires
up `PATH` the same way, but that path hasn't been run on an actual Linux desktop.

**No execution trace.** The debug protocol has no `trace` family — nothing has
needed one yet. `bp`, `reg`, `mem` and `disasm` cover stepping and inspection.

---

## Credits

- CPU implementation adapted from [OneLoneCoder's olcNES](https://github.com/OneLoneCoder/olcNES)
- TMS9918 implementation based on [vrEmuTms9918](https://github.com/visrealm/vrEmuTms9918) by Troy Schrapel

## License

MIT License — see [LICENSE](LICENSE) for details.

## Contributing

This project pairs with the hardware and firmware linked above. Contributions, issues, and feature requests are welcome!
