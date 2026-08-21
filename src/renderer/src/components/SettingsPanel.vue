<template>
  <!-- Semi-transparent backdrop — clicking closes the panel -->
  <div class="settings-backdrop" @click="$emit('close')" />

  <!-- Right-side slide-in panel -->
  <div class="settings-panel">

    <!-- Header -->
    <div class="panel-header">
      <span class="panel-title">Settings</span>
      <button class="close-btn" @click="$emit('close')" title="Close">✕</button>
    </div>

    <div class="panel-body">

      <!-- ── Files ─────────────────────────────────────────────────────────── -->
      <section class="panel-section">
        <h3 class="section-heading">FILES</h3>

        <div class="file-row">
          <span class="file-kind">ROM</span>
          <span class="file-name" :title="store.romName ?? ''">{{ store.romName ?? '—' }}</span>
          <input ref="romInput" type="file" accept=".bin,.rom" class="hidden" @change="onLoadROM" />
          <button class="btn-sm btn-secondary" @click="romInput?.click()">Load</button>
          <button
            v-if="store.romName !== DEFAULT_ROM_LABEL"
            class="btn-icon"
            title="Reset to default BIOS"
            @click="resetROM"
          >
            <XMarkIcon class="size-4" />
          </button>
        </div>

        <div class="file-row">
          <span class="file-kind">CART</span>
          <span class="file-name" :title="store.cartName ?? ''">{{ store.cartName ?? '—' }}</span>
          <input ref="cartInput" type="file" accept=".bin,.crt,.cart" class="hidden" @change="onLoadCart" />
          <button class="btn-sm btn-secondary" @click="cartInput?.click()">Load</button>
          <button
            v-if="store.cartName"
            class="btn-icon"
            title="Eject cartridge"
            @click="store.unloadCart()"
          >
            <XMarkIcon class="size-4" />
          </button>
        </div>

        <div class="file-row">
          <span class="file-kind">PROG</span>
          <span class="file-name" :title="store.programName ?? ''">{{ store.programName ?? '—' }}</span>
          <input ref="programInput" type="file" accept=".prg,.bas" class="hidden" @change="onLoadProgram" />
          <button class="btn-sm btn-secondary" @click="programInput?.click()">Load</button>
          <button
            v-if="store.programName"
            class="btn-icon"
            title="Unload program (resets machine)"
            @click="store.unloadProgram()"
          >
            <XMarkIcon class="size-4" />
          </button>
        </div>

        <!-- Raw binary at an explicit address — the emulator's BLOAD. -->
        <div class="file-row">
          <span class="file-kind">BIN</span>
          <span class="file-name" :title="store.binaryName ?? ''">{{ store.binaryName ?? '—' }}</span>
          <input
            v-model="binaryAddress"
            class="field addr-field"
            spellcheck="false"
            placeholder="addr"
            title="Load address in hex, e.g. 2000"
          />
          <input ref="binaryInput" type="file" accept=".bin" class="hidden" @change="onLoadBinary" />
          <button
            class="btn-sm btn-secondary"
            :disabled="binaryLoadAddress === null"
            @click="binaryInput?.click()"
          >
            Load
          </button>
        </div>

        <p v-if="store.loadWarning" class="load-warning">{{ store.loadWarning }}</p>
      </section>

      <!-- ── Storage ───────────────────────────────────────────────────────── -->
      <section class="panel-section">
        <h3 class="section-heading">STORAGE</h3>

        <div class="file-row">
          <span class="file-kind">CF</span>
          <span class="file-name" :title="cfDisplayName">{{ cfDisplayName }}</span>
          <template v-if="isElectron">
            <button class="btn-sm btn-secondary" @click="pickCF">Select…</button>
            <button v-if="cfPath" class="btn-icon" title="Revert to default CF image" @click="resetCF">
              <XMarkIcon class="size-4" />
            </button>
          </template>
          <template v-else>
            <input ref="cfInput" type="file" accept=".img,.bin" class="hidden" @change="loadCFFromFile" />
            <button class="btn-sm btn-secondary" @click="cfInput?.click()">Load</button>
            <button class="btn-sm btn-secondary" @click="exportCF">Export</button>
          </template>
        </div>

        <div class="file-row">
          <span class="file-kind">NVRAM</span>
          <span class="file-name" :title="nvramDisplayName">{{ nvramDisplayName }}</span>
          <template v-if="isElectron">
            <button class="btn-sm btn-secondary" @click="pickNVRAM">Select…</button>
            <button v-if="nvramPath" class="btn-icon" title="Revert to default NVRAM" @click="resetNVRAM">
              <XMarkIcon class="size-4" />
            </button>
          </template>
          <template v-else>
            <input ref="nvramInput" type="file" accept=".bin,.nvram" class="hidden" @change="loadNVRAMFromFile" />
            <button class="btn-sm btn-secondary" @click="nvramInput?.click()">Load</button>
            <button class="btn-sm btn-secondary" @click="exportNVRAM">Export</button>
          </template>
        </div>
      </section>

      <!-- ── Serial ────────────────────────────────────────────────────────── -->
      <section class="panel-section">
        <h3 class="section-heading">SERIAL</h3>

        <div class="serial-status-row">
          <span
            class="status-dot"
            :class="{
              'bg-gray-500': serialStatus === 'disconnected',
              'bg-yellow-400 animate-pulse': serialStatus === 'connecting',
              'bg-green-500': serialStatus === 'connected',
              'bg-red-500': serialStatus === 'error',
            }"
          />
          <span class="status-text">{{ serialStatus }}</span>
        </div>

        <!-- Electron: port selector + config -->
        <template v-if="isElectron">
          <div class="port-row">
            <select v-model="selectedPort" class="field port-select">
              <option value="">— select port —</option>
              <option v-for="p in ports" :key="p.path" :value="p.path">
                {{ p.path }}{{ p.manufacturer ? ` (${p.manufacturer})` : '' }}
              </option>
            </select>
            <button class="btn-icon" title="Refresh ports" @click="refreshPorts">
              <ArrowPathIcon class="size-4" />
            </button>
          </div>

          <div class="config-grid">
            <div class="config-item">
              <label class="config-label">Baud Rate</label>
              <input v-model.number="serialConfig.baudRate" type="number" class="field" />
            </div>
            <div class="config-item">
              <label class="config-label">Data Bits</label>
              <select v-model.number="serialConfig.dataBits" class="field">
                <option :value="8">8</option>
                <option :value="7">7</option>
                <option :value="6">6</option>
                <option :value="5">5</option>
              </select>
            </div>
            <div class="config-item">
              <label class="config-label">Parity</label>
              <select v-model="serialConfig.parity" class="field">
                <option value="none">None</option>
                <option value="even">Even</option>
                <option value="odd">Odd</option>
              </select>
            </div>
            <div class="config-item">
              <label class="config-label">Stop Bits</label>
              <select v-model.number="serialConfig.stopBits" class="field">
                <option :value="1">1</option>
                <option :value="2">2</option>
              </select>
            </div>
          </div>
        </template>

        <button
          class="btn-connect"
          :class="serialStatus === 'connected' ? 'btn-danger' : 'btn-primary'"
          @click="toggleSerial"
          :disabled="serialStatus === 'connecting'"
        >
          {{ serialStatus === 'connected' ? 'Disconnect' : 'Connect' }}
        </button>
      </section>

      <!-- ── Joystick ──────────────────────────────────────────────────────── -->
      <section class="panel-section">
        <h3 class="section-heading">JOYSTICK</h3>

        <p class="debug-hint">
          Gamepads: the first pad drives <code>JOY(1)</code> (Port B), the second
          drives <code>JOY(2)</code> (Port A).
        </p>

        <div class="config-item joystick-preset">
          <label class="config-label">Keyboard for <code>JOY(1)</code></label>
          <select v-model="keyboard1Preset" class="field" @change="saveJoystick">
            <option value="numpad">Numpad</option>
            <option value="arrows">Arrows + Space</option>
            <option value="off">Off</option>
          </select>
        </div>

        <p class="debug-hint">{{ keyboard1Hint }}</p>

        <label class="joystick-toggle">
          <input type="checkbox" v-model="keyboard2Enabled" @change="saveJoystick" />
          <span>WASD keyboard for <code>JOY(2)</code></span>
        </label>

        <p class="debug-hint">
          Off by default: WASD, Space and E/Q/R collide with typing, so they only
          drive the second stick while this is on. Space = A, E = B, Q = X, R = Y.
        </p>
      </section>

      <!-- ── Debug ─────────────────────────────────────────────────────────── -->
      <section v-if="isElectron" class="panel-section">
        <h3 class="section-heading">DEBUG SERVER</h3>

        <div class="serial-status-row">
          <span
            class="status-dot"
            :class="debugStatus.running ? 'bg-green-500' : 'bg-gray-500'"
          />
          <span class="status-text">
            {{ debugStatus.running ? `listening on ${debugStatus.host}:${debugStatus.port}` : 'off' }}
          </span>
        </div>

        <!-- The value shrinks and the button never does, so the button stays
             inside the 320 px panel however long the URL and token get. -->
        <div v-if="debugStatus.running" class="debug-url">
          <span class="debug-url-value" :title="debugConnectionUrl">{{ debugConnectionUrl }}</span>
          <button
            class="btn-icon copy-btn"
            :title="copiedUrl ? 'Copied' : 'Copy connection URL'"
            @click="copyDebugUrl"
          >
            <CheckIcon v-if="copiedUrl" class="size-4 copied" />
            <ClipboardDocumentIcon v-else class="size-4" />
          </button>
        </div>

        <p class="debug-hint">
          Lets <code>6502 dbg</code> and <code>6502 attach</code> connect to this running machine.
          Both find it on their own while it is running here; the URL above is for
          anything else that speaks the protocol.
        </p>

        <button
          class="btn-connect"
          :class="debugStatus.running ? 'btn-danger' : 'btn-primary'"
          @click="toggleDebugServer"
        >
          {{ debugStatus.running ? 'Stop' : 'Start' }}
        </button>
      </section>

      <!-- ── CLI ───────────────────────────────────────────────────────────── -->
      <section v-if="isElectron" class="panel-section">
        <h3 class="section-heading">COMMAND LINE</h3>

        <p class="debug-hint">
          {{
            cliStatus.managedByInstaller
              ? "Installed by this platform's installer."
              : cliStatus.installed
                ? `Installed at ${cliStatus.path}`
                : "Adds the '6502' command to your PATH."
          }}
        </p>

        <p v-if="cliMessage" class="debug-hint">{{ cliMessage }}</p>

        <button
          v-if="!cliStatus.managedByInstaller"
          class="btn-connect"
          :class="cliStatus.installed ? 'btn-danger' : 'btn-primary'"
          @click="toggleCli"
        >
          {{ cliStatus.installed ? 'Uninstall' : 'Install' }}
        </button>
      </section>

    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { ArrowPathIcon, XMarkIcon, ClipboardDocumentIcon, CheckIcon } from '@heroicons/vue/24/solid'
