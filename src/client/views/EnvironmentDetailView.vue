<script setup lang="ts">import { translate as tr } from "../i18n";

import {
  ArrowLeft,
  BookOpen,
  Copy,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  Globe2,
  KeyRound,
  MemoryStick,
  FileText,
  Plus,
  Pencil,
  Settings2,
  TerminalSquare,
  Trash2,
  Wrench,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, defineAsyncComponent, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, prefetchApi } from "../api";
import TlsPopover from "../components/credentials/TlsPopover.vue";
import DesktopExecutionNotice from "../components/DesktopExecutionNotice.vue";
import EnvironmentImmersiveNavigation from "../components/EnvironmentImmersiveNavigation.vue";
import DesktopWebAccountBrowser from "../components/DesktopWebAccountBrowser.vue";
import WebAccountBrowser from "../components/WebAccountBrowser.vue";
import { copyTextToClipboard } from "../clipboard";
import { desktopExecutionTargets, desktopState, isDesktopApp } from "../desktop";
import {
  environmentBackgroundPreloadAllowed,
  environmentBackgroundPreloadOrder,
  type EnvironmentPreloadTab,
} from "../environment-preload";
import { immersiveModeKey } from "../immersive-mode";
import { session } from "../session";
import type { ImmersiveNavigationEntry, ImmersiveWorkspaceTab } from "../../shared/immersive-navigation";
import { reorderIds, sameOrder } from "../../shared/tab-order";

const loadSshWorkbench = () => import("../components/SshWorkbench.vue");
const loadDatabaseWorkbench = () => import("../components/DatabaseWorkbench.vue");
const loadRedisWorkbench = () => import("../components/RedisWorkbench.vue");
const loadEnvironmentLogPanel = () => import("../components/EnvironmentLogPanel.vue");
const loadKnowledgeBasePanel = () => import("../components/KnowledgeBasePanel.vue");
const loadServiceMaintenancePanel = () => import("../components/ServiceMaintenancePanel.vue");
const SshWorkbench = defineAsyncComponent(loadSshWorkbench);
const DatabaseWorkbench = defineAsyncComponent(loadDatabaseWorkbench);
const RedisWorkbench = defineAsyncComponent(loadRedisWorkbench);
const EnvironmentLogPanel = defineAsyncComponent(loadEnvironmentLogPanel);
const KnowledgeBasePanel = defineAsyncComponent(loadKnowledgeBasePanel);
const ServiceMaintenancePanel = defineAsyncComponent(loadServiceMaintenancePanel);

interface EnvironmentItem {
  id: string;
  groupId: string | null;
  name: string;
  groupName: string | null;
  description: string;
  tags: string[];
  webCount: number;
  sshCount: number;
  databaseCount: number;
  redisCount: number;
  logCount: number;
  knowledgeDocumentCount: number;
  serviceCount: number;
  monitorHostCount: number;
  updatedAt: string;
}

interface EnvironmentGroup { id: string; name: string }

interface WebEntry {
  id: string;
  name: string;
  url: string;
  description: string;
  tags: string[];
  credentialCount: number;
  tls?: import("../../shared/tls-certificates").TlsWebEntryBadge | null;
}

interface WebCredential {
  id: string;
  username: string;
  note: string;
  customFields: Record<string, string>;
  hasPassword: boolean;
}

interface OpenedWebCredential extends WebCredential {
  entryId: string;
}

interface TabDropTarget {
  id: string;
  after: boolean;
}

type WorkspaceTab = ImmersiveWorkspaceTab;

const props = withDefaults(defineProps<{
  environmentId?: string;
  routeQuery?: Record<string, string>;
  active?: boolean;
  preview?: boolean;
}>(), { active: true, preview: false });
const emit = defineEmits<{ previewFrame: [dataUrl: string] }>();
const route = useRoute();
const router = useRouter();
const immersiveMode = inject(immersiveModeKey);
const desktop = isDesktopApp();
const webTarget = computed(() => desktopExecutionTargets.value.web);
const sshTarget = computed(() => desktopExecutionTargets.value.ssh);
const sftpTarget = computed(() => desktopExecutionTargets.value.sftp);
const logsTarget = computed(() => desktopExecutionTargets.value.logs);
const databaseTarget = computed(() => desktopExecutionTargets.value.database);
const redisTarget = computed(() => desktopExecutionTargets.value.redis);
const workspaceTabsElement = ref<HTMLElement | null>(null);
const environmentId = props.environmentId || String(route.params.id);
const workspaceQuery = computed<Record<string, string>>(() => props.routeQuery ?? Object.fromEntries(
  Object.entries(route.query).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : []),
));
const pageActive = computed(() => props.active);
const loading = ref(true);
const environment = ref<EnvironmentItem | null>(null);
const groups = ref<EnvironmentGroup[]>([]);
const webEntries = ref<WebEntry[]>([]);
const entryFavicons = ref<Record<string, string>>({});
const selectedEntryId = ref("");
const credentials = ref<WebCredential[]>([]);
const immersiveCredentials = ref<Record<string, WebCredential[]>>({});
const immersiveCredentialLoading = ref<Set<string>>(new Set());
const revealed = ref<Record<string, string>>({});
const activeTab = ref<WorkspaceTab>("web");
const entryDialog = ref(false);
const credentialDialog = ref(false);
const environmentDialog = ref(false);
const editingEntryId = ref("");
const editingCredentialId = ref("");
const saving = ref(false);
const splitMode = ref(false);
const activeWebPane = ref<0 | 1>(0);
const paneCredentialIds = ref<[string, string]>(["", ""]);
const paneOpenedCredentials = ref<[OpenedWebCredential[], OpenedWebCredential[]]>([[], []]);
const draggingEntryId = ref("");
const entryDropTarget = ref<TabDropTarget | null>(null);
const savingEntryOrder = ref(false);
const draggingCredentialId = ref("");
const credentialDropTarget = ref<TabDropTarget | null>(null);
const savingCredentialOrder = ref(false);
const webPaneIndexes: Array<0 | 1> = [0, 1];
let credentialScrollTimer: number | undefined;
let entryFaviconLoadVersion = 0;
let backgroundPreloadTimer: number | undefined;
let webPreloadTimer: number | undefined;
let intentPreloadTimer: number | undefined;
let backgroundPreloadGeneration = 0;
const webPreloadEnabled = ref(false);
const webPreloadCredentialId = ref("");

const entryForm = reactive({ name: "", url: "", description: "", tags: "" });
const credentialForm = reactive({ username: "", password: "", note: "" });
const environmentForm = reactive({ name: "", groupId: null as string | null, description: "", tags: "" });
const selectedEntry = computed(() => webEntries.value.find((item) => item.id === selectedEntryId.value) ?? null);
const canManageWorkspace = computed(() => session.workspace?.role === "owner" || session.workspace?.role === "admin");
const canSortTabs = computed(() => canManageWorkspace.value && !savingEntryOrder.value && !savingCredentialOrder.value);
const focusedWebView = computed(() => workspaceQuery.value.webFocus === "1" && Boolean(workspaceQuery.value.webCredentialId));
const environmentImmersive = computed(() => props.preview ? workspaceQuery.value.immersive === "1" : immersiveMode?.active.value ?? false);
const requestedConnectionId = computed(() => workspaceQuery.value.connectionId || undefined);
const immersiveCounts = computed<Record<ImmersiveWorkspaceTab, number>>(() => ({
  web: environment.value?.webCount ?? 0,
  ssh: environment.value?.sshCount ?? 0,
  logs: environment.value?.logCount ?? 0,
  database: environment.value?.databaseCount ?? 0,
  redis: environment.value?.redisCount ?? 0,
  knowledge: environment.value?.knowledgeDocumentCount ?? 0,
  maintenance: environment.value?.serviceCount ?? 0,
}));
const logFocusRequest = reactive({ id: "", sequence: 0 });
const immersiveEntries = computed<ImmersiveNavigationEntry[]>(() => webEntries.value.map((entry) => ({
  id: entry.id,
  name: entry.name,
  credentialCount: entry.credentialCount,
  credentials: immersiveCredentials.value[entry.id]?.map((credential) => ({ id: credential.id, username: credential.username })) ?? null,
  loading: immersiveCredentialLoading.value.has(entry.id),
})));
const preloadCounts = computed(() => ({
  ssh: environment.value?.sshCount ?? 0,
  logs: environment.value?.logCount ?? 0,
  database: environment.value?.databaseCount ?? 0,
  redis: environment.value?.redisCount ?? 0,
  knowledge: environment.value?.knowledgeDocumentCount ?? 0,
  maintenance: (environment.value?.serviceCount ?? 0) + (environment.value?.monitorHostCount ?? 0),
}));

function dataSaverEnabled(): boolean {
  return Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData);
}

function backgroundPreloadAllowed(): boolean {
  return environmentBackgroundPreloadAllowed({
    active: pageActive.value,
    preview: props.preview,
    visible: document.visibilityState === "visible",
    saveData: dataSaverEnabled(),
  });
}

function tabModuleLoader(tab: EnvironmentPreloadTab): () => Promise<unknown> {
  if (tab === "ssh") return loadSshWorkbench;
  if (tab === "logs") return loadEnvironmentLogPanel;
  if (tab === "database") return loadDatabaseWorkbench;
  if (tab === "redis") return loadRedisWorkbench;
  if (tab === "knowledge") return loadKnowledgeBasePanel;
  return loadServiceMaintenancePanel;
}

function prefetchTabData(tab: EnvironmentPreloadTab): Promise<unknown>[] {
  if (tab === "ssh") {
    const connectionsPath = `/api/v1/connections?type=ssh&environmentId=${encodeURIComponent(environmentId)}`;
    return [
      prefetchApi(connectionsPath),
      ...(!desktop || sshTarget.value === "server" ? [prefetchApi("/api/v1/ssh-sessions")] : []),
    ];
  }
  if (tab === "logs") return [
    prefetchApi(`/api/v1/environments/${environmentId}/logs`),
    prefetchApi(`/api/v1/connections?type=ssh&environmentId=${encodeURIComponent(environmentId)}`),
  ];
  if (tab === "database") return [
    prefetchApi(`/api/v1/connections?type=database&environmentId=${encodeURIComponent(environmentId)}&includeProfiles=true`),
    prefetchApi("/api/v1/connection-groups?type=database"),
    prefetchApi("/api/v1/database-object-favorites"),
  ];
  if (tab === "redis") return [prefetchApi(`/api/v1/connections?assignment=all&type=redis&environmentId=${encodeURIComponent(environmentId)}`)];
  if (tab === "knowledge") return [prefetchApi(`/api/v1/environments/${environmentId}/knowledge`)];
  return [prefetchApi(`/api/v1/environments/${environmentId}/service-deployments`)];
}

async function preloadTab(tab: EnvironmentPreloadTab): Promise<void> {
  await Promise.allSettled([tabModuleLoader(tab)(), ...prefetchTabData(tab)]);
}

function cancelEnvironmentPreloads(): void {
  backgroundPreloadGeneration += 1;
  window.clearTimeout(backgroundPreloadTimer);
  window.clearTimeout(webPreloadTimer);
  window.clearTimeout(intentPreloadTimer);
  backgroundPreloadTimer = undefined;
  webPreloadTimer = undefined;
  intentPreloadTimer = undefined;
  webPreloadEnabled.value = false;
  webPreloadCredentialId.value = "";
}

function scheduleEnvironmentPreloads(): void {
  cancelEnvironmentPreloads();
  if (!backgroundPreloadAllowed()) return;
  const generation = backgroundPreloadGeneration;
  const queue = environmentBackgroundPreloadOrder(preloadCounts.value, activeTab.value);
  const next = async () => {
    if (generation !== backgroundPreloadGeneration || !backgroundPreloadAllowed()) return;
    const tab = queue.shift();
    if (!tab) return;
    await preloadTab(tab);
    if (generation !== backgroundPreloadGeneration || !backgroundPreloadAllowed()) return;
    backgroundPreloadTimer = window.setTimeout(() => void next(), 1_200);
  };
  backgroundPreloadTimer = window.setTimeout(() => void next(), activeTab.value === "web" && paneCredentialIds.value[0] ? 3_600 : 1_800);
  if (activeTab.value === "web" && paneCredentialIds.value[0]) {
    webPreloadTimer = window.setTimeout(() => {
      if (generation !== backgroundPreloadGeneration || !backgroundPreloadAllowed() || activeTab.value !== "web") return;
      webPreloadCredentialId.value = paneCredentialIds.value[0];
      webPreloadEnabled.value = Boolean(webPreloadCredentialId.value);
    }, 1_500);
  }
}

function preloadTabOnIntent(tab: EnvironmentPreloadTab): void {
  if (!backgroundPreloadAllowed()) return;
  window.clearTimeout(intentPreloadTimer);
  void preloadTab(tab);
}

function preloadTabOnHover(tab: EnvironmentPreloadTab): void {
  if (!backgroundPreloadAllowed()) return;
  window.clearTimeout(intentPreloadTimer);
  if (tab !== "database") return void preloadTab(tab);
  intentPreloadTimer = window.setTimeout(() => {
    if (backgroundPreloadAllowed()) void preloadTab(tab);
  }, 280);
}

function cancelIntentPreload(): void {
  window.clearTimeout(intentPreloadTimer);
  intentPreloadTimer = undefined;
}

function handleVisibilityChange(): void {
  if (document.visibilityState === "visible") scheduleEnvironmentPreloads();
  else cancelEnvironmentPreloads();
}

watch(
  () => workspaceQuery.value.tab,
  (tab) => {
    if (typeof tab === "string" && ["web", "ssh", "logs", "database", "redis", "knowledge", "maintenance"].includes(tab)) {
      activeTab.value = tab as WorkspaceTab;
    }
  },
  { immediate: true },
);

watch(
  [() => workspaceQuery.value.tab, requestedConnectionId],
  ([tab, connectionId]) => {
    if (tab !== "logs" || !connectionId) return;
    logFocusRequest.id = connectionId;
    logFocusRequest.sequence += 1;
  },
  { immediate: true },
);

watch([pageActive, activeTab], () => scheduleEnvironmentPreloads());

async function loadEntryFavicons(entries: WebEntry[]) {
  const version = ++entryFaviconLoadVersion;
  const results = await Promise.all(entries.map(async (entry) => {
    try {
      const response = await api<{ dataUrl: string | null }>(`/api/v1/web-entries/${entry.id}/favicon`);
      return [entry.id, response.dataUrl] as const;
    } catch {
      return [entry.id, null] as const;
    }
  }));
  if (version !== entryFaviconLoadVersion) return;
  const currentIds = new Set(webEntries.value.map((entry) => entry.id));
  entryFavicons.value = Object.fromEntries(results.filter((result): result is readonly [string, string] => currentIds.has(result[0]) && Boolean(result[1])));
}

function discardEntryFavicon(entryId: string) {
  const next = { ...entryFavicons.value };
  delete next[entryId];
  entryFavicons.value = next;
}

function insertAfterTarget(event: DragEvent): boolean {
  const element = event.currentTarget;
  if (!(element instanceof HTMLElement)) return false;
  const bounds = element.getBoundingClientRect();
  return event.clientX > bounds.left + bounds.width / 2;
}

function clearDropTargetOnLeave(target: TabDropTarget | null, event: DragEvent): boolean {
  const nextTarget = event.relatedTarget;
  return target?.id === (event.currentTarget instanceof HTMLElement ? event.currentTarget.dataset.tabId : "")
    && !(nextTarget instanceof Node && event.currentTarget instanceof HTMLElement && event.currentTarget.contains(nextTarget));
}

function leaveEntryDropTarget(event: DragEvent) {
  if (clearDropTargetOnLeave(entryDropTarget.value, event)) entryDropTarget.value = null;
}

function leaveCredentialDropTarget(event: DragEvent) {
  if (clearDropTargetOnLeave(credentialDropTarget.value, event)) credentialDropTarget.value = null;
}

function orderedItems<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return orderedIds.map((id) => byId.get(id)).filter((item): item is T => Boolean(item));
}

function startEntryDrag(entryId: string, event: DragEvent) {
  if (!canSortTabs.value) {
    event.preventDefault();
    return;
  }
  draggingEntryId.value = entryId;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `web-entry:${entryId}`);
  }
}

function dragEntryOver(entryId: string, event: DragEvent) {
  if (!draggingEntryId.value || draggingEntryId.value === entryId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  entryDropTarget.value = { id: entryId, after: insertAfterTarget(event) };
}

async function dropEntry(entryId: string, event: DragEvent) {
  if (!draggingEntryId.value) return;
  event.preventDefault();
  const original = [...webEntries.value];
  const originalIds = original.map((entry) => entry.id);
  const orderedIds = reorderIds(originalIds, draggingEntryId.value, entryId, insertAfterTarget(event));
  draggingEntryId.value = "";
  entryDropTarget.value = null;
  if (sameOrder(originalIds, orderedIds)) return;
  webEntries.value = orderedItems(original, orderedIds);
  savingEntryOrder.value = true;
  try {
    await api(`/api/v1/environments/${environmentId}/web-entries/order`, {
      method: "PUT",
      body: JSON.stringify({ orderedIds }),
    });
  } catch (error) {
    webEntries.value = original;
    ElMessage.error(error instanceof Error ? error.message : tr("保存 Web 入口顺序失败"));
  } finally {
    savingEntryOrder.value = false;
  }
}

function endEntryDrag() {
  draggingEntryId.value = "";
  entryDropTarget.value = null;
}

function startCredentialDrag(credentialId: string, event: DragEvent) {
  if (!canSortTabs.value) {
    event.preventDefault();
    return;
  }
  draggingCredentialId.value = credentialId;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `web-credential:${credentialId}`);
  }
}

function dragCredentialOver(credentialId: string, event: DragEvent) {
  if (!draggingCredentialId.value || draggingCredentialId.value === credentialId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  credentialDropTarget.value = { id: credentialId, after: insertAfterTarget(event) };
}

async function dropCredential(credentialId: string, event: DragEvent) {
  if (!draggingCredentialId.value || !selectedEntryId.value) return;
  event.preventDefault();
  const entryId = selectedEntryId.value;
  const original = [...credentials.value];
  const originalIds = original.map((credential) => credential.id);
  const orderedIds = reorderIds(originalIds, draggingCredentialId.value, credentialId, insertAfterTarget(event));
  draggingCredentialId.value = "";
  credentialDropTarget.value = null;
  if (sameOrder(originalIds, orderedIds)) return;
  credentials.value = orderedItems(original, orderedIds);
  immersiveCredentials.value = { ...immersiveCredentials.value, [entryId]: credentials.value };
  savingCredentialOrder.value = true;
  try {
    await api(`/api/v1/web-entries/${entryId}/credentials/order`, {
      method: "PUT",
      body: JSON.stringify({ orderedIds }),
    });
  } catch (error) {
    if (selectedEntryId.value === entryId) credentials.value = original;
    immersiveCredentials.value = { ...immersiveCredentials.value, [entryId]: original };
    ElMessage.error(error instanceof Error ? error.message : tr("保存登录账号顺序失败"));
  } finally {
    savingCredentialOrder.value = false;
  }
}

function endCredentialDrag() {
  draggingCredentialId.value = "";
  credentialDropTarget.value = null;
}

function pinWorkspaceTabsIntoView() {
  workspaceTabsElement.value?.scrollIntoView({
    block: "start",
    inline: "nearest",
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
}

function relatedTlsEntries(entry: WebEntry) {
  return webEntries.value
    .filter((item) => item.id !== entry.id && item.tls?.certificateId && item.tls.certificateId === entry.tls?.certificateId)
    .map((item) => ({ id: item.id, name: item.name, url: item.url }));
}

async function selectWorkspaceTab(tab: WorkspaceTab) {
  const shouldSyncRoute = !props.preview && workspaceQuery.value.tab !== tab;
  activeTab.value = tab;
  if (shouldSyncRoute) {
    const query: Record<string, string> = { ...workspaceQuery.value, tab };
    delete query.activeConnectionId;
    delete query.connectionId;
    delete query.mode;
    await router.replace({ name: "environment", params: { id: environmentId }, query });
  }
  await nextTick();
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  pinWorkspaceTabsIntoView();
}

async function loadEnvironment() {
  loading.value = true;
  try {
    const [environmentResponse, entryResponse, groupResponse] = await Promise.all([
      api<{ item: EnvironmentItem }>(`/api/v1/environments/${environmentId}`),
      api<{ items: WebEntry[] }>(`/api/v1/environments/${environmentId}/web-entries`),
      api<{ items: EnvironmentGroup[] }>("/api/v1/environment-groups"),
    ]);
    environment.value = environmentResponse.item;
    webEntries.value = entryResponse.items;
    void loadEntryFavicons(entryResponse.items);
    groups.value = groupResponse.items;
    const requestedEntryId = workspaceQuery.value.webEntryId ?? "";
    if (requestedEntryId && webEntries.value.some((entry) => entry.id === requestedEntryId)) selectedEntryId.value = requestedEntryId;
    if (!selectedEntryId.value && webEntries.value.length) selectedEntryId.value = webEntries.value[0].id;
    if (selectedEntryId.value) await loadCredentials();
    scheduleEnvironmentPreloads();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载环境失败"));
  } finally {
    loading.value = false;
  }
}

async function loadCredentials(preferredCredentialId = "") {
  if (!selectedEntryId.value) {
    credentials.value = [];
    return;
  }
  if (preferredCredentialId) paneCredentialIds.value[0] = preferredCredentialId;
  const response = await api<{ items: WebCredential[] }>(`/api/v1/web-entries/${selectedEntryId.value}/credentials`);
  credentials.value = response.items;
  immersiveCredentials.value = { ...immersiveCredentials.value, [selectedEntryId.value]: response.items };
  syncWebPanes();
}

async function loadImmersiveCredentials(entryId: string) {
  if (immersiveCredentials.value[entryId] || immersiveCredentialLoading.value.has(entryId)) return;
  immersiveCredentialLoading.value = new Set(immersiveCredentialLoading.value).add(entryId);
  try {
    const response = await api<{ items: WebCredential[] }>(`/api/v1/web-entries/${entryId}/credentials`);
    immersiveCredentials.value = { ...immersiveCredentials.value, [entryId]: response.items };
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载登录账号失败"));
  } finally {
    const loading = new Set(immersiveCredentialLoading.value);
    loading.delete(entryId);
    immersiveCredentialLoading.value = loading;
  }
}

function syncWebPanes() {
  const available = new Set(credentials.value.map((credential) => credential.id));
  reconcileOpenedCredentials();
  const requestedCredentialId = workspaceQuery.value.webCredentialId ?? "";
  if (requestedCredentialId && available.has(requestedCredentialId)) paneCredentialIds.value[0] = requestedCredentialId;
  if (!available.has(paneCredentialIds.value[0])) paneCredentialIds.value[0] = credentials.value[0]?.id ?? "";
  if (!available.has(paneCredentialIds.value[1])) paneCredentialIds.value[1] = "";
  if (splitMode.value && !paneCredentialIds.value[1]) {
    paneCredentialIds.value[1] = credentials.value.find((credential) => credential.id !== paneCredentialIds.value[0])?.id ?? paneCredentialIds.value[0];
  }
  rememberCredential(0, paneCredentialIds.value[0]);
  rememberCredential(1, paneCredentialIds.value[1]);
}

function credentialForPane(index: 0 | 1) {
  return credentials.value.find((credential) => credential.id === paneCredentialIds.value[index]) ?? null;
}

function reconcileOpenedCredentials() {
  const current = new Map(credentials.value.map((credential) => [credential.id, credential]));
  for (const index of [0, 1] as const) {
    paneOpenedCredentials.value[index] = paneOpenedCredentials.value[index].flatMap((opened) => {
      if (opened.entryId !== selectedEntryId.value) return [opened];
      const credential = current.get(opened.id);
      return credential ? [{ ...credential, entryId: opened.entryId }] : [];
    });
  }
}

function rememberCredential(index: 0 | 1, id: string) {
  if (!id || !selectedEntryId.value) return;
  const credential = credentials.value.find((item) => item.id === id);
  if (!credential) return;
  const opened = { ...credential, entryId: selectedEntryId.value };
  const existingIndex = paneOpenedCredentials.value[index].findIndex((item) => item.id === id);
  if (existingIndex >= 0) paneOpenedCredentials.value[index].splice(existingIndex, 1, opened);
  else paneOpenedCredentials.value[index].push(opened);
}

function removeOpenedCredential(id: string) {
  paneOpenedCredentials.value = [
    paneOpenedCredentials.value[0].filter((item) => item.id !== id),
    paneOpenedCredentials.value[1].filter((item) => item.id !== id),
  ];
}

function removeOpenedEntry(entryId: string) {
  paneOpenedCredentials.value = [
    paneOpenedCredentials.value[0].filter((item) => item.entryId !== entryId),
    paneOpenedCredentials.value[1].filter((item) => item.entryId !== entryId),
  ];
}

function openedCredentialActive(index: 0 | 1, opened: OpenedWebCredential) {
  return pageActive.value && activeTab.value === "web"
    && (index === 0 || splitMode.value)
    && selectedEntryId.value === opened.entryId
    && paneCredentialIds.value[index] === opened.id;
}

async function selectCredential(id: string, event?: MouseEvent) {
  paneCredentialIds.value[activeWebPane.value] = id;
  rememberCredential(activeWebPane.value, id);
  await nextTick();
  const row = (event?.currentTarget as HTMLElement | null)?.closest<HTMLElement>(".web-account-row");
  if (!row) return;
  window.clearTimeout(credentialScrollTimer);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    row.scrollIntoView({ block: "nearest", inline: "nearest" });
    return;
  }
  credentialScrollTimer = window.setTimeout(() => {
    if (row.classList.contains("is-selected")) row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, 230);
}

function credentialSelected(id: string) {
  return paneCredentialIds.value[activeWebPane.value] === id;
}

function setSplitMode(value: boolean) {
  splitMode.value = value;
  if (value) {
    activeWebPane.value = 1;
    syncWebPanes();
  } else {
    activeWebPane.value = 0;
  }
}

function externalWebHref(entryId: string, credentialId: string) {
  return router.resolve({
    name: "environment",
    params: { id: environmentId },
    query: { webEntryId: entryId, webCredentialId: credentialId, webFocus: "1", immersive: "1" },
  }).href;
}

function webEntryUrl(entryId: string) {
  return webEntries.value.find((entry) => entry.id === entryId)?.url ?? "";
}

async function setFocusedWebView(focused: boolean, credential: OpenedWebCredential) {
  if (props.preview) return;
  const query = { ...workspaceQuery.value };
  query.webEntryId = credential.entryId;
  query.webCredentialId = credential.id;
  if (focused) {
    query.webFocus = "1";
    query.immersive = "1";
  } else {
    delete query.webFocus;
    delete query.immersive;
  }
  await router.replace({ name: "environment", params: { id: environmentId }, query });
  if (!focused && environmentImmersive.value) immersiveMode?.setActive(false);
}

async function selectEntry(id: string) {
  selectedEntryId.value = id;
  revealed.value = {};
  paneCredentialIds.value = ["", ""];
  activeWebPane.value = 0;
  await loadCredentials();
}

async function selectImmersiveCredential(entryId: string, credentialId: string) {
  await selectWorkspaceTab("web");
  if (selectedEntryId.value === entryId) {
    await selectCredential(credentialId);
    return;
  }
  selectedEntryId.value = entryId;
  revealed.value = {};
  paneCredentialIds.value = [credentialId, ""];
  activeWebPane.value = 0;
  await loadCredentials(credentialId);
}

function exitEnvironmentImmersive() {
  immersiveMode?.setActive(false);
}

function openEntryCreate() {
  editingEntryId.value = "";
  Object.assign(entryForm, { name: "", url: "", description: "", tags: "" });
  entryDialog.value = true;
}

function openEntryEdit(entry: WebEntry) {
  editingEntryId.value = entry.id;
  Object.assign(entryForm, { name: entry.name, url: entry.url, description: entry.description, tags: entry.tags.join(", ") });
  entryDialog.value = true;
}

async function saveEntry() {
  if (!entryForm.name.trim() || !entryForm.url.trim()) return ElMessage.warning(tr("请填写名称和页面地址"));
  saving.value = true;
  try {
    await api(editingEntryId.value ? `/api/v1/web-entries/${editingEntryId.value}` : `/api/v1/environments/${environmentId}/web-entries`, {
      method: editingEntryId.value ? "PUT" : "POST",
      body: JSON.stringify({
        name: entryForm.name,
        url: entryForm.url,
        description: entryForm.description,
        tags: entryForm.tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      }),
    });
    entryDialog.value = false;
    Object.assign(entryForm, { name: "", url: "", description: "", tags: "" });
    ElMessage.success(editingEntryId.value ? tr("Web 入口已更新") : tr("Web 入口已添加"));
    await loadEnvironment();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("添加失败"));
  } finally {
    saving.value = false;
  }
}

async function removeEntry(entry: WebEntry) {
  try {
    await ElMessageBox.confirm(tr("删除“{0}”后，其登录账号也会删除。", [entry.name]), tr("删除 Web 入口"), { type: "warning", confirmButtonText: tr("删除"), cancelButtonText: tr("取消") });
    await api(`/api/v1/web-entries/${entry.id}`, { method: "DELETE" });
    removeOpenedEntry(entry.id);
    if (selectedEntryId.value === entry.id) selectedEntryId.value = "";
    ElMessage.success(tr("Web 入口已删除"));
    await loadEnvironment();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除失败"));
  }
}

function openCredentialCreate() {
  editingCredentialId.value = "";
  Object.assign(credentialForm, { username: "", password: "", note: "" });
  credentialDialog.value = true;
}

function openCredentialEdit(credential: WebCredential) {
  editingCredentialId.value = credential.id;
  Object.assign(credentialForm, { username: credential.username, password: "", note: credential.note });
  credentialDialog.value = true;
}

async function saveCredential() {
  if (!credentialForm.username.trim()) return ElMessage.warning(tr("请输入用户名"));
  saving.value = true;
  try {
    const editing = Boolean(editingCredentialId.value);
    const response = await api<{ id?: string }>(editingCredentialId.value ? `/api/v1/web-credentials/${editingCredentialId.value}` : `/api/v1/web-entries/${selectedEntryId.value}/credentials`, {
      method: editingCredentialId.value ? "PUT" : "POST",
      body: JSON.stringify({ ...credentialForm, customFields: {} }),
    });
    credentialDialog.value = false;
    Object.assign(credentialForm, { username: "", password: "", note: "" });
    ElMessage.success(editing ? tr("登录账号已更新") : tr("登录账号已加密保存"));
    await loadCredentials();
    if (!editing && response.id) selectCredential(response.id);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存账号失败"));
  } finally {
    saving.value = false;
  }
}

async function removeCredential(credential: WebCredential) {
  try {
    await ElMessageBox.confirm(tr("删除“{0}”后，其密码、Cookie、缓存和页面登录状态都会永久删除。", [credential.username]), tr("删除登录账号"), { type: "warning", confirmButtonText: tr("全部删除"), cancelButtonText: tr("取消") });
    await api(`/api/v1/web-credentials/${credential.id}`, { method: "DELETE" });
    removeOpenedCredential(credential.id);
    ElMessage.success(tr("登录账号已删除"));
    await loadCredentials();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除失败"));
  }
}

function openEnvironmentEdit() {
  if (!environment.value) return;
  Object.assign(environmentForm, {
    name: environment.value.name,
    groupId: environment.value.groupId,
    description: environment.value.description,
    tags: environment.value.tags.join(", "),
  });
  environmentDialog.value = true;
}

function updateLogCount(count: number) {
  if (environment.value) environment.value.logCount = count;
}

function updateKnowledgeDocumentCount(count: number) {
  if (environment.value) environment.value.knowledgeDocumentCount = count;
}

function updateServiceCount(counts: { services: number; monitoredHosts: number }) {
  if (!environment.value) return;
  environment.value.serviceCount = counts.services;
  environment.value.monitorHostCount = counts.monitoredHosts;
}

async function openServiceLog(logId: string) {
  logFocusRequest.id = logId;
  logFocusRequest.sequence += 1;
  await selectWorkspaceTab("logs");
}

async function openServiceSsh(connectionId: string) {
  if (!connectionId) return;
  activeTab.value = "ssh";
  if (!props.preview) {
    const query: Record<string, string> = { ...workspaceQuery.value, tab: "ssh", connectionId };
    delete query.mode;
    await router.replace({ name: "environment", params: { id: environmentId }, query });
  }
  await nextTick();
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  pinWorkspaceTabsIntoView();
}

async function saveEnvironment() {
  if (!environmentForm.name.trim()) return ElMessage.warning(tr("请输入环境名称"));
  saving.value = true;
  try {
    await api(`/api/v1/environments/${environmentId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: environmentForm.name,
        groupId: environmentForm.groupId,
        description: environmentForm.description,
        tags: environmentForm.tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      }),
    });
    environmentDialog.value = false;
    ElMessage.success(tr("环境已更新"));
    await loadEnvironment();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("更新环境失败"));
  } finally {
    saving.value = false;
  }
}

async function removeEnvironment() {
  if (!environment.value) return;
  try {
    await ElMessageBox.confirm(tr("删除“{0}”后，SSH/数据库连接会回到待分配，Web 入口会删除。", [environment.value.name]), tr("删除环境"), { type: "warning", confirmButtonText: tr("删除环境"), cancelButtonText: tr("取消") });
    await api(`/api/v1/environments/${environmentId}`, { method: "DELETE" });
    ElMessage.success(tr("环境已删除"));
    await router.replace("/");
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除环境失败"));
  }
}

async function toggleReveal(credential: WebCredential) {
  if (revealed.value[credential.id]) {
    const copy = { ...revealed.value };
    delete copy[credential.id];
    revealed.value = copy;
    return;
  }
  try {
    const response = await api<{ password: string }>(`/api/v1/web-credentials/${credential.id}/reveal`, { method: "POST" });
    revealed.value = { ...revealed.value, [credential.id]: response.password };
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("读取密码失败"));
  }
}

async function copyText(value: string, label: string) {
  try {
    await copyTextToClipboard(value);
    ElMessage.success(tr("{0}已复制", [label]));
  } catch {
    ElMessage.error(tr("复制失败"));
  }
}

onMounted(async () => {
  document.addEventListener("visibilitychange", handleVisibilityChange);
  if (desktop) {
    await desktopState();
  }
  await loadEnvironment();
});
onBeforeUnmount(() => {
  cancelEnvironmentPreloads();
  window.clearTimeout(credentialScrollTimer);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
});
</script>

<template>
  <div v-loading="loading" class="environment-workspace" :class="{ 'is-focused-web-workspace': focusedWebView, 'is-immersive-workspace': environmentImmersive, 'is-preview-workspace': preview }">
    <EnvironmentImmersiveNavigation
      v-if="environment && environmentImmersive"
      :native="desktop"
      :environment-name="environment.name"
      :active-tab="activeTab"
      :selected-entry-id="selectedEntryId"
      :selected-credential-id="paneCredentialIds[0]"
      :counts="immersiveCounts"
      :maintenance-host-count="environment.monitorHostCount"
      :entries="immersiveEntries"
      @select-tab="selectWorkspaceTab"
      @select-credential="selectImmersiveCredential"
      @load-credentials="loadImmersiveCredentials"
      @exit="exitEnvironmentImmersive"
    />

    <section v-if="environment && !focusedWebView && !environmentImmersive" class="environment-hero">
      <div class="environment-hero__identity">
        <RouterLink to="/" class="environment-back-action" :aria-label="$t('返回环境总览')" :title="$t('返回环境总览')"><ArrowLeft :size="16" /></RouterLink>
        <span class="environment-avatar environment-avatar--large">{{ environment.name.slice(0, 2) }}</span>
        <div class="environment-hero__copy">
          <div class="hero-title-row"><h2>{{ environment.name }}</h2><span class="hero-group">{{ environment.groupName || $t('未分组') }}</span></div>
          <p v-if="environment.description">{{ environment.description }}</p>
        </div>
      </div>
      <div class="environment-hero__actions"><span>{{ $t('更新于') }} {{ new Date(environment.updatedAt).toLocaleString($locale()) }}</span><el-button @click="openEnvironmentEdit"><Settings2 :size="16" />{{ $t('编辑环境') }}</el-button></div>
    </section>

    <nav v-if="!focusedWebView && !environmentImmersive" ref="workspaceTabsElement" class="workspace-tabs">
      <button :class="{ 'is-active': activeTab === 'web' }" @click="selectWorkspaceTab('web')"><Globe2 :size="17" />{{ $t('Web 入口') }} <small>{{ environment?.webCount || 0 }}</small></button>
      <button :class="{ 'is-active': activeTab === 'ssh' }" @pointerenter="preloadTabOnHover('ssh')" @focus="preloadTabOnIntent('ssh')" @touchstart.passive="preloadTabOnIntent('ssh')" @click="selectWorkspaceTab('ssh')"><TerminalSquare :size="17" />{{ $t('SSH 终端') }} <small>{{ environment?.sshCount || 0 }}</small></button>
      <button :class="{ 'is-active': activeTab === 'logs' }" @pointerenter="preloadTabOnHover('logs')" @focus="preloadTabOnIntent('logs')" @touchstart.passive="preloadTabOnIntent('logs')" @click="selectWorkspaceTab('logs')"><FileText :size="17" />{{ $t('日志') }} <small>{{ environment?.logCount || 0 }}</small></button>
      <button :class="{ 'is-active': activeTab === 'database' }" @pointerenter="preloadTabOnHover('database')" @pointerleave="cancelIntentPreload" @focus="preloadTabOnIntent('database')" @blur="cancelIntentPreload" @touchstart.passive="preloadTabOnIntent('database')" @click="selectWorkspaceTab('database')"><Database :size="17" />{{ $t('数据库') }} <small>{{ environment?.databaseCount || 0 }}</small></button>
      <button :class="{ 'is-active': activeTab === 'redis' }" @pointerenter="preloadTabOnHover('redis')" @focus="preloadTabOnIntent('redis')" @touchstart.passive="preloadTabOnIntent('redis')" @click="selectWorkspaceTab('redis')"><MemoryStick :size="17" />Redis <small>{{ environment?.redisCount || 0 }}</small></button>
      <button :class="{ 'is-active': activeTab === 'knowledge' }" @pointerenter="preloadTabOnHover('knowledge')" @focus="preloadTabOnIntent('knowledge')" @touchstart.passive="preloadTabOnIntent('knowledge')" @click="selectWorkspaceTab('knowledge')"><BookOpen :size="17" />{{ $t('知识库') }} <small>{{ environment?.knowledgeDocumentCount || 0 }}</small></button>
      <button :class="{ 'is-active': activeTab === 'maintenance' }" @pointerenter="preloadTabOnHover('maintenance')" @focus="preloadTabOnIntent('maintenance')" @touchstart.passive="preloadTabOnIntent('maintenance')" @click="selectWorkspaceTab('maintenance')"><Wrench :size="17" />{{ $t('服务维护') }} <small>{{ $t('服务') }} {{ environment?.serviceCount || 0 }} · {{ $t('主机') }} {{ environment?.monitorHostCount || 0 }}</small></button>
    </nav>

    <div class="environment-tab-stage">
      <section v-show="activeTab === 'web'" class="web-vault environment-tab-panel" :class="{ 'is-focused-web-view': focusedWebView, 'is-immersive-web-view': environmentImmersive }">
      <aside class="resource-list" :aria-label="$t('页面入口')">
        <div class="resource-list__items">
          <button
            v-for="entry in webEntries"
            :key="entry.id"
            class="resource-list__item"
            :class="{
              'is-active': selectedEntryId === entry.id,
              'is-dragging': draggingEntryId === entry.id,
              'is-drop-before': entryDropTarget?.id === entry.id && !entryDropTarget.after,
              'is-drop-after': entryDropTarget?.id === entry.id && entryDropTarget.after,
            }"
            :data-tab-id="entry.id"
            :title="entry.name"
            :aria-pressed="selectedEntryId === entry.id"
            :draggable="canSortTabs"
            @click="selectEntry(entry.id)"
            @dragstart="startEntryDrag(entry.id, $event)"
            @dragover="dragEntryOver(entry.id, $event)"
            @dragleave="leaveEntryDropTarget"
            @drop="dropEntry(entry.id, $event)"
            @dragend="endEntryDrag"
          >
            <span class="resource-list__icon"><img v-if="entryFavicons[entry.id]" :src="entryFavicons[entry.id]" alt="" @error="discardEntryFavicon(entry.id)" /><Globe2 v-else :size="17" /></span>
            <strong>{{ entry.name }}</strong>
            <span v-if="entry.tls" class="web-entry-tls" @click.stop>
              <TlsPopover :tls="entry.tls" :related-entries="relatedTlsEntries(entry)" @refreshed="loadEnvironment" />
            </span>
            <em>{{ entry.credentialCount }}</em>
          </button>
          <div v-if="!webEntries.length" class="list-empty"><Globe2 :size="20" /><span>{{ $t('还没有页面入口') }}</span></div>
          <button class="resource-list__add" type="button" :aria-label="$t('添加 Web 入口')" :title="$t('添加 Web 入口')" @click="openEntryCreate"><span><Plus :size="18" /></span></button>
        </div>
        <div class="resource-list__actions">
          <template v-if="selectedEntry">
            <button class="icon-action" :aria-label="$t('复制页面地址')" :title="$t('复制页面地址')" @click="copyText(selectedEntry.url, $t('页面地址'))"><Copy :size="15" /></button>
            <button class="icon-action" :aria-label="$t('编辑 Web 入口')" :title="$t('编辑 Web 入口')" @click="openEntryEdit(selectedEntry)"><Pencil :size="15" /></button>
            <button class="icon-action is-danger" :aria-label="$t('删除 Web 入口')" :title="$t('删除 Web 入口')" @click="removeEntry(selectedEntry)"><Trash2 :size="15" /></button>
          </template>
        </div>
      </aside>

      <main class="web-vault__main">
        <template v-if="selectedEntry">
          <section class="web-account-workspace">
            <aside class="web-account-list" :aria-label="$t('账号视角')">
              <div class="web-account-list__items">
                <article
                  v-for="credential in credentials"
                  :key="credential.id"
                  class="web-account-row"
                  :class="{
                    'is-selected': credentialSelected(credential.id),
                    'is-dragging': draggingCredentialId === credential.id,
                    'is-drop-before': credentialDropTarget?.id === credential.id && !credentialDropTarget.after,
                    'is-drop-after': credentialDropTarget?.id === credential.id && credentialDropTarget.after,
                  }"
                  :data-tab-id="credential.id"
                  @dragover="dragCredentialOver(credential.id, $event)"
                  @dragleave="leaveCredentialDropTarget"
                  @drop="dropCredential(credential.id, $event)"
                >
                  <button
                    class="web-account-row__main"
                    type="button"
                    :aria-pressed="credentialSelected(credential.id)"
                    :draggable="canSortTabs"
                    @click="selectCredential(credential.id, $event)"
                    @dragstart="startCredentialDrag(credential.id, $event)"
                    @dragend="endCredentialDrag"
                  >
                    <span class="admin-avatar">{{ credential.username.slice(0, 1).toUpperCase() }}</span>
                    <span class="web-account-row__identity">
                      <strong>{{ credential.username }}</strong>
                      <code v-if="credentialSelected(credential.id) && revealed[credential.id]">{{ revealed[credential.id] }}</code>
                    </span>
                  </button>
                  <div v-if="credentialSelected(credential.id)" class="web-account-row__actions">
                    <button v-if="!desktop" type="button" :aria-label="revealed[credential.id] ? $t('隐藏密码') : $t('显示密码')" :title="revealed[credential.id] ? $t('隐藏密码') : $t('显示密码')" @click="toggleReveal(credential)"><EyeOff v-if="revealed[credential.id]" :size="14" /><Eye v-else :size="14" /></button>
                    <button v-if="!desktop" type="button" :aria-label="$t('复制密码')" :title="$t('复制密码')" :disabled="!revealed[credential.id]" @click="copyText(revealed[credential.id], $t('密码'))"><Copy :size="14" /></button>
                    <button type="button" :aria-label="$t('编辑登录账号')" :title="$t('编辑登录账号')" @click="openCredentialEdit(credential)"><Pencil :size="14" /></button>
                    <button type="button" class="is-danger" :aria-label="$t('删除登录账号')" :title="$t('删除登录账号')" @click="removeCredential(credential)"><Trash2 :size="14" /></button>
                  </div>
                </article>
                <div v-if="!credentials.length" class="web-account-empty"><KeyRound :size="20" /><span>{{ $t('还没有登录账号') }}</span></div>
                <button class="web-account-list__add" type="button" :aria-label="$t('添加登录账号')" :title="$t('添加登录账号')" @click="openCredentialCreate"><span><Plus :size="18" /></span></button>
              </div>
            </aside>

            <div class="web-view-stage">
              <div class="web-view-grid">
                <article v-for="paneIndex in webPaneIndexes.slice(0, 1)" :key="paneIndex" class="web-view-pane is-active">
                  <template v-for="opened in paneOpenedCredentials[paneIndex]" :key="opened.id">
                    <DesktopWebAccountBrowser
                      v-if="desktop && webTarget === 'local'"
                      v-show="openedCredentialActive(paneIndex, opened)"
                      :environment-id="environmentId"
                      :credential-id="opened.id"
                      :username="opened.username"
                      :entry-url="webEntryUrl(opened.entryId)"
                      :active="openedCredentialActive(paneIndex, opened)"
                      :focused="environmentImmersive"
                      :preview="preview"
                      :auto-start="(focusedWebView || (webPreloadEnabled && webPreloadCredentialId === opened.id)) && openedCredentialActive(paneIndex, opened)"
                      :preload-start="webPreloadEnabled && webPreloadCredentialId === opened.id && !focusedWebView"
                      @focus-change="setFocusedWebView($event, opened)"
                      @preview-frame="emit('previewFrame', $event)"
                    />
                    <DesktopExecutionNotice v-else-if="desktop && webTarget === 'unavailable'" v-show="openedCredentialActive(paneIndex, opened)" :capability='$t("当前连接模式下 Web 账号浏览")' compact />
                    <WebAccountBrowser
                      v-else
                      v-show="openedCredentialActive(paneIndex, opened)"
                      :credential-id="opened.id"
                      :username="opened.username"
                      :entry-url="webEntryUrl(opened.entryId)"
                      :external-href="externalWebHref(opened.entryId, opened.id)"
                      :active="openedCredentialActive(paneIndex, opened)"
                      :focused="desktop ? environmentImmersive : undefined"
                      :auto-connect="(focusedWebView || (webPreloadEnabled && webPreloadCredentialId === opened.id)) && openedCredentialActive(paneIndex, opened)"
                      :preload-connect="webPreloadEnabled && webPreloadCredentialId === opened.id && !focusedWebView"
                      @focus-change="setFocusedWebView($event, opened)"
                    />
                  </template>
                  <div v-if="!credentialForPane(paneIndex)" class="web-view-pane__empty"><KeyRound :size="26" /><strong>{{ $t('选择一个账号') }}</strong><span>{{ $t('从上方账号列表载入此区域') }}</span></div>
                </article>
              </div>
            </div>
          </section>
        </template>
        <div v-else class="panel-empty panel-empty--large"><Globe2 :size="30" /><h3>{{ $t('选择或添加一个 Web 入口') }}</h3></div>
      </main>
      </section>

      <KeepAlive>
        <DesktopExecutionNotice v-if="desktop && sshTarget === 'unavailable' && activeTab === 'ssh'" class="environment-tab-panel" :capability='$t("当前连接模式下 SSH")' />
        <SshWorkbench v-else-if="activeTab === 'ssh'" class="environment-tab-panel" :environment-id="environmentId" :initial-connection-id="requestedConnectionId" :initial-mode="workspaceQuery.mode === 'sftp' ? 'sftp' : 'terminal'" :workspace-key="`fixed:environment:${environmentId}:ssh`" :local-execution="desktop && sshTarget === 'local'" :sftp-enabled="!desktop || sftpTarget !== 'unavailable'" :active="active" />
      </KeepAlive>

      <KeepAlive>
        <DesktopExecutionNotice v-if="desktop && databaseTarget === 'unavailable' && activeTab === 'database'" class="environment-tab-panel" :capability='$t("当前连接模式下数据库")' />
        <DatabaseWorkbench v-else-if="activeTab === 'database'" class="environment-tab-panel" :environment-id="environmentId" :initial-connection-id="requestedConnectionId" :workspace-key="`fixed:environment:${environmentId}:database`" :active="active" />
      </KeepAlive>

      <KeepAlive>
        <DesktopExecutionNotice v-if="desktop && redisTarget === 'unavailable' && activeTab === 'redis'" class="environment-tab-panel" :capability='$t("当前连接模式下 Redis")' />
        <RedisWorkbench v-else-if="activeTab === 'redis'" class="environment-tab-panel" :environment-id="environmentId" :initial-connection-id="requestedConnectionId" :workspace-key="`fixed:environment:${environmentId}:redis`" />
      </KeepAlive>

      <KeepAlive>
        <EnvironmentLogPanel v-if="activeTab === 'logs'" class="environment-tab-panel" :environment-id="environmentId" :execution-enabled="!desktop || logsTarget !== 'unavailable'" :local-execution="desktop && logsTarget === 'local'" :focus-log-id="logFocusRequest.id" :focus-request="logFocusRequest.sequence" :active="active" @count-change="updateLogCount" />
      </KeepAlive>

      <KeepAlive>
        <KnowledgeBasePanel v-if="activeTab === 'knowledge'" class="environment-tab-panel" :environment-id="environmentId" @count-change="updateKnowledgeDocumentCount" />
      </KeepAlive>

      <KeepAlive>
        <ServiceMaintenancePanel
          v-if="activeTab === 'maintenance'"
          class="environment-tab-panel"
          :environment-id="environmentId"
          :focus-host-id="workspaceQuery.maintenanceHostId || workspaceQuery.hostId"
          :focus-service-id="workspaceQuery.maintenanceServiceId || workspaceQuery.serviceId"
          :focus-deployment-id="workspaceQuery.maintenanceDeploymentId || workspaceQuery.deploymentId"
          :focus-endpoint-id="workspaceQuery.maintenanceEndpointId || workspaceQuery.endpointId"
          @count-change="updateServiceCount"
          @open-log="openServiceLog"
          @open-ssh="openServiceSsh"
        />
      </KeepAlive>
    </div>

    <el-dialog v-model="entryDialog" align-center class="envman-dialog" :title="editingEntryId ? $t('编辑 Web 入口') : $t('添加 Web 入口')" width="600px">
      <el-form label-position="top">
        <el-form-item :label="$t('入口名称')" required><el-input v-model="entryForm.name" :placeholder="$t('例如：管理控制台')" /></el-form-item>
        <el-form-item :label="$t('页面地址')" required><el-input v-model="entryForm.url" placeholder="https://console.example.com" /></el-form-item>
        <el-form-item :label="$t('说明')"><el-input v-model="entryForm.description" type="textarea" :rows="3" /></el-form-item>
        <el-form-item :label="$t('标签')"><el-input v-model="entryForm.tags" :placeholder="$t('多个标签用逗号分隔')" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="entryDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveEntry">{{ $t('保存入口') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="credentialDialog" align-center class="envman-dialog compact-dialog" :title="editingCredentialId ? $t('编辑登录账号') : $t('添加登录账号')" width="560px">
      <el-form label-position="top">
        <el-form-item :label="$t('用户名')" required><el-input v-model="credentialForm.username" /></el-form-item>
        <el-form-item :label="$t('密码')"><el-input v-model="credentialForm.password" type="password" show-password :placeholder="editingCredentialId ? $t('留空表示保持原密码') : ''" /></el-form-item>
        <el-form-item :label="$t('备注')"><el-input v-model="credentialForm.note" type="textarea" :rows="2" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="credentialDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveCredential">{{ $t('加密保存') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="environmentDialog" align-center class="envman-dialog" :title="$t('编辑环境')" width="620px">
      <el-form label-position="top" class="dialog-form-grid">
        <el-form-item :label="$t('环境名称')" required><el-input v-model="environmentForm.name" /></el-form-item>
        <el-form-item :label="$t('环境组')"><el-select v-model="environmentForm.groupId" clearable :placeholder="$t('未分组')" style="width:100%"><el-option v-for="group in groups" :key="group.id" :label="group.name" :value="group.id" /></el-select></el-form-item>
        <el-form-item :label="$t('标签')" class="form-span-2"><el-input v-model="environmentForm.tags" :placeholder="$t('多个标签用逗号分隔')" /></el-form-item>
        <el-form-item :label="$t('环境说明')" class="form-span-2"><el-input v-model="environmentForm.description" type="textarea" :rows="3" /></el-form-item>
      </el-form>
      <template #footer><div class="dialog-footer-actions"><el-button @click="environmentDialog = false">{{ $t('取消') }}</el-button><div><el-button type="danger" plain @click="removeEnvironment">{{ $t('删除环境') }}</el-button><el-button type="primary" :loading="saving" @click="saveEnvironment">{{ $t('保存修改') }}</el-button></div></div></template>
    </el-dialog>
  </div>
</template>
