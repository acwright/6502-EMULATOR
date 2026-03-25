#! /usr/bin/env node

import figlet from 'figlet'
import { Machine } from './components/Machine'
import { Command, Option } from 'commander'
import { SerialPort } from 'serialport'
import { Video } from './components/IO/Video'
import { Terminal } from './components/IO/Terminal'
import { Storage } from './components/IO/Storage'
import { Sound } from './components/IO/Sound'
import sdl from '@kmamal/sdl'
import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'

const VERSION = '1.8.0'
const WIDTH = 320
const HEIGHT = 240

// Audio constants
const AUDIO_SAMPLE_RATE = 44100
const AUDIO_CHANNELS = 1
const AUDIO_FORMAT = 'f32'
const AUDIO_BUFFERED = 2048

// Joystick button bit masks (matching JoystickAttachment)
const BUTTON_UP = 0x01
const BUTTON_DOWN = 0x02
const BUTTON_LEFT = 0x04
const BUTTON_RIGHT = 0x08
const BUTTON_A = 0x10
const BUTTON_B = 0x20
const BUTTON_SELECT = 0x40
const BUTTON_START = 0x80

// Axis threshold for converting analog input to digital (50% of normalized range)
const AXIS_THRESHOLD = 0.5

interface EmulatorOptions {
  cart?: string
  freq?: string
  rom?: string
  scale?: string
  baudrate?: string
  parity?: string
  databits?: string
  stopbits?: string
  port?: string
  storage?: string
  target?: string
  encoder?: string
}

class Emulator {
  private machine: Machine
  private serialPort?: SerialPort
  private window?: any
  private audioDevice?: any
  private controllers: Map<number, any>
  private joystickButtonStateA: number
  private joystickButtonStateB: number
  private options: EmulatorOptions

  constructor(options: EmulatorOptions) {
    this.options = options
    this.machine = new Machine(options.target ?? 'cob')
    this.controllers = new Map()
    this.joystickButtonStateA = 0x00
    this.joystickButtonStateB = 0x00
  }

  async initialize(): Promise<void> {
    this.validateOptions()
    await this.loadBinaries()
    this.configureFrequency()
    this.configureScale()
    this.configureEncoder()
    await this.setupSerialPort()
    this.setupAudio()
    this.setupWindow()
    this.setupControllers()
    this.machine.reset(true)
  }

  private validateOptions(): void {
    const dataBits = parseInt(this.options.databits || '8') as 5 | 6 | 7 | 8
    const stopBits = parseFloat(this.options.stopbits || '1') as 1 | 1.5 | 2

    if (dataBits !== 5 && dataBits !== 6 && dataBits !== 7 && dataBits !== 8) {
      console.log('Error: Invalid Data Bits')
      process.exit(1)
    }
    if (stopBits !== 1 && stopBits !== 1.5 && stopBits !== 2) {
      console.log('Error: Invalid Stop Bits')
      process.exit(1)
    }
  }

  private async loadBinaries(): Promise<void> {
    if (this.options.rom) {
      const romData = await readFile(this.options.rom)
      this.machine.loadROM(new Uint8Array(romData))
      console.log(`Loaded ROM: ${this.options.rom}`)
    } else {
      console.log('Loaded ROM: NONE')
    }

    if (this.options.cart) {
      const cartData = await readFile(this.options.cart)
      this.machine.loadCart(new Uint8Array(cartData))
      console.log(`Loaded Cart: ${this.options.cart}`)
    } else {
      console.log('Loaded Cart: NONE')
    }

    if (this.options.storage && this.options.target !== 'kim') {
      if (existsSync(this.options.storage)) {
        const storageData = await readFile(this.options.storage)
        ;(this.machine.io4 as Storage).loadData(new Uint8Array(storageData))
      } else {
        console.log(`Storage file not found: ${this.options.storage}`)
        console.log('Initializing new storage file...')
        const emptyStorage = (this.machine.io4 as Storage).getData()
        await writeFile(this.options.storage, emptyStorage)
        console.log(`Storage file created: ${this.options.storage}`)
      }
    }
  }

  private configureEncoder(): void {
    const enc = this.options.encoder ?? 'matrix'
    const activePort = enc === 'ps2' ? 'A' : enc === 'matrix' ? 'B' : 'both'
    if (this.machine.keyboardEncoderAttachment) {
      this.machine.keyboardEncoderAttachment.activePort = activePort as 'A' | 'B' | 'both'
      console.log(`Keyboard encoder: ${enc} (Port ${activePort})`)
    }
  }

