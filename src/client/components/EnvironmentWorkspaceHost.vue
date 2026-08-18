<script setup lang="ts">
import { toJpeg } from "html-to-image";
import gsap from "gsap";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { activeEnvironmentDockEnvironments } from "../../shared/active-environment-dock";
import { activeEnvironmentDockNavigationTarget } from "../active-connection-navigation";
import { rememberedActiveConnectionOrigin } from "../active-connection-origin";
import { activeConnections } from "../active-connections";
import { captureDesktopRendererPreview, isDesktopApp } from "../desktop";
import {
  environmentWorkspaceConnectionVisible,
  environmentWorkspacePreviews,
  normalizeEnvironmentWorkspaceQuery,
  pruneHiddenEnvironmentWorkspaceConnections,
  removeEnvironmentPreviewFrame,
  resetEnvironmentWorkspacePreviews,
  setEnvironmentPreviewFrame,
  transitionEnvironmentWorkspace,
  type EnvironmentWorkspaceQuery,
} from "../environment-workspace-previews";
import {
  ENVIRONMENT_WORKSPACE_ENTER_MS,
  takeEnvironmentWorkspaceTransition,
} from "../environment-workspace-transition";
import { session } from "../session";
import EnvironmentDetailView from "../views/EnvironmentDetailView.vue";

interface RouteSnapshot {
  environmentId: string;
  query: EnvironmentWorkspaceQuery;
}

const route = useRoute();
const router = useRouter();
const desktop = isDesktopApp();
const sourceElements = new Map<string, HTMLElement>();
const enteringEnvironmentId = ref("");
let entranceMedia: ReturnType<typeof gsap.matchMedia> | null = null;
const nativePreviewEnvironmentIds = new Set<string>();
const retentionClock = ref(Date.now());
let captureTimer: number | undefined;
let retentionTimer: number | undefined;
let capturePromise: Promise<void> | null = null;
let removeNavigationGuard: (() => void) | undefined;
let previousRoute: RouteSnapshot = { environmentId: "", query: {} };

const rememberedEnvironmentIds = computed(() => Object.fromEntries(
  activeConnections.items.flatMap((item) => {
    const environmentId = rememberedActiveConnectionOrigin(item.id);
    return environmentId ? [[item.id, environmentId]] : [];
  }),
));
const connectedEnvironments = computed(() => {
  const user = session.user;
  const workspace = session.workspace;
  if (!user || !workspace) return [];
  return activeEnvironmentDockEnvironments(activeConnections.items, {
    ownerId: user.id,
    workspaceType: workspace.type,
    workspaceId: workspace.id,
    desktop,
    rememberedEnvironmentIds: rememberedEnvironmentIds.value,
  }).flatMap((environment) => {
    const connections = environment.connections.filter((connection) => environmentWorkspaceConnectionVisible(connection.id));
    return connections.length ? [{ ...environment, connections }] : [];
  });
});
const connectedEnvironmentIds = computed(() => new Set(connectedEnvironments.value.map((environment) => environment.id)));
const currentEnvironmentId = computed(() => route.name === "environment" ? String(route.params.id ?? "") : "");
const currentQuery = computed(() => normalizeEnvironmentWorkspaceQuery(route.query));
const workspaceIds = computed(() => {
  const now = retentionClock.value;
  const ids = currentEnvironmentId.value ? [currentEnvironmentId.value] : [];
  for (const environmentId of [
    ...environmentWorkspacePreviews.stack,
    ...connectedEnvironments.value.map((environment) => environment.id),
  ]) {
    const retained = (environmentWorkspacePreviews.retainUntil[environmentId] ?? 0) > now;
    if (environmentId !== currentEnvironmentId.value && (connectedEnvironmentIds.value.has(environmentId) || retained)) ids.push(environmentId);
  }
  return [...new Set(ids)];
});

function routeSnapshot(): RouteSnapshot {
  return { environmentId: currentEnvironmentId.value, query: currentQuery.value };
}

function workspaceQuery(environmentId: string): EnvironmentWorkspaceQuery {
  if (environmentId === currentEnvironmentId.value) return currentQuery.value;
  const remembered = environmentWorkspacePreviews.queries[environmentId];
  if (remembered && Object.keys(remembered).length) return remembered;
  const connection = connectedEnvironments.value.find((environment) => environment.id === environmentId)?.connections[0];
  if (!connection) return remembered ?? {};
  const target = activeEnvironmentDockNavigationTarget(connection, environmentId);
  return target.name === "environment" ? target.query ?? {} : remembered ?? {};
}

