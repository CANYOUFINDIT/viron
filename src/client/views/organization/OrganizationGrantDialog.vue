<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { Check, Database, FolderTree, MemoryStick, Search, Server, ShieldCheck } from "@lucide/vue";
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
interface CatalogItem { id: string; name: string; environmentName: string }
interface CatalogGroup { id: string; name: string; description: string; color: string }
interface CatalogEnvironment {
  id: string;
  name: string;
  alias: string;
  description: string;
  groupId: string | null;
  tags: string[];
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
  description: string;
  canAuthorizeGroup: boolean;
  items: CatalogEnvironment[];
  showEmpty: boolean;
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
const hydrating = ref(false);
const pickerLoading = ref(false);
const pickerReady = ref(false);
const pickerGroups = ref<CatalogGroup[]>([]);
const pickerEnvironments = ref<CatalogEnvironment[]>([]);
const pickerConnections = ref<CatalogConnection[]>([]);
let pickerRequest = 0;

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
  return "搜索环境、别称或环境组";
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
  for (const group of groups) {
    const members = environments.filter((item) => item.groupId === group.id);
    const groupMatches = !query || `${group.name} ${group.description}`.toLowerCase().includes(query);
    const items = groupMatches ? members : members.filter((item) => environmentMatches(item, query));
    if (query && !items.length) continue;
    sections.push({
      id: group.id,
      name: group.name,
      color: group.color || "#7d8891",
      description: group.description,
      canAuthorizeGroup: true,
      items,
      showEmpty: !items.length,
    });
  }
  const ungrouped = environments.filter((item) => !item.groupId || !knownGroups.has(item.groupId));
  const ungroupedItems = query ? ungrouped.filter((item) => environmentMatches(item, query)) : ungrouped;
  if (ungroupedItems.length) {
    sections.push({
      id: "ungrouped",
      name: "未分组",
      color: "#7d8891",
      description: "",
      canAuthorizeGroup: false,
      items: ungroupedItems,
      showEmpty: false,
    });
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
const pickerEmpty = computed(() => activeFamily.value === "environment" ? environmentSections.value.length === 0 : connectionSections.value.length === 0);
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

function environmentSecondary(item: CatalogEnvironment) {
  return item.alias.trim() && item.alias.trim() !== item.name ? item.name : "";
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
  step.value = "pick";
  if (!grant) {
    kind.value = "environment";
    groupId.value = "";
    wholeGroup.value = false;
    targetIds.value = [];
    duration.value = "8h";
    customEnd.value = "";
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
  hydrating.value = false;
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
watch([targetIds, wholeGroup, kind], () => { void loadCatalog(); });

async function loadCatalog() {
  if (!showItems.value || !currentOrganizationId.value) {
    catalog.value = {};
    return;
  }
  try {
    catalog.value = await api<Record<string, CatalogItem[]>>(`/api/v1/organizations/${currentOrganizationId.value}/grant-catalog?environmentIds=${encodeURIComponent(targetIds.value.join(","))}`);
  } catch {
    catalog.value = {};
  }
}

function chooseFamily(next: Family) {
  if (activeFamily.value === next || hydrating.value) return;
  kind.value = next;
  groupId.value = "";
  wholeGroup.value = false;
  targetIds.value = [];
  keyword.value = "";
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
  <el-dialog append-to-body v-model="grantDialog" align-center class="envman-dialog grant-auth-dialog" :title="editingGrant ? $t('修改授权') : $t('授权资源')" width="min(980px, calc(100% - 32px))" @closed="editingGrant = null">
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

        <div class="grant-picker" :aria-label="activeFamily === 'environment' ? $t('环境总览') : $t(families.find((item) => item.value === activeFamily)?.label || '资源')" v-loading="pickerLoading && pickerEmpty">
          <template v-if="activeFamily === 'environment'">
            <section v-for="section in environmentSections" :key="section.id" class="grant-picker-section">
              <header class="grant-picker-group" :class="{ 'is-selected': groupSelected(section.id) }">
                <i :style="{ background: section.color }"></i>
                <strong :title="section.description || section.name">{{ section.id === 'ungrouped' ? $t(section.name) : section.name }}</strong>
                <small>{{ section.items.length }} {{ $t('个环境') }}</small>
                <button v-if="section.canAuthorizeGroup" type="button" class="grant-whole-group" :class="{ 'is-active': groupSelected(section.id) }" :aria-pressed="groupSelected(section.id)" :title="$t('整个组，以后新加的环境也算')" @click="selectWholeGroup(section.id)">{{ $t('整个组') }}</button>
              </header>
              <p v-if="section.showEmpty && !groupSelected(section.id)" class="grant-picker-note">{{ $t('这一组里还没有环境') }}</p>
              <button v-for="item in section.items" :key="item.id" type="button" class="grant-picker-row" :class="{ 'is-selected': environmentSelected(item.id) }" :aria-pressed="environmentSelected(item.id)" @click="toggleEnvironment(item.id)">
                <span class="grant-picker-copy">
                  <strong>{{ environmentTitle(item) }}</strong>
                  <small v-if="environmentSecondary(item)">{{ environmentSecondary(item) }}</small>
                  <small v-if="item.detailed" class="grant-picker-meta"><span>Web {{ item.webCount }}</span><span>SSH {{ item.sshCount }}</span><span>{{ $t('数据库') }} {{ item.databaseCount }}</span><span>Redis {{ item.redisCount }}</span></small>
                </span>
                <Check v-if="environmentSelected(item.id)" class="grant-picker-check" :size="16" />
              </button>
            </section>
          </template>
          <template v-else>
            <section v-for="section in connectionSections" :key="section.path || 'ungrouped'" class="grant-picker-section">
              <header class="grant-picker-group">
                <FolderTree :size="14" />
                <strong>{{ section.path || $t('未分组') }}</strong>
                <small>{{ section.items.length }}</small>
                <button type="button" class="grant-whole-group" :class="{ 'is-active': sectionFullySelected(section.items) }" :aria-pressed="sectionFullySelected(section.items)" @click="toggleConnectionSection(section.items)">{{ $t('全选') }}</button>
              </header>
              <button v-for="item in section.items" :key="item.id" type="button" class="grant-picker-row" :class="{ 'is-selected': connectionSelected(item.id) }" :aria-pressed="connectionSelected(item.id)" @click="toggleConnection(item.id)">
                <Server v-if="item.type === 'ssh'" :size="16" />
                <Database v-else-if="item.type === 'database'" :size="16" />
                <MemoryStick v-else :size="16" />
                <span class="grant-picker-copy">
                  <strong>{{ item.name }}</strong>
                  <small v-if="connectionEndpoint(item)">{{ connectionEndpoint(item) }}</small>
                  <small v-if="item.tags.length" class="grant-picker-meta"><span v-for="tag in item.tags.slice(0, 3)" :key="tag">{{ tag }}</span></small>
                </span>
                <Check v-if="connectionSelected(item.id)" class="grant-picker-check" :size="16" />
              </button>
            </section>
          </template>
          <div v-if="pickerEmpty" class="grant-picker-empty">
            <Search v-if="keyword.trim()" :size="20" />
            <Server v-else :size="20" />
            <span>{{ $t(emptyLabel) }}</span>
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
                <div class="grant-scope-choice">
                  <button type="button" :class="{ 'is-active': itemMode[capability] !== 'some' }" @click="itemMode[capability] = 'all'">{{ $t('这一整块') }}</button>
                  <button type="button" :class="{ 'is-active': itemMode[capability] === 'some' }" @click="itemMode[capability] = 'some'">{{ $t('只选其中几个') }}</button>
                </div>
                <div v-if="itemMode[capability] === 'some'" class="grant-item-list">
                  <label v-for="item in catalog[capability] ?? []" :key="item.id">
                    <input type="checkbox" :checked="(pickedItems[capability] ?? []).includes(item.id)" @change="toggleItem(capability, item.id, ($event.target as HTMLInputElement).checked)">
                    <span>{{ item.name }}</span>
                    <small v-if="targetIds.length > 1">{{ item.environmentName }}</small>
                  </label>
                  <span v-if="!(catalog[capability] ?? []).length" class="grant-item-empty">{{ $t('这一块里还没有可选项') }}</span>
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
.grant-kind-switch button:focus-visible, .grant-picker-row:focus-visible, .grant-whole-group:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.grant-kind-switch button.is-active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-strong); font-weight: 650; }
.grant-picker { max-height: min(420px, 48vh); margin-top: 12px; border: 1px solid var(--color-rule); border-radius: 10px; background: var(--color-paper); overflow: auto; }
.grant-picker-section + .grant-picker-section { border-top: 1px solid var(--color-rule); }
.grant-picker-group { position: sticky; top: 0; z-index: 1; min-height: 40px; padding: 0 10px 0 12px; display: flex; align-items: center; gap: 8px; background: color-mix(in srgb, var(--color-ink) 4%, var(--color-paper)); color: var(--color-ink); }
.grant-picker-group.is-selected { background: var(--color-accent-soft); }
.grant-picker-group > i { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; }
.grant-picker-group > strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.grant-picker-group > small, .grant-picker-note, .grant-pick-summary small, .grant-selection-bar span { color: var(--color-muted); font-size: 12px; }
.grant-picker-group > svg { flex: 0 0 auto; color: var(--color-muted); }
.grant-whole-group { margin-left: auto; min-height: 28px; padding: 0 8px; border: 1px solid var(--color-rule-strong); border-radius: 7px; background: var(--color-paper); color: var(--color-ink-soft); cursor: pointer; font-size: 12px; }
.grant-whole-group:hover { color: var(--color-ink); }
.grant-whole-group.is-active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-strong); }
.grant-picker-note { margin: 0; padding: 6px 12px 8px 28px; }
.grant-picker-row { width: 100%; min-height: 44px; padding: 8px 12px 8px 28px; border: 0; background: transparent; color: var(--color-ink); display: flex; align-items: center; gap: 10px; cursor: pointer; text-align: left; }
.grant-picker-row > svg { flex: 0 0 auto; color: var(--color-muted); }
.grant-picker-row:hover { background: color-mix(in srgb, var(--color-ink) 4%, transparent); }
.grant-picker-row.is-selected { background: var(--color-accent-soft); }
.grant-picker-row.is-selected:hover { background: var(--color-accent-soft); }
.grant-picker-row.is-selected > strong, .grant-picker-copy strong { font-weight: 650; }
.grant-picker-row.is-selected .grant-picker-copy strong { color: var(--color-accent-strong); }
.grant-picker-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.grant-picker-copy strong, .grant-picker-copy > small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grant-picker-copy strong { font-size: 13px; }
.grant-picker-copy > small, .grant-picker-meta { color: var(--color-muted); font-size: 11px; }
.grant-picker-meta { display: flex; flex-wrap: wrap; gap: 2px 10px; white-space: normal; }
.grant-picker-check { flex: 0 0 auto; color: var(--color-accent); }
.grant-picker-empty { min-height: 168px; display: grid; place-items: center; align-content: center; gap: 8px; color: var(--color-muted); font-size: 13px; }
.grant-pick-summary { min-height: 22px; margin: 12px 0 0; display: flex; align-items: baseline; gap: 8px; }
.grant-pick-summary strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ink); font-size: 13px; }
.grant-pick-summary.is-empty { color: var(--color-muted); font-size: 12px; }
.grant-selection-bar { margin-bottom: 14px; padding: 10px 12px; border: 1px solid var(--color-rule); border-radius: 10px; background: var(--color-paper); }
.grant-selection-bar small, .grant-selection-bar strong, .grant-selection-bar span { display: block; }
.grant-selection-bar strong { margin-top: 2px; color: var(--color-ink); font-size: 14px; }
.grant-scope-choice { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
.grant-scope-choice button, .grant-duration button { min-height: 34px; padding: 0 10px; border: 1px solid var(--color-rule-strong); border-radius: 8px; background: var(--color-paper); color: var(--color-ink-soft); cursor: pointer; font-size: 12px; }
.grant-scope-choice button.is-active, .grant-duration button.is-active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-strong); }
.grant-matrix { margin: 4px 0 16px; border: 1px solid var(--color-rule); border-radius: 10px; overflow: hidden; }
.grant-matrix__head, .grant-matrix__row { display: grid; grid-template-columns: 112px minmax(220px, 1.1fr) minmax(220px, 1fr); gap: 12px; align-items: start; }
.grant-matrix.is-connection .grant-matrix__head, .grant-matrix.is-connection .grant-matrix__row { grid-template-columns: 112px minmax(0, 1fr); }
.grant-matrix__head { min-height: 36px; padding: 0 12px; align-items: center; background: color-mix(in srgb, var(--color-ink) 6%, var(--color-paper)); color: var(--color-muted); font-size: 12px; font-weight: 650; }
.grant-matrix__row { padding: 12px; border-top: 1px solid var(--color-rule); }
.grant-matrix__row > strong { padding-top: 4px; color: var(--color-ink); font-size: 13px; }
.grant-matrix__actions, .grant-item-list { display: flex; flex-wrap: wrap; gap: 8px 14px; }
.grant-matrix__actions label, .grant-item-list label { display: inline-flex; align-items: center; gap: 6px; color: var(--color-ink-soft); font-size: 12px; }
.grant-matrix__actions input, .grant-item-list input { width: 15px; height: 15px; margin: 0; accent-color: var(--color-accent); }
.grant-item-list { max-height: 148px; margin-top: 8px; overflow: auto; }
.grant-item-list small, .grant-item-empty { color: var(--color-muted); font-size: 11px; }
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