  private configureFrequency(): void {
    if (this.options.freq) {
      const frequency = Number(this.options.freq)
      
      if (!isNaN(frequency)) {
        this.machine.frequency = frequency
        console.log(`Frequency: ${this.options.freq} Hz`)
      } else {
        console.log()
        console.error(`Aborting... Error Invalid Frequency: '${this.options.freq}'`)
        process.exit(1)
      }
    } else {
      console.log("Frequency: 1000000 Hz")
    }
  }

  private configureScale(): void {
    if (this.options.scale) {
      const scale = Number(this.options.scale)

      if (!isNaN(scale)) {
        this.machine.scale = scale
        console.log(`Scale: ${this.options.scale}x`)
      } else {
        console.log()
        console.error(`Aborting... Error Invalid Scale: '${this.options.scale}'`)
        process.exit(1)
      }
    } else {
      console.log(`Scale: 1x`)
    }
  }

  private async setupSerialPort(): Promise<void> {
    if (!this.options.port) {
      return
    }

    const baudRate = parseInt(this.options.baudrate || '9600')
    const parity = (this.options.parity || 'none') as 'odd' | 'even' | 'none'
    const dataBits = parseInt(this.options.databits || '8') as 5 | 6 | 7 | 8
    const stopBits = parseFloat(this.options.stopbits || '1') as 1 | 1.5 | 2

    this.serialPort = new SerialPort({
      path: this.options.port,
      baudRate: baudRate,
      parity: parity,
      dataBits: dataBits,
      stopBits: stopBits,
      autoOpen: false
    })

    this.serialPort.on('data', (data: Buffer<ArrayBuffer>) => {
      for (let i = 0; i < data.length; i++) {
        this.machine.onReceive(data[i])
      }
    })

    this.machine.transmit = (data: number) => {
      if (this.serialPort && this.serialPort.isOpen) {
        this.serialPort.write(Buffer.from([data]), (err) => {
          if (err) {
            console.log('Error sending serial data: ', err.message)
          }
        })
      }
    }

    await new Promise<void>((resolve, reject) => {
      this.serialPort!.open((err) => {
        if (err) {
          console.log('Error opening serial port: ', err.message)
          reject(err)
        } else {
          console.log(`Serial port opened: ${this.options.port}`)
          resolve()
        }
      })
    })
  }

  private setupAudio(): void {
    if (this.options.target === 'kim') return
    try {
      this.audioDevice = sdl.audio.openDevice({ type: 'playback' }, {
        channels: AUDIO_CHANNELS as 1,
        frequency: AUDIO_SAMPLE_RATE,
        format: AUDIO_FORMAT as any,
        buffered: AUDIO_BUFFERED,
      })

      // Configure Sound sample rate to match audio device (not needed for dev target)
      if (this.options.target !== 'dev') {
        ;(this.machine.io7 as Sound).sampleRate = this.audioDevice.frequency
      }

      // Connect the Machine's audio callback to the SDL audio device
      this.machine.play = (samples: Float32Array) => {
        if (!this.audioDevice || this.audioDevice.closed) return

        const { channels, bytesPerSample } = this.audioDevice
        const buffer = Buffer.alloc(samples.length * channels * bytesPerSample)
        let offset = 0
        for (let i = 0; i < samples.length; i++) {
          for (let ch = 0; ch < channels; ch++) {
            offset = this.audioDevice.writeSample(buffer, samples[i], offset)
          }
        }
        this.audioDevice.enqueue(buffer)
      }

      this.audioDevice.play()
      console.log(`Audio: ${this.audioDevice.frequency} Hz, ${AUDIO_FORMAT}, buffer ${AUDIO_BUFFERED}`)
    } catch (error) {
      console.error('Failed to initialize audio:', error)
    }
  }