import { useEmulatorStore } from '@/stores/emulator'
import { useJoystickStore } from '@/stores/joystick'
import { loadDefaultBIOS, DEFAULT_ROM_LABEL } from '@/composables/useDefaultBIOS'
import { useSerial } from '@/composables/useSerial'
import { DEFAULT_SERIAL_CONFIG, JOYSTICK_PRESETS } from '@shared/types'
import type {
  SerialConfig,
  PortInfo,
  DebugServerStatus,
  CliShimStatus,
  JoystickPreset
} from '@shared/types'

defineEmits<{ close: [] }>()

const store = useEmulatorStore()
const joysticks = useJoystickStore()
const { available, status: serialStatus, connect, disconnect } = useSerial()
const isElectron = computed(() => typeof window !== 'undefined' && !!window.api)

// ── Joystick ──────────────────────────────────────────────────────────────────

// Settings saved before this preset existed have no keyboard1Preset, and the
// merge that loads them is shallow — hence the fallback.
const keyboard1Preset = ref<JoystickPreset>(joysticks.settings.keyboard1Preset ?? 'numpad')
const keyboard2Enabled = ref(joysticks.settings.keyboard2Enabled)

const KEYBOARD1_HINTS: Record<JoystickPreset, string> = {
  numpad: 'Collision-free — the machine has no keypad, so these never reach BASIC. ' +
    '8/4/6/2 move, 0 = A, . = B, 5 = X, Enter = Y.',
  arrows: 'For a laptop without a numpad. Arrows move, Space = A, slash = B, period = X, comma = Y. ' +
    'The stick takes those keys while this is on, so cursor keys stop editing in ' +
    'BASIC and the Monitor until you switch back.',
  off: 'No keyboard for the first stick; a gamepad still drives it.'
}

