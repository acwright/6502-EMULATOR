import { ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { Machine } from '@core/Machine'
import { Session } from '@debug/Session'
import { Storage } from '@core/IO/Storage'
import { ROM } from '@core/ROM'
import { Cart } from '@core/Cart'
import {
  loadProgramImage,
  applyProgramPointers,
  loadBinary as writeBinary,
  MAX_PROGRAM_SIZE,
} from '@core/ProgramImage'
import type { VideoCard, VdpModel } from '@core/IO/VideoCard'
import { createVideoCard } from '@core/IO/createVideoCard'
import { DEFAULT_VDP, romWantsPicovdp, VDP_MISMATCH_WARNING } from '@shared/vdp'
import { loadDefaultBIOS, DEFAULT_ROM_LABEL } from '@/composables/useDefaultBIOS'
import { RTC } from '@core/IO/RTC'
import type { ClockReading } from '@core/IO/RTC'
import type { Sound } from '@core/IO/Sound'

// CF card size: real machine = 256 disks × 1 MB = 256 MB.
// Initialised at full size so LBA addressing matches the real machine.
// Persistence (usePersistence) overwrites this with saved/default data on startup.
const CF_CARD_SIZE = 256 * 1024 * 1024

export const useEmulatorStore = defineStore('emulator', () => {
  // The Session owns forward progress; the store exposes the machine for the
  // components and composables that read or poke its hardware directly.
  const session = shallowRef<Session | null>(null)
  const machine = shallowRef<Machine | null>(null)
  const isRunning = ref(false)
  /**
   * The program executed STP, so the CPU cannot advance again until it is reset.
   *
   * Tracked off the Session's stop announcement rather than read from
   * `machine.cpu.stopped`: `machine` is a shallowRef over the emulator core, and
   * nothing in there is reactive, so a computed on that field would never
   * re-evaluate.
   */
  const isHalted = ref(false)
  const serialConnected = ref(false)
  // Reactive CPU frequency — drives machine.frequency; 1 MHz default.
  const frequency = ref<number>(1_000_000)
  // Display labels for currently loaded files (shown in SettingsPanel).
  const romName = ref<string>(DEFAULT_ROM_LABEL)
  const cartName = ref<string | null>(null)
  const programName = ref<string | null>(null)
  const binaryName = ref<string | null>(null)
  // Message from the most recent program/binary load; null when it went cleanly.
  const loadWarning = ref<string | null>(null)
  // The video card in io8, by the name `--vdp` and `vdp=` take.
  const vdp = ref<VdpModel>(DEFAULT_VDP)

  // Callbacks set by composables / platform services
  let onRender: (() => void) | undefined
  let onTransmit: ((data: number) => void) | undefined
  let onPlay: ((samples: Float32Array) => void) | undefined
  let onAudioFlush: (() => void) | undefined

  function setRenderCallback(cb: () => void) {
    onRender = cb
    if (machine.value) machine.value.render = cb
  }

  function setTransmitCallback(cb: (data: number) => void) {
    onTransmit = cb
    if (machine.value) machine.value.transmit = cb
  }

  function setPlayCallback(cb: (samples: Float32Array) => void) {
    onPlay = cb
    if (machine.value) machine.value.play = cb
  }

  function setAudioFlushCallback(cb: () => void) {
    onAudioFlush = cb
    if (machine.value) machine.value.flushAudio = cb
  }

  /**
   * Build the machine.
   *
   * `rtc` fixes what the clock reads instead of taking the host's — `6502 run
   * --rtc`, the same reproducibility knob the headless host has. The clock
   * still advances from there; only its starting point is pinned.
   *
   * `cfSize` exists for the embed, where the full card is the wrong default:
   * two embeds on one docs page would allocate half a gigabyte for a card
   * neither of them touches. Everything else wants the real machine's geometry
   * and should leave it alone.
   *
   * `vdp` is the video card. It is always passed to the machine rather than
   * left to `Machine`'s own default, which is the core's reference card and not
   * the card a host boots when nothing names one (`DEFAULT_VDP`).
   */
  function init(options: { rtc?: ClockReading; cfSize?: number; vdp?: VdpModel } = {}) {
    const { rtc, cfSize } = options
    vdp.value = options.vdp ?? DEFAULT_VDP
    const s = new Session({
      io4: new Storage(cfSize ?? CF_CARD_SIZE),
      io8: createVideoCard(vdp.value),
      ...(rtc ? { io3: new RTC(() => rtc) } : {})
    })
    const m = s.machine
    m.frequency = frequency.value

    s.onStop((reason) => {
      if (reason.kind !== 'trap' || reason.detail !== 'stp') return
      isHalted.value = true
      // The scheduler has already stopped; the toolbar would otherwise still be
      // offering a Stop button for a machine that is no longer going anywhere.
      isRunning.value = false
    })

    m.render = onRender
    m.transmit = onTransmit
    m.play = onPlay
    m.flushAudio = onAudioFlush

    session.value = s
    machine.value = m
  }

  /**
   * Swap the ROM and restart the CPU from the new reset vector.
   *
   * The reset is not optional. ROM and cartridge both back the code the CPU is
   * executing out of, so replacing either under a running machine leaves the PC
   * pointing at an address whose meaning just changed — the CPU carries on
   * mid-routine in an unrelated image, and what it does next is arbitrary. That
   * is why this lives here rather than at each call site: every caller needs it,
   * and the one that forgot (the file pickers) turned "insert a cartridge" into
   * a jump into the middle of the cartridge's BASIC.
   */
  function loadROM(data: Uint8Array | ArrayBuffer, label?: string) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    if (!checkImageSize(bytes, ROM.SIZE, 'ROM')) return
    machine.value?.loadROM(bytes)
    if (label !== undefined) romName.value = label
    loadWarning.value = romMismatch(bytes)
    reset()
  }

  /**
   * The one-line warning for a BIOS 2.x ROM on the TMS9918A, or null.
   *
   * A warning and never a refusal, and never a change of card: 2.x has no
   * TMS9918A support, so it draws garbage there rather than failing, and the
   * person loading it may be doing so on purpose.
   */
  function romMismatch(rom: Uint8Array): string | null {
    return vdp.value === 'tms9918a' && romWantsPicovdp(rom) ? VDP_MISMATCH_WARNING : null
  }

  /**
   * Put the other video card in the machine: a power cycle with a different card.
   *
   * The card is swapped in place rather than the Session rebuilt. Everything
   * else — RAM contents aside, which a power cycle clears anyway — is the same
   * machine: the CF card and NVRAM stay in their slots, so there is nothing to
   * save and reload, and the debug bridge and the embed's messaging, which
   * subscribe to this Session once, keep working. Every reader of the card goes
   * through `Machine.video()` each time, so none of them holds the old one.
   *
   * The ROM follows the card only while it is the bundled one. A ROM the user
   * chose stays, and gets the mismatch check against the new card.
   */
  async function setVdp(model: VdpModel): Promise<void> {
    const m = machine.value
    if (!m || model === vdp.value) return
    // Stopping first also lets App.vue's watcher save the CF card and NVRAM, as
    // any stop does, before the power cycle.
    const wasRunning = isRunning.value
    if (wasRunning) stop()

    m.io8 = createVideoCard(model)
    vdp.value = model

    if (romName.value === DEFAULT_ROM_LABEL) {
      const bios = await loadDefaultBIOS(model)
      if (bios) m.loadROM(bios)
      loadWarning.value = bios ? null : 'The bundled BIOS could not be loaded for this card.'
    } else {
      loadWarning.value = romMismatch(Uint8Array.from(m.rom.data))
    }

    powerCycle()
    if (wasRunning) run()
  }

  /** Insert a cartridge over $C000-$FFFF and reset so it takes its own vectors. */
  function loadCart(data: Uint8Array | ArrayBuffer, label?: string) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    if (!checkImageSize(bytes, Cart.SIZE, 'Cartridge')) return
    machine.value?.loadCart(bytes)
    if (label !== undefined) cartName.value = label
    loadWarning.value = null
    reset()
  }

  /**
   * ROM.load() and Cart.load() drop an image that is not exactly the right size,
   * silently. That was survivable while loading did nothing else; now that a
   * load resets the CPU, an unnoticed drop would reset the machine, put the
   * file's name on the panel, and change nothing else.
   */
  function checkImageSize(bytes: Uint8Array, expected: number, what: string): boolean {
    if (bytes.length === expected) return true
    loadWarning.value =
      `${what} image is ${bytes.length} bytes; it must be exactly ${expected}. Nothing loaded.`
    return false
  }

  // An image written to RAM before BASIC had booted, waiting for the pointer
  // fixup. Polled while the machine runs; see schedulePointerFixup().
  let pendingProgramLength: number | null = null
  let pendingPoll: ReturnType<typeof setInterval> | null = null

  function cancelPointerFixup() {
    if (pendingPoll !== null) clearInterval(pendingPoll)
    pendingPoll = null
    pendingProgramLength = null
  }

  /**
   * Wait for BASIC to finish booting, then set the end-of-program pointers.
   *
   * Needed whenever an image is written while the machine is reset or stopped —
   * BASIC's startup overwrites those pointers, so the fixup cannot be applied up
   * front. Its own chain walk recovers a plain BASIC program but stops at the
   * end marker, so a .prg's machine code would be left unprotected.
   */
  function schedulePointerFixup(byteLength: number) {
    cancelPointerFixup()
    pendingProgramLength = byteLength
    pendingPoll = setInterval(() => {
      const m = machine.value
      if (!m || pendingProgramLength === null) return
      if (applyProgramPointers(m, pendingProgramLength)) {
        cancelPointerFixup()
        loadWarning.value = null
      }
    }, 100)
  }

  /**
   * Load a program image (.prg / .bas) at $0800, mirroring BASIC's own LOAD —
   * the bytes plus the end-of-program pointer fixup. The extension is not
   * inspected; use loadBinary() for raw machine code at an explicit address.
   *
   * Safe to call before the machine has booted: the fixup is applied as soon as
   * BASIC is up, so a preloaded program is correct by the time it can be run.
   */
  function loadProgram(data: Uint8Array | ArrayBuffer, label?: string) {
    const m = machine.value
    if (!m) return
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data

    cancelPointerFixup()
    switch (loadProgramImage(m, bytes)) {
      case 'empty':
        loadWarning.value = 'Program file is empty — nothing loaded.'
        return
      case 'too-large':
        loadWarning.value =
          `Program is ${bytes.length} bytes; only ${MAX_PROGRAM_SIZE} fit in $0800-$7FFF. Nothing loaded.`
        return
      case 'basic-not-ready':
        schedulePointerFixup(bytes.length)
        loadWarning.value = 'Loaded — waiting for BASIC to boot to finish setting up the program.'
        break
      case 'ok':
        loadWarning.value = null
        break
    }

    if (label !== undefined) programName.value = label
  }

  /**
   * Load raw bytes at an explicit address, the emulator's equivalent of BLOAD.
   * BASIC's state is left untouched.
   */
  function loadBinary(data: Uint8Array | ArrayBuffer, address: number, label?: string) {
    const m = machine.value
    if (!m) return
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data

    switch (writeBinary(m, address, bytes)) {
      case 'empty':
        loadWarning.value = 'Binary file is empty — nothing loaded.'
        return
      case 'out-of-range':
        loadWarning.value =
          `${bytes.length} bytes at $${address.toString(16).toUpperCase().padStart(4, '0')} runs past the top of RAM ($7FFF). Nothing loaded.`
        return
      case 'ok':
        loadWarning.value = null
        break
    }

    if (label !== undefined) {
      binaryName.value = `${label} @ $${address.toString(16).toUpperCase().padStart(4, '0')}`
    }
  }

  /** Remove the loaded cartridge and warm-reset so the CPU re-reads its vectors. */
  function unloadCart() {
    machine.value?.unloadCart()
    cartName.value = null
    session.value?.reset(false)
  }

  /**
   * Clear the loaded program. The program was written into RAM, so a power
   * cycle is needed to actually wipe it and return the machine to a clean boot
   * state. A power cycle also discards any loaded binary, so both labels are
   * cleared.
   */
  function unloadProgram() {
    programName.value = null
    binaryName.value = null
    loadWarning.value = null
    powerCycle()
  }

  function run() {
    session.value?.run('realtime')
    isRunning.value = true
  }

  function stop() {
    session.value?.pause()
    isRunning.value = false
  }

  // Models the physical reset button, which only pulses the CPU RESET line —
  // SRAM keeps its contents, so a BASIC session (program + variables) survives,
  // exactly as on hardware. A pending program image is still in RAM, so its
  // fixup poll is left running.
  function reset() {
    // RESET is the only thing that lifts STP, which is the whole reason the
    // halted state is worth surfacing on the toolbar.
    isHalted.value = false
    session.value?.reset(false)
  }

  // Models a power cycle: RAM is zeroed, so any image still waiting for its
  // pointer fixup has already been wiped and BASIC always cold-boots.
  function powerCycle() {
    cancelPointerFixup()
    isHalted.value = false
    session.value?.reset(true)
  }

  // Through `Machine.video()` rather than a cast of io8, so a slot holding
  // anything else answers null instead of a card that is not there.
  function getVideo(): VideoCard | null {
    return machine.value?.video() ?? null
  }

  function getRTC(): RTC | null {
    return (machine.value?.io3 as RTC) ?? null
  }

  function getStorage(): Storage | null {
    return (machine.value?.io4 as Storage) ?? null
  }

  function getSound(): Sound | null {
    return (machine.value?.io7 as Sound) ?? null
  }

  /** Update the CPU frequency at runtime; persisted to settings by the caller. */
  function setFrequency(f: number) {
    frequency.value = f
    if (machine.value) machine.value.frequency = f
  }

  /** Load new CF card data into the running machine's Storage (io4). */
  function reloadCF(data: Uint8Array) {
    const storage = getStorage()
    if (storage) storage.loadData(data)
  }

  /** Load new NVRAM data into the running machine's RTC (io3). */
  function reloadNVRAM(data: Uint8Array) {
    const rtc = getRTC()
    if (rtc) rtc.loadNVRAM(data)
  }

  return {
    session,
    machine,
    isRunning,
    isHalted,
    serialConnected,
    frequency,
    romName,
    cartName,
    programName,
    binaryName,
    loadWarning,
    vdp,
    init,
    setVdp,
    loadROM,
    loadCart,
    loadProgram,
    loadBinary,
    unloadCart,
    unloadProgram,
    run,
    stop,
    reset,
    powerCycle,
    setFrequency,
    reloadCF,
    reloadNVRAM,
    getVideo,
    getRTC,
    getStorage,
    getSound,
    setRenderCallback,
    setTransmitCallback,
    setPlayCallback,
    setAudioFlushCallback,
  }
})