  private setupWindow(): void {
    const isKIM = this.options.target === 'kim'
    const lcd = this.machine.lcdAttachment

    // LCD dot-matrix rendering constants
    const DOT_SIZE = 2      // Each LCD dot rendered as DOT_SIZE x DOT_SIZE pixels
    const DOT_GAP = 1       // Gap between dots
    const LCD_PADDING = 8   // Green border padding around the display
    const CELL = DOT_SIZE + DOT_GAP

    let windowWidth: number
    let windowHeight: number
    if (isKIM && lcd) {
      windowWidth = LCD_PADDING * 2 + lcd.pixelsWidth * CELL
      windowHeight = LCD_PADDING * 2 + lcd.pixelsHeight * CELL
    } else {
      windowWidth = WIDTH
      windowHeight = HEIGHT
    }

    this.window = sdl.video.createWindow({
      title: `6502 Emulator (${(this.options.target ?? 'cob').toUpperCase()})`,
      width: windowWidth * this.machine.scale,
      height: windowHeight * this.machine.scale,
      accelerated: true,
      vsync: true
    })

    this.window.on('keyDown', (event: any) => {
      if (!event.scancode) { return }
      this.machine.onKeyDown(event.scancode)
    })

    this.window.on('keyUp', (event: any) => {
      if (!event.scancode) { return }
      this.machine.onKeyUp(event.scancode)
    })

    if (isKIM && lcd) {
      const lcdWidth = lcd.pixelsWidth
      const lcdHeight = lcd.pixelsHeight
      const renderWidth = windowWidth
      const renderHeight = windowHeight
      const rgbaBuffer = Buffer.alloc(renderWidth * renderHeight * 4)

      // Pre-fill with background color (LCD green for padding + gaps)
      for (let i = 0; i < renderWidth * renderHeight; i++) {
        const off = i * 4
        rgbaBuffer[off] = 0x50
        rgbaBuffer[off + 1] = 0x88
        rgbaBuffer[off + 2] = 0x38
        rgbaBuffer[off + 3] = 0xFF
      }

      this.machine.render = () => {
        if (!this.window) { return }
        const buf = lcd.buffer

        // Reset buffer to background color
        for (let i = 0; i < renderWidth * renderHeight; i++) {
          const off = i * 4
          rgbaBuffer[off] = 0x50
          rgbaBuffer[off + 1] = 0x88
          rgbaBuffer[off + 2] = 0x38
          rgbaBuffer[off + 3] = 0xFF
        }

        // Render each buffer pixel as a dot block
        for (let by = 0; by < lcdHeight; by++) {
          for (let bx = 0; bx < lcdWidth; bx++) {
            const val = buf[by * lcdWidth + bx]

            if (val < 0) {
              // Gap pixel - skip, shows background color
              continue
            }

            let r: number, g: number, b: number
            if (val === 0) {
              // Pixel off - slightly brighter than background for visible dot grid
              r = 0x60; g = 0xA0; b = 0x40
            } else {
              // Pixel on - dark
              r = 0x10; g = 0x20; b = 0x10
            }

            // Draw DOT_SIZE x DOT_SIZE block
            const screenX = LCD_PADDING + bx * CELL
            const screenY = LCD_PADDING + by * CELL
            for (let dy = 0; dy < DOT_SIZE; dy++) {
              for (let dx = 0; dx < DOT_SIZE; dx++) {
                const off = ((screenY + dy) * renderWidth + (screenX + dx)) * 4
                rgbaBuffer[off] = r
                rgbaBuffer[off + 1] = g
                rgbaBuffer[off + 2] = b
                rgbaBuffer[off + 3] = 0xFF
              }
            }
          }
        }

        this.window.render(renderWidth, renderHeight, renderWidth * 4, 'rgba32', rgbaBuffer)
      }
    } else if (this.options.target === 'cob' || this.options.target === 'vcs') {
      const Video = this.machine.io8 as Video
      this.machine.render = () => {
        if (!this.window) { return }
        this.window.render(WIDTH, HEIGHT, WIDTH * 4, 'rgba32', Video.buffer)
      }
    } else if (this.options.target === 'dev') {
      const devBoard = this.machine.io8 as Terminal
      const rgbaBuffer = Buffer.alloc(WIDTH * HEIGHT * 4)
      this.machine.render = () => {
        if (!this.window) { return }
        const src = devBoard.vtac.buffer
        for (let i = 0; i < WIDTH * HEIGHT; i++) {
          const v = src[i]
          const off = i * 4
          const r3 = (v >> 5) & 0x07
          const g3 = (v >> 2) & 0x07
          const b2 = v & 0x03
          rgbaBuffer[off]     = (r3 << 5) | (r3 << 2) | (r3 >> 1)
          rgbaBuffer[off + 1] = (g3 << 5) | (g3 << 2) | (g3 >> 1)
          rgbaBuffer[off + 2] = (b2 << 6) | (b2 << 4) | (b2 << 2) | b2
          rgbaBuffer[off + 3] = 0xFF
        }
        this.window.render(WIDTH, HEIGHT, WIDTH * 4, 'rgba32', rgbaBuffer)

        // Synthesize and play any queued VTAC bell tones
        if (this.machine.play && this.audioDevice) {
          const sampleRate = this.audioDevice.frequency
          while (devBoard.vtac.hasQueuedBells()) {
            const bell = devBoard.vtac.getNextBell()
            if (bell) {
              const numSamples = Math.floor((bell.duration / 60) * sampleRate)
              const samples = new Float32Array(numSamples)
              const twoPiF = 2 * Math.PI * bell.frequency
              for (let i = 0; i < numSamples; i++) {
                samples[i] = Math.sin(twoPiF * i / sampleRate)
              }
              this.machine.play(samples)
            }
          }
        }
      }
    }

    this.window.on('close', () => this.shutdown())
  }

