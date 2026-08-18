<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { clampStepperValue, formatStepperDigits } from "../../shared/threshold-stepper";

const props = withDefaults(defineProps<{
  modelValue: number;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  suffix?: string;
  disabled?: boolean;
}>(), {
  min: 0,
  max: 100,
  step: 1,
  digits: 3,
  suffix: "",
  disabled: false,
});

const emit = defineEmits<{ "update:modelValue": [value: number] }>();

const direction = ref<1 | -1>(1);
let holdDelay = 0;
let holdRepeat = 0;

const value = computed(() => clampStepperValue(props.modelValue, props.min, props.max, props.step));
const display = computed(() => formatStepperDigits(value.value, props.digits));
const atMin = computed(() => value.value <= props.min);
const atMax = computed(() => value.value >= props.max);
const valueText = computed(() => `${display.value.negative ? "-" : ""}${display.value.digits.join("")}${props.suffix}`);

function commit(next: number, nextDirection: 1 | -1) {
  const clamped = clampStepperValue(next, props.min, props.max, props.step);
  if (clamped === props.modelValue) return false;
  direction.value = nextDirection;
  emit("update:modelValue", clamped);
  return true;
}

function nudge(nextDirection: -1 | 1) {
  if (props.disabled) return false;
  return commit(value.value + nextDirection * props.step, nextDirection);
}

function clearHold() {
  window.clearTimeout(holdDelay);
  window.clearInterval(holdRepeat);
  holdDelay = 0;
  holdRepeat = 0;
  window.removeEventListener("pointerup", clearHold);
  window.removeEventListener("pointercancel", clearHold);
}

function startHold(nextDirection: -1 | 1) {
  clearHold();
  nudge(nextDirection);
  window.addEventListener("pointerup", clearHold);
  window.addEventListener("pointercancel", clearHold);
  holdDelay = window.setTimeout(() => {
    holdRepeat = window.setInterval(() => {
      if (!nudge(nextDirection)) clearHold();
    }, 90);
  }, 380);
}

function onKeydown(event: KeyboardEvent) {
  if (props.disabled) return;
  if (event.key === "ArrowUp" || event.key === "ArrowRight") {
    event.preventDefault();
    nudge(1);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
    event.preventDefault();
    nudge(-1);
    return;
  }
  if (event.key === "PageUp") {
    event.preventDefault();
    commit(value.value + props.step * 10, 1);
    return;
  }
  if (event.key === "PageDown") {
    event.preventDefault();
    commit(value.value - props.step * 10, -1);
    return;
  }
  if (event.key === "Home") {
    event.preventDefault();
    commit(props.min, -1);
    return;
  }
  if (event.key === "End") {
    event.preventDefault();
    commit(props.max, 1);
  }
}

onBeforeUnmount(clearHold);
</script>

<template>
  <div class="animated-counter" :class="{ 'is-disabled': disabled, 'is-down': direction < 0 }">
    <button
      type="button"
      :disabled="disabled || atMin"
      :aria-label="$t('减少')"
      @pointerdown.prevent="startHold(-1)"
      @pointerup="clearHold"
      @pointerleave="clearHold"
      @pointercancel="clearHold"
      @keydown.enter.prevent="nudge(-1)"
      @keydown.space.prevent="nudge(-1)"
    >−</button>
    <div
      class="animated-counter__value"
      role="spinbutton"
      tabindex="0"
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-valuenow="value"
      :aria-valuetext="valueText"
      :aria-disabled="disabled"
      @keydown="onKeydown"
    >
      <span v-if="display.negative" class="animated-counter__sign">−</span>
      <span v-for="(digit, index) in display.digits" :key="index" class="animated-counter__digit">
        <Transition name="animated-counter-digit">
          <strong :key="`${index}-${digit}`">{{ digit }}</strong>
        </Transition>
      </span>
    </div>
    <button
      type="button"
      class="is-plus"
      :disabled="disabled || atMax"
      :aria-label="$t('增加')"
      @pointerdown.prevent="startHold(1)"
      @pointerup="clearHold"
      @pointerleave="clearHold"
      @pointercancel="clearHold"
      @keydown.enter.prevent="nudge(1)"
      @keydown.space.prevent="nudge(1)"
    >+</button>
    <em v-if="suffix">{{ suffix }}</em>
  </div>
</template>

<style scoped>
.animated-counter {
  display: inline-flex;
  align-items: center;
  gap: .3125rem;
  padding: .25rem;
  border-radius: 10px;
  background: var(--ink-50);
  user-select: none;
}
.animated-counter button {
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: var(--surface);
  color: var(--ink-700);
  display: grid;
  place-items: center;
  box-shadow: var(--shadow-whisper);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  touch-action: manipulation;
  transition: background-color var(--dur-micro) var(--ease-out), transform var(--dur-micro) var(--ease-out);
}
.animated-counter button.is-plus {
  background: var(--color-ink);
  color: var(--color-paper);
}
.animated-counter button:disabled {
  opacity: .38;
  cursor: not-allowed;
}
.animated-counter button:active:not(:disabled) {
  transform: scale(.94);
}
.animated-counter.is-disabled {
  opacity: .62;
}
.animated-counter__value {
  min-width: 3.15rem;
  height: 1.75rem;
  padding-inline: .375rem;
  border-radius: 8px;
  background: var(--surface);
  color: var(--color-ink);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-whisper);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.animated-counter__value:focus-visible {
  outline: 2px solid var(--teal-500);
  outline-offset: 2px;
}
.animated-counter__sign,
.animated-counter__digit {
  position: relative;
  width: .62rem;
  height: 1.25rem;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.animated-counter__digit strong,
.animated-counter__sign {
  font-size: .875rem;
  font-weight: 700;
  line-height: 1;
}
.animated-counter__digit strong {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.animated-counter em {
  margin-inline: .125rem .25rem;
  color: var(--ink-500);
  font-family: var(--font-mono);
  font-size: .6875rem;
  font-style: normal;
}
.animated-counter-digit-enter-active,
.animated-counter-digit-leave-active {
  transition: transform var(--dur-short) var(--ease-out), opacity var(--dur-short) var(--ease-out);
}
.animated-counter-digit-enter-from {
  transform: translateY(-70%);
  opacity: 0;
}
.animated-counter-digit-leave-to {
  transform: translateY(70%);
  opacity: 0;
}
.animated-counter.is-down .animated-counter-digit-enter-from {
  transform: translateY(70%);
}
.animated-counter.is-down .animated-counter-digit-leave-to {
  transform: translateY(-70%);
}
@media (prefers-reduced-motion: reduce) {
  .animated-counter-digit-enter-active,
  .animated-counter-digit-leave-active { transition: none; }
  .animated-counter button { transition: none; }
}
@media (hover: hover) and (pointer: fine) {
  .animated-counter button:hover:not(:disabled) { background: var(--ink-100); }
  .animated-counter button.is-plus:hover:not(:disabled) { background: var(--ink-800); }
}
</style>
