<script setup lang="ts">import { translate as tr } from "./i18n";

import { onBeforeUnmount, onErrorCaptured, ref, watch } from "vue";
import { RouterView, useRoute } from "vue-router";
import AppShell from "./components/AppShell.vue";
import EnvironmentWorkspaceHost from "./components/EnvironmentWorkspaceHost.vue";
import RouteErrorState from "./components/RouteErrorState.vue";
import { setDesktopTitleBarTheme } from "./desktop";
import { elementPlusLocale } from "./i18n";
import { theme } from "./theme";

type EnvManWindow = Window & { __envmanRouteErrorMessage?: string };

const routeError = ref((window as EnvManWindow).__envmanRouteErrorMessage ?? "");
const activeRoute = useRoute();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : tr("页面加载失败");
}

function handleRouteError(event: Event) {
  const message = (event as CustomEvent<{ message?: string }>).detail?.message;
  routeError.value = message || tr("页面加载失败");
}

function reloadApp() {
  window.location.reload();
}

window.addEventListener("envman:route-error", handleRouteError);
onBeforeUnmount(() => window.removeEventListener("envman:route-error", handleRouteError));

watch(
  () => activeRoute.fullPath,
  () => {
    routeError.value = "";
    delete (window as EnvManWindow).__envmanRouteErrorMessage;
  },
);

watch(
  [() => activeRoute.name, theme],
  ([routeName, currentTheme]) => {
    void setDesktopTitleBarTheme(!routeName || routeName === "login" ? "login" : currentTheme).catch((error) => {
      console.error("[Viron] Failed to synchronize the native title bar theme", error);
    });
  },
  { immediate: true },
);

onErrorCaptured((error) => {
  routeError.value = errorMessage(error);
  console.error("[EnvMan] route render failed", error);
  return false;
});
</script>

<template>
  <el-config-provider :locale="elementPlusLocale">
    <RouterView v-slot="{ Component, route }">
      <component :is="Component" v-if="route.meta.public && !routeError" />
      <RouteErrorState v-else-if="route.meta.public" :message="routeError" @reload="reloadApp" />
      <AppShell v-else>
        <RouteErrorState v-if="routeError" :message="routeError" @reload="reloadApp" />
        <template v-else>
          <EnvironmentWorkspaceHost />
          <KeepAlive v-if="route.name !== 'environment'" include="SshWorkbenchView,DatabaseWorkbenchView">
            <component :is="Component" :key="String(route.name)" />
          </KeepAlive>
        </template>
      </AppShell>
    </RouterView>
  </el-config-provider>
</template>