const keyboard1Hint = computed(() => KEYBOARD1_HINTS[keyboard1Preset.value])

function saveJoystick() {
  // The preset is stored alongside the map it produced: the machine reads the
  // map, the panel shows the preset, and neither has to be guessed from the other.
  joysticks.settings = {
    ...joysticks.settings,
    keyboard1Preset: keyboard1Preset.value,
    keyboard1: { ...JOYSTICK_PRESETS[keyboard1Preset.value] },
    keyboard2Enabled: keyboard2Enabled.value
  }
  window.api?.settings.set({ joystick: { ...joysticks.settings } }).catch(() => {})
}

// ── File loading helpers ──────────────────────────────────────────────────────

const romInput = ref<HTMLInputElement | null>(null)
const cartInput = ref<HTMLInputElement | null>(null)
const programInput = ref<HTMLInputElement | null>(null)

async function readInputFile(event: Event): Promise<{ data: Uint8Array; name: string } | null> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return null
  const data = new Uint8Array(await file.arrayBuffer())
  input.value = ''
  return { data, name: file.name }
}

async function onLoadROM(event: Event) {
  const f = await readInputFile(event)
  if (f) store.loadROM(f.data, f.name)
}

async function onLoadCart(event: Event) {
  const f = await readInputFile(event)
  if (f) store.loadCart(f.data, f.name)
}

