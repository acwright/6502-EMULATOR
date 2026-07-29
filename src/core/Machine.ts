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

/** The eight memory-mapped expansion slots, in address order from $8000. */
export type SlotName = 'io1' | 'io2' | 'io3' | 'io4' | 'io5' | 'io6' | 'io7' | 'io8'

/**
 * Cards to place in the slots, overriding the standard layout.
 *
 * Pass `new Empty()` to leave a slot vacant — the BIOS probes each slot on boot
 * and adapts, so an empty video slot is how you get a serial console rather than
 * a video one. Omitted slots get the standard card.
 */
export type SlotConfig = Partial<Record<SlotName, IO>>

export class Machine {

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

  // VIA Attachments — only created when a VIA is actually present in a slot.
  keyboardMatrixAttachment?: KeyboardMatrixAttachment
  keyboardEncoderAttachment?: KeyboardEncoderAttachment
  joystickAttachmentA?: JoystickAttachment
  joystickAttachmentB?: JoystickAttachment

  frequency: number = 1000000 // 1 MHz

  /**
   * Clock cycles elapsed since the machine was created.
   *
   * Distinct from `cpu.cycles`, which adds each instruction's cost up front at
   * decode time and so runs ahead of the clock mid-instruction. This one counts
   * actual ticks, which is what a cycle budget has to mean. Monotonic — a reset
   * does not zero it.
   */
  cycles: number = 0

  transmit?: (data: number) => void
  render?: () => void
  play?: (samples: Float32Array) => void
  /** Discard audio already queued on the host — the machine is no longer producing it. */
  flushAudio?: () => void

  //
  // Initialization
  //

  constructor(slots: SlotConfig = {}) {
    this.cpu = new CPU(this.read.bind(this), this.write.bind(this))
    this.ram = new RAM()
    this.rom = new ROM()

    this.configure(slots)

    this.cpu.reset()
  }

  private configure(slots: SlotConfig): void {
    this.io1 = slots.io1 ?? new RAMBank()
    this.io2 = slots.io2 ?? new RAMBank()
    this.io3 = slots.io3 ?? new RTC()
    this.io4 = slots.io4 ?? new Storage()
    this.io5 = slots.io5 ?? new ACIA()
    this.io6 = slots.io6 ?? new VIA()
    this.io7 = slots.io7 ?? new Sound()
    this.io8 = slots.io8 ?? new Video()

    // Wire the machine's outward callbacks by capability rather than by slot
    // number, so a card still reaches the host if it is moved or omitted.
    for (const io of this.slots()) {
      if (io instanceof ACIA) {
        io.transmit = (data: number) => this.transmit?.(data)
      }
      if (io instanceof Sound) {
        io.pushSamples = (samples: Float32Array) => this.play?.(samples)
      }
      if (io instanceof VIA) {
        this.attachGPIOPeripherals(io)
      }
    }
  }

  private attachGPIOPeripherals(via: VIA): void {
    this.keyboardMatrixAttachment = new KeyboardMatrixAttachment(10)
    this.keyboardEncoderAttachment = new KeyboardEncoderAttachment(20)
    this.joystickAttachmentA = new JoystickAttachment(false, 100)
    this.joystickAttachmentB = new JoystickAttachment(false, 100)

    via.attachToPortA(this.keyboardMatrixAttachment)
    via.attachToPortB(this.keyboardMatrixAttachment)
    via.attachToPortA(this.keyboardEncoderAttachment)
    via.attachToPortB(this.keyboardEncoderAttachment)
    via.attachToPortA(this.joystickAttachmentA)
    via.attachToPortB(this.joystickAttachmentB)
  }

  /** The eight slot cards in address order. */
  slots(): IO[] {
    return [this.io1, this.io2, this.io3, this.io4, this.io5, this.io6, this.io7, this.io8]
  }

  /** The video card, or undefined when the slot is vacant (serial-console boot). */
  video(): Video | undefined {
    return this.io8 instanceof Video ? this.io8 : undefined
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

  /** Remove any loaded cartridge so the address space reverts to ROM/RAM. */
  unloadCart = () => {
    this.cart = undefined
  }

  /**
   * Advance the machine by exactly `cycles` clock cycles.
   *
   * The engine's bulk-execution primitive. Deciding how many cycles to run and
   * when belongs to a scheduler, not here — see src/debug/Scheduler.
   */
  runCycles(cycles: number): void {
    for (let i = 0; i < cycles; i++) {
      this.cpu.tick()
      this.tickIO()
    }
    this.cycles += cycles
  }

  step(): void {
    // Step through one complete instruction
    const cyclesExecuted = this.cpu.step()

    // Tick IO cards for each cycle of the instruction
    for (let i = 0; i < cyclesExecuted; i++) {
      this.tickIO()
    }
    this.cycles += cyclesExecuted
  }

  reset(coldStart: boolean): void {
    this.flushAudio?.()
    this.cpu.reset()
    this.ram.reset(coldStart)
    for (const io of this.slots()) io.reset(coldStart)
  }

  tick(): void {
    // Execute one CPU clock cycle
    this.cpu.tick()

    // Tick all IO cards and handle level-triggered interrupts
    this.tickIO()

    this.cycles += 1
  }

  private tickIO(): void {
    // Every slot is ticked, including io1/io2. Those hold RAM banks by default,
    // whose tick() does nothing — but skipping them made any other card placed
    // there silently inert, which is a trap now that slots are configurable.
    // Measured at 1.7% of loop throughput against ~5x realtime headroom.
    let interrupt = 0
    interrupt |= this.io1.tick(this.frequency)
    interrupt |= this.io2.tick(this.frequency)
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

  /** Deliver a received serial byte. A no-op when no serial card is present. */
  onReceive(data: number): void {
    for (const io of this.slots()) {
      if (io instanceof ACIA) io.onData(data)
    }
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