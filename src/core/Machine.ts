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
import { IO } from './IO'

export class Machine {

  static MAX_FPS: number = 60
  static FRAME_INTERVAL_MS: number = 1000 / Machine.MAX_FPS

  private loopHandle?: ReturnType<typeof setImmediate> | ReturnType<typeof setTimeout>

  cpu: CPU
  ram: RAM
  rom: ROM
  cart?: Cart

  io1!: IO
  io2!: IO
  io3!: IO
  io4!: IO
  io5!: IO
  io6!: IO
  io7!: IO
  io8!: IO

  // VIA Attachments
  keyboardMatrixAttachment?: KeyboardMatrixAttachment
  keyboardEncoderAttachment?: KeyboardEncoderAttachment
  joystickAttachmentA?: JoystickAttachment
  joystickAttachmentB?: JoystickAttachment

  isRunning: boolean = false
  frequency: number = 1000000 // 1 MHz
  scale: number = 2
  frames: number = 0
  startTime: number = Date.now()
  previousTime: number = performance.now()

  transmit?: (data: number) => void
  render?: () => void
  play?: (samples: Float32Array) => void

  //
  // Initialization
  //

  constructor() {
    this.cpu = new CPU(this.read.bind(this), this.write.bind(this))
    this.ram = new RAM()
    this.rom = new ROM()

    this.configure()
    
    this.startTime = Date.now()
    this.cpu.reset()
  }

  private configure(): void {
    const acia = new ACIA()
    this.io5 = acia

    // Connect ACIA transmit callback
    acia.transmit = (data: number) => {
      if (this.transmit) {
        this.transmit(data)
      }
    }

    const rtc = new RTC()
    const storage = new Storage()
    const via = new VIA()
    const sound = new Sound()
    const video = new Video()

    this.io1 = new RAMBank()
    this.io2 = new RAMBank()
    this.io3 = rtc
    this.io4 = storage
    this.io6 = via
    this.io7 = sound
    this.io8 = video

    // Connect Sound pushSamples callback
    sound.pushSamples = (samples: Float32Array) => {
      if (this.play) {
        this.play(samples)
      }
    }

    // Create standard GPIO attachments
    this.keyboardMatrixAttachment = new KeyboardMatrixAttachment(10)
    this.keyboardEncoderAttachment = new KeyboardEncoderAttachment(20)
    this.joystickAttachmentA = new JoystickAttachment(false, 100)
    this.joystickAttachmentB = new JoystickAttachment(false, 100)

    // Attach peripherals to GPIO Card
    via.attachToPortA(this.keyboardMatrixAttachment)
    via.attachToPortB(this.keyboardMatrixAttachment)
    via.attachToPortA(this.keyboardEncoderAttachment)
    via.attachToPortB(this.keyboardEncoderAttachment)
    via.attachToPortA(this.joystickAttachmentA)
    via.attachToPortB(this.joystickAttachmentB)
  }

  //
  // Methods
  //

  loadROM = (data: Uint8Array | number[] | ArrayBuffer) => {
    if (data instanceof ArrayBuffer) {
      this.rom.load(Array.from(new Uint8Array(data)))
    } else if (data instanceof Uint8Array) {
      this.rom.load(Array.from(data))
    } else {
      this.rom.load(data)
    }
  }

  loadCart = (data: Uint8Array | number[] | ArrayBuffer) => {
    let dataArray: number[]
    if (data instanceof ArrayBuffer) {
      dataArray = Array.from(new Uint8Array(data))
    } else if (data instanceof Uint8Array) {
      dataArray = Array.from(data)
    } else {
      dataArray = data
    }
    const cart = new Cart()
    cart.load(dataArray)
    this.cart = cart
  }

  run(): void {
    this.isRunning = true
    this.loop()
  }

  stop(): void {
    this.isRunning = false
    if (this.loopHandle) {
      if (typeof clearImmediate !== 'undefined') {
        clearImmediate(this.loopHandle as any)
      } else {
        clearTimeout(this.loopHandle as any)
      }
      this.loopHandle = undefined
    }
  }

  step(): void {
    // Step through one complete instruction
    const cyclesExecuted = this.cpu.step()
    
    // Tick IO cards for each cycle of the instruction
    for (let i = 0; i < cyclesExecuted; i++) {
      this.tickIO()
    }
  }

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

  tick(): void {
    // Execute one CPU clock cycle
    this.cpu.tick()
    
    // Tick all IO cards and handle level-triggered interrupts
    this.tickIO()
  }

  private tickIO(): void {
    let interrupt = 0
    interrupt |= this.io3.tick(this.frequency)
    interrupt |= this.io4.tick(this.frequency)
    interrupt |= this.io5.tick(this.frequency)
    interrupt |= this.io6.tick(this.frequency)
    interrupt |= this.io7.tick(this.frequency)
    interrupt |= this.io8.tick(this.frequency)

    if (interrupt & 0x80) {
      this.cpu.irqTrigger()
    } else {
      this.cpu.irqClear()
    }
    if (interrupt & 0x40) {
      this.cpu.nmi()
    }
  }

  onReceive(data: number): void {
    (this.io5 as ACIA).onData(data) // Pass data to Serial card
  }

  onKeyDown(scancode: number): void {
    this.keyboardMatrixAttachment?.updateKey(scancode, true)
    this.keyboardEncoderAttachment?.updateKey(scancode, true)
  }

  onKeyUp(scancode: number): void {
    this.keyboardMatrixAttachment?.updateKey(scancode, false)
    this.keyboardEncoderAttachment?.updateKey(scancode, false)
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
          this.tickIO()
        }
        accumulator -= ticksToRun / ticksPerMs
      }

      (this as any)._accumulatorMs = accumulator
    }

    if (this.render) {
      const video = this.io8 as Video
      if (video.frameReady) {
        video.frameReady = false
        this.render()
        this.frames += 1
      }
    }

    if (this.isRunning) {
      if (typeof setImmediate !== 'undefined') {
        this.loopHandle = setImmediate(() => this.loop())
      } else {
        this.loopHandle = setTimeout(() => this.loop(), 0)
      }
    }
  }

  //
  // Bus Operations
  //

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