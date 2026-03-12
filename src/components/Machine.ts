import { CPU } from './CPU'
import { RAM } from './RAM'
import { ROM } from './ROM'
import { Cart } from './Cart'
import { GPIOCard } from './IO/GPIOCard'
import { RAMCard } from './IO/RAMCard'
import { RTCCard } from './IO/RTCCard'
import { SerialCard } from './IO/SerialCard'
import { SoundCard } from './IO/SoundCard'
import { StorageCard } from './IO/StorageCard'
import { VideoCard } from './IO/VideoCard'
import { GPIOKeyboardMatrixAttachment } from './IO/GPIOAttachments/GPIOKeyboardMatrixAttachment'
import { GPIOKeyboardEncoderAttachment } from './IO/GPIOAttachments/GPIOKeyboardEncoderAttachment'
import { GPIOJoystickAttachment } from './IO/GPIOAttachments/GPIOJoystickAttachment'
import { GPIOLCDAttachment } from './IO/GPIOAttachments/GPIOLCDAttachment'
import { GPIOKeypadAttachment } from './IO/GPIOAttachments/GPIOKeypadAttachment'
import { EmptyCard } from './IO/EmptyCard'
import { DevOutputBoard } from './IO/DevOutputBoard'
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
  io5: SerialCard
  io6: IO
  io7: IO
  io8: IO

  cart?: Cart
  target: string

  // GPIO Attachments
  keyboardMatrixAttachment: GPIOKeyboardMatrixAttachment
  keyboardEncoderAttachment: GPIOKeyboardEncoderAttachment
  joystickAttachmentA: GPIOJoystickAttachment
  joystickAttachmentB: GPIOJoystickAttachment

  // KIM mode attachments
  lcdAttachment?: GPIOLCDAttachment
  keypadAttachment?: GPIOKeypadAttachment

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

    this.io5 = new SerialCard()

    // Connect SerialCard IRQ/NMI to CPU
    this.io5.raiseIRQ = () => this.cpu.irq()
    this.io5.raiseNMI = () => this.cpu.nmi()

    // Connect SerialCard transmit callback
    this.io5.transmit = (data: number) => {
      if (this.transmit) {
        this.transmit(data)
      }
    }

    // Always create standard GPIO attachments (for type stability)
    this.keyboardMatrixAttachment = new GPIOKeyboardMatrixAttachment(10)
    this.keyboardEncoderAttachment = new GPIOKeyboardEncoderAttachment(20)
    this.joystickAttachmentA = new GPIOJoystickAttachment(false, 100)
    this.joystickAttachmentB = new GPIOJoystickAttachment(false, 100)

    if (target === 'kim') {
      this.io1 = new EmptyCard()
      this.io2 = new EmptyCard()
      this.io3 = new EmptyCard()
      this.io4 = new EmptyCard()
      this.io6 = new EmptyCard()
      this.io7 = new EmptyCard()

      const gpioCard = new GPIOCard()
      this.io8 = gpioCard

      // Connect GPIOCard IRQ/NMI to CPU
      gpioCard.raiseIRQ = () => this.cpu.irq()
      gpioCard.raiseNMI = () => this.cpu.nmi()

      // Create KIM GPIO Attachments
      this.lcdAttachment = new GPIOLCDAttachment(16, 2, 10)
      this.keypadAttachment = new GPIOKeypadAttachment(true, 20)

      // Attach LCD to Port A (control: RS/RW/E on bits 5-7) and Port B (data bus)
      gpioCard.attachToPortA(this.lcdAttachment)
      gpioCard.attachToPortB(this.lcdAttachment)

      // Attach keypad to Port A (bits 0-4)
      gpioCard.attachToPortA(this.keypadAttachment)
    } else if (target === 'dev') {
      const rtcCard = new RTCCard()
      const storageCard = new StorageCard()
      const gpioCard = new GPIOCard()

      this.io1 = new RAMCard()
      this.io2 = new RAMCard()
      this.io3 = rtcCard
      this.io4 = storageCard
      this.io6 = gpioCard
      this.io7 = new EmptyCard()
      this.io8 = new DevOutputBoard()

      // Connect RTCCard IRQ/NMI to CPU
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
      const rtcCard = new RTCCard()
      const storageCard = new StorageCard()
      const gpioCard = new GPIOCard()
      const soundCard = new SoundCard()
      const videoCard = new VideoCard()

      this.io1 = new RAMCard()
      this.io2 = new RAMCard()
      this.io3 = rtcCard
      this.io4 = storageCard
      this.io6 = gpioCard
      this.io7 = soundCard
      this.io8 = videoCard

      // Connect RTCCard IRQ/NMI to CPU
      rtcCard.raiseIRQ = () => this.cpu.irq()
      rtcCard.raiseNMI = () => this.cpu.nmi()

      // Connect VideoCard IRQ/NMI to CPU
      videoCard.raiseIRQ = () => this.cpu.irq()
      videoCard.raiseNMI = () => this.cpu.nmi()

      // Connect SoundCard pushSamples callback
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
      // SerialCard must be cycle-accurate
      this.io5.tick(this.frequency)
      
      this.ioCycleAccumulator++
      if (this.ioCycleAccumulator >= this.ioTickInterval) {
        // Skip ticking RAMCard IO1 and IO2 since they have no timing behavior
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
    
    // SerialCard must be cycle-accurate
    this.io5.tick(this.frequency)
    
    // Tick other IO cards at intervals
    this.ioCycleAccumulator++
    if (this.ioCycleAccumulator >= this.ioTickInterval) {
      // Skip ticking RAMCard IO1 and IO2 since they have no timing behavior
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

          // SerialCard must be cycle-accurate
          this.io5.tick(this.frequency)

          this.ioCycleAccumulator++
          if (this.ioCycleAccumulator >= this.ioTickInterval) {
            // Skip ticking RAMCard IO1 and IO2 since they have no timing behavior
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
      const videoCard = this.io8 as VideoCard
      if (videoCard.frameReady) {
        videoCard.frameReady = false
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