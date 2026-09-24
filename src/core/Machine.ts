import { CPU } from './CPU'
import { RAM } from './RAM'
import { ROM } from './ROM'
import { Cart, cartFromImage } from './Cart'
import type { Cartridge } from './Cart'
import { VIA } from './IO/VIA'
import { RAMBank } from './IO/RAMBank'
import { RTC } from './IO/RTC'
import { ACIA } from './IO/ACIA'
import { normalizeSerialCard } from './IO/SerialCard'
import type { SerialCardConfig, SerialPin } from './IO/SerialCard'
import { Sound } from './IO/Sound'
import { Storage } from './IO/Storage'
import { Video } from './IO/Video'
import { TMS9918A } from './IO/TMS9918A'
import type { VideoCard } from './IO/VideoCard'
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

/**
 * The serial card a machine is built with when nothing names one: the ACE's own
 * R6551, with `CTS EN` and `DCD EN` at ground, where every board has them.
 * Ground is asserted, so this is the machine as it was before cards and jumpers
 * were modelled.
 */
export const DEFAULT_SERIAL_CARD: SerialCardConfig = {
  card: 'ace',
  jumpers: { cts: 'ground', dcd: 'ground' }
}

export class Machine {

  cpu: CPU
  ram: RAM
  rom: ROM
  cart?: Cartridge

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

  /**
   * PHI2, the CPU clock: 1 MHz.
   *
   * The ACE runs at 1 MHz only. Rev 1.0 of the ACE had a jumper offering
   * 2 MHz, but the SID's clock is wired to the fixed 1 MHz tap, so at 2 MHz it
   * answered only every other CPU cycle; Rev 1.1 drops the jumper, and 3.5
   * dropped the setting. Nothing a user can reach changes this. It stays a
   * field because cards receive PHI2 through tick() and derive their own timing
   * from it, and tools that drive a card directly (6502-PICOVDP's) set it.
   */
  frequency: number = 1000000

  /**
   * Clock cycles elapsed since the machine was created.
   *
   * Distinct from `cpu.cycles`, which adds each instruction's cost up front at
   * decode time and so runs ahead of the clock mid-instruction. This one counts
   * actual ticks, which is what a cycle budget has to mean. Monotonic — a reset
   * does not zero it.
   */
  cycles: number = 0

  /**
   * Bus taps for watchpoints. Left undefined the cost is one check per access,
   * which is noise beside the address decode already happening — but they are
   * only ever set while a watchpoint is armed.
   */
  onRead?: (address: number, value: number) => void
  onWrite?: (address: number, value: number) => void

  private _flowControl = true

  /**
   * RTS/CTS flow control on host input to the serial card: while on, bytes
   * handed to `onReceive` wait at the far end of the cable for as long as the
   * machine holds RTS high (see `ACIA.readyToReceive`). On by default, as a
   * terminal connected to the board should be; off is a far end that ignores
   * RTS.
   *
   * A host setting — what the far end of the cable does — so it is not part
   * of a snapshot and survives one being loaded.
   */
  get flowControl(): boolean {
    return this._flowControl
  }

  set flowControl(on: boolean) {
    this._flowControl = on
    for (const io of this.slots()) {
      if (io instanceof ACIA) io.flowControl = on
    }
  }

  private _serialCard: SerialCardConfig = DEFAULT_SERIAL_CARD

  /**
   * The serial card and where its jumpers are, which decide whether each of
   * CTS, DCD and DSR is tied to ground or follows the cable (see
   * `SerialCard.ts`). A jumper the card lacks is dropped; one not given is at
   * ground.
   *
   * Configuration, like `flowControl`: not part of a snapshot, and it survives
   * one being loaded.
   */
  get serialCard(): SerialCardConfig {
    return this._serialCard
  }

  set serialCard(config: SerialCardConfig) {
    this._serialCard = normalizeSerialCard(config)
    for (const io of this.slots()) {
      if (io instanceof ACIA) io.serialCard = this._serialCard
    }
  }

  /**
   * The far end of the serial cable drives one of its lines. It reaches the
   * chip only where the card wires that pin to the cable; CTS deasserted there
   * stops the transmitter, and DCD deasserted stops the receiver.
   */
  setSerialLine(pin: SerialPin, asserted: boolean): void {
    this.setSerialLines({ [pin]: asserted })
  }

  /** The far end drives several lines at once; the chip sees one change. */
  setSerialLines(lines: Partial<Record<SerialPin, boolean>>): void {
    for (const io of this.slots()) {
      if (io instanceof ACIA) io.setCableLines(lines)
    }
  }

  /**
   * Whether the serial card asserts RTS on the cable (the pin low: "the far
   * end may send"). RTS reaches the cable on every card. False with no serial
   * card, where nothing drives the line.
   */
  get requestToSend(): boolean {
    for (const io of this.slots()) {
      if (io instanceof ACIA) return io.requestToSend
    }
    return false
  }

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
        io.flowControl = this._flowControl
        io.serialCard = this._serialCard
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
    // The first argument is which port the attachment sits on. Port A's was
    // false, so joystickAttachmentA took readPortA's "not mine" branch and
    // Port A read $FF whatever the stick did — JOY(2) on the BIOS side could
    // never see an input.
    this.joystickAttachmentA = new JoystickAttachment(true, 100)
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

  /**
   * The video card in io8 — either model — or undefined when the slot is vacant
   * (serial-console boot).
   *
   * The machine's own default io8 is the PICOVDP, the reference card, which
   * the goldens and traces rely on. Hosts never rely on it: they pass
   * `io8: createVideoCard(vdp)`.
   */
  video(): VideoCard | undefined {
    return this.io8 instanceof Video || this.io8 instanceof TMS9918A ? this.io8 : undefined
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

  /**
   * Insert a cartridge. The image's length picks the mapper (6502-VCS
   * `PLAN.md` §1 rule 2); any other length is dropped and leaves whatever was
   * in the slot alone, rather than half-loading.
   */
  loadCart = (data: Uint8Array | number[] | ArrayBuffer) => {
    let bytes: Uint8Array
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else if (data instanceof Uint8Array) {
      bytes = data
    } else {
      bytes = Uint8Array.from(data)
    }
    const cart = cartFromImage(bytes)
    if (cart) this.cart = cart
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
   *
   * **The counter advances inside the loop, not after it.** Adding the whole
   * slice at the end is the same arithmetic to anyone reading it between calls,
   * and wrong to anything the machine itself hands it to while the loop runs:
   * `readBus` passes it to the cartridge, whose flash measures its busy window
   * against it. A frozen counter makes that window last the rest of the slice,
   * so a cart polling its own chip after a program spins until the scheduler
   * comes back — for a fifth of a second at a 200,000-cycle slice, and forever
   * for a caller that asked for the whole run in one go.
   */
  runCycles(cycles: number): void {
    for (let i = 0; i < cycles; i++) {
      this.cpu.tick()
      this.tickIO()
      this.cycles++
    }
  }

  step(): void {
    // Step through one complete instruction
    const cyclesExecuted = this.cpu.step()

    // Tick IO cards for each cycle of the instruction
    for (let i = 0; i < cyclesExecuted; i++) {
      this.tickIO()
      this.cycles++
    }
  }

  reset(coldStart: boolean): void {
    this.flushAudio?.()
    this.cpu.reset()
    this.ram.reset(coldStart)
    // The bank register's /MR is on RESB, so a warm reset clears it too.
    this.cart?.reset()
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

  /**
   * Whether the serial line may be sent another byte: false only while
   * `flowControl` is on and a serial card has RTS raised. True when there is no
   * serial card, where `onReceive` is a no-op and there is nothing to wait for.
   */
  get serialReady(): boolean {
    for (const io of this.slots()) {
      if (io instanceof ACIA && !io.readyToReceive) return false
    }
    return true
  }

  /**
   * Deliver a received serial byte. A no-op when no serial card is present.
   *
   * The byte goes to the far end of the card's cable, which sends it when the
   * line will take it (see `ACIA.tick`). With `flowControl` on and RTS raised it
   * waits there, so a host that cannot pace itself (a real serial port bridged
   * in by the app) is still flow-controlled. A byte sent while the card's
   * receiver is disabled (command register bit 0 clear, as after a reset) is
   * lost, as it would be at the board.
   */
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
    const value = this.readBus(address)
    if (this.onRead) this.onRead(address, value)
    return value
  }

  /**
   * Bus access that does not notify the taps.
   *
   * A debugger inspecting memory must not trip a watchpoint — the watchpoint is
   * there to catch what the *program* does, and having "show me $0400" fire the
   * breakpoint watching $0400 would make it unusable. Same for a monitor write.
   */
  peek(address: number): number {
    return this.readBus(address)
  }

  poke(address: number, data: number): void {
    this.writeBus(address, data)
  }

  private readBus(address: number): number {
    switch(true) {
      // The cart takes the CPU address as it stands: a BankedCart does its own
      // translation through the register, and a flat Cart subtracts its own
      // START. `cycles` is what lets a busy flash chip answer with status.
      case (this.cart && address >= Cart.CODE && address <= Cart.END):
        return this.cart.read(address, this.cycles)
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
    if (this.onWrite) this.onWrite(address, data)
    this.writeBus(address, data)
  }

  private writeBus(address: number, data: number): void {
    switch(true) {
      // $C000-$DFFF is flash WEB, $E000-$FFFF latches the bank register
      // (6502-VCS PLAN.md §2). On a flat ROM cart both do nothing, so a legacy
      // cartridge behaves exactly as it did before this case existed.
      case (this.cart !== undefined && address >= Cart.CODE && address <= Cart.END):
        this.cart.write(address, data, this.cycles)
        return
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