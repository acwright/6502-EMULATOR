<template>
  <!--
    Two-div layout:
    • .canvas-outer   flex:1 in the column layout; stretches to fill all space above ControlBar
    • .canvas-screen  as large as fits, at 4:3, whichever way the viewport is shaped
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
  // The `as ArrayBuffer` is what makes this a `Uint8ClampedArray<ArrayBuffer>`
  // rather than `<ArrayBufferLike>`, which since TS 5.7 `ImageData` will not
  // take — a `SharedArrayBuffer` cannot back one. This is a view on the video
  // buffer and never shared. It has to stay a view: this runs once a frame.
  const data = new ImageData(
    new Uint8ClampedArray(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength),
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
  /* Full width whatever the parent's `align-items` says. Both entry points now
     stretch their children anyway, but this box has to fill the row for the
     `100cqh` below to be measured against anything useful. */
  align-self: stretch;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  box-sizing: border-box;
  /* Makes this box's content area the reference for the screen below. */
  container-type: size;
}

/*
  As large as fits, at 4:3, whichever way the viewport is shaped.

  `width: min(100%, height × 4/3)` rather than a height with `max-width` on it.
  A box that already has a definite height ignores its aspect ratio when the
  max-width clamps it — the width shrinks and the height does not follow, which
  is a 320 × 240 picture stretched down a portrait phone. The ratio has to come
  out of the arithmetic rather than out of a fallback.
*/
.canvas-screen {
  width: min(100%, calc(100cqh * 4 / 3));
  aspect-ratio: 320 / 240;
}

.canvas-screen canvas {
  display: block;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
  border-radius: 0.5rem;
}
</style>
