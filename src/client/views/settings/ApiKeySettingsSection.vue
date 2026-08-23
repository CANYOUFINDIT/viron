<script setup lang="ts">
import { useSettingsContext } from "./context";
import ApiKeySettings from "../../components/ApiKeySettings.vue";

const { session } = useSettingsContext();
</script>

<template>
<section class="settings-section-panel">
          <ApiKeySettings :is-platform-admin="Boolean(session.user?.isPlatformAdmin)" />
        </section>
</template>
