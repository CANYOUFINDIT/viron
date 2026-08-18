<script setup lang="ts">
import { Construction } from "@lucide/vue";

defineProps<{ title: string }>();
</script>

<template>
  <section class="planned-feature-stage" :aria-label="title">
    <div class="planned-feature-notice">
      <div class="planned-feature-notice__status"><span></span>{{ $t('功能建设中') }}</div>
      <div class="planned-feature-notice__icon" aria-hidden="true"><Construction :size="38" :stroke-width="1.7" /></div>
      <h3>{{ title }}</h3>
    </div>
  </section>
</template>
