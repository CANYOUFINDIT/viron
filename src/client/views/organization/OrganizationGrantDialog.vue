<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { ArrowLeft, ArrowRight, Boxes, Check, ChevronDown, ChevronRight, Database, EllipsisVertical, FolderTree, Globe2, MemoryStick, Search, Server, ShieldCheck, Star, TerminalSquare, X } from "@lucide/vue";
import { api } from "../../api";
import {
  ACTION_LABELS,
  CAPABILITIES,
  CAPABILITY_ACTIONS,
  CAPABILITY_LABELS,
  type Capability,
  connectionCapability,
} from "../../../shared/access-permissions";
import { expandActions, heavierActions } from "../../../shared/access-permissions";
import { useOrganizationContext } from "./context";

type Kind = "environment_group" | "environment" | "ssh_connection" | "database_connection" | "redis_connection";
type Family = "environment" | "ssh_connection" | "database_connection" | "redis_connection";
type DurationId = "1h" | "8h" | "1d" | "7d" | "30d" | "custom" | "forever";
type Step = "pick" | "permissions";
interface CatalogItem { id: string; name: string; environmentId?: string; environmentName: string }
interface ScopeGroup { environmentName: string; items: CatalogItem[] }
interface CatalogGroup { id: string; name: string; description: string; color: string }
interface CatalogEnvironment {
  id: string;
  name: string;
  alias: string;
  description: string;
  groupId: string | null;
  tags: string[];
  favorite: boolean;
  webCount: number;
  sshCount: number;
  databaseCount: number;
  redisCount: number;
  detailed: boolean;
}
interface CatalogConnection {
  id: string;
  type: "ssh" | "database" | "redis";
  name: string;
  host: string;
  port: number;
  username: string;
  engine: string;
  defaultDatabase: string;
  connectionGroupPath: string;
  tags: string[];
}
interface EnvironmentSection {
  id: string;
  name: string;
  color: string;
  canAuthorizeGroup: boolean;
  isFavorite: boolean;
  items: CatalogEnvironment[];
}
interface ConnectionSection { path: string; items: CatalogConnection[] }

const {
  currentOrganizationId, editingGrant, grantDialog, grantingResource, resources, saveGrant, selectedGrantTarget,
} = useOrganizationContext();

const step = ref<Step>("pick");
const kind = ref<Kind>("environment");
const groupId = ref("");
const wholeGroup = ref(false);
const targetIds = ref<string[]>([]);
const keyword = ref("");
const checked = reactive<Record<string, string[]>>({});
const itemMode = reactive<Record<string, "all" | "some">>({});
const pickedItems = reactive<Record<string, string[]>>({});
const duration = ref<DurationId>("8h");
const customEnd = ref("");
const catalog = ref<Record<string, CatalogItem[]>>({});
const catalogLoading = ref(false);
const hydrating = ref(false);
const pickerLoading = ref(false);
const pickerReady = ref(false);
const pickerGroups = ref<CatalogGroup[]>([]);
const pickerEnvironments = ref<CatalogEnvironment[]>([]);
const pickerConnections = ref<CatalogConnection[]>([]);
const collapsedGroupIds = ref(new Set<string>());
const collapsedConnectionPaths = ref(new Set<string>());
const activeGroup = ref("");
const sectionElements = new Map<string, HTMLElement>();
let pickerRequest = 0;
let catalogRequest = 0;

const durations: Array<{ id: DurationId; hours: number; label: string }> = [
  { id: "1h", hours: 1, label: "1 小时" },
  { id: "8h", hours: 8, label: "8 小时" },
  { id: "1d", hours: 24, label: "1 天" },
  { id: "7d", hours: 168, label: "7 天" },
  { id: "30d", hours: 720, label: "30 天" },
  { id: "custom", hours: 0, label: "自己指定结束时间" },
  { id: "forever", hours: 0, label: "永久" },
];
const families: Array<{ value: Family; label: string }> = [
  { value: "environment", label: "环境与环境组" },
  { value: "ssh_connection", label: "SSH 连接" },
  { value: "database_connection", label: "数据库连接" },
  { value: "redis_connection", label: "Redis 连接" },
];

const isConnection = computed(() => kind.value.endsWith("_connection"));
const activeFamily = computed<Family>(() => kind.value === "environment_group" ? "environment" : kind.value as Family);
const showItems = computed(() => !isConnection.value && !(kind.value === "environment_group" && wholeGroup.value) && targetIds.value.length > 0);
const visibleCapabilities = computed<Capability[]>(() => (
  isConnection.value
    ? [connectionCapability(kind.value as "ssh_connection" | "database_connection" | "redis_connection")]
    : [...CAPABILITIES]
));
const subject = computed(() => editingGrant.value
  ? { name: editingGrant.value.granteeName, project: editingGrant.value.granteeType === "project" }
  : selectedGrantTarget.value
    ? { name: selectedGrantTarget.value.name, project: selectedGrantTarget.value.type === "project" }
    : null);
const searchPlaceholder = computed(() => {
  if (activeFamily.value === "ssh_connection") return "搜索主机或标签";
  if (activeFamily.value === "database_connection") return "搜索数据库连接";
  if (activeFamily.value === "redis_connection") return "搜索 Redis 连接";
  return "搜索环境名称、别称或标签";
});

const catalogGroupSource = computed(() => pickerReady.value ? pickerGroups.value : resources.value
  .filter((item) => item.type === "environment_group")
  .map((item) => ({ id: item.id, name: item.name, description: "", color: "#7d8891" })));
const catalogEnvironmentSource = computed(() => pickerReady.value ? pickerEnvironments.value : resources.value
  .filter((item) => item.type === "environment")
  .map((item) => ({
    id: item.id,
    name: item.name,
    alias: "",
    description: "",
    groupId: item.groupId ?? null,
    tags: [],
    favorite: false,
    webCount: 0,
    sshCount: 0,
    databaseCount: 0,
    redisCount: 0,
    detailed: false,
  })));
const catalogConnectionSource = computed(() => pickerReady.value ? pickerConnections.value : resources.value
  .filter((item) => item.type.endsWith("_connection"))
  .map((item) => ({
    id: item.id,
    type: item.type.replace(/_connection$/, "") as CatalogConnection["type"],
    name: item.name,
    host: "",
    port: 0,
    username: "",
    engine: "",
    defaultDatabase: "",
    connectionGroupPath: "",
    tags: [],
  })));

const environmentSections = computed<EnvironmentSection[]>(() => {
  const query = keyword.value.trim().toLowerCase();
  const groups = catalogGroupSource.value;
  const knownGroups = new Set(groups.map((group) => group.id));
  const environments = catalogEnvironmentSource.value;
  const sections: EnvironmentSection[] = [];
  const favorites = environments.filter((item) => item.favorite && (!query || environmentMatches(item, query)));
  if (!query || favorites.length) {
    sections.push({ id: "favorites", name: "收藏", color: "#d49a2a", canAuthorizeGroup: false, isFavorite: true, items: favorites });
  }
  for (const group of groups) {
    const members = environments.filter((item) => item.groupId === group.id);
    const groupMatches = !query || `${group.name} ${group.description}`.toLowerCase().includes(query);
    const items = groupMatches ? members : members.filter((item) => environmentMatches(item, query));
    if (query && !items.length) continue;
    sections.push({
      id: group.id,
      name: group.name,
      color: group.color || "#7d8891",
      canAuthorizeGroup: true,
      isFavorite: false,
      items,
    });
  }
  const ungrouped = environments.filter((item) => !item.groupId || !knownGroups.has(item.groupId));
  const ungroupedItems = query ? ungrouped.filter((item) => environmentMatches(item, query)) : ungrouped;
  if (!query || ungroupedItems.length) {
    sections.push({ id: "ungrouped", name: "未分组", color: "#7d8891", canAuthorizeGroup: false, isFavorite: false, items: ungroupedItems });
  }
  return sections;
});
const connectionSections = computed<ConnectionSection[]>(() => {
  const query = keyword.value.trim().toLowerCase();
  const type = activeFamily.value === "ssh_connection" ? "ssh" : activeFamily.value === "database_connection" ? "database" : "redis";
  const items = catalogConnectionSource.value.filter((item) => item.type === type);
  const grouped = new Map<string, CatalogConnection[]>();
  for (const item of items) {
    const path = item.connectionGroupPath || "";
    const pathMatches = Boolean(query) && path.toLowerCase().includes(query);
    if (query && !pathMatches && !connectionMatches(item, query)) continue;
    const bucket = grouped.get(path) ?? [];
    bucket.push(item);
    grouped.set(path, bucket);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => {
      if (!left) return 1;
      if (!right) return -1;
      return left.localeCompare(right, "zh-CN");
    })
    .map(([path, sectionItems]) => ({ path, items: sectionItems }));
});
const pickerEmpty = computed(() => activeFamily.value === "environment"
  ? !environmentSections.value.some((section) => section.items.length)
  : connectionSections.value.length === 0);
const emptyLabel = computed(() => {
  if (keyword.value.trim()) return activeFamily.value === "environment" ? "没有匹配的环境" : "没有匹配的连接";
  if (activeFamily.value === "ssh_connection") return "没有可用 SSH 连接";
  if (activeFamily.value === "database_connection") return "还没有数据库连接";
  if (activeFamily.value === "redis_connection") return "还没有 Redis 连接";
  return "还没有环境";
});
const targetsOk = computed(() => (
  kind.value === "environment_group"
    ? Boolean(groupId.value) && wholeGroup.value
    : targetIds.value.length > 0
));
const selectionSummary = computed(() => {
  if (kind.value === "environment_group" && wholeGroup.value && groupId.value) {
    return { title: resourceName(groupId.value, "environment_group"), detailKey: "整个组，以后新加的环境也算", detailValues: [] as unknown[] };
  }
  if (kind.value === "environment" && targetIds.value.length) {
    return {
      title: joinNames(targetIds.value.map((id) => resourceName(id, "environment"))),
      detailKey: "已选 {0} 个环境",
      detailValues: [targetIds.value.length],
    };
  }
  if (isConnection.value && targetIds.value.length) {
    return {
      title: joinNames(targetIds.value.map((id) => resourceName(id, kind.value))),
      detailKey: "已选 {0} 个连接",
      detailValues: [targetIds.value.length],
    };
  }
  return null;
});

function environmentMatches(item: CatalogEnvironment, query: string) {
  return [item.name, item.alias, item.description, ...item.tags].join("\n").toLowerCase().includes(query);
}

function connectionMatches(item: CatalogConnection, query: string) {
  return [item.name, item.username, item.host, item.engine, item.connectionGroupPath, ...item.tags].join("\n").toLowerCase().includes(query);
}

function resourceName(id: string, type: Kind) {
  const detailed = type === "environment_group"
    ? catalogGroupSource.value.find((item) => item.id === id)?.name
    : type === "environment"
      ? catalogEnvironmentSource.value.find((item) => item.id === id)?.name
      : catalogConnectionSource.value.find((item) => item.id === id)?.name;
  return detailed || resources.value.find((item) => item.type === type && item.id === id)?.name || id;
}

function joinNames(names: string[]) {
  if (names.length <= 3) return names.join("、");
  return `${names.slice(0, 3).join("、")} +${names.length - 3}`;
}

function environmentTitle(item: CatalogEnvironment) {
  return item.alias.trim() || item.name;
}

function environmentAccent(item: CatalogEnvironment, section: EnvironmentSection) {
  if (!section.isFavorite) return section.color;
  return catalogGroupSource.value.find((group) => group.id === item.groupId)?.color || "#7d8891";
}

function sectionLabel(section: EnvironmentSection) {
  return section.isFavorite || section.id === "ungrouped";
}

function connectionEndpoint(item: CatalogConnection) {
  if (!item.host) return "";
  const identity = item.username ? `${item.username}@${item.host}` : item.host;
  const engine = item.type === "database" && item.engine ? `${item.engine.toUpperCase()} · ` : "";
  const database = item.type === "redis" && item.defaultDatabase !== "" ? ` · DB ${item.defaultDatabase}` : "";
  return `${engine}${identity}:${item.port}${database}`;
}

function blankChecks() {
  for (const capability of CAPABILITIES) {
    checked[capability] = [];
    itemMode[capability] = "all";
    pickedItems[capability] = [];
  }
}

function toLocalInput(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function applyGrant() {
  hydrating.value = true;
  const grant = editingGrant.value;
  blankChecks();
  catalog.value = {};
  keyword.value = "";
  collapsedGroupIds.value = new Set();
  collapsedConnectionPaths.value = new Set();
  step.value = "pick";
  if (!grant) {
    kind.value = "environment";
    groupId.value = "";
    wholeGroup.value = false;
    targetIds.value = [];
    duration.value = "8h";
    customEnd.value = "";
    focusDirectory();
    hydrating.value = false;
    return;
  }
  kind.value = grant.wholeGroup ? "environment_group" : grant.scopeKind;
  groupId.value = grant.groupId ?? "";
  wholeGroup.value = grant.wholeGroup;
  targetIds.value = [...grant.targetIds];
  for (const capability of CAPABILITIES) {
    checked[capability] = [...(grant.permissions[capability] ?? [])];
    pickedItems[capability] = [...(grant.items[capability] ?? [])];
    itemMode[capability] = grant.items[capability]?.length ? "some" : "all";
  }
  if (!grant.expiresAt) {
    duration.value = "forever";
    customEnd.value = "";
  } else {
    duration.value = "custom";
    customEnd.value = toLocalInput(grant.expiresAt);
  }
  focusDirectory();
  hydrating.value = false;
}

function focusDirectory() {
  activeGroup.value = environmentSections.value[0]?.id ?? "";
}

function normalizeGroup(item: { id?: string; name?: string; description?: string; color?: string }): CatalogGroup | null {
  if (!item.id || !item.name) return null;
  return { id: item.id, name: item.name, description: item.description ?? "", color: item.color || "#7d8891" };
}

function normalizeEnvironment(item: Partial<CatalogEnvironment> & { id?: string; name?: string }): CatalogEnvironment | null {
  if (!item.id || !item.name) return null;
  return {
    id: item.id,
    name: item.name,
    alias: item.alias ?? "",
    description: item.description ?? "",
    groupId: item.groupId ?? null,
    tags: Array.isArray(item.tags) ? item.tags : [],
    favorite: Boolean(item.favorite),
    webCount: Number(item.webCount ?? 0),
    sshCount: Number(item.sshCount ?? 0),
    databaseCount: Number(item.databaseCount ?? 0),
    redisCount: Number(item.redisCount ?? 0),
    detailed: true,
  };
}

function normalizeConnection(item: Partial<CatalogConnection> & { id?: string; name?: string; type?: string }): CatalogConnection | null {
  if (!item.id || !item.name || (item.type !== "ssh" && item.type !== "database" && item.type !== "redis")) return null;
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    host: item.host ?? "",
    port: Number(item.port ?? 0),
    username: item.username ?? "",
    engine: item.engine ?? "",
    defaultDatabase: item.defaultDatabase == null ? "" : String(item.defaultDatabase),
    connectionGroupPath: item.connectionGroupPath ?? "",
    tags: Array.isArray(item.tags) ? item.tags : [],
  };
}

async function loadPicker() {
  const requestId = ++pickerRequest;
  pickerLoading.value = true;
  try {
    const [groups, environments, connections] = await Promise.all([
      api<{ items?: Array<{ id?: string; name?: string; description?: string; color?: string }> }>("/api/v1/environment-groups"),
      api<{ items?: Array<Partial<CatalogEnvironment> & { id?: string; name?: string }> }>("/api/v1/environments"),
      api<{ items?: Array<Partial<CatalogConnection> & { id?: string; name?: string; type?: string }> }>("/api/v1/connections"),
    ]);
    if (requestId !== pickerRequest) return;
    if (!Array.isArray(groups.items) || !Array.isArray(environments.items) || !Array.isArray(connections.items)) return;
    pickerGroups.value = groups.items.map(normalizeGroup).filter((item): item is CatalogGroup => Boolean(item));
    pickerEnvironments.value = environments.items.map(normalizeEnvironment).filter((item): item is CatalogEnvironment => Boolean(item));
    pickerConnections.value = connections.items.map(normalizeConnection).filter((item): item is CatalogConnection => Boolean(item));
    pickerReady.value = true;
  } catch {
    return;
  } finally {
    if (requestId === pickerRequest) pickerLoading.value = false;
  }
}

watch(grantDialog, (open) => {
  if (!open) return;
  applyGrant();
  void loadPicker();
}, { immediate: true });
watch(environmentSections, (sections) => {
  if (!sections.some((section) => section.id === activeGroup.value)) activeGroup.value = sections[0]?.id ?? "";
}, { immediate: true });
watch([targetIds, wholeGroup, kind], () => { void loadCatalog(); });

async function loadCatalog() {
  const requestId = ++catalogRequest;
  if (!showItems.value || !currentOrganizationId.value) {
    catalog.value = {};
    catalogLoading.value = false;
    return;
  }
  catalogLoading.value = true;
  try {
    const next = await api<Record<string, CatalogItem[]>>(`/api/v1/organizations/${currentOrganizationId.value}/grant-catalog?environmentIds=${encodeURIComponent(targetIds.value.join(","))}`);
    if (requestId !== catalogRequest) return;
    catalog.value = next && typeof next === "object" ? next : {};
  } catch {
    if (requestId !== catalogRequest) return;
    catalog.value = {};
  } finally {
    if (requestId === catalogRequest) catalogLoading.value = false;
  }
}

function scopeItems(capability: string) {
  const seen = new Set<string>();
  const items: CatalogItem[] = [];
  for (const item of catalog.value[capability] ?? []) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

function scopeGroups(capability: string): ScopeGroup[] {
  const nameById = new Map(catalogEnvironmentSource.value.map((item) => [item.id, item.name]));
  const groups = new Map<string, CatalogItem[]>();
  for (const id of targetIds.value) {
    const name = nameById.get(id);
    if (name) groups.set(name, groups.get(name) ?? []);
  }
  for (const item of scopeItems(capability)) {
    const name = item.environmentName || "";
    const bucket = groups.get(name) ?? [];
    bucket.push(item);
    groups.set(name, bucket);
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length)
    .map(([environmentName, items]) => ({ environmentName, items }));
}

function scopePickedCount(capability: string) {
  const ids = new Set(scopeItems(capability).map((item) => item.id));
  return (pickedItems[capability] ?? []).filter((id) => ids.has(id)).length;
}

function chooseFamily(next: Family) {
  if (activeFamily.value === next || hydrating.value) return;
  kind.value = next;
  groupId.value = "";
  wholeGroup.value = false;
  targetIds.value = [];
  keyword.value = "";
  collapsedGroupIds.value = new Set();
  collapsedConnectionPaths.value = new Set();
  focusDirectory();
}

function setSectionRef(element: unknown, id: string) {
  if (element instanceof HTMLElement) sectionElements.set(id, element);
  else if (!element) sectionElements.delete(id);
}

function toggleCollapsedGroup(id: string) {
  const next = new Set(collapsedGroupIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedGroupIds.value = next;
}

async function scrollToGroup(id: string) {
  activeGroup.value = id;
  if (collapsedGroupIds.value.has(id)) {
    const next = new Set(collapsedGroupIds.value);
    next.delete(id);
    collapsedGroupIds.value = next;
    await nextTick();
  }
  sectionElements.get(id)?.scrollIntoView({ block: "nearest" });
}

function connectionGroupOpen(path: string) {
  return !collapsedConnectionPaths.value.has(path);
}

function toggleConnectionGroup(path: string) {
  const next = new Set(collapsedConnectionPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsedConnectionPaths.value = next;
}

function groupSelected(id: string) {
  return kind.value === "environment_group" && wholeGroup.value && groupId.value === id;
}

function environmentSelected(id: string) {
  return kind.value === "environment" && targetIds.value.includes(id);
}

function selectWholeGroup(id: string) {
  if (groupSelected(id)) {
    kind.value = "environment";
    groupId.value = "";
    wholeGroup.value = false;
    targetIds.value = [];
    return;
  }
  kind.value = "environment_group";
  groupId.value = id;
  wholeGroup.value = true;
  targetIds.value = [];
}

function toggleEnvironment(id: string) {
  if (kind.value !== "environment" || wholeGroup.value) {
    kind.value = "environment";
    groupId.value = "";
    wholeGroup.value = false;
    targetIds.value = [id];
    return;
  }
  const next = new Set(targetIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  targetIds.value = [...next];
}

function connectionSelected(id: string) {
  return isConnection.value && targetIds.value.includes(id);
}

function toggleConnection(id: string) {
  if (!isConnection.value) return;
  const next = new Set(targetIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  targetIds.value = [...next];
}

function sectionFullySelected(items: CatalogConnection[]) {
  return items.length > 0 && items.every((item) => targetIds.value.includes(item.id));
}

function toggleConnectionSection(items: CatalogConnection[]) {
  if (!isConnection.value) return;
  const ids = items.map((item) => item.id);
  if (sectionFullySelected(items)) {
    const remove = new Set(ids);
    targetIds.value = targetIds.value.filter((id) => !remove.has(id));
    return;
  }
  targetIds.value = [...new Set([...targetIds.value, ...ids])];
}

function isChecked(capability: string, action: string) {
  return (checked[capability] ?? []).includes(action);
}

function toggleAction(capability: Capability, action: string, on: boolean) {
  const next = new Set(checked[capability] ?? []);
  if (on) for (const item of expandActions(capability, [action])) next.add(item);
  else {
    next.delete(action);
    for (const item of heavierActions(capability, action)) next.delete(item);
  }
  checked[capability] = CAPABILITY_ACTIONS[capability].filter((item) => next.has(item));
}

function toggleItem(capability: string, id: string, on: boolean) {
  const next = new Set(pickedItems[capability] ?? []);
  if (on) next.add(id);
  else next.delete(id);
  pickedItems[capability] = [...next];
}

function expiryValue() {
  if (duration.value === "forever") return null;
  if (duration.value === "custom") {
    const parsed = Date.parse(customEnd.value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
  }
  const hours = durations.find((item) => item.id === duration.value)?.hours ?? 8;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

const canSave = computed(() => {
  const selected = visibleCapabilities.value.some((capability) => (checked[capability] ?? []).length);
  const itemsOk = visibleCapabilities.value.every((capability) => (
    !(checked[capability] ?? []).length || !showItems.value || itemMode[capability] !== "some" || (pickedItems[capability] ?? []).length > 0
  ));
  return selected && targetsOk.value && itemsOk && expiryValue() !== "";
});

function continueToPermissions() {
  if (!targetsOk.value) return;
  step.value = "permissions";
}

function submit() {
  if (step.value !== "permissions" || !canSave.value || grantingResource.value) return;
  const permissions: Record<string, string[]> = {};
  const items: Record<string, string[]> = {};
  for (const capability of visibleCapabilities.value) {
    if (!(checked[capability] ?? []).length) continue;
    permissions[capability] = checked[capability]!;
    if (showItems.value && itemMode[capability] === "some") items[capability] = pickedItems[capability] ?? [];
  }
  const scopeKind: Kind = kind.value === "environment_group" && !wholeGroup.value ? "environment" : kind.value;
  void saveGrant({
    scopeKind,
    wholeGroup: kind.value === "environment_group" && wholeGroup.value,
    groupId: kind.value === "environment_group" && wholeGroup.value ? groupId.value : null,
    targetIds: kind.value === "environment_group" && wholeGroup.value ? [] : [...targetIds.value],
    permissions,
    items,
    expiresAt: expiryValue(),
  });
}
</script>

<template>
  <el-dialog append-to-body v-model="grantDialog" align-center class="envman-dialog grant-auth-dialog" :title="editingGrant ? $t('修改授权') : $t('授权资源')" width="min(1280px, calc(100vw - 32px))" @closed="editingGrant = null">
    <div v-if="subject" class="dialog-subject">
      <span class="dialog-subject__icon"><ShieldCheck :size="18" /></span>
      <div>
        <small>{{ $t('授权对象') }}</small>
        <strong>{{ subject.name }}</strong>
        <p>{{ subject.project ? $t('项目组及其子项目组会继承这项授权') : $t('仅授权给该成员个人') }}</p>
      </div>
    </div>

    <el-form label-position="top" @submit.prevent="submit">
      <template v-if="step === 'pick'">
        <div class="grant-kind-switch" role="tablist" :aria-label="$t('资源类型')">
          <button v-for="item in families" :key="item.value" type="button" role="tab" :aria-selected="activeFamily === item.value" :class="{ 'is-active': activeFamily === item.value }" @click="chooseFamily(item.value)">{{ $t(item.label) }}</button>
        </div>
        <el-input v-model="keyword" clearable :placeholder="$t(searchPlaceholder)">
          <template #prefix><Search :size="15" /></template>
        </el-input>

        <div v-if="activeFamily === 'environment'" class="grant-overview" :aria-label="$t('环境总览')" v-loading="pickerLoading && !pickerReady">
          <div v-if="pickerLoading && !pickerReady" class="grant-picker-empty"></div>
          <div v-else-if="environmentSections.length" class="overview-directory-layout">
            <aside class="environment-directory" :aria-label="$t('环境目录')">
              <div class="environment-directory__title"><Boxes :size="16" /><strong>{{ $t('环境目录') }}</strong><small>{{ catalogEnvironmentSource.length }}</small></div>
              <nav>
                <button v-for="section in environmentSections" :key="section.id" type="button" class="environment-directory__link" :class="{ 'is-active': activeGroup === section.id }" @click="scrollToGroup(section.id)">
                  <span class="group-color" :style="{ background: section.color }"></span>
                  <span>{{ sectionLabel(section) ? $t(section.name) : section.name }}</span>
                  <small>{{ section.items.length }}</small>
                </button>
              </nav>
            </aside>
            <main class="environment-sections">
              <section v-for="section in environmentSections" :key="section.id" :ref="(element) => setSectionRef(element, section.id)" class="environment-section" :class="{ 'is-favorites': section.isFavorite, 'is-collapsed': collapsedGroupIds.has(section.id), 'is-whole-group': groupSelected(section.id) }">
                <header>
                  <button class="section-toggle" type="button" :aria-expanded="!collapsedGroupIds.has(section.id)" @click="toggleCollapsedGroup(section.id)">
                    <ChevronDown :size="16" :class="{ 'is-collapsed': collapsedGroupIds.has(section.id) }" />
                    <span class="group-color" :style="{ background: section.color }"></span>
                    <h3>{{ sectionLabel(section) ? $t(section.name) : section.name }}</h3>
                    <small>{{ section.items.length }} {{ $t('个环境') }}</small>
                  </button>
                  <button v-if="section.canAuthorizeGroup" type="button" class="grant-whole-group" :class="{ 'is-active': groupSelected(section.id) }" :aria-pressed="groupSelected(section.id)" :title="$t('整个组，以后新加的环境也算')" @click="selectWholeGroup(section.id)">{{ $t('整个组') }}</button>
                </header>
                <template v-if="!collapsedGroupIds.has(section.id)">
                  <div v-if="section.items.length" class="environment-grid">
                    <article v-for="item in section.items" :key="item.id" class="environment-card-shell">
                      <button type="button" class="environment-card" :class="{ 'is-selected': environmentSelected(item.id) }" :style="{ '--environment-card-accent': environmentAccent(item, section) }" :aria-pressed="environmentSelected(item.id)" @click="toggleEnvironment(item.id)">
                        <div class="environment-browser__chrome">
                          <div class="environment-browser__windowbar">
                            <span class="environment-browser__tab">
                              <i></i>
                              <strong :title="environmentTitle(item)">{{ environmentTitle(item) }}</strong>
                              <X class="environment-browser__tab-close" :size="11" aria-hidden="true" />
                            </span>
                            <Check v-if="environmentSelected(item.id)" class="grant-card-check" :size="16" />
                          </div>
                          <div class="environment-browser__toolbar">
                            <ArrowLeft :size="14" class="is-muted" aria-hidden="true" />
                            <ArrowRight :size="14" class="is-muted" aria-hidden="true" />
                            <span class="environment-browser__address"><i></i><strong>{{ item.name }}</strong></span>
                            <span class="grant-card-star" :class="{ 'is-favorite': item.favorite }"><Star :size="13" :fill="item.favorite ? 'currentColor' : 'none'" aria-hidden="true" /></span>
                            <EllipsisVertical :size="14" aria-hidden="true" />
                          </div>
                        </div>
                        <div class="environment-browser__page">
                          <div class="environment-browser__summary">
                            <span class="environment-avatar">{{ item.name.slice(0, 2) }}</span>
                            <p class="environment-card__description">{{ item.description || $t('暂无环境说明') }}</p>
                          </div>
                          <div class="resource-counts" :aria-label="$t('环境资源数量')">
                            <span :title="$t('{0} 个 Web 入口', [item.webCount])"><Globe2 :size="14" aria-hidden="true" /><strong>{{ item.webCount }}</strong><small>Web</small></span>
                            <span :title="$t('{0} 个 SSH 连接', [item.sshCount])"><TerminalSquare :size="14" aria-hidden="true" /><strong>{{ item.sshCount }}</strong><small>SSH</small></span>
                            <span :title="$t('{0} 个数据库连接', [item.databaseCount])"><Database :size="14" aria-hidden="true" /><strong>{{ item.databaseCount }}</strong><small>{{ $t('数据库') }}</small></span>
                            <span :title="$t('{0} 个 Redis 连接', [item.redisCount])"><MemoryStick :size="14" aria-hidden="true" /><strong>{{ item.redisCount }}</strong><small>Redis</small></span>
                          </div>
                        </div>
                      </button>
                    </article>
                  </div>
                  <div v-else class="environment-group-empty">
                    <Server :size="20" />
                    <span>{{ section.isFavorite ? (keyword.trim() ? $t('当前筛选下没有收藏环境') : $t('暂无收藏环境')) : (keyword.trim() ? $t('当前筛选下没有环境') : $t('暂无环境')) }}</span>
                  </div>
                </template>
              </section>
            </main>
          </div>
          <div v-else class="grant-picker-empty">
            <Search v-if="keyword.trim()" :size="20" />
            <Server v-else :size="20" />
            <span>{{ $t(emptyLabel) }}</span>
          </div>
        </div>

        <div v-else-if="activeFamily === 'ssh_connection'" class="ssh-workbench grant-ssh-list" :aria-label="$t('SSH 连接')" v-loading="pickerLoading && !pickerReady">
          <div v-if="pickerLoading && !pickerReady" class="grant-picker-empty"></div>
          <aside v-else class="ssh-hosts">
            <div class="ssh-host-list">
              <section v-for="section in connectionSections" :key="section.path || 'ungrouped'" class="workbench-connection-group">
                <div class="grant-workbench-head">
                  <button class="workbench-group-toggle" type="button" :aria-expanded="connectionGroupOpen(section.path)" @click="toggleConnectionGroup(section.path)"><ChevronDown v-if="connectionGroupOpen(section.path)" :size="14" /><ChevronRight v-else :size="14" /><FolderTree :size="13" /><span>{{ section.path || $t('未分组') }}</span><em>{{ section.items.length }}</em></button>
                  <button type="button" class="grant-whole-group" :class="{ 'is-active': sectionFullySelected(section.items) }" :aria-pressed="sectionFullySelected(section.items)" @click="toggleConnectionSection(section.items)">{{ $t('全选') }}</button>
                </div>
                <div v-for="item in connectionGroupOpen(section.path) ? section.items : []" :key="item.id" class="ssh-host-card" :class="{ 'is-selected': connectionSelected(item.id) }">
                  <button class="connection-card-main" type="button" :aria-pressed="connectionSelected(item.id)" @click="toggleConnection(item.id)">
                    <span class="ssh-host-card__icon"><Server :size="16" /></span>
                    <span class="ssh-host-card__details">
                      <strong>{{ item.name }}</strong>
                      <small v-if="connectionEndpoint(item)" class="ssh-host-card__endpoint"><em v-if="item.username">{{ item.username }}@</em><span>{{ item.host }}:{{ item.port }}</span></small>
                      <span v-if="item.tags.length" class="ssh-host-tags"><i v-for="tag in item.tags.slice(0, 3)" :key="tag">{{ tag }}</i></span>
                    </span>
                  </button>
                  <Check v-if="connectionSelected(item.id)" class="grant-host-check" :size="15" />
                </div>
              </section>
              <div v-if="pickerEmpty" class="sidebar-empty"><Search v-if="keyword.trim()" :size="20" /><Server v-else :size="22" /><span>{{ $t(emptyLabel) }}</span></div>
            </div>
          </aside>
        </div>

        <div v-else-if="activeFamily === 'database_connection'" class="database-navigator grant-db-list" :aria-label="$t('数据库连接')" v-loading="pickerLoading && !pickerReady">
          <div v-if="pickerLoading && !pickerReady" class="grant-picker-empty"></div>
          <div v-else class="database-navigation-tree">
            <section v-for="section in connectionSections" :key="section.path || 'ungrouped'" class="database-navigation-group">
              <div class="grant-workbench-head">
                <button class="database-navigation-group-toggle" type="button" :aria-expanded="connectionGroupOpen(section.path)" @click="toggleConnectionGroup(section.path)"><ChevronDown v-if="connectionGroupOpen(section.path)" :size="12" /><ChevronRight v-else :size="12" /><FolderTree :size="13" /><span>{{ section.path || $t('未分组') }}</span></button>
                <button type="button" class="grant-whole-group" :class="{ 'is-active': sectionFullySelected(section.items) }" :aria-pressed="sectionFullySelected(section.items)" @click="toggleConnectionSection(section.items)">{{ $t('全选') }}</button>
              </div>
              <div v-for="item in connectionGroupOpen(section.path) ? section.items : []" :key="item.id" class="database-navigation-connection-row" :class="{ 'is-selected': connectionSelected(item.id) }">
                <span class="database-navigation-placeholder"></span>
                <button class="database-navigation-connection" type="button" :aria-pressed="connectionSelected(item.id)" :title="connectionEndpoint(item) || item.name" @click="toggleConnection(item.id)">
                  <Database :size="14" />
                  <span class="database-navigation-connection-label">{{ item.name }}</span>
                  <Check v-if="connectionSelected(item.id)" :size="13" />
                  <span v-else></span>
                  <i></i>
                </button>
              </div>
            </section>
            <div v-if="pickerEmpty" class="sidebar-empty"><Search v-if="keyword.trim()" :size="20" /><Database v-else :size="22" /><span>{{ $t(emptyLabel) }}</span></div>
          </div>
        </div>

        <div v-else class="grant-redis-list" :aria-label="$t('Redis 连接')" v-loading="pickerLoading && !pickerReady">
          <div v-if="pickerLoading && !pickerReady" class="grant-picker-empty"></div>
          <div v-else class="redis-connection-list">
            <section v-for="section in connectionSections" :key="section.path || 'ungrouped'">
              <h4>
                <button type="button" @click="toggleConnectionGroup(section.path)"><ChevronDown v-if="connectionGroupOpen(section.path)" :size="13" /><ChevronRight v-else :size="13" /><FolderTree :size="13" /><span>{{ section.path || $t('未分组') }}</span></button>
                <small>{{ section.items.length }}</small>
                <button type="button" class="grant-whole-group" :class="{ 'is-active': sectionFullySelected(section.items) }" :aria-pressed="sectionFullySelected(section.items)" @click="toggleConnectionSection(section.items)">{{ $t('全选') }}</button>
              </h4>
              <button v-for="item in connectionGroupOpen(section.path) ? section.items : []" :key="item.id" type="button" :class="{ 'is-active': connectionSelected(item.id) }" :aria-pressed="connectionSelected(item.id)" @click="toggleConnection(item.id)">
                <span class="redis-connection-icon"><MemoryStick :size="14" /></span>
                <div>
                  <strong>{{ item.name }}</strong>
                  <small v-if="connectionEndpoint(item)">{{ connectionEndpoint(item) }}</small>
                </div>
                <Check v-if="connectionSelected(item.id)" :size="14" />
              </button>
            </section>
            <div v-if="pickerEmpty" class="grant-picker-empty"><Search v-if="keyword.trim()" :size="20" /><MemoryStick v-else :size="20" /><span>{{ $t(emptyLabel) }}</span></div>
          </div>
        </div>

        <p v-if="selectionSummary" class="grant-pick-summary"><strong>{{ selectionSummary.title }}</strong><small>{{ $t(selectionSummary.detailKey, selectionSummary.detailValues) }}</small></p>
        <p v-else class="grant-pick-summary is-empty">{{ $t('从列表里选择要授权的环境或连接') }}</p>
      </template>

      <template v-else>
        <div v-if="selectionSummary" class="grant-selection-bar">
          <div>
            <small>{{ $t('授权资源') }}</small>
            <strong>{{ selectionSummary.title }}</strong>
            <span>{{ $t(selectionSummary.detailKey, selectionSummary.detailValues) }}</span>
          </div>
        </div>

        <div class="grant-matrix" :class="{ 'is-connection': isConnection }" role="table" :aria-label="$t('操作权限')">
          <div class="grant-matrix__head" role="row"><span>{{ $t('资源') }}</span><span>{{ $t('操作') }}</span><span v-if="!isConnection">{{ $t('范围') }}</span></div>
          <div v-for="capability in visibleCapabilities" :key="capability" class="grant-matrix__row" role="row">
            <strong>{{ $t(CAPABILITY_LABELS[capability]) }}</strong>
            <div class="grant-matrix__actions">
              <label v-for="action in CAPABILITY_ACTIONS[capability]" :key="action">
                <input type="checkbox" :checked="isChecked(capability, action)" @change="toggleAction(capability, action, ($event.target as HTMLInputElement).checked)">
                <span>{{ $t((ACTION_LABELS[capability] as Record<string, string>)[action]) }}</span>
              </label>
            </div>
            <div v-if="!isConnection" class="grant-matrix__scope">
              <template v-if="showItems && (checked[capability] ?? []).length">
                <div class="grant-scope-choice" role="radiogroup" :aria-label="$t('范围')">
                  <button type="button" role="radio" :aria-checked="itemMode[capability] !== 'some'" :class="{ 'is-active': itemMode[capability] !== 'some' }" :title="$t('以后新增的也算')" @click="itemMode[capability] = 'all'">{{ $t('全部') }}</button>
                  <button type="button" role="radio" :aria-checked="itemMode[capability] === 'some'" :class="{ 'is-active': itemMode[capability] === 'some' }" :title="$t('只包含勾选的这些')" @click="itemMode[capability] = 'some'">{{ $t('指定') }}</button>
                </div>
                <div v-if="itemMode[capability] === 'some'" class="grant-scope-panel">
                  <p v-if="catalogLoading" class="grant-scope-note">{{ $t('正在读取可选项') }}</p>
                  <template v-else-if="scopeItems(capability).length">
                    <p class="grant-scope-meta">
                      <span>{{ $t('已选 {0}/{1}', [scopePickedCount(capability), scopeItems(capability).length]) }}</span>
                      <span v-if="!scopePickedCount(capability)" class="is-needed">{{ $t('至少选一个') }}</span>
                    </p>
                    <div class="grant-item-list">
                      <section v-for="group in scopeGroups(capability)" :key="group.environmentName || 'ungrouped'">
                        <h4 v-if="scopeGroups(capability).length > 1">{{ group.environmentName || $t('未分组') }}</h4>
                        <label v-for="item in group.items" :key="item.id" :class="{ 'is-checked': (pickedItems[capability] ?? []).includes(item.id) }">
                          <input type="checkbox" :checked="(pickedItems[capability] ?? []).includes(item.id)" @change="toggleItem(capability, item.id, ($event.target as HTMLInputElement).checked)">
                          <span>{{ item.name }}</span>
                        </label>
                      </section>
                    </div>
                  </template>
                  <p v-else class="grant-scope-note">{{ $t('还没有可选项') }}</p>
                </div>
              </template>
              <span v-else-if="wholeGroup && kind === 'environment_group'" class="grant-item-empty">{{ $t('整个组使用同一套操作') }}</span>
            </div>
          </div>
        </div>

        <el-form-item :label="$t('有效期')">
          <div class="grant-duration" role="radiogroup" :aria-label="$t('授权时长')">
            <button v-for="item in durations" :key="item.id" type="button" :class="{ 'is-active': duration === item.id }" @click="duration = item.id">{{ $t(item.label) }}</button>
          </div>
          <input v-if="duration === 'custom'" v-model="customEnd" class="grant-datetime" type="datetime-local" :aria-label="$t('自己指定结束时间')">
        </el-form-item>
      </template>
    </el-form>
    <template #footer>
      <div class="grant-footer">
        <el-button v-if="step === 'permissions'" :disabled="grantingResource" @click="step = 'pick'">{{ $t('上一步') }}</el-button>
        <span class="grant-footer-spacer"></span>
        <el-button :disabled="grantingResource" @click="grantDialog = false">{{ $t('取消') }}</el-button>
        <el-button v-if="step === 'pick'" type="primary" :disabled="!targetsOk" @click="continueToPermissions">{{ $t('下一步') }}</el-button>
        <el-button v-else type="primary" :loading="grantingResource" :disabled="!canSave" @click="submit"><ShieldCheck v-if="!grantingResource" :size="15" />{{ editingGrant ? $t('保存修改') : $t('确认授权') }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.grant-kind-switch { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
.grant-kind-switch button { min-height: 36px; padding: 0 8px; border: 1px solid var(--color-rule-strong); border-radius: 8px; background: var(--color-paper); color: var(--color-ink-soft); cursor: pointer; font-size: 13px; }
.grant-kind-switch button:hover { color: var(--color-ink); }
.grant-kind-switch button:focus-visible, .grant-whole-group:focus-visible, .grant-overview .environment-card:focus-visible, .grant-overview .environment-directory__link:focus-visible, .grant-ssh-list .connection-card-main:focus-visible, .grant-db-list .database-navigation-connection:focus-visible, .grant-redis-list button:focus-visible, .grant-scope-choice button:focus-visible, .grant-item-list label:focus-within { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.grant-kind-switch button.is-active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-strong); font-weight: 650; }
.grant-overview { margin-top: 12px; }
.grant-overview .overview-directory-layout { margin-top: 0; }
.grant-overview .environment-directory { top: 0; }
.grant-overview .environment-section > header { gap: 8px; }
.grant-overview .environment-section.is-whole-group > header { padding-right: 4px; border-radius: 8px; background: var(--color-accent-soft); }
.grant-overview .environment-card { width: 100%; padding: 0; border: 1px solid var(--color-rule-strong); font: inherit; color: inherit; text-align: left; cursor: pointer; }
.grant-overview .environment-card.is-selected .environment-browser__page { background: color-mix(in srgb, var(--color-accent-soft) 70%, var(--color-paper-raised)); }
.grant-card-check { flex: 0 0 auto; margin: 0 10px 6px 0; color: #7dcea0; }
.grant-card-star { width: 22px; height: 22px; color: var(--color-sidebar-muted); display: grid; place-items: center; }
.grant-card-star.is-favorite { color: #e0a13a; }
.grant-whole-group { flex: 0 0 auto; margin-left: auto; min-height: 28px; padding: 0 8px; border: 1px solid var(--color-rule-strong); border-radius: 7px; background: var(--color-paper); color: var(--color-ink-soft); cursor: pointer; font-size: 12px; }
.grant-whole-group:hover { color: var(--color-ink); }
.grant-whole-group.is-active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-strong); }
.grant-picker-empty { min-height: 168px; display: grid; place-items: center; align-content: center; gap: 8px; color: var(--color-muted); font-size: 13px; }
.grant-ssh-list.ssh-workbench { height: auto; min-height: 0; max-height: min(560px, 54vh); margin-top: 12px; display: flex; background: #101c1f; overflow: auto; }
.grant-ssh-list .ssh-hosts { flex: 1; border-right: 0; }
.grant-ssh-list .ssh-host-card__endpoint { grid-area: endpoint; display: flex; align-items: baseline; min-width: 0; overflow: hidden; color: #687d78; font-size: 12px; line-height: 1.35; white-space: nowrap; }
.grant-ssh-list .ssh-host-card.is-selected { border-color: #315148; background: #1a2d29; }
.grant-host-check { position: absolute; top: 10px; right: 10px; color: #5dd0ac; }
:root.bright .grant-ssh-list.ssh-workbench,
:root.bright .grant-workbench-head { background: #f4f7f7; }
:root.bright .grant-ssh-list .ssh-host-card.is-selected { border-color: #8fbfb0; background: #e7f1ee; }
:root.bright .grant-ssh-list .ssh-host-card__endpoint { color: #6b7f83; }
:root.bright .grant-host-check { color: #126f60; }
:root.bright .grant-db-list.database-navigator { border-color: #d3dbdc; }
.grant-workbench-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 6px; background: #101c1f; }
.grant-workbench-head .workbench-group-toggle, .grant-workbench-head .database-navigation-group-toggle { flex: 1; min-width: 0; }
.grant-db-list.database-navigator { height: auto; min-height: 0; max-height: min(560px, 54vh); margin-top: 12px; display: block; border: 1px solid #293a3d; border-radius: 10px; overflow: auto; }
.grant-redis-list { min-height: 0; max-height: min(560px, 54vh); margin-top: 12px; padding: 8px; border: 1px solid var(--color-rule); border-radius: 10px; background: color-mix(in srgb, var(--color-paper) 76%, var(--color-paper-raised)); overflow: auto; }
.grant-redis-list .redis-connection-list { display: flex; flex-direction: column; gap: 8px; }
.grant-redis-list h4 { min-height: 32px; margin: 0; display: flex; align-items: center; gap: 6px; color: var(--color-muted); font-size: 12px; }
.grant-redis-list h4 > button:first-child { min-width: 0; flex: 1; padding: 0; border: 0; background: transparent; color: inherit; display: flex; align-items: center; gap: 6px; cursor: pointer; text-align: left; font: inherit; font-weight: 700; }
.grant-redis-list h4 > button:first-child span, .grant-redis-list .redis-connection-list button strong, .grant-redis-list .redis-connection-list button small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grant-redis-list h4 small { font-family: var(--font-mono); }
.grant-redis-list .redis-connection-list section > button { width: 100%; min-height: 46px; padding: 6px 8px; border: 0; border-radius: 7px; background: transparent; color: var(--color-ink-soft); display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 8px; text-align: left; cursor: pointer; }
.grant-redis-list .redis-connection-list section > button:hover { background: color-mix(in srgb, var(--color-ink) 5%, transparent); }
.grant-redis-list .redis-connection-list section > button.is-active { background: var(--color-accent-soft); color: var(--color-accent-strong); }
.grant-redis-list .redis-connection-icon { width: 28px; height: 28px; border: 1px solid var(--color-rule); border-radius: 6px; display: grid; place-items: center; }
.grant-redis-list .redis-connection-list button > div { min-width: 0; display: flex; flex-direction: column; }
.grant-redis-list .redis-connection-list button small { color: var(--color-muted); font-family: var(--font-mono); font-size: 11px; }
.grant-pick-summary small, .grant-selection-bar span { color: var(--color-muted); font-size: 12px; }
.grant-pick-summary { min-height: 22px; margin: 12px 0 0; display: flex; align-items: baseline; gap: 8px; }
.grant-pick-summary strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ink); font-size: 13px; }
.grant-pick-summary.is-empty { color: var(--color-muted); font-size: 12px; }
.grant-selection-bar { margin-bottom: 14px; padding: 10px 12px; border: 1px solid var(--color-rule); border-radius: 10px; background: var(--color-paper); }
.grant-selection-bar small, .grant-selection-bar strong, .grant-selection-bar span { display: block; }
.grant-selection-bar strong { margin-top: 2px; color: var(--color-ink); font-size: 14px; }
.grant-matrix__scope { min-width: 0; }
.grant-scope-choice { display: grid; grid-template-columns: 1fr 1fr; width: 100%; border: 1px solid var(--color-rule-strong); border-radius: 8px; overflow: hidden; background: var(--color-paper); }
.grant-scope-choice button { min-height: 32px; padding: 0 8px; border: 0; background: transparent; color: var(--color-ink-soft); cursor: pointer; font-size: 12px; }
.grant-scope-choice button + button { border-left: 1px solid var(--color-rule-strong); }
.grant-scope-choice button:hover { color: var(--color-ink); }
.grant-scope-choice button.is-active { background: var(--color-accent-soft); color: var(--color-accent-strong); font-weight: 650; }
.grant-scope-choice button:focus-visible { outline-offset: -2px; }
.grant-scope-note, .grant-scope-meta { margin: 6px 2px 0; color: var(--color-muted); font-size: 12px; }
.grant-scope-meta { display: flex; align-items: center; gap: 8px; }
.grant-scope-meta .is-needed { color: var(--color-accent-strong); }
.grant-duration button { min-height: 34px; padding: 0 10px; border: 1px solid var(--color-rule-strong); border-radius: 8px; background: var(--color-paper); color: var(--color-ink-soft); cursor: pointer; font-size: 12px; }
.grant-duration button.is-active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-strong); }
.grant-matrix { margin: 4px 0 16px; border: 1px solid var(--color-rule); border-radius: 10px; overflow: hidden; }
.grant-matrix__head, .grant-matrix__row { display: grid; grid-template-columns: 112px minmax(220px, 1.1fr) minmax(220px, 1fr); gap: 12px; align-items: start; }
.grant-matrix.is-connection .grant-matrix__head, .grant-matrix.is-connection .grant-matrix__row { grid-template-columns: 112px minmax(0, 1fr); }
.grant-matrix__head { min-height: 36px; padding: 0 12px; align-items: center; background: color-mix(in srgb, var(--color-ink) 6%, var(--color-paper)); color: var(--color-muted); font-size: 12px; font-weight: 650; }
.grant-matrix__row { padding: 12px; border-top: 1px solid var(--color-rule); }
.grant-matrix__row > strong { padding-top: 4px; color: var(--color-ink); font-size: 13px; }
.grant-matrix__actions { display: flex; flex-wrap: wrap; gap: 8px 14px; }
.grant-matrix__actions label { display: inline-flex; align-items: center; gap: 6px; color: var(--color-ink-soft); font-size: 12px; }
.grant-matrix__actions input, .grant-item-list input { width: 15px; height: 15px; margin: 0; accent-color: var(--color-accent); flex: 0 0 auto; }
.grant-item-list { display: flex; flex-direction: column; gap: 2px; max-height: 280px; margin-top: 6px; overflow: auto; }
.grant-item-list h4 { margin: 6px 2px 2px; color: var(--color-muted); font-size: 11px; font-weight: 650; }
.grant-item-list section:first-child h4 { margin-top: 0; }
.grant-item-list label { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 8px; border-radius: 7px; color: var(--color-ink-soft); font-size: 12px; cursor: pointer; }
.grant-item-list label:hover { background: color-mix(in srgb, var(--color-ink) 5%, transparent); }
.grant-item-list label.is-checked { background: var(--color-accent-soft); color: var(--color-accent-strong); }
.grant-item-list label span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grant-item-empty { color: var(--color-muted); font-size: 11px; }
.grant-duration { display: flex; flex-wrap: wrap; gap: 8px; }
.grant-datetime { width: 100%; max-width: 280px; height: 36px; margin-top: 10px; padding: 0 10px; border: 1px solid var(--color-rule-strong); border-radius: 8px; background: var(--color-paper); color: var(--color-ink); }
.grant-footer { display: flex; align-items: center; gap: 8px; width: 100%; }
.grant-footer-spacer { flex: 1; }
@media (max-width: 760px) {
  .grant-kind-switch { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grant-matrix__head, .grant-matrix__row { grid-template-columns: 1fr; }
  .grant-matrix__head span:not(:first-child) { display: none; }
  .grant-pick-summary { align-items: flex-start; flex-direction: column; gap: 2px; }
}
</style>
