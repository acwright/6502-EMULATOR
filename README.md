# 6502 Emulator

A comprehensive, cycle-accurate emulator for the [A.C. Wright 6502](https://github.com/acwright/6502) computer system, built with TypeScript and Node.js.

## Overview

This emulator provides a complete software implementation of a 65C02-based computer system, designed to run the same code as the hardware implementation. It features full I/O peripheral support, including video, sound, serial communication, storage, and GPIO interfaces.

## Features

- **Cycle-Accurate 65C02 CPU Emulation**
  - Full instruction set support
  - Accurate timing and cycle counting
  - IRQ and NMI interrupt handling
  
- **Memory Architecture**
  - System RAM and ROM
  - Cartridge support for program loading
  - Multiple RAM expansion cards
  
- **Video Output**
  - TMS9918 Video Display Processor emulation
  - Multiple graphics modes (Graphics I/II, Text, Multicolor)
  - 256×192 active display area in 320×240 buffer
  - Hardware sprites support
  - Real-time rendering via SDL
  
- **Audio Output**
  - MOS 6518 SID Sound card emulation with sample generation
  - 44.1 kHz audio output
  - SDL audio integration
  
- **I/O Peripherals**
  - **Serial Card**: 6551 UART communication with configurable baud rate, parity, data/stop bits
  - **Storage Card**: Compact Flash 8-bit IDE mode persistent storage emulation
  - **RTC Card**: DS1511Y real-time clock emulation with IRQ/NMI support
  - **GPIO Card**: 65C22 VIA (Versatile Interface Adapter) emulation
    - Two 8-bit bidirectional I/O ports
    - Two 16-bit timers with interrupts
    - Shift register for serial I/O
  
- **Input Devices**
  - Keyboard support (matrix and encoder modes)
  - Joystick/gamepad support with button mapping
  - SDL input handling
  
- **Development Features**
  - Comprehensive test suite with Jest
  - Command-line interface with multiple options
  - Debug and monitoring capabilities
  - Code coverage reporting

## Quick Start

Get up and running in seconds:

```bash
# Install globally
npm install -g ac6502

# Run the emulator
ac6502

# Load a ROM
ac6502 --rom /path/to/rom.bin
```

## Installation

### Via NPM (Recommended)

Install globally via npm:

```bash
npm install -g ac6502
```

### From Source

#### Prerequisites

- Node.js (v16 or higher)
- npm or yarn

#### Install Dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

## Usage

### Basic Usage

```bash
npm start
```

Or use the CLI directly:

```bash
ac6502 [options]
```

### Command-Line Options

- `-c, --cart <path>` - Load a cartridge ROM file
- `-r, --rom <path>` - Load a system ROM file
- `-f, --freq <frequency>` - Set CPU frequency in Hz (default: 2000000)
- `-s, --scale <factor>` - Set display scale factor (default: 2)
- `-p, --port <device>` - Serial port device path
- `-b, --baudrate <rate>` - Serial baud rate (default: 9600)
- `-a, --parity <type>` - Serial parity: none, even, odd (default: none)
- `-d, --databits <bits>` - Serial data bits: 5, 6, 7, 8 (default: 8)
- `-t, --stopbits <bits>` - Serial stop bits: 1, 1.5, 2 (default: 1)
- `-S, --storage <path>` - Set storage file path for Compact Flash card persistence

### Examples

Load a cartridge:

```bash
ac6502 --cart /path/to/game.bin
```

Connect to serial hardware:

```bash
ac6502 --port /dev/ttyUSB0 --baudrate 9600 --rom /path/to/monitor.bin
```

## Architecture

### Component Structure

```
Machine
├── CPU (65C02)
├── RAM (System Memory)
├── ROM (System BIOS/Monitor)
├── Cart (Optional Cartridge)
└── I/O Cards (8 slots)
    ├── IO1: RAM Card (Expansion)
    ├── IO2: RAM Card (Expansion)
    ├── IO3: RTC Card (Real-Time Clock)
    ├── IO4: Storage Card (Compact Flash 8-bit IDE Mode)
    ├── IO5: Serial Card (6551 UART)
    ├── IO6: GPIO Card (65C22 VIA)
    ├── IO7: Sound Card (6581 SID)
    └── IO8: Video Card (TMS9918)
```

### GPIO Attachments

The GPIO card supports multiple attachment types:

- **Keyboard Matrix**: PS/2-style keyboard matrix scanning
- **Keyboard Encoder**: Parallel keyboard encoder
- **Joystick**: Game controller with 8 buttons and directional input

### Memory Map

The system uses a standard 6502 memory layout with I/O cards mapped into the address space. Each I/O card occupies a dedicated region accessible via memory-mapped registers.

## Development

### Project Structure

```
src/
├── index.ts                 # Main entry point and emulator loop
├── components/
│   ├── CPU.ts              # 65C02 CPU implementation
│   ├── Machine.ts          # System integration
│   ├── RAM.ts              # RAM module
│   ├── ROM.ts              # ROM module
│   ├── Cart.ts             # Cartridge support
│   ├── IO.ts               # I/O interface
│   └── IO/                 # I/O peripheral implementations
│       ├── VIA.ts
│       ├── RAMBank.ts
│       ├── RTC.ts
│       ├── ACIA.ts
│       ├── Sound.ts
│       ├── Storage.ts
│       ├── Video.ts
│       └── Attachments/
│           ├── Attachment.ts
│           ├── JoystickAttachment.ts
│           ├── KeyboardEncoderAttachment.ts
│           └── KeyboardMatrixAttachment.ts
└── tests/                  # Comprehensive test suite
```

### Running Tests

Run all tests:

```bash
npm test
```

Watch mode for development:

```bash
npm run test:watch
```

Generate coverage report:

```bash
npm run test:coverage
```

### Release Build

```
git tag vX.Y.Z
git push origin main --tags
npm publish
```

### Technical Details

- **Language**: TypeScript
- **Target**: CommonJS (Node.js)
- **Testing**: Jest with ts-jest
- **Graphics**: SDL via @kmamal/sdl
- **Serial**: SerialPort library
- **CLI**: Commander.js

## Performance

The emulator targets 2 MHz operation by default (configurable) and attempts to maintain accurate timing by synchronizing with real-time clock cycles. The frame rate is capped at 60 FPS for video output.

## Credits

- CPU implementation adapted from [OneLoneCoder's olcNES](https://github.com/OneLoneCoder/olcNES)
- TMS9918 implementation based on [vrEmuTms9918](https://github.com/visrealm/vrEmuTms9918) by Troy Schrapel

## License

MIT License - See [LICENSE](LICENSE) file for details

## Author

A.C. Wright

## Repository

[https://github.com/acwright/6502-Emulator](https://github.com/acwright/6502-Emulator)

## Contributing

This project is part of the [A.C. Wright Design 6502](https://github.com/acwright/6502) hardware project. Contributions, issues, and feature requests are welcome!