async function onLoadProgram(event: Event) {
  const f = await readInputFile(event)
  if (f) store.loadProgram(f.data, f.name)
}

// ── Raw binary (BLOAD) ────────────────────────────────────────────────────────

const binaryInput = ref<HTMLInputElement | null>(null)
const binaryAddress = ref('')

/** Parsed hex load address, or null while the field is empty or out of RAM. */
const binaryLoadAddress = computed(() => {
  const text = binaryAddress.value.trim().replace(/^(\$|0x)/i, '')
  if (!/^[0-9a-f]{1,4}$/i.test(text)) return null
  const address = parseInt(text, 16)
  return address < 0x8000 ? address : null
})

async function onLoadBinary(event: Event) {
  const address = binaryLoadAddress.value
  const f = await readInputFile(event)
  if (f && address !== null) store.loadBinary(f.data, address, f.name)
}

async function resetROM() {
  const bios = await loadDefaultBIOS()
  if (!bios) return
  store.loadROM(bios, DEFAULT_ROM_LABEL)
}

// ── Serial ────────────────────────────────────────────────────────────────────

const ports = ref<PortInfo[]>([])
const selectedPort = ref('')
const serialConfig = ref<SerialConfig>({ ...DEFAULT_SERIAL_CONFIG })

async function refreshPorts() {
  if (!isElectron.value) return
  try { ports.value = await window.api!.serial.listPorts() } catch { /* ignore */ }
}

async function toggleSerial() {
  if (serialStatus.value === 'connected') {
    await disconnect()
  } else {
    await connect(serialConfig.value, isElectron.value ? selectedPort.value || undefined : undefined)
  }
}

// Only a change the user made here is worth saving. Loading the current
// settings into the fields below counts as a change to this watcher, and
// writing that straight back would persist whatever happened to be in effect —
// including settings `6502 run` set for one launch only.
let hydrating = true

watch(serialConfig, (cfg) => {
  if (hydrating) return
  window.api?.settings.set({ serialConfig: { ...cfg } }).catch(() => {})
}, { deep: true })

// ── CF Card ───────────────────────────────────────────────────────────────────

const cfPath = ref('')
const cfInput = ref<HTMLInputElement | null>(null)
const cfDisplayName = computed(() => cfPath.value ? cfPath.value.split('/').pop()! : 'Default')

async function pickCF() {
  const path = await window.api!.storage.pickCF()
  if (!path) return
  cfPath.value = path
  window.api!.settings.set({ cfPath: path }).catch(() => {})
  const data = await window.api!.storage.loadCF()
  if (data) store.reloadCF(new Uint8Array(data))
}

async function loadCFFromFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  store.reloadCF(new Uint8Array(await file.arrayBuffer()))
  input.value = ''
}

async function resetCF() {
  const data = await window.api!.storage.resetCF()
  cfPath.value = ''
  if (data) store.reloadCF(new Uint8Array(data))
}

function exportCF() {
  const data = store.getStorage()?.getData()
  if (!data) return
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }))
  a.download = 'storage.img'
  a.click()
  URL.revokeObjectURL(a.href)
}

