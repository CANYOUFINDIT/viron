<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  applyAgentHostState,
  currentAgentHostSnapshot,
  dispatchLocalAgentHostAction,
  notifyDesktopAgentChatPointerOutside,
  onDesktopAgentHostRequest,
  registerAgentHostNavigateSettings,
  respondDesktopAgentHost,
  updateDesktopAgentHost,
} from "../agent-host";
import { isDesktopApp } from "../desktop";
import { session } from "../session";
import type { AgentHostAction } from "../../shared/agent-host";

const desktop = isDesktopApp();
const route = useRoute();
const router = useRouter();
let removeRequestListener: (() => void) | undefined;
let removeNavigateListener: (() => void) | undefined;

function snapshot() {
  return currentAgentHostSnapshot({
    userId: session.user?.id ?? "",
    workspaceType: session.workspace?.type ?? "",
    workspaceId: session.workspace?.id ?? "",
    routePath: route.fullPath,
    routeName: String(route.name ?? ""),
    settingsSection: String(route.query.section ?? ""),
  });
}

function publish() {
  if (!desktop) return;
  const next = snapshot();
  applyAgentHostState(next);
  void updateDesktopAgentHost(session.user ? next : null);
}

async function handleAction(action: AgentHostAction) {
  if (action.type === "navigate-settings") {
    if (route.name === "settings" && route.query.section === "ai-agent") return { ok: true };
    await router.push({ name: "settings", query: { ...route.query, section: "ai-agent" } });
    return { ok: true };
  }
  if (action.type === "scene-snapshot") return { ok: true, result: snapshot() };
  applyAgentHostState(snapshot());
  return dispatchLocalAgentHostAction(action);
}

function handlePointerDown() {
  void notifyDesktopAgentChatPointerOutside();
}

onMounted(() => {
  if (!desktop) return;
  removeNavigateListener = registerAgentHostNavigateSettings(async () => {
    if (route.name === "settings" && route.query.section === "ai-agent") return;
    await router.push({ name: "settings", query: { ...route.query, section: "ai-agent" } });
  });
  removeRequestListener = onDesktopAgentHostRequest((request) => {
    void handleAction(request.action)
      .then((result) => respondDesktopAgentHost(request.id, result))
      .catch((error) => respondDesktopAgentHost(request.id, {
        ok: false,
        error: error instanceof Error ? error.message : "Viron Agent 宿主操作失败",
      }));
  });
  document.addEventListener("pointerdown", handlePointerDown);
  publish();
});

watch(
  [
    () => session.user?.id,
    () => session.workspace?.type,
    () => session.workspace?.id,
    () => route.fullPath,
    () => route.name,
    () => route.query.section,
  ],
  publish,
);

onBeforeUnmount(() => {
  removeRequestListener?.();
  removeNavigateListener?.();
  document.removeEventListener("pointerdown", handlePointerDown);
  if (desktop) void updateDesktopAgentHost(null);
});
</script>

<template>
  <span class="agent-host-bridge" aria-hidden="true"></span>
</template>

<style scoped>
.agent-host-bridge { display: none; }
</style>
