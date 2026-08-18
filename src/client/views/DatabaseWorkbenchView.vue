<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import DatabaseWorkbench from "../components/DatabaseWorkbench.vue";
import DesktopExecutionNotice from "../components/DesktopExecutionNotice.vue";
import { desktopExecutionTargets, desktopState, isDesktopApp } from "../desktop";

defineOptions({ name: "DatabaseWorkbenchView" });

const route = useRoute();
const desktop = isDesktopApp();
const capabilityLoaded = ref(!desktop);
const databaseTarget = computed(() => desktopExecutionTargets.value.database);
const connectionId = computed(() => typeof route.query.connectionId === "string" ? route.query.connectionId : undefined);
const environmentId = computed(() => typeof route.query.environmentId === "string" ? route.query.environmentId : undefined);
const workspaceKey = computed(() => typeof route.query.workspaceId === "string" ? `browser:database:${route.query.workspaceId}` : "fixed:database");

onMounted(async () => {
  if (desktop) {
    await desktopState();
  }
  capabilityLoaded.value = true;
});
</script>

<template>
  <div class="standalone-workbench">
    <DesktopExecutionNotice v-if="desktop && capabilityLoaded && databaseTarget === 'unavailable'" :capability='$t("当前连接模式下数据库")' />
    <DatabaseWorkbench v-else-if="capabilityLoaded" :environment-id="environmentId" :initial-connection-id="connectionId" :workspace-key="workspaceKey" />
  </div>
</template>