  private playerForController(deviceId: number): 'A' | 'B' {
    const ids = Array.from(this.controllers.keys())
    return ids.indexOf(deviceId) === 0 ? 'B' : 'A'
  }

  private setupControllers(): void {
    if (this.options.target === 'kim') return
    // Controller device add/remove handlers
    (sdl.controller as any).on('deviceAdd', (device: any) => {
      console.log(`Controller added: ${device.name || device.id}`)
      
      try {
        const controller = sdl.controller.openDevice(device)
        this.controllers.set(device.id, controller)
        
        const player = this.playerForController(device.id)
        this.setupControllerHandlers(controller, device, player)
        
        console.log(`Controller ${device.name || device.id} opened as Player ${player}`)
      } catch (error) {
        console.error(`Failed to open controller ${device.name || device.id}:`, error)
      }
    })

    ;(sdl.controller as any).on('deviceRemove', (device: any) => {
      console.log(`Controller removed: ${device.name || device.id}`)
      
      const player = this.playerForController(device.id)
      const controller = this.controllers.get(device.id)
      if (controller && !controller.closed) {
        controller.close()
      }
      this.controllers.delete(device.id)
      
      // Clear joystick state for the removed controller's player
      if (player === 'A') {
        this.joystickButtonStateA = 0x00
        this.machine.onJoystickA(this.joystickButtonStateA)
      } else {
        this.joystickButtonStateB = 0x00
        this.machine.onJoystickB(this.joystickButtonStateB)
      }
    })

    // Initialize controllers - detect any already connected
    console.log('Scanning for controllers...')
    const devices = sdl.controller.devices
    if (devices && devices.length > 0) {
      console.log(`Found ${devices.length} controller(s)`)
      devices.forEach((device: any) => {
        try {
          const controller = sdl.controller.openDevice(device)
          this.controllers.set(device.id, controller)
          
          const player = this.playerForController(device.id)
          this.setupControllerHandlers(controller, device, player)
          
          console.log(`Controller ${device.name || device.id} opened as Player ${player}`)
        } catch (error) {
          console.error(`Failed to open controller ${device.name || device.id}:`, error)
        }
      })
    } else {
      console.log('No controllers found')
    }
  }

  private setupControllerHandlers(controller: any, device: any, player: 'A' | 'B'): void {
    const getState = () => player === 'A' ? this.joystickButtonStateA : this.joystickButtonStateB
    const setState = (v: number) => {
      if (player === 'A') this.joystickButtonStateA = v
      else this.joystickButtonStateB = v
    }
    const send = () => {
      if (player === 'A') this.machine.onJoystickA(this.joystickButtonStateA)
      else this.machine.onJoystickB(this.joystickButtonStateB)
    }

    ;(controller as any).on('buttonDown', (button: string) => {
      let state = getState()
      switch (button) {
        case 'dpadUp':    state |= BUTTON_UP; break
        case 'dpadDown':  state |= BUTTON_DOWN; break
        case 'dpadLeft':  state |= BUTTON_LEFT; break
        case 'dpadRight': state |= BUTTON_RIGHT; break
        case 'a':         state |= BUTTON_A; break
        case 'b':         state |= BUTTON_B; break
        case 'back':      state |= BUTTON_SELECT; break
        case 'start':     state |= BUTTON_START; break
      }
      setState(state)
      send()
    })

    ;(controller as any).on('buttonUp', (button: string) => {
      let state = getState()
      switch (button) {
        case 'dpadUp':    state &= ~BUTTON_UP; break
        case 'dpadDown':  state &= ~BUTTON_DOWN; break
        case 'dpadLeft':  state &= ~BUTTON_LEFT; break
        case 'dpadRight': state &= ~BUTTON_RIGHT; break
        case 'a':         state &= ~BUTTON_A; break
        case 'b':         state &= ~BUTTON_B; break
        case 'back':      state &= ~BUTTON_SELECT; break
        case 'start':     state &= ~BUTTON_START; break
      }
      setState(state)
      send()
    })

    controller.on('axisMotion', ({ axis, value }: { axis: string; value: number }) => {
      let state = getState()
      if (axis === 'leftStickX') {
        if (value < -AXIS_THRESHOLD) {
          state |= BUTTON_LEFT
          state &= ~BUTTON_RIGHT
        } else if (value > AXIS_THRESHOLD) {
          state |= BUTTON_RIGHT
          state &= ~BUTTON_LEFT
        } else {
          state &= ~(BUTTON_LEFT | BUTTON_RIGHT)
        }
        setState(state)
        send()
      } else if (axis === 'leftStickY') {
        if (value < -AXIS_THRESHOLD) {
          state |= BUTTON_UP
          state &= ~BUTTON_DOWN
        } else if (value > AXIS_THRESHOLD) {
          state |= BUTTON_DOWN
          state &= ~BUTTON_UP
        } else {
          state &= ~(BUTTON_UP | BUTTON_DOWN)
        }
        setState(state)
        send()
      }
    })

    controller.on('close', () => {
      console.log(`Controller closed: ${device.name || device.id}`)
      this.controllers.delete(device.id)
    })
  }

