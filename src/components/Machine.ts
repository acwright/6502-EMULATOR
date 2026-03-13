import { CPU } from './CPU'
import { RAM } from './RAM'
import { ROM } from './ROM'
import { Cart } from './Cart'
import { VIA } from './IO/VIA'
import { RAMBank } from './IO/RAMBank'
import { RTC } from './IO/RTC'
import { ACIA } from './IO/ACIA'
import { Sound } from './IO/Sound'
import { Storage } from './IO/Storage'
import { Video } from './IO/Video'
import { KeyboardMatrixAttachment } from './IO/Attachments/KeyboardMatrixAttachment'
import { KeyboardEncoderAttachment } from './IO/Attachments/KeyboardEncoderAttachment'
import { JoystickAttachment } from './IO/Attachments/JoystickAttachment'
import { LCDAttachment } from './IO/Attachments/LCDAttachment'
import { KeypadAttachment } from './IO/Attachments/KeypadAttachment'
import { Empty } from './IO/Empty'
import { Terminal } from './IO/Terminal'
import { IO } from './IO'
import { readFile } from 'fs/promises'

export class Machine {

  static MAX_FPS: number = 60
  static FRAME_INTERVAL_MS: number = 1000 / Machine.MAX_FPS

  private ioCycleAccumulator: number = 0
  private ioTickInterval: number = 128 // adjust (64/128/256)

  cpu: CPU
  ram: RAM
  rom: ROM
  io1: IO
  io2: IO
  io3: IO
  io4: IO
  io5: ACIA
  io6: IO
  io7: IO
  io8: IO

  cart?: Cart
  target: string

  // GPIO Attachments
  keyboardMatrixAttachment: KeyboardMatrixAttachment
  keyboardEncoderAttachment: KeyboardEncoderAttachment
  joystickAttachmentA: JoystickAttachment
  joystickAttachmentB: JoystickAttachment

  // KIM mode attachments
  lcdAttachment?: LCDAttachment
  keypadAttachment?: KeypadAttachment

  isAlive: boolean = false
  isRunning: boolean = false
  frequency: number = 2000000 // 2 MHz
  scale: number = 2
  frames: number = 0
  frameDelay: number = 0
  frameDelayCount: number = 0
  startTime: number = Date.now()
  previousTime: number = performance.now()

  transmit?: (data: number) => void
  render?: () => void
  pushAudioSamples?: (samples: Float32Array) => void

  //
  // Initialization
  //

  constructor(target: string = 'cob') {
    this.target = target
    this.cpu = new CPU(this.read.bind(this), this.write.bind(this))
    this.ram = new RAM()
    this.rom = new ROM()

    this.io5 = new ACIA()

    // Connect ACIA IRQ/NMI to CPU
    this.io5.raiseIRQ = () => this.cpu.irq()
    this.io5.raiseNMI = () => this.cpu.nmi()

    // Connect ACIA transmit callback
    this.io5.transmit = (data: number) => {
      if (this.transmit) {
        this.transmit(data)
      }
    }

    // Always create standard GPIO attachments (for type stability)
    this.keyboardMatrixAttachment = new KeyboardMatrixAttachment(10)
    this.keyboardEncoderAttachment = new KeyboardEncoderAttachment(20)
    this.joystickAttachmentA = new JoystickAttachment(false, 100)
    this.joystickAttachmentB = new JoystickAttachment(false, 100)

    if (target === 'kim') {
      this.io1 = new Empty()
      this.io2 = new Empty()
      this.io3 = new Empty()
      this.io4 = new Empty()
      this.io6 = new Empty()
      this.io7 = new Empty()

      const gpioCard = new VIA()
      this.io8 = gpioCard

      // Connect VIA IRQ/NMI to CPU
      gpioCard.raiseIRQ = () => this.cpu.irq()
      gpioCard.raiseNMI = () => this.cpu.nmi()

      // Create KIM GPIO Attachments
      this.lcdAttachment = new LCDAttachment(16, 2, 10)
      this.keypadAttachment = new KeypadAttachment(true, 20)

      // Attach LCD to Port A (control: RS/RW/E on bits 5-7) and Port B (data bus)
      gpioCard.attachToPortA(this.lcdAttachment)
      gpioCard.attachToPortB(this.lcdAttachment)

      // Attach keypad to Port A (bits 0-4)
      gpioCard.attachToPortA(this.keypadAttachment)
    } else if (target === 'dev') {
      const rtcCard = new RTC()
      const storageCard = new Storage()
      const gpioCard = new VIA()

      this.io1 = new RAMBank()
      this.io2 = new RAMBank()
      this.io3 = rtcCard
      this.io4 = storageCard
      this.io6 = gpioCard
      this.io7 = new Empty()
      this.io8 = new Terminal()

      // Connect RTC IRQ/NMI to CPU
      rtcCard.raiseIRQ = () => this.cpu.irq()
      rtcCard.raiseNMI = () => this.cpu.nmi()

      // Attach peripherals to GPIO Card
      gpioCard.attachToPortA(this.keyboardMatrixAttachment)
      gpioCard.attachToPortB(this.keyboardMatrixAttachment)
      gpioCard.attachToPortA(this.keyboardEncoderAttachment)
      gpioCard.attachToPortB(this.keyboardEncoderAttachment)
      gpioCard.attachToPortA(this.joystickAttachmentA)
      gpioCard.attachToPortB(this.joystickAttachmentB)
    } else {
      // COB / VCS
      const rtcCard = new RTC()
      const storageCard = new Storage()
      const gpioCard = new VIA()
      const soundCard = new Sound()
      const video = new Video()

      this.io1 = new RAMBank()
      this.io2 = new RAMBank()
      this.io3 = rtcCard
      this.io4 = storageCard
      this.io6 = gpioCard
      this.io7 = soundCard
      this.io8 = video

      // Connect RTC IRQ/NMI to CPU
      rtcCard.raiseIRQ = () => this.cpu.irq()
      rtcCard.raiseNMI = () => this.cpu.nmi()

      // Connect Video IRQ/NMI to CPU
      video.raiseIRQ = () => this.cpu.irq()
      video.raiseNMI = () => this.cpu.nmi()

      // Connect Sound pushSamples callback
      soundCard.pushSamples = (samples: Float32Array) => {
        if (this.pushAudioSamples) {
          this.pushAudioSamples(samples)
        }
      }

      // Attach peripherals to GPIO Card
      gpioCard.attachToPortA(this.keyboardMatrixAttachment)
      gpioCard.attachToPortB(this.keyboardMatrixAttachment)
      gpioCard.attachToPortA(this.keyboardEncoderAttachment)
      gpioCard.attachToPortB(this.keyboardEncoderAttachment)
      gpioCard.attachToPortA(this.joystickAttachmentA)
      gpioCard.attachToPortB(this.joystickAttachmentB)
    }

    this.cpu.reset()
  }