// ── NVRAM ─────────────────────────────────────────────────────────────────────

const nvramPath = ref('')
const nvramInput = ref<HTMLInputElement | null>(null)
const nvramDisplayName = computed(() => nvramPath.value ? nvramPath.value.split('/').pop()! : 'Default')

async function pickNVRAM() {
  const path = await window.api!.storage.pickNVRAM()
  if (!path) return
  nvramPath.value = path
  window.api!.settings.set({ nvramPath: path }).catch(() => {})
  const data = await window.api!.storage.loadNVRAM()
  if (data) store.reloadNVRAM(new Uint8Array(data))
}

async function loadNVRAMFromFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  store.reloadNVRAM(new Uint8Array(await file.arrayBuffer()))
  input.value = ''
}

async function resetNVRAM() {
  const data = await window.api!.storage.resetNVRAM()
  nvramPath.value = ''
  if (data) store.reloadNVRAM(new Uint8Array(data))
}

function exportNVRAM() {
  const data = store.getRTC()?.getNVRAM()
  if (!data) return
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }))
  a.download = 'nvram.bin'
  a.click()
  URL.revokeObjectURL(a.href)
}

// ── Debug server ──────────────────────────────────────────────────────────────

const debugStatus = ref<DebugServerStatus>({ running: false })
const copiedUrl = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Everything a client needs in one string. The token rides in the query the
 * same way `6502 attach` puts it there, so the pasted URL authenticates by
 * itself rather than leaving the token to be found separately.
 */
const debugConnectionUrl = computed(() => {
  const status = debugStatus.value
  if (!status.url) return ''
  return status.token ? `${status.url}/?token=${status.token}` : status.url
})

async function toggleDebugServer() {
  if (debugStatus.value.running) {
    await window.api!.debug.stop()
  } else {
    debugStatus.value = await window.api!.debug.start()
  }
}

async function copyDebugUrl() {
  if (!debugConnectionUrl.value) return
  await navigator.clipboard.writeText(debugConnectionUrl.value)
  // Writing to the clipboard is silent; without this the button reads as dead
  // even when it worked.
  copiedUrl.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copiedUrl.value = false }, 1500)
}

// ── CLI shim ──────────────────────────────────────────────────────────────────

const cliStatus = ref<CliShimStatus>({ installed: false })
const cliMessage = ref('')

async function toggleCli() {
  cliMessage.value = ''
  const result = cliStatus.value.installed
    ? await window.api!.cli.uninstall()
    : await window.api!.cli.install()
  cliMessage.value = result.message
  cliStatus.value = await window.api!.cli.status()
}

// ── Initialisation ────────────────────────────────────────────────────────────

let offDebugStatus: (() => void) | undefined

onMounted(async () => {
  if (isElectron.value) {
    try {
      const settings = await window.api!.settings.get()
      serialConfig.value = { ...DEFAULT_SERIAL_CONFIG, ...settings.serialConfig }
      if (settings.cfPath) cfPath.value = settings.cfPath
      if (settings.nvramPath) nvramPath.value = settings.nvramPath
      // Let the assignment above reach the watcher before edits start counting.
      await nextTick()
    } catch { /* use defaults */ }
    hydrating = false
    await refreshPorts()

    debugStatus.value = await window.api!.debug.status()
    offDebugStatus = window.api!.debug.onStatusChanged((status) => {
      debugStatus.value = status
    })
    cliStatus.value = await window.api!.cli.status()
  }
})

onUnmounted(() => {
  offDebugStatus?.()
  clearTimeout(copiedTimer)
})
</script>

<style scoped>
/* ── Backdrop ────────────────────────────────────────────────────────────────── */
.settings-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 99;
}

/* ── Panel ───────────────────────────────────────────────────────────────────── */
.settings-panel {
  position: fixed;
  top: 0;
  right: 0;
  /* `dvh`, not `100%`: a fixed element sized against the layout viewport runs on
     under mobile Safari's toolbars, which is what put the bottom of this panel
     out of reach. The dynamic viewport is the part actually on the screen. */
  height: 100dvh;
  width: 320px;
  background: #141414;
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  flex-direction: column;
  z-index: 100;
  overflow: hidden;
  /* Outside #app, so its safe-area padding does not apply here. */
  padding-top: env(safe-area-inset-top);
  padding-right: env(safe-area-inset-right);
  padding-bottom: env(safe-area-inset-bottom);
}

