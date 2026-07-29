# 6502 Emulator

Desktop and web emulator for the [A.C. Wright 6502](https://github.com/acwright/6502-ACE) family of computer systems.

Runs on **macOS, Windows, and Linux** as a native Electron application, and in any modern browser via **[GitHub Pages](https://acwright.github.io/6502-EMULATOR/)**.

## Try It in the Browser

[https://acwright.github.io/6502-EMULATOR/](https://acwright.github.io/6502-EMULATOR/)

---

## Default Boot Experience

When the emulator starts it behaves exactly like the real machine being powered on:

1. The bundled **BIOS ROM** loads and probes all I/O slots.
2. A splash screen is displayed on the TMS9918 VDP: `-- 6502 BIOS v1.3 --`
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

### Fullscreen

Press **F11** (or **⌘ Return** on macOS) to toggle fullscreen. The 4:3 VDP aspect ratio is always maintained via CSS letterboxing.

---

## Command Line

The emulator can run without a window, with its console wired to stdin/stdout.
This is what makes it usable from a build script, from CI, or by an AI agent
end-to-end testing 6502 code.

```sh
npm run build:cli          # compiles to out/cli/
./bin/6502 run --help
```

### Why there is a console at all

The BIOS probes for a video card on boot, and finding none it sets `IO_MODE` to
serial and routes the console to the 6551 ACIA — and its IRQ handler feeds
received bytes into the same input buffer the keyboard uses. So a machine booted
with an empty video slot is a complete, bidirectional terminal session with **no
firmware changes**. `--console serial` (the default) is exactly that.

### Examples

```sh
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
five seconds on the real machine — the emulator runs at about 10 MHz when it is
not pacing itself against the wall clock.

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
```

The Jest suite covers the full emulator core (CPU, RAM, ROM, Cart, all I/O cards and attachments).

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
  debug/         Session + Scheduler — owns execution and pacing
  host/headless/ Windowless host; wires the console to a byte stream
  cli/           `6502` command line
  main/          Electron main process (serial, storage, settings services)
  preload/       contextBridge — exposes window.api to the renderer
  renderer/      Vue 3 UI (shared by Electron and web builds)
  shared/        Types, IPC channel constants, AppApi interface
assets/
  roms/          Bundled BIOS binary (included in Electron extraResources)
bin/             `6502` CLI entry point
build/           electron-builder resources (icons, gen-icon.mjs)
scripts/         dist-win.sh, dist-linux.sh
```

---

## Related

- [A.C. Wright 6502 Hardware](https://github.com/acwright/6502-ACE) — the real machine
- [6502 BIOS](https://github.com/acwright/6502-BIOS) — firmware source


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

---

## Credits

- CPU implementation adapted from [OneLoneCoder's olcNES](https://github.com/OneLoneCoder/olcNES)
- TMS9918 implementation based on [vrEmuTms9918](https://github.com/visrealm/vrEmuTms9918) by Troy Schrapel

## License

MIT License — see [LICENSE](LICENSE) for details.

## Contributing

This project pairs with the hardware and firmware linked above. Contributions, issues, and feature requests are welcome!