function setSourceElement(environmentId: string, value: Element | null): void {
  if (value instanceof HTMLElement) sourceElements.set(environmentId, value);
  else sourceElements.delete(environmentId);
}

async function animateWorkspaceEntrance(environmentId: string): Promise<void> {
  const origin = takeEnvironmentWorkspaceTransition(environmentId);
  if (!origin) return;
  enteringEnvironmentId.value = environmentId;
  await nextTick();
  const instance = sourceElements.get(environmentId);
  const target = instance?.querySelector<HTMLElement>(".environment-workspace") ?? null;
  if (!target) {
    enteringEnvironmentId.value = "";
    return;
  }
  entranceMedia?.revert();
  entranceMedia = gsap.matchMedia();
  entranceMedia.add(
    {
      allowMotion: "(prefers-reduced-motion: no-preference)",
      reduceMotion: "(prefers-reduced-motion: reduce)",
    },
    (context) => {
      const { reduceMotion } = context.conditions as { reduceMotion: boolean };
      if (reduceMotion) {
        gsap.fromTo(target, { autoAlpha: 0 }, {
          autoAlpha: 1,
          duration: 0.12,
          ease: "power1.out",
          clearProps: "opacity,visibility",
          onComplete: () => { if (enteringEnvironmentId.value === environmentId) enteringEnvironmentId.value = ""; },
        });
        return;
      }
      const targetBounds = target.getBoundingClientRect();
      const sourceCenterX = origin.x + origin.width / 2;
      const sourceCenterY = origin.y + origin.height / 2;
      const targetCenterX = targetBounds.x + targetBounds.width / 2;
      const targetCenterY = targetBounds.y + targetBounds.height / 2;
      const scale = Math.max(0.82, Math.min(0.94, origin.width / Math.max(targetBounds.width, 1)));
      gsap.fromTo(target, {
        autoAlpha: 0.35,
        x: (sourceCenterX - targetCenterX) * 0.28,
        y: (sourceCenterY - targetCenterY) * 0.28,
        scale,
        transformOrigin: `${sourceCenterX - targetBounds.x}px ${sourceCenterY - targetBounds.y}px`,
        clipPath: "inset(2.5% round 12px)",
        willChange: "transform, opacity, clip-path",
      }, {
        autoAlpha: 1,
        x: 0,
        y: 0,
        scale: 1,
        clipPath: "inset(0% round 0px)",
        duration: ENVIRONMENT_WORKSPACE_ENTER_MS / 1_000,
        ease: "power3.out",
        clearProps: "transform,opacity,visibility,clipPath,willChange",
        onComplete: () => { if (enteringEnvironmentId.value === environmentId) enteringEnvironmentId.value = ""; },
      });
    },
    target,
  );
}

function setNativePreviewFrame(environmentId: string, dataUrl: string): void {
  if (!environmentId || !dataUrl) return;
  nativePreviewEnvironmentIds.add(environmentId);
  setEnvironmentPreviewFrame(environmentId, dataUrl);
}

function captureSurface(environmentId: string): HTMLElement | null {
  return sourceElements.get(environmentId)?.querySelector<HTMLElement>(".environment-tab-stage") ?? null;
}

function currentWorkspaceTab(): string {
  return currentQuery.value.tab || "web";
}

function scheduleCapture(delay = 1_200): void {
  window.clearTimeout(captureTimer);
  captureTimer = window.setTimeout(() => void captureCurrentWorkspace(), delay);
}

async function captureWorkspace(environmentId: string): Promise<void> {
  if (!environmentId || document.visibilityState === "hidden") return;
  if (desktop && environmentId === currentEnvironmentId.value
    && currentWorkspaceTab() === "web" && nativePreviewEnvironmentIds.has(environmentId)) return;
  const previousCapture = capturePromise ?? Promise.resolve();
  const nextCapture = previousCapture.then(async () => {
    const source = captureSurface(environmentId);
    if (!source) return;
    try {
      const rect = source.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const dataUrl = desktop
        ? await captureDesktopRendererPreview({
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        })
        : await toJpeg(source, {
          backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() || "#f7f7f7",
          canvasWidth: 640,
          canvasHeight: 360,
          cacheBust: false,
          quality: 0.72,
          skipAutoScale: true,
          skipFonts: true,
        });
      if (dataUrl) setEnvironmentPreviewFrame(environmentId, dataUrl);
    } catch (error) {
      console.warn("[Viron] Failed to capture environment preview", environmentId, error);
    }
  });
  capturePromise = nextCapture;
  try {
    await nextCapture;
  } finally {
    if (capturePromise === nextCapture) capturePromise = null;
  }
}