  //
  // Methods
  //

  loadROM = async (path: string) => {
    try {
      this.rom.load(Array.from(new Uint8Array(await readFile(path))))
    } catch (error) {
      console.error('Error reading file:', error)
    }
  }

  loadCart = async (path: string) => {
    try {
      const data = Array.from(new Uint8Array(await readFile(path)))
      const cart = new Cart()
      cart.load(data)
      this.cart = cart
    } catch (error) {
      console.error('Error reading file:', error)
    }
  }

  start(): void {
    this.cpu.reset()
    this.startTime = Date.now()
    this.isRunning = true
    this.isAlive = true
    this.loop()
  }

  end(): void {
    this.isRunning = false
    this.isAlive = false
  }

  run(): void {
    this.isRunning = true
  }

  stop(): void {
    this.isRunning = false
  }

  step(): void {
    // Step through one complete instruction
    const cyclesExecuted = this.cpu.step()
    
    // Tick IO cards for each cycle of the instruction
    for (let i = 0; i < cyclesExecuted; i++) {
      // ACIA must be cycle-accurate
      this.io5.tick(this.frequency)
      
      this.ioCycleAccumulator++
      if (this.ioCycleAccumulator >= this.ioTickInterval) {
        // Skip ticking RAMBank IO1 and IO2 since they have no timing behavior
        this.io3.tick(this.frequency)
        this.io4.tick(this.frequency)
        this.io6.tick(this.frequency)
        this.io7.tick(this.frequency)
        this.io8.tick(this.frequency)
        this.ioCycleAccumulator = 0
      }
    }
  }

  tick(): void {
    // Execute one CPU clock cycle
    this.cpu.tick()
    
    // ACIA must be cycle-accurate
    this.io5.tick(this.frequency)
    
    // Tick other IO cards at intervals
    this.ioCycleAccumulator++
    if (this.ioCycleAccumulator >= this.ioTickInterval) {
      // Skip ticking RAMBank IO1 and IO2 since they have no timing behavior
      this.io3.tick(this.frequency)
      this.io4.tick(this.frequency)
      this.io6.tick(this.frequency)
      this.io7.tick(this.frequency)
      this.io8.tick(this.frequency)
      this.ioCycleAccumulator = 0
    }
  }

  onReceive(data: number): void {
    this.io5.onData(data) // Pass data to Serial card
  }

  onKeyDown(scancode: number): void {
    if (this.target === 'kim') {
      this.keypadAttachment?.updateKey(scancode, true)
    } else {
      this.keyboardMatrixAttachment.updateKey(scancode, true)
      this.keyboardEncoderAttachment.updateKey(scancode, true)
    }
  }

  onKeyUp(scancode: number): void {
    if (this.target !== 'kim') {
      this.keyboardMatrixAttachment.updateKey(scancode, false)
      this.keyboardEncoderAttachment.updateKey(scancode, false)
    }
  }

