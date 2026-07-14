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
          <input ref="programInput" type="file" accept=".bin,.prg" class="hidden" @change="onLoadProgram" />
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

    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { ArrowPathIcon, XMarkIcon } from '@heroicons/vue/24/solid'
import { useEmulatorStore } from '@/stores/emulator'
import { loadDefaultBIOS, DEFAULT_ROM_LABEL } from '@/composables/useDefaultBIOS'
import { useSerial } from '@/composables/useSerial'
import { DEFAULT_SERIAL_CONFIG } from '@shared/types'
import type { SerialConfig, PortInfo } from '@shared/types'

defineEmits<{ close: [] }>()

const store = useEmulatorStore()
const { available, status: serialStatus, connect, disconnect } = useSerial()
const isElectron = computed(() => typeof window !== 'undefined' && !!window.api)

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

async function resetROM() {
  const bios = await loadDefaultBIOS()
  if (!bios) return
  store.loadROM(bios, DEFAULT_ROM_LABEL)
  store.resetCPU()
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

watch(serialConfig, (cfg) => {
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

// ── Initialisation ────────────────────────────────────────────────────────────

onMounted(async () => {
  if (isElectron.value) {
    try {
      const settings = await window.api!.settings.get()
      serialConfig.value = { ...DEFAULT_SERIAL_CONFIG, ...settings.serialConfig }
      if (settings.cfPath) cfPath.value = settings.cfPath
      if (settings.nvramPath) nvramPath.value = settings.nvramPath
    } catch { /* use defaults */ }
    await refreshPorts()
  }
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
  height: 100%;
  width: 320px;
  background: #141414;
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  flex-direction: column;
  z-index: 100;
  overflow: hidden;
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

/* ── Fields ──────────────────────────────────────────────────────────────────── */
.field {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  color: #eee;
  padding: 3px 6px;
  font-size: 12px;
  font-family: monospace;
  height: 26px;
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
