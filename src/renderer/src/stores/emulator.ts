import { ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { Machine } from '@core/Machine'
import { Session } from '@debug/Session'
import { Storage } from '@core/IO/Storage'
import {
  loadProgramImage,
  applyProgramPointers,
  loadBinary as writeBinary,
  MAX_PROGRAM_SIZE,
} from '@core/ProgramImage'
import type { Video } from '@core/IO/Video'
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
  const serialConnected = ref(false)
  // Reactive CPU frequency — drives machine.frequency; 1 MHz default.
  const frequency = ref<number>(1_000_000)
  // Display labels for currently loaded files (shown in SettingsPanel).
  const romName = ref<string>('BIOS (default)')
  const cartName = ref<string | null>(null)
  const programName = ref<string | null>(null)
  const binaryName = ref<string | null>(null)
  // Message from the most recent program/binary load; null when it went cleanly.
  const loadWarning = ref<string | null>(null)

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
   */
  function init(options: { rtc?: ClockReading } = {}) {
    const { rtc } = options
    const s = new Session({
      io4: new Storage(CF_CARD_SIZE),
      ...(rtc ? { io3: new RTC(() => rtc) } : {})
    })
    const m = s.machine
    m.frequency = frequency.value

    m.render = onRender
    m.transmit = onTransmit
    m.play = onPlay
    m.flushAudio = onAudioFlush

    session.value = s
    machine.value = m
  }

  function loadROM(data: Uint8Array | ArrayBuffer, label?: string) {
    machine.value?.loadROM(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
    if (label !== undefined) romName.value = label
  }

  function loadCart(data: Uint8Array | ArrayBuffer, label?: string) {
    machine.value?.loadCart(data instanceof ArrayBuffer ? new Uint8Array(data) : data)
    if (label !== undefined) cartName.value = label
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
    session.value?.reset(false)
  }

  // Models a power cycle: RAM is zeroed, so any image still waiting for its
  // pointer fixup has already been wiped and BASIC always cold-boots.
  function powerCycle() {
    cancelPointerFixup()
    session.value?.reset(true)
  }

  function getVideo(): Video | null {
    return (machine.value?.io8 as Video) ?? null
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

  /**
   * Warm-reset the CPU so it re-reads the reset vector from the currently
   * loaded ROM. Call this after loadROM() to ensure the CPU starts at the
   * correct entry point.
   */
  function resetCPU() {
    session.value?.reset(false)
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
    serialConnected,
    frequency,
    romName,
    cartName,
    programName,
    binaryName,
    loadWarning,
    init,
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
    resetCPU,
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
