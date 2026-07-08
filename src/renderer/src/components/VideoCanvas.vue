<template>
  <!--
    Two-div layout (mirrors APL1-Terminal):
    • .canvas-outer   flex:1 in the column layout; stretches to fill all space above ControlBar
    • .canvas-screen  height:100% + aspect-ratio 320/240 → width is derived; max-width:100% handles
                      portrait/narrow viewports; aspect-ratio recalculates height when max-width clamps
    The canvas element fills the screen div at 100%/100%, so CSS scales the 320×240 buffer up cleanly.
  -->
  <div class="canvas-outer">
    <div class="canvas-screen">
      <canvas ref="canvasRef" width="320" height="240" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import type { Video } from '@core/IO/Video'

const emulator = useEmulatorStore()
const canvasRef = ref<HTMLCanvasElement | null>(null)
let ctx: CanvasRenderingContext2D | null = null

function render() {
  if (!ctx) return
  const video = emulator.getVideo() as Video | null
  if (!video) return
  const buf = video.buffer
  const data = new ImageData(
    new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength),
    320,
    240
  )
  ctx.putImageData(data, 0, 0)
}

onMounted(() => {
  ctx = canvasRef.value?.getContext('2d') ?? null
  emulator.setRenderCallback(render)
})

onUnmounted(() => {
  emulator.setRenderCallback(() => {})
})
</script>

<style scoped>
.canvas-outer {
  /* Takes all vertical space above the ControlBar in the flex column */
  flex: 1;
  align-self: stretch;   /* Override parent's align-items:center so we fill full width */
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  box-sizing: border-box;
}

.canvas-screen {
  /* Fills available height; aspect-ratio derives width; max-width prevents overflow */
  height: 100%;
  aspect-ratio: 320 / 240;
  max-width: 100%;
}

.canvas-screen canvas {
  display: block;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
  border-radius: 0.5rem;
}
</style>