  onJoystickA(buttons: number): void {
    this.joystickAttachmentA?.updateJoystick(buttons)
  }

  onJoystickB(buttons: number): void {
    this.joystickAttachmentB?.updateJoystick(buttons)
  }

  //
  // Loop Operations
  //

  private loop(): void {
    if (!this.isAlive) { return }

    const now = performance.now()
    const elapsedMs = now - this.previousTime
    this.previousTime = now

    if (this.isRunning) {
      const ticksPerMs = this.frequency / 1000
      let accumulator = (this as any)._accumulatorMs ?? 0
      accumulator += elapsedMs

      const maxCatchUpMs = 250
      if (accumulator > maxCatchUpMs) accumulator = maxCatchUpMs

      const ticksToRun = Math.floor(accumulator * ticksPerMs)
      if (ticksToRun > 0) {
        for (let i = 0; i < ticksToRun; i++) {
          this.cpu.tick()

          // ACIA must be cycle-accurate
          this.io5.tick(this.frequency)

          this.ioCycleAccumulator++
          if (this.ioCycleAccumulator >= this.ioTickInterval) {
            // Skip ticking RAMBank IO1 and IO2 since they have no timing behavior
            this.io3.tick(this.frequency)
            this.io4.tick(this.frequency)
            this.io6.tick(this.frequency)
            this.io7.tick(this.frequency)
            this.io8.tick(this.frequency)
            this.ioCycleAccumulator = 0
          }
        }
        accumulator -= ticksToRun / ticksPerMs
      }

      (this as any)._accumulatorMs = accumulator
    }

    if (this.render && (this.target === 'kim' || this.target === 'dev')) {
      this.render()
      this.frames += 1
    } else if (this.render && (this.target === 'cob' || this.target === 'vcs')) {
      const Video = this.io8 as Video
      if (Video.frameReady) {
        Video.frameReady = false
        this.render()
        this.frames += 1
      }
    }

    setImmediate(() => this.loop())
  }

  //
  // Bus Operations
  //

  reset(coldStart: boolean): void {
    this.cpu.reset()
    this.ram.reset(coldStart)
    this.io1.reset(coldStart)
    this.io2.reset(coldStart)
    this.io3.reset(coldStart)
    this.io4.reset(coldStart)
    this.io5.reset(coldStart)
    this.io6.reset(coldStart)
    this.io7.reset(coldStart)
    this.io8.reset(coldStart)
  }

  read(address: number): number {
    switch(true) {
      case (this.cart && address >= Cart.CODE && address <= Cart.END):
        return this.cart.read(address - Cart.START)
      case (address >= ROM.CODE && address <= ROM.END):
        return this.rom.read(address - ROM.START)
      case (address >= RAM.START && address <= RAM.END):
        return this.ram.read(address)
      case (address >= 0x8000 && address <= 0x83FF):
        return this.io1.read(address - 0x8000) || 0
      case (address >= 0x8400 && address <= 0x87FF):
        return this.io2.read(address - 0x8400) || 0
      case (address >= 0x8800 && address <= 0x8BFF):
        return this.io3.read(address - 0x8800) || 0
      case (address >= 0x8C00 && address <= 0x8FFF):
        return this.io4.read(address - 0x8C00) || 0
      case (address >= 0x9000 && address <= 0x93FF):
        return this.io5.read(address - 0x9000) || 0
      case (address >= 0x9400 && address <= 0x97FF):
        return this.io6.read(address - 0x9400) || 0
      case (address >= 0x9800 && address <= 0x9BFF):
        return this.io7.read(address - 0x9800) || 0
      case (address >= 0x9C00 && address <= 0x9FFF):
        return this.io8.read(address - 0x9C00) || 0
      default:
        return 0
    }
  }

  write(address: number, data: number): void {
    switch(true) {
      case (address >= RAM.START && address <= RAM.END):
        this.ram.write(address, data)
        return
      case (address >= 0x8000 && address <= 0x83FF):
        this.io1.write(address - 0x8000, data)
        return
      case (address >= 0x8400 && address <= 0x87FF):
        this.io2.write(address - 0x8400, data)
        return
      case (address >= 0x8800 && address <= 0x8BFF):
        this.io3.write(address - 0x8800, data)
        return
      case (address >= 0x8C00 && address <= 0x8FFF):
        this.io4.write(address - 0x8C00, data)
        return
      case (address >= 0x9000 && address <= 0x93FF):
        this.io5.write(address - 0x9000, data)
        return
      case (address >= 0x9400 && address <= 0x97FF):
        this.io6.write(address - 0x9400, data)
        return
      case (address >= 0x9800 && address <= 0x9BFF):
        this.io7.write(address - 0x9800, data)
        return
      case (address >= 0x9C00 && address <= 0x9FFF):
        this.io8.write(address - 0x9C00, data)
        return
      default:
        return
    }
  }

}