<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import DesktopExecutionNotice from "../components/DesktopExecutionNotice.vue";
import RedisWorkbench from "../components/RedisWorkbench.vue";
import { desktopExecutionTargets, desktopState, isDesktopApp } from "../desktop";

defineOptions({ name: "RedisWorkbenchView" });

const route = useRoute();
const desktop = isDesktopApp();
const capabilityLoaded = ref(!desktop);
const redisTarget = computed(() => desktopExecutionTargets.value.redis);
const connectionId = computed(() => typeof route.query.connectionId === "string" ? route.query.connectionId : undefined);
const environmentId = computed(() => typeof route.query.environmentId === "string" ? route.query.environmentId : undefined);
const workspaceKey = computed(() => typeof route.query.workspaceId === "string" ? `browser:redis:${route.query.workspaceId}` : "fixed:redis");

onMounted(async () => {
  if (desktop) await desktopState();
  capabilityLoaded.value = true;
});
</script>

<template>
  <div class="standalone-workbench">
    <DesktopExecutionNotice v-if="desktop && capabilityLoaded && redisTarget === 'unavailable'" :capability='$t("当前连接模式下 Redis")' />
    <RedisWorkbench v-else-if="capabilityLoaded" :environment-id="environmentId" :initial-connection-id="connectionId" :workspace-key="workspaceKey" />
  </div>
</template>
