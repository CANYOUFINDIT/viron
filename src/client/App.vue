<script setup lang="ts">import { translate as tr } from "./i18n";

import { onBeforeUnmount, onErrorCaptured, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import AppShell from "./components/AppShell.vue";
import EnvironmentWorkspaceHost from "./components/EnvironmentWorkspaceHost.vue";
import RouteErrorState from "./components/RouteErrorState.vue";
import { isDesktopApp, setDesktopTitleBarTheme } from "./desktop";
import { elementPlusLocale } from "./i18n";
import { theme } from "./theme";
import { logout } from "./session";

type EnvManWindow = Window & { __envmanRouteErrorMessage?: string };

const routeError = ref((window as EnvManWindow).__envmanRouteErrorMessage ?? "");
const activeRoute = useRoute();
const router = useRouter();
const desktop = isDesktopApp();
const signingOut = ref(false);

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

async function signOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await logout();
    routeError.value = "";
    delete (window as EnvManWindow).__envmanRouteErrorMessage;
    await router.replace({ name: "login" });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("退出登录失败"));
  } finally {
    signingOut.value = false;
  }
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
  <el-config-provider :locale="elementPlusLocale" :message="{ showClose: true, grouping: true, duration: 4500, offset: 24 }">
    <RouterView v-slot="{ Component, route }">
      <component :is="Component" v-if="route.meta.public && !routeError" />
      <RouteErrorState v-else-if="route.meta.public" :message="routeError" :allow-logout="desktop" :signing-out="signingOut" @reload="reloadApp" @logout="signOut" />
      <AppShell v-else>
        <RouteErrorState v-if="routeError" :message="routeError" :allow-logout="desktop" :signing-out="signingOut" @reload="reloadApp" @logout="signOut" />
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