  private shutdown(): void {
    // Stop the machine loop to prevent further rendering after window close
    this.machine.stop()

    // Close all connected controllers
    for (const [id, controller] of this.controllers.entries()) {
      if (!controller.closed) {
        console.log(`Closing controller ${id}`)
        controller.close()
      }
    }
    this.controllers.clear()
    
    // Close the audio device
    if (this.audioDevice && !this.audioDevice.closed) {
      this.audioDevice.pause()
      this.audioDevice.close()
    }

    if (this.serialPort && this.serialPort.isOpen) {
      this.serialPort.close((err) => {
        if (err) {
          console.log('Error closing serial port: ', err.message)
        }
      })
    }

    const uptime = Date.now() - this.machine.startTime

    console.log()
    console.log('Result:')
    console.table({
      'Time Elapsed': uptime / 1000,
      'CPU Cycles': this.machine.cpu.cycles,
      'Frames': this.machine.frames,
      'Avg FPS': parseFloat((this.machine.frames / (uptime / 1000)).toFixed(2))
    })
    
    // Save storage data if path was provided
    if (this.options.storage && this.options.target !== 'kim') {
      const storageData = (this.machine.io4 as Storage).getData()
      writeFile(this.options.storage, storageData).then(() => {
        console.log(`Storage saved to: ${this.options.storage}`)
        process.exit(0)
      }).catch((error) => {
        console.error('Error saving storage file:', error)
        process.exit(1)
      })
    } else {
      process.exit(0)
    }
  }

  run(): void {
    this.machine.run()
  }
}

// Parse command line arguments
const program = new Command()
program
  .name('ac6502')
  .description('Emulator for the A.C. Wright 6502 project.')
  .version(VERSION, '-v, --version', 'Output the current emulator version')
  .helpOption('-h, --help', 'Output help / options')
  .addOption(new Option('-a, --parity <parity>', 'Parity (odd | even | none)').default('none'))
  .addOption(new Option('-b, --baudrate <baudrate>', 'Baud Rate').default('9600'))
  .addOption(new Option('-c, --cart <path>', 'Path to 32K Cart binary file'))
  .addOption(new Option('-d, --databits <databits>', 'Data Bits (5 | 6 | 7 | 8)').default('8'))
  .addOption(new Option('-f, --freq <freq>', 'Set the clock frequency in Hz').default('1000000'))
  .addOption(new Option('-p, --port <port>', 'Path to the serial port (e.g., /dev/ttyUSB0)'))
  .addOption(new Option('-r, --rom <path>', 'Path to 32K ROM binary file'))
  .addOption(new Option('-s, --scale <scale>', 'Set the emulator scale').default('2'))
  .addOption(new Option('-S, --storage <path>', 'Path to storage data file for Compact Flash card persistence'))
  .addOption(new Option('-t, --stopbits <stopbits>', 'Stop Bits (1 | 1.5 | 2)').default('1'))
  .addOption(new Option('-T, --target <target>', 'System target').choices(['cob', 'vcs', 'kim', 'dev']).default('cob'))
  .addOption(new Option('-e, --encoder <mode>', 'Keyboard encoder active port (ps2 = Port A / CA1, matrix = Port B / CB1)').choices(['ps2', 'matrix', 'both']).default('matrix'))
  .addHelpText('beforeAll', figlet.textSync('6502 Emulator', { font: 'cricket' }) + '\n' + `Version: ${VERSION} | A.C. Wright Design\n`)
  .parse(process.argv)

const options = program.opts()

// Main initialization function
async function main() {
  const emulator = new Emulator(options)
  await emulator.initialize()
  emulator.run()
}

// Run the main function
main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})