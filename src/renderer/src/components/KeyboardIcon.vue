<script setup lang="ts">
/**
 * A keyboard, drawn rather than imported.
 *
 * Heroicons has no keyboard in either weight, and this is the same glyph the
 * KIMulator draws in its focus badges — so the two machines say "keys go here"
 * with one shape.
 */
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="2.5" y="6.5" width="19" height="11" rx="2" stroke="currentColor" />
    <g fill="currentColor">
      <rect x="5" y="9" width="2" height="1.6" rx="0.4" />
      <rect x="8.5" y="9" width="2" height="1.6" rx="0.4" />
      <rect x="12" y="9" width="2" height="1.6" rx="0.4" />
      <rect x="15.5" y="9" width="2" height="1.6" rx="0.4" />
      <rect x="5" y="12" width="2" height="1.6" rx="0.4" />
      <rect x="8.5" y="12" width="5.5" height="1.6" rx="0.4" />
      <rect x="15.5" y="12" width="2" height="1.6" rx="0.4" />
    </g>
  </svg>
</template>