async function captureCurrentWorkspace(): Promise<void> {
  if (currentEnvironmentId.value && connectedEnvironmentIds.value.has(currentEnvironmentId.value)) {
    await captureWorkspace(currentEnvironmentId.value);
  }
  scheduleCapture();
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "visible") scheduleCapture(180);
}

watch(
  () => route.fullPath,
  () => {
    const next = routeSnapshot();
    const previousEnvironmentId = previousRoute.environmentId;
    transitionEnvironmentWorkspace(
      previousEnvironmentId,
      previousRoute.query,
      next.environmentId,
      next.query,
    );
    if (next.environmentId && (next.query.tab || "web") !== "web") nativePreviewEnvironmentIds.delete(next.environmentId);
    previousRoute = next;
    if (next.environmentId && next.environmentId !== previousEnvironmentId) void animateWorkspaceEntrance(next.environmentId);
    void nextTick(() => scheduleCapture(180));
  },
  { immediate: true },
);

watch(workspaceIds, (ids, previousIds) => {
  for (const environmentId of previousIds ?? []) {
    if (!ids.includes(environmentId)) {
      nativePreviewEnvironmentIds.delete(environmentId);
      removeEnvironmentPreviewFrame(environmentId);
    }
  }
  void nextTick(() => scheduleCapture(180));
});

watch(
  () => activeConnections.items.map((item) => item.id),
  (ids) => pruneHiddenEnvironmentWorkspaceConnections(ids),
  { immediate: true },
);

onMounted(() => {
  removeNavigationGuard = router.beforeEach(async (to, from) => {
    const environmentId = from.name === "environment" ? String(from.params.id ?? "") : "";
    if (environmentId && to.fullPath !== from.fullPath) await captureWorkspace(environmentId);
    return true;
  });
  document.addEventListener("visibilitychange", handleVisibilityChange);
  retentionTimer = window.setInterval(() => { retentionClock.value = Date.now(); }, 1_000);
  scheduleCapture(280);
});

onBeforeUnmount(() => {
  window.clearTimeout(captureTimer);
  window.clearInterval(retentionTimer);
  removeNavigationGuard?.();
  entranceMedia?.revert();
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  for (const environmentId of workspaceIds.value) removeEnvironmentPreviewFrame(environmentId);
  nativePreviewEnvironmentIds.clear();
  sourceElements.clear();
  resetEnvironmentWorkspacePreviews();
});
</script>

<template>
  <div class="environment-workspace-host">
    <div
      v-for="environmentId in workspaceIds"
      :key="environmentId"
      :ref="(element) => setSourceElement(environmentId, element as Element | null)"
      class="environment-workspace-instance"
      :class="environmentId === currentEnvironmentId ? 'is-foreground' : 'is-preview-source'"
      :data-environment-preview-source="environmentId === currentEnvironmentId ? undefined : environmentId"
      :aria-hidden="environmentId === currentEnvironmentId ? undefined : 'true'"
    >
      <EnvironmentDetailView
        :environment-id="environmentId"
        :route-query="workspaceQuery(environmentId)"
        :active="environmentId === currentEnvironmentId && environmentId !== enteringEnvironmentId"
        :preview="environmentId !== currentEnvironmentId"
        @preview-frame="setNativePreviewFrame(environmentId, $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.environment-workspace-host,
.environment-workspace-instance.is-foreground { display: contents; }
.environment-workspace-instance.is-preview-source {
  --workbench-viewport-height: 720px;
  position: fixed;
  left: -20000px;
  top: 0;
  z-index: -1;
  width: 1280px;
  height: 720px;
  overflow: hidden;
  contain: strict;
  visibility: hidden;
  pointer-events: none;
  background: var(--paper);
}
.environment-workspace-instance.is-preview-source :deep(*) { caret-color: transparent !important; }
</style>
