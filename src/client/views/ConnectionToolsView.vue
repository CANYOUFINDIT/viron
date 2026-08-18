<script setup lang="ts">
import { Activity, Copy, RefreshCw } from "@lucide/vue";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import ConnectionCopyPanel from "../components/ConnectionCopyPanel.vue";
import ConnectionInspectionPanel from "../components/ConnectionInspectionPanel.vue";
import DesktopExecutionNotice from "../components/DesktopExecutionNotice.vue";
import PageHeader from "../components/PageHeader.vue";
import { desktopExecutionTargets, desktopState, isDesktopApp } from "../desktop";
import ConnectionSourcesView from "./ConnectionSourcesView.vue";

type ToolTab = "sync" | "copy" | "inspection";
const route = useRoute();
const router = useRouter();
const desktop = isDesktopApp();
const capabilityLoaded = ref(!desktop);
const inspectionSshTarget = computed(() => desktopExecutionTargets.value.inspectionSsh);
const inspectionDatabaseTarget = computed(() => desktopExecutionTargets.value.inspectionDatabase);
const inspectionRedisTarget = computed(() => desktopExecutionTargets.value.inspectionRedis);
const inspectionAvailable = computed(() => inspectionSshTarget.value !== "unavailable" || inspectionDatabaseTarget.value !== "unavailable" || inspectionRedisTarget.value !== "unavailable");
const tab = computed<ToolTab>(() => ["sync", "copy", "inspection"].includes(String(route.query.tab)) ? String(route.query.tab) as ToolTab : "sync");

function selectTab(value: ToolTab) {
  void router.replace({ name: "connection-tools", query: { tab: value } });
}

onMounted(async () => {
  if (!desktop) return;
  try {
    await desktopState();
  } finally {
    capabilityLoaded.value = true;
  }
});
</script>

<template>
  <div class="connection-tools-page">
    <PageHeader :title="$t('连接工具')" />
    <nav class="connection-tool-tabs" :aria-label="$t('连接工具')">
      <button :class="{ 'is-active': tab === 'sync' }" @click="selectTab('sync')"><RefreshCw :size="17" /><span><strong>{{ $t('连接同步') }}</strong></span></button>
      <button :class="{ 'is-active': tab === 'copy' }" @click="selectTab('copy')"><Copy :size="17" /><span><strong>{{ $t('连接复制') }}</strong></span></button>
      <button :class="{ 'is-active': tab === 'inspection' }" @click="selectTab('inspection')"><Activity :size="17" /><span><strong>{{ $t('连接巡检') }}</strong></span></button>
    </nav>
    <ConnectionSourcesView v-if="tab === 'sync'" embedded />
    <ConnectionCopyPanel v-else-if="tab === 'copy'" />
    <DesktopExecutionNotice v-else-if="desktop && capabilityLoaded && !inspectionAvailable" :capability='$t("当前连接模式下连接巡检")' />
    <ConnectionInspectionPanel v-else-if="!desktop || (capabilityLoaded && inspectionAvailable)" :ssh-enabled="!desktop || inspectionSshTarget !== 'unavailable'" :database-enabled="!desktop || inspectionDatabaseTarget !== 'unavailable'" :redis-enabled="!desktop || inspectionRedisTarget !== 'unavailable'" />
  </div>
</template>
