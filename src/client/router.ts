import { translate as tr } from "./i18n";
import { createRouter, createWebHashHistory, createWebHistory } from "vue-router";
import { onAuthenticationRequired } from "./authentication-required";
import { isDesktopApp } from "./desktop";
import { resolveRouteScrollPosition } from "./route-scroll";
import { clearSession, loadSession, session } from "./session";

type EnvManWindow = Window & { __envmanRouteErrorMessage?: string };

const routeReloadKeyPrefix = "envman:route-reload:";

function routeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : tr("页面加载失败");
}

function isRecoverableRouteLoadError(error: unknown): boolean {
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk [\w-]+ failed|CSS_CHUNK_LOAD_FAILED/i.test(routeErrorMessage(error));
}

export const router = createRouter({
  history: isDesktopApp() ? createWebHashHistory() : createWebHistory(),
  scrollBehavior: resolveRouteScrollPosition,
  routes: [
    { path: "/login", name: "login", component: () => import("./views/LoginView.vue"), meta: { public: true } },
    { path: "/", name: "overview", component: () => import("./views/OverviewView.vue") },
    { path: "/environments/:id", name: "environment", component: () => import("./views/EnvironmentDetailView.vue") },
    { path: "/knowledge", name: "knowledge", component: () => import("./views/KnowledgeBaseView.vue") },
    { path: "/connections", name: "connections", component: () => import("./views/ConnectionPoolView.vue") },
    { path: "/ssh-keys", name: "ssh-keys", component: () => import("./views/SshKeysView.vue"), meta: { managerOnly: true } },
    { path: "/connections/tools", name: "connection-tools", component: () => import("./views/ConnectionToolsView.vue") },
    { path: "/connection-tools", redirect: (to) => ({ name: "connection-tools", query: to.query }) },
    { path: "/connection-sources", redirect: { name: "connection-tools", query: { tab: "sync" } } },
    { path: "/ssh", name: "ssh", component: () => import("./views/SshWorkbenchView.vue") },
    { path: "/sftp", redirect: (to) => ({ name: "ssh", query: { ...to.query, mode: "sftp" } }) },
    { path: "/database", name: "database", component: () => import("./views/DatabaseWorkbenchView.vue") },
    { path: "/redis", name: "redis", component: () => import("./views/RedisWorkbenchView.vue") },
    { path: "/active-connections", name: "active-connections", component: () => import("./views/ActiveConnectionsView.vue") },
    { path: "/audit", name: "audit", component: () => import("./views/AuditView.vue") },
    { path: "/downloads", name: "client-downloads", component: () => import("./views/ClientDownloadsView.vue"), meta: { webOnly: true } },
    { path: "/settings", name: "settings", component: () => import("./views/SettingsView.vue") },
    { path: "/organization", name: "organization", component: () => import("./views/OrganizationView.vue") },
    { path: "/join/:token", name: "organization-invitation", component: () => import("./views/OrganizationInvitationView.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

let authenticationRedirectPending = false;

onAuthenticationRequired(() => {
  const redirect = router.currentRoute.value.fullPath;
  clearSession();
  if (!session.loaded || router.currentRoute.value.name === "login" || authenticationRedirectPending) return;
  authenticationRedirectPending = true;
  void router.replace({ name: "login", query: { redirect } })
    .catch((error) => console.error("[Viron] Failed to redirect an expired session", error))
    .finally(() => { authenticationRedirectPending = false; });
});

router.beforeEach(async (to) => {
  if (!session.loaded) await loadSession();
  if (!to.meta.public && !session.user) return { name: "login", query: { redirect: to.fullPath } };
  if (to.name === "login" && session.user) return { name: "overview" };
  if (to.meta.webOnly && isDesktopApp()) return { name: "overview" };
  if (to.meta.managerOnly && !["owner", "admin"].includes(session.workspace?.role ?? "")) return { name: "overview" };
  return true;
});

router.onError((error, to) => {
  const message = routeErrorMessage(error);
  console.error("[EnvMan] route navigation failed", error);
  const reloadKey = `${routeReloadKeyPrefix}${to.fullPath}`;
  if (isRecoverableRouteLoadError(error) && !sessionStorage.getItem(reloadKey)) {
    sessionStorage.setItem(reloadKey, "1");
    window.location.reload();
    return;
  }
  (window as EnvManWindow).__envmanRouteErrorMessage = message;
  window.dispatchEvent(new CustomEvent("envman:route-error", { detail: { message } }));
});

router.afterEach((to, _from, failure) => {
  if (!failure) sessionStorage.removeItem(`${routeReloadKeyPrefix}${to.fullPath}`);
});
