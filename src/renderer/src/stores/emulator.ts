import { ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { Machine } from '@core/Machine'
import { Storage } from '@core/IO/Storage'
import type { Video } from '@core/IO/Video'
import type { RTC } from '@core/IO/RTC'

const PROGRAM_LOAD_ADDRESS = 0x0800

// CF card size: real machine = 256 disks × 1 MB = 256 MB.
// Initialised at full size so LBA addressing matches the real machine.
// Persistence (usePersistence) overwrites this with saved/default data on startup.
const CF_CARD_SIZE = 256 * 1024 * 1024

export const useEmulatorStore = defineStore('emulator', () => {
  const machine = shallowRef<Machine | null>(null)
  const isRunning = ref(false)
  const serialConnected = ref(false)
  // Reactive CPU frequency — drives machine.frequency; 1 MHz default.
  const frequency = ref<number>(1_000_000)
  // Display labels for currently loaded files (shown in SettingsPanel).
  const romName = ref<string>('BIOS (default)')
  const cartName = ref<string | null>(null)
  const programName = ref<string | null>(null)

  // Callbacks set by composables / platform services
  let onRender: (() => void) | undefined
  let onTransmit: ((data: number) => void) | undefined
  let onPlay: ((samples: Float32Array) => void) | undefined

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

  function init() {
    const m = new Machine()
    m.frequency = frequency.value
    m.io4 = new Storage(CF_CARD_SIZE)

    m.render = onRender
    m.transmit = onTransmit
    m.play = onPlay

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

  function loadProgram(data: Uint8Array | ArrayBuffer, label?: string) {
    const m = machine.value
    if (!m) return
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
    for (let i = 0; i < bytes.length; i++) {
      m.write(PROGRAM_LOAD_ADDRESS + i, bytes[i]!)
    }
    if (label !== undefined) programName.value = label
  }

  function run() {
    machine.value?.run()
    isRunning.value = true
  }

  function stop() {
    machine.value?.stop()
    isRunning.value = false
  }

  function reset() {
    const wasRunning = isRunning.value
    if (wasRunning) stop()
    machine.value?.reset(true)
    if (wasRunning) run()
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
    machine.value?.reset(false)
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
    machine,
    isRunning,
    serialConnected,
    frequency,
    romName,
    cartName,
    programName,
    init,
    loadROM,
    loadCart,
    loadProgram,
    run,
    stop,
    reset,
    resetCPU,
    setFrequency,
    reloadCF,
    reloadNVRAM,
    getVideo,
    getRTC,
    getStorage,
    setRenderCallback,
    setTransmitCallback,
    setPlayCallback,
  }
})
