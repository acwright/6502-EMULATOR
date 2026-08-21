<template>
  <div class="paste-backdrop" @click="onCancel" />

  <div class="paste-modal" @keydown.esc="onCancel">
    <div class="paste-header">
      <span class="paste-title">Paste Text</span>
      <button class="close-btn" @click="onCancel" title="Close">✕</button>
    </div>

    <div class="paste-body">
      <textarea
        ref="textarea"
        v-model="text"
        class="paste-input"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        placeholder="Paste or type text to send to the emulator as keystrokes…"
      />
      <p class="paste-hint">
        Text is typed into the machine as emulated key presses. Uppercase and
        symbols are sent with Shift; newlines send Enter.
      </p>
    </div>

    <div class="paste-footer">
      <span v-if="sending" class="paste-status">Sending…</span>
      <button class="btn-sm btn-secondary" @click="onCancel">{{ sending ? 'Stop' : 'Cancel' }}</button>
      <button class="btn-sm btn-primary" :disabled="sending || !text" @click="onSend">Send</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue'
import { usePaste } from '@/composables/usePaste'

const emit = defineEmits<{ close: [] }>()

const { injectText, cancel } = usePaste()

const text = ref('')
const sending = ref(false)
const textarea = ref<HTMLTextAreaElement | null>(null)

onMounted(async () => {
  await nextTick()
  textarea.value?.focus()
})

async function onSend() {
  if (!text.value || sending.value) return
  sending.value = true
  try {
    await injectText(text.value)
  } finally {
    sending.value = false
    emit('close')
  }
}

function onCancel() {
  if (sending.value) {
    // Sending in progress — stop the injection; onSend's finally closes the modal.
    cancel()
    return
  }
  emit('close')
}
</script>

<style scoped>
.paste-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 199;
}

/*
  Centred, but never taller than the screen it is centred on.

  Without the cap this was a fixed header, a 200px box and a footer measured
  against nothing, so on a phone the Send button sat below the bottom of the
  screen — and with the soft keyboard up, so did most of the box. The height is
  `dvh` because the visible viewport is what the modal has to fit inside, and the
  body scrolls so that the header and the footer never leave.
*/
.paste-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(560px, 92vw);
  max-height: calc(100dvh - 2rem - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  background: #141414;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  z-index: 200;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
}

/*
  A phone in landscape with the keyboard up has perhaps 150px of viewport left.
  Centring in that puts the box under the keyboard; pinning it to the top keeps
  the textarea and the buttons where the browser can scroll them into view.
*/
@media (max-height: 560px) {
  .paste-modal {
    top: calc(0.5rem + env(safe-area-inset-top));
    transform: translateX(-50%);
    max-height: calc(100dvh - 1rem - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  }
}

.paste-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.paste-title {
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
.close-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }

.paste-body {
  padding: 14px 16px;
  /* Takes the squeeze when the modal is capped, so the header and footer do not. */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.paste-input {
  width: 100%;
  /* Never more than a third of the screen: this is a box you paste into, and on
     a short viewport its old fixed 200px was most of what there was. */
  height: clamp(5rem, 32dvh, 200px);
  resize: vertical;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  color: #eee;
  padding: 8px 10px;
  font-size: 13px;
  font-family: monospace;
  line-height: 1.4;
  outline: none;
}
.paste-input:focus { border-color: rgba(255, 255, 255, 0.35); }

.paste-hint {
  margin: 8px 2px 0;
  font-size: 11px;
  color: #666;
  line-height: 1.4;
}

.paste-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  padding-bottom: calc(12px + env(safe-area-inset-bottom));
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.paste-status {
  margin-right: auto;
  font-size: 12px;
  color: #888;
  font-family: monospace;
}

.btn-sm {
  padding: 5px 14px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  height: 28px;
  white-space: nowrap;
}

.btn-primary  { background: rgba(99, 102, 241, 0.85); color: #fff; }
.btn-primary:hover:not(:disabled)  { background: rgba(99, 102, 241, 1); }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

.btn-secondary {
  background: rgba(255, 255, 255, 0.07);
  color: #ccc;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.btn-secondary:hover:not(:disabled) { background: rgba(255, 255, 255, 0.14); }
</style>
