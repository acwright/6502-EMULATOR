<script setup lang="ts">
/**
 * The board's keyboard, on the screen.
 *
 * The same 67 caps in the same places at the same widths — see
 * `keyboard/layout.ts`, which carries the layout and what each switch sends.
 * There is no phone-keyboard abstraction over it: no autocorrect, no shifted
 * letters (the ACE has no lower case), and no symbol layers, because the
 * hardware has none of those and a keyboard that types something the machine
 * cannot receive is worse than a small one.
 *
 * Presses go in as HID codes, so `Machine` cannot tell this from a real
 * keyboard: Shift and Ctrl go down and up around the key rather than being
 * resolved here, and the keyboard attachments do the matrix and the ASCII
 * exactly as the AB Controller does. That is also why Fn is not sent — no
 * keyboard sends an Fn code; the host sees F1…F10 and infers it, which is what
 * `KeyboardMatrixAttachment` decodes back into a held Fn and a digit.
 *
 * Not a mobile-only control. It is the only keyboard a touch device has, but it
 * is also the fastest way to find Fn, the arrows or Ins on a laptop whose own
 * keyboard puts them somewhere else.
 */
import { computed, onUnmounted, ref } from 'vue'
import { useEmulatorStore } from '@/stores/emulator'
import { BOARD_HEIGHT, BOARD_WIDTH, FUNCTION_ROW, KEY_CAPS } from '@/keyboard/layout'
import type { KeyCap, Modifier } from '@/keyboard/layout'

const store = useEmulatorStore()

/**
 * A sticky modifier's three states, in the order tapping cycles them.
 *
 * `armed` survives exactly one key and then lets go, which is the only way to
 * type a shifted character with one finger. `locked` stays down until it is
 * tapped off — for arrow keys under Fn, or a run of Ctrl codes.
 */
type Latch = 'off' | 'armed' | 'locked'

const latches = ref<Record<Modifier, Latch>>({
  shift: 'off',
  ctrl: 'off',
  alt: 'off',
  fn: 'off'
})

/**
 * The modifier switches this board actually has codes for.
 *
 * Fn is not one of them, and no keyboard's is: the host is told F1…F10 and
 * infers the rest. `KeyboardMatrixAttachment` runs that inference backwards, so
 * sending it a function key is what puts Fn's own switch down in the matrix.
 */
const MODIFIER_HID: Readonly<Record<Modifier, number | null>> = {
  shift: 0xe1,
  ctrl: 0xe0,
  alt: 0xe2,
  fn: null
}

const isDown = (modifier: Modifier): boolean => latches.value[modifier] !== 'off'

/**
 * Tapping a modifier walks it off → armed → locked → off.
 *
 * The switch itself goes down when the modifier is armed and does not come back
 * up until it is off again, which is what a hand does: a locked Shift is a
 * finger resting on it, not a finger tapping it once per letter.
 */
function cycle(modifier: Modifier): void {
  const next: Record<Latch, Latch> = { off: 'armed', armed: 'locked', locked: 'off' }
  const to = next[latches.value[modifier]]
  const hid = MODIFIER_HID[modifier]

  if (hid !== null) {
    if (to === 'armed') store.machine?.onKeyDown(hid)
    else if (to === 'off') store.machine?.onKeyUp(hid)
  }

  latches.value = { ...latches.value, [modifier]: to }
}

/** Armed lasts exactly one key. Locked stays down until it is tapped off. */
function disarm(): void {
  const cleared = { ...latches.value }
  for (const modifier of Object.keys(cleared) as Modifier[]) {
    if (cleared[modifier] !== 'armed') continue
    cleared[modifier] = 'off'
    const hid = MODIFIER_HID[modifier]
    if (hid !== null) store.machine?.onKeyUp(hid)
  }
  latches.value = cleared
}

// ── What a cap is, right now ──────────────────────────────────────────────────

/** Fn moves the number row to F1…F10 and leaves the rest of the board alone. */
const functionRow = computed(() => (isDown('fn') ? FUNCTION_ROW : null))

function faceOf(cap: KeyCap): { legend: string; shifted?: string } {
  const fn = cap.row === 0 ? functionRow.value?.[cap.legend] : undefined
  if (fn) return { legend: fn.legend }
  return { legend: cap.legend, shifted: cap.shifted }
}

function hidFor(cap: KeyCap): number | null {
  const fn = cap.row === 0 ? functionRow.value?.[cap.legend] : undefined
  return fn ? fn.hid : cap.hid
}

// ── Pressing ──────────────────────────────────────────────────────────────────

/** HID codes currently down, so the highlight and the release agree. */
const held = ref(new Set<number>())

/**
 * The shortest a press is allowed to last.
 *
 * A tap can be over in a few milliseconds, and the controller wants two clean
 * sweeps 10 ms apart before it will call a key pressed — so a tap that went down
 * and came up inside one sweep would simply not be a keystroke. Holding it this
 * long is what a finger on a real cap does anyway.
 */
const MIN_HOLD_MS = 40

const pressedAt = new Map<number, number>()
const pending = new Set<ReturnType<typeof setTimeout>>()

function onPress(cap: KeyCap, event: PointerEvent): void {
  // Keeps the press from moving DOM focus off whatever had it, and stops the
  // browser turning a held cap into a text selection or a long-press callout.
  event.preventDefault()

  if (cap.modifier) {
    cycle(cap.modifier)
    return
  }

  const hid = hidFor(cap)
  if (hid === null || held.value.has(hid)) return

  // Whatever is armed or locked is already down — see cycle().
  store.machine?.onKeyDown(hid)
  held.value = new Set(held.value).add(hid)
  pressedAt.set(hid, performance.now())
}

function onRelease(cap: KeyCap): void {
  const hid = hidFor(cap)
  if (hid === null || !held.value.has(hid)) return

  // The cap comes back up straight away whatever happens below: the floor is the
  // machine's, not the hand's, and a cap still down after the finger left reads
  // as stuck.
  lift(hid)

  const elapsed = performance.now() - (pressedAt.get(hid) ?? 0)
  if (elapsed >= MIN_HOLD_MS) {
    release(hid)
    return
  }

  const timer = setTimeout(() => {
    pending.delete(timer)
    release(hid)
  }, MIN_HOLD_MS - elapsed)
  pending.add(timer)
}

function release(hid: number): void {
  store.machine?.onKeyUp(hid)
  pressedAt.delete(hid)
  disarm()
}

function lift(hid: number): void {
  const next = new Set(held.value)
  next.delete(hid)
  held.value = next
}

onUnmounted(() => {
  for (const timer of pending) clearTimeout(timer)
  // Nothing may be left held down on a keyboard that is no longer on the screen.
  for (const hid of held.value) store.machine?.onKeyUp(hid)
  for (const modifier of Object.keys(latches.value) as Modifier[]) {
    const hid = MODIFIER_HID[modifier]
    if (hid !== null && isDown(modifier)) store.machine?.onKeyUp(hid)
  }
})

// ── Geometry ──────────────────────────────────────────────────────────────────

/**
 * Each cap placed as a percentage of the board, with a fixed gutter taken out of
 * it. Percentages keep the layout exact at any size; the gutter is in pixels so
 * the channels between caps stay visible when the board is small.
 */
function place(cap: KeyCap): Record<string, string> {
  return {
    left: `calc(${(cap.x / BOARD_WIDTH) * 100}% + 1px)`,
    top: `calc(${(cap.row / BOARD_HEIGHT) * 100}% + 1px)`,
    width: `calc(${(cap.w / BOARD_WIDTH) * 100}% - 2px)`,
    height: `calc(${100 / BOARD_HEIGHT}% - 2px)`
  }
}

function classesFor(cap: KeyCap): Record<string, boolean> {
  const hid = hidFor(cap)
  return {
    'cap-dark': cap.dark === true,
    'cap-wide': cap.wide === true,
    'cap-held': hid !== null && held.value.has(hid),
    'cap-armed': cap.modifier !== undefined && latches.value[cap.modifier] === 'armed',
    'cap-locked': cap.modifier !== undefined && latches.value[cap.modifier] === 'locked'
  }
}

/** What the cap is for, spelled out for a screen reader and a hover. */
function titleFor(cap: KeyCap): string {
  if (cap.modifier) return `${cap.legend} — tap to arm, again to lock`
  const face = faceOf(cap)
  if (face.shifted) return `${face.legend}, or ${face.shifted} with Shift`
  return face.legend || 'Space'
}
</script>

<template>
  <section
    class="osk"
    role="group"
    aria-label="On-screen keyboard"
    @contextmenu.prevent
  >
    <div class="board">
      <button
        v-for="(cap, index) in KEY_CAPS"
        :key="index"
        class="cap"
        :class="classesFor(cap)"
        :style="place(cap)"
        :title="titleFor(cap)"
        :aria-label="titleFor(cap)"
        :aria-pressed="cap.modifier ? latches[cap.modifier] !== 'off' : undefined"
        tabindex="-1"
        @pointerdown="onPress(cap, $event)"
        @pointerup="onRelease(cap)"
        @pointercancel="onRelease(cap)"
        @pointerleave="onRelease(cap)"
      >
        <!-- Both legends, as the cap is printed. The live one is the bright one:
             which half of the cap you get is the thing Shift changes. -->
        <span v-if="faceOf(cap).shifted" class="legend legend-pair">
          <span :class="{ dim: !isDown('shift') }">{{ faceOf(cap).shifted }}</span>
          <span :class="{ dim: isDown('shift') }">{{ faceOf(cap).legend }}</span>
        </span>
        <span v-else class="legend">{{ faceOf(cap).legend }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
/*
  The board keeps its proportions and stops growing before it eats the screen.

  `width: min(…)` rather than a height with `max-width` on it, because clamping a
  box that already has a definite height only squashes it — the ratio has to come
  out of the arithmetic. The three terms are: the room there is, the width at
  which the board would be `--osk-height` tall, and the width past which a
  desktop monitor is just making keycaps enormous.
*/
.osk {
  --osk-height: min(34dvh, 13rem);
  flex-shrink: 0;
  /* The board's width is measured against this, so it has to be a real width
     rather than whatever the caps happen to add up to. */
  width: 100%;
  box-sizing: border-box;
  padding: 6px 8px;
  background: #0b0b0b;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.board {
  position: relative;
  width: min(100%, calc(var(--osk-height) * 16.5 / 5), 56rem);
  aspect-ratio: 16.5 / 5;
  margin: 0 auto;
  /* Makes the board the reference for the legends, so a cap's legend is sized
     off the board rather than off the window. */
  container-type: size;
  /* A tap must never scroll the page, zoom it, select a legend, or raise the
     long-press callout — all four of which a keyboard would otherwise do. */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

.cap {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  padding: 0;
  overflow: hidden;
  background: #cccccc;
  color: #000;
  transition: transform 0.05s ease-out, filter 0.05s ease-out;
}

/* Esc, Enter, Space and the arrows. */
.cap-dark {
  background: #393b3b;
  color: #f7f2ea;
}

.legend {
  /* The caps are one unit tall, so this is ~40% of a cap. */
  font-size: 8cqh;
  line-height: 1;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

/* A word or an arrow has to fit across a cap that is not much wider than a
   letter's, so it is set smaller than a single character is. */
.cap-wide .legend {
  font-size: 5cqh;
  font-weight: 500;
}

/* Two legends stacked, upper one first, exactly as the cap is printed. */
.legend-pair {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2em;
  font-size: 5.6cqh;
}

.legend-pair .dim {
  opacity: 0.45;
}

.cap:hover {
  filter: brightness(1.12);
}

.cap-held {
  transform: translateY(4%) scale(0.97);
  filter: brightness(0.82);
}

/* Armed lasts one key; locked stays down. Two states, told apart by how loud
   they are, because "this will apply once" and "this is stuck on" are different
   promises. */
.cap-armed {
  background: #6366f1;
  color: #fff;
}

.cap-locked {
  background: #6366f1;
  color: #fff;
  box-shadow: inset 0 0 0 2px #fff;
}

/*
  Beside the screen rather than under it — App.vue's `.stage` turns the column
  into a row at the same breakpoint, and this is the board's half of that.

  The height is the row's now, so the board is measured against its own box
  instead of against `--osk-height`. Same arithmetic either way: as wide as
  fits, or as wide as its height entitles it to be, whichever is smaller.
*/
@media (max-height: 480px) and (min-width: 700px) {
  .osk {
    display: flex;
    align-items: center;
    height: 100%;
    padding: 6px;
    border-top: none;
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    /* A definite height, so `100cqh` below is a length the board can use. */
    container-type: size;
  }

  .board {
    width: min(100%, calc(100cqh * 16.5 / 5));
  }
}
</style>