/*
  On a phone a 320px drawer leaves a strip of the machine showing down one side
  that is too narrow to read and too wide to ignore, and it steals the width the
  settings rows themselves want. Below that, the panel is the screen.
*/
@media (max-width: 560px) {
  .settings-panel {
    width: 100%;
    border-left: none;
  }
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.panel-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #fff;
}

.close-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font-size: 14px;
  color: #999;
  transition: color 0.15s, background 0.15s;
}
.close-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

/* ── Sections ────────────────────────────────────────────────────────────────── */
.panel-section {
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.section-heading {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #555;
  margin: 0 0 10px 0;
}

/* ── Joystick ────────────────────────────────────────────────────────────────── */
.joystick-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #ccc;
  cursor: pointer;
  margin: 4px 0 10px 0;
}
.joystick-toggle input { cursor: pointer; }

.joystick-preset { margin-bottom: 10px; }

/* ── File rows ───────────────────────────────────────────────────────────────── */
.file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  min-width: 0;
}

.file-kind {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: #666;
  width: 36px;
  flex-shrink: 0;
}

.file-name {
  flex: 1;
  font-size: 12px;
  font-family: monospace;
  color: #bbb;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.addr-field {
  width: 56px;
  flex-shrink: 0;
  text-align: center;
}

.load-warning {
  font-size: 11px;
  line-height: 1.4;
  color: #d9a441;
  margin: 2px 0 0 0;
}

/* ── Serial ──────────────────────────────────────────────────────────────────── */
.serial-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-text {
  font-size: 12px;
  color: #888;
  font-family: monospace;
}

.port-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.config-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
  margin-bottom: 10px;
}

.config-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.config-item .field {
  width: 100%;
}

/* ── Debug / CLI ─────────────────────────────────────────────────────────────── */
.debug-url {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 0 10px 0;
}

/* min-width: 0 is what lets the URL shrink. A flex item defaults to
   min-width: auto, so without it the 64-character token pushes the copy button
   out past the panel's edge — which is exactly how it was unreachable. */
.debug-url-value {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-family: monospace;
  color: #888;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copy-btn { flex-shrink: 0; }
.copied { color: #4ade80; }

.debug-hint {
  font-size: 11px;
  line-height: 1.4;
  color: #666;
  /* A top margin as well as a bottom one: a hint explains the control above it,
     and with none it sat flush against the joystick dropdown's border and read
     as part of the field rather than as a note about it. */
  margin: 6px 0 10px 0;
}
.debug-hint code {
  font-family: monospace;
  color: #999;
}

/* ── Fields ──────────────────────────────────────────────────────────────────── */
.field {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  color: #eee;
  /* Padding, not a fixed height. A field pinned to 26px has nowhere to put the
     16px text a touch device raises it to, and the glyphs spill out of the box —
     which is what the accessory dropdown was doing on an iPad. Sized by its own
     line instead, it comes out the same on a desktop and simply grows when the
     text does. */
  padding: 3px 6px;
  font-size: 12px;
  font-family: monospace;
  line-height: 1.5;
  outline: none;
}
.field:focus { border-color: rgba(255, 255, 255, 0.35); }

.port-select { flex: 1; }

.config-label {
  font-size: 10px;
  color: #666;
  letter-spacing: 0.03em;
}

/* ── Buttons ─────────────────────────────────────────────────────────────────── */
.btn-icon {
  display: flex;
  align-items: center;
  padding: 3px;
  border-radius: 4px;
  color: #888;
}
.btn-icon:hover { color: #fff; }

.btn-sm {
  padding: 3px 9px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  height: 24px;
  white-space: nowrap;
}

.btn-connect {
  width: 100%;
  padding: 6px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  transition: opacity 0.15s;
}
.btn-connect:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-primary  { background: rgba(99, 102, 241, 0.85); color: #fff; }
.btn-primary:hover:not(:disabled)  { background: rgba(99, 102, 241, 1); }

.btn-danger   { background: rgba(239, 68, 68, 0.75);  color: #fff; }
.btn-danger:hover:not(:disabled)   { background: rgba(239, 68, 68, 0.9); }

.btn-secondary {
  background: rgba(255, 255, 255, 0.07);
  color: #ccc;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.btn-secondary:hover:not(:disabled) { background: rgba(255, 255, 255, 0.14); }
</style>
