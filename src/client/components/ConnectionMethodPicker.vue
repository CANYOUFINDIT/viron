<script setup lang="ts">
interface ConnectionMethodChoice {
  value: string;
  title: string;
  description: string;
  badge?: string;
}

defineProps<{
  modelValue: string;
  choices: ConnectionMethodChoice[];
  label: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();
</script>

<template>
  <div class="connection-method-field form-span-2">
    <span class="connection-method-field__label">{{ label }}</span>
    <div class="connection-method-picker" role="radiogroup" :aria-label="label">
      <button
        v-for="choice in choices"
        :key="choice.value"
        type="button"
        role="radio"
        :aria-checked="modelValue === choice.value"
        :class="{ 'is-selected': modelValue === choice.value }"
        @click="emit('update:modelValue', choice.value)"
      >
        <span class="connection-method-picker__heading">
          <strong>{{ choice.title }}</strong>
          <small v-if="choice.badge">{{ choice.badge }}</small>
        </span>
        <span>{{ choice.description }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.connection-method-field {
  min-width: 0;
  margin-bottom: 18px;
}

.connection-method-field__label {
  display: block;
  margin-bottom: 7px;
  color: var(--ink-700);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
}

.connection-method-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
}

.connection-method-picker > button {
  min-width: 0;
  min-height: 86px;
  padding: 12px 13px;
  border: 1px solid var(--ink-200);
  border-radius: 9px;
  background: color-mix(in srgb, var(--ink-50) 55%, var(--surface));
  color: var(--ink-500);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 7px;
  font: inherit;
  font-size: 12px;
  line-height: 1.45;
  text-align: left;
  cursor: pointer;
  transition: border-color .16s ease, background-color .16s ease, box-shadow .16s ease, transform .16s ease;
}

.connection-method-picker > button:hover {
  border-color: var(--ink-300);
  background: var(--surface);
  transform: translateY(-1px);
}

.connection-method-picker > button.is-selected {
  border-color: var(--teal-500);
  background: color-mix(in srgb, var(--teal-50) 78%, var(--surface));
  color: var(--teal-800);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--teal-500) 12%, transparent);
}

.connection-method-picker__heading {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.connection-method-picker strong {
  color: var(--ink-800);
  font-size: 13px;
  line-height: 1.25;
}

.connection-method-picker > button.is-selected strong {
  color: var(--teal-800);
}

.connection-method-picker small {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--surface);
  color: var(--ink-500);
  font-size: 10px;
  font-weight: 700;
  line-height: 1.3;
}

@media (max-width: 680px) {
  .connection-method-picker {
    grid-template-columns: minmax(0, 1fr);
  }

  .connection-method-picker > button {
    min-height: 0;
  }
}
</style>
