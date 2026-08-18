<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import DesktopExecutionNotice from "../components/DesktopExecutionNotice.vue";
import SshWorkbench from "../components/SshWorkbench.vue";
import { desktopExecutionTargets, desktopState, isDesktopApp } from "../desktop";

defineOptions({ name: "SshWorkbenchView" });

const route = useRoute();
const desktop = isDesktopApp();
const capabilityLoaded = ref(!desktop);
const sshTarget = computed(() => desktopExecutionTargets.value.ssh);
const sftpTarget = computed(() => desktopExecutionTargets.value.sftp);
const connectionId = computed(() => typeof route.query.connectionId === "string" ? route.query.connectionId : undefined);
const environmentId = computed(() => typeof route.query.environmentId === "string" ? route.query.environmentId : undefined);
const workspaceKey = computed(() => typeof route.query.workspaceId === "string" ? `browser:ssh:${route.query.workspaceId}` : "fixed:ssh");
const initialMode = computed(() => route.query.mode === "sftp" ? "sftp" : "terminal");

onMounted(async () => {
  if (desktop) {
    await desktopState();
  }
  capabilityLoaded.value = true;
});
</script>

<template>
  <div class="standalone-workbench">
    <DesktopExecutionNotice v-if="desktop && capabilityLoaded && sshTarget === 'unavailable'" :capability='$t("当前连接模式下 SSH")' />
    <SshWorkbench v-else-if="capabilityLoaded" :environment-id="environmentId" :initial-connection-id="connectionId" :initial-mode="initialMode" :workspace-key="workspaceKey" :local-execution="desktop && sshTarget === 'local'" :sftp-enabled="!desktop || sftpTarget !== 'unavailable'" />
  </div>
</template>
