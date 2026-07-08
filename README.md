# 6502 Emulator

Desktop and web emulator for the [A.C. Wright 6502](https://github.com/acwright/6502-ACE) family of computer systems.

Runs on **macOS, Windows, and Linux** as a native Electron application, and in any modern browser via **[GitHub Pages](https://acwright.github.io/6502-EMULATOR/)**.

## Try It in the Browser

[https://acwright.github.io/6502-EMULATOR/](https://acwright.github.io/6502-EMULATOR/)

---

## Default Boot Experience

When the emulator starts it behaves exactly like the real machine being powered on:

1. The bundled **BIOS ROM** loads and probes all I/O slots.
2. A splash screen is displayed on the TMS9918 VDP: `-- 6502 BIOS v1.1 --`
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
| **Document+** | Load Cartridge (`.bin` / `.cart`) |
| **Document$** | Load Program into RAM at `$0800` (`.bin` / `.prg`) |
| **▶ / ■** | Run / Stop emulation |
| **↺** | Reset CPU |
| **`1 MHz` / `2 MHz`** | Toggle CPU clock speed (persisted) |
| **⚙** | Open / close the Settings panel |

### Settings Panel

**Serial Port**  
- Electron: choose port from the detected list, configure baud rate, data bits, parity, stop bits, then click **Connect**.  
- Web: click **Connect** — the browser's port-picker dialog opens.  
- Default: 19200 8-N-1 (matches the real machine's boot configuration). Serial is not connected on startup.

**CF Card**  
- Electron: **Select…** opens a file dialog; the chosen `.img` or `.bin` is loaded into the emulator immediately and persisted across restarts.  
- Web: **Load** uploads a file from disk; **Export** downloads the current CF image.  
- Default: a 256 MB blank image created in the app's data directory on first launch.

**NVRAM**  
- Same pattern as CF Card (256 bytes, DS1511Y+ battery-backed registers).

### Fullscreen

Press **F11** (or **⌘ Return** on macOS) to toggle fullscreen. The 4:3 VDP aspect ratio is always maintained via CSS letterboxing.

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
  main/          Electron main process (serial, storage, settings services)
  preload/       contextBridge — exposes window.api to the renderer
  renderer/      Vue 3 UI (shared by Electron and web builds)
  shared/        Types, IPC channel constants, AppApi interface
assets/
  roms/          Bundled BIOS binary (included in Electron extraResources)
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

## Credits

- CPU implementation adapted from [OneLoneCoder's olcNES](https://github.com/OneLoneCoder/olcNES)
- TMS9918 implementation based on [vrEmuTms9918](https://github.com/visrealm/vrEmuTms9918) by Troy Schrapel

## License

MIT License — see [LICENSE](LICENSE) for details.

## Contributing

This project pairs with the hardware and firmware linked above. Contributions, issues, and feature requests are welcome!
