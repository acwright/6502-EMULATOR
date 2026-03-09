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
import { readFile } from 'fs/promises'

export class Machine {

  static MAX_FPS: number = 60
  static FRAME_INTERVAL_MS: number = 1000 / Machine.MAX_FPS

  private ioCycleAccumulator: number = 0
  private ioTickInterval: number = 128 // adjust (64/128/256)

  cpu: CPU
  ram: RAM
  rom: ROM
  io1: RAMCard
  io2: RAMCard
  io3: RTCCard
  io4: StorageCard
  io5: SerialCard
  io6: GPIOCard
  io7: SoundCard
  io8: VideoCard

  cart?: Cart

  // GPIO Attachments
  keyboardMatrixAttachment: GPIOKeyboardMatrixAttachment
  keyboardEncoderAttachment: GPIOKeyboardEncoderAttachment
  joystickAttachmentA: GPIOJoystickAttachment
  joystickAttachmentB: GPIOJoystickAttachment

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
  render?: (buffer: Buffer<ArrayBufferLike>) => void
  pushAudioSamples?: (samples: Float32Array) => void

  //
  // Initialization
  //

  constructor() {
    this.cpu = new CPU(this.read.bind(this), this.write.bind(this))
    this.ram = new RAM()
    this.rom = new ROM()
    this.io1 = new RAMCard()
    this.io2 = new RAMCard()
    this.io3 = new RTCCard()
    this.io4 = new StorageCard()
    this.io5 = new SerialCard()
    this.io6 = new GPIOCard()
    this.io7 = new SoundCard()
    this.io8 = new VideoCard()

    // Connect RTCCard IRQ/NMI to CPU
    this.io3.raiseIRQ = () => this.cpu.irq()
    this.io3.raiseNMI = () => this.cpu.nmi()

    // Connect SerialCard IRQ/NMI to CPU
    this.io5.raiseIRQ = () => this.cpu.irq()
    this.io5.raiseNMI = () => this.cpu.nmi()

    // Connect SerialCard transmit callback (use arrow function to look up this.transmit at call time)
    this.io5.transmit = (data: number) => {
      if (this.transmit) {
        this.transmit(data)
      }
    }

    // Connect VideoCard IRQ/NMI to CPU
    this.io8.raiseIRQ = () => this.cpu.irq()
    this.io8.raiseNMI = () => this.cpu.nmi()

    // Connect SoundCard pushSamples callback (use arrow function to look up this.pushAudioSamples at call time)
    this.io7.pushSamples = (samples: Float32Array) => {
      if (this.pushAudioSamples) {
        this.pushAudioSamples(samples)
      }
    }

    // Create GPIO Attachments
    // Keyboard matrix (manual scanning) - highest priority for Port A rows (priority 10)
    this.keyboardMatrixAttachment = new GPIOKeyboardMatrixAttachment(10)
    
    // Keyboard encoder (ASCII on both Port A and Port B) - medium priority (priority 20)
    this.keyboardEncoderAttachment = new GPIOKeyboardEncoderAttachment(20)
    
    // Joystick - lowest priority, fallback (priority 100)
    this.joystickAttachmentA = new GPIOJoystickAttachment(false, 100)
    this.joystickAttachmentB = new GPIOJoystickAttachment(false, 100)

    // Attach peripherals to GPIO Card
    this.io6.attachToPortA(this.keyboardMatrixAttachment)
    this.io6.attachToPortB(this.keyboardMatrixAttachment)
    this.io6.attachToPortA(this.keyboardEncoderAttachment)
    this.io6.attachToPortB(this.keyboardEncoderAttachment)
    this.io6.attachToPortA(this.joystickAttachmentA)
    this.io6.attachToPortB(this.joystickAttachmentB)

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
    // Route keyboard input to attachments
    this.keyboardMatrixAttachment.updateKey(scancode, true)   // Update keyboard matrix
    this.keyboardEncoderAttachment.updateKey(scancode, true)  // Update keyboard encoder
  }

  onKeyUp(scancode: number): void {
    // Release key from keyboard matrix and encoder
    this.keyboardMatrixAttachment.updateKey(scancode, false)  // Update keyboard matrix
    this.keyboardEncoderAttachment.updateKey(scancode, false) // Update keyboard encoder
  }

  onJoystick(buttons: number): void {
    // Update joystick attachments with button states
    // For now we are just supporting one emulator attached joystick 
    // and sending data to both Joystick ports
    // TODO: Support multiple joysticks
    this.joystickAttachmentA.updateJoystick(buttons)
    this.joystickAttachmentB.updateJoystick(buttons)
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

    if (this.render) {
      this.render(this.io8.buffer)
      this.frames += 1
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