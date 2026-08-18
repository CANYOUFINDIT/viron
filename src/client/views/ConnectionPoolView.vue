<script setup lang="ts">import { translate as tr, currentLocale } from "../i18n";

import {
  AlertTriangle,
  Boxes,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleCheck,
  CircleX,
  Clock3,
  Copy,
  Database,
  FolderPlus,
  FolderTree,
  Layers3,
  KeyRound,
  Link2,
  MemoryStick,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Unplug,
  Upload,
  Wrench,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { session } from "../session";
import PageHeader from "../components/PageHeader.vue";
import SshLoginScriptEditor from "../components/SshLoginScriptEditor.vue";
import TipIcon from "../components/TipIcon.vue";

interface EnvironmentItem {
  id: string;
  name: string;
}

interface EnvironmentGroup {
  id: string;
  name: string;
  description: string;
  color: string;
  environmentCount: number;
}

interface ConnectionGroup {
  id: string;
  type: "ssh" | "database" | "redis";
  parentId: string | null;
  name: string;
  path: string;
}

interface SshKeyOption {
  id: string;
  name: string;
  fingerprint: string;
  algorithm: string;
}

interface ConnectionItem {
  id: string;
  type: "ssh" | "database" | "redis";
  environmentId: string | null;
  environmentName: string | null;
  environmentIds: string[];
  environments: EnvironmentItem[];
  connectionGroupId: string | null;
  connectionGroupName: string | null;
  connectionGroupPath: string | null;
  sourceName: string;
  sourcePath: string | null;
  sourceDeleted: boolean;
  name: string;
  engine?: "mysql" | "mariadb";
  host: string;
  port: number;
  username: string;
  authType?: "password" | "privateKey" | "keyboardInteractive";
  sshKeyId?: string | null;
  sshKeyName?: string | null;
  connectionMode?: "tcp" | "sshTunnel" | "httpTunnel";
  defaultDatabase?: string | number;
  jumpConnectionId?: string | null;
  tags?: string[];
  options: Record<string, unknown>;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasHttpTunnelAuth?: boolean;
  lastInspectionStatus: "available" | "unavailable" | null;
  lastInspectionLatencyMs: number | null;
  lastInspectionMessage: string | null;
  lastInspectedAt: string | null;
  updatedAt: string;
}

type ConnectionLeafRow = ConnectionItem & { rowKind: "connection" };
interface ConnectionGroupRow {
  id: string;
  rowKind: "group";
  groupPath: string;
  count: number;
  children: ConnectionLeafRow[];
}
type ConnectionTableRow = ConnectionLeafRow | ConnectionGroupRow;

const loading = ref(true);
const saving = ref(false);
const connections = ref<ConnectionItem[]>([]);
const inventory = ref<ConnectionItem[]>([]);
const environments = ref<EnvironmentItem[]>([]);
const environmentGroups = ref<EnvironmentGroup[]>([]);
const connectionGroups = ref<ConnectionGroup[]>([]);
const sshKeys = ref<SshKeyOption[]>([]);
const selection = ref<ConnectionItem[]>([]);
const assignment = ref<"all" | "unassigned" | "assigned">("all");
const type = ref<"all" | "ssh" | "database" | "redis">("all");
const keyword = ref("");
const assignDialog = ref(false);
const targetEnvironmentIds = ref<string[]>([]);
const connectionDialog = ref(false);
const groupDialog = ref(false);
const environmentDialog = ref(false);
const environmentGroupDialog = ref(false);
const editingId = ref("");
const importDialog = ref(false);
const importStep = ref<"upload" | "preview">("upload");
const importType = ref<"securecrt" | "navicat">("securecrt");
const importPassphrase = ref("");
const importFile = ref<File | null>(null);
const importInput = ref<HTMLInputElement | null>(null);
const activeImportTab = ref<"ssh" | "database">("ssh");
const expandedConnectionGroupIds = ref<string[]>([]);

interface ImportConflict { id: string; name: string; environmentName: string | null; sourceName: string | null; connectionGroupName: string | null; connectionGroupPath: string | null }
interface ImportItem {
  id: string;
  type: "ssh" | "database";
  name: string;
  endpoint: string;
  sourcePath: string;
  status: "new" | "conflict" | "invalid" | "imported" | "skipped";
  conflicts: ImportConflict[];
  warnings: string[];
  hasCredential: boolean;
}
interface ImportBatch {
  id: string;
  filename: string;
  type: "securecrt" | "navicat";
  sourceType: string;
  summary: { total: number; ssh: number; database: number; new: number; conflict: number; conflictSsh?: number; conflictDatabase?: number; invalid: number; warnings: number };
  items: ImportItem[];
}
const importBatch = ref<ImportBatch | null>(null);
type ImportAction = "import" | "keep" | "overwrite" | "reuse" | "skip" | "";
const importDecisions = ref<Record<string, { action: ImportAction; targetId?: string }>>({});
const route = useRoute();
const router = useRouter();

const form = reactive({
  type: "ssh" as "ssh" | "database" | "redis",
  environmentIds: [] as string[],
  connectionGroupId: null as string | null,
  name: "",
  host: "",
  port: 22,
  username: "",
  authType: "password" as "password" | "privateKey" | "keyboardInteractive",
  sshKeyId: null as string | null,
  password: "",
  jumpConnectionId: null as string | null,
  tags: [] as string[],
  loginScriptEnabled: false,
  loginScript: "",
  engine: "mysql" as "mysql" | "mariadb",
  defaultDatabase: "" as string | number,
  connectionMode: "tcp" as "tcp" | "sshTunnel" | "httpTunnel",
  sshConnectionId: null as string | null,
  sslEnabled: false,
  rejectUnauthorized: true,
  httpTunnelUrl: "",
  httpTunnelUsername: "",
  httpTunnelPassword: "",
  httpTunnelRejectUnauthorized: true,
  keySeparator: ":",
  readOnly: false,
  tlsServerName: "",
  tlsCa: "",
  tlsCertificate: "",
  tlsPrivateKey: "",
  tlsPassphrase: "",
});
const groupForm = reactive({ type: "ssh" as "ssh" | "database" | "redis", parentId: null as string | null, name: "" });
const environmentForm = reactive({
  name: "",
  groupId: null as string | null,
  description: "",
  tags: "",
});
const environmentGroupForm = reactive({ name: "", description: "", color: "#1d8a74" });

const counts = computed(() => ({
  total: inventory.value.length,
  ssh: inventory.value.filter((item) => item.type === "ssh").length,
  database: inventory.value.filter((item) => item.type === "database").length,
  redis: inventory.value.filter((item) => item.type === "redis").length,
  unassigned: inventory.value.filter((item) => !item.environmentIds.length).length,
}));

const groupedConnectionRows = computed<ConnectionGroupRow[]>(() => {
  const groups = new Map<string, { id: string; path: string; items: ConnectionItem[] }>();
  for (const connection of connections.value) {
    const id = connection.connectionGroupId ?? "ungrouped";
    const current = groups.get(id);
    groups.set(id, {
      id,
      path: connection.connectionGroupPath || tr("未分组"),
      items: [...(current?.items ?? []), connection],
    });
  }
  return [...groups.values()]
    .sort((left, right) => left.id === "ungrouped" ? 1 : right.id === "ungrouped" ? -1 : left.path.localeCompare(right.path, "zh-CN"))
    .map((group) => ({
      id: `connection-group:${group.id}`,
      rowKind: "group",
      groupPath: group.path,
      count: group.items.length,
      children: group.items.map((item) => ({ ...item, rowKind: "connection" })),
    }));
});

const allConnectionGroupsExpanded = computed(() => groupedConnectionRows.value.length > 0
  && groupedConnectionRows.value.every((group) => expandedConnectionGroupIds.value.includes(group.id)));

function isGroupRow(row: ConnectionTableRow): row is ConnectionGroupRow {
  return row.rowKind === "group";
}

function rowSelectable(row: ConnectionTableRow) {
  return !isGroupRow(row);
}

function handleSelectionChange(rows: ConnectionTableRow[]) {
  selection.value = rows.filter((row): row is ConnectionLeafRow => !isGroupRow(row));
}

function mobileConnectionSelected(item: ConnectionItem) {
  return selection.value.some((selected) => selected.id === item.id && selected.type === item.type);
}

function toggleMobileConnectionSelection(item: ConnectionItem, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  selection.value = checked
    ? [...selection.value.filter((selected) => selected.id !== item.id || selected.type !== item.type), item]
    : selection.value.filter((selected) => selected.id !== item.id || selected.type !== item.type);
}

function handleConnectionGroupExpansion(row: ConnectionTableRow, expanded: boolean) {
  if (!isGroupRow(row)) return;
  const expandedIds = new Set(expandedConnectionGroupIds.value);
  if (expanded) expandedIds.add(row.id);
  else expandedIds.delete(row.id);
  expandedConnectionGroupIds.value = [...expandedIds];
}

function toggleAllConnectionGroups() {
  expandedConnectionGroupIds.value = allConnectionGroupsExpanded.value
    ? []
    : groupedConnectionRows.value.map((group) => group.id);
}

function connectionRowClass({ row }: { row: ConnectionTableRow }) {
  return isGroupRow(row) ? "is-connection-group-row" : "";
}

const CONNECTION_GROUP_COLUMN_SPAN = 10;

function connectionCellSpan({ row, columnIndex }: { row: ConnectionTableRow; columnIndex: number }) {
  if (!isGroupRow(row) || columnIndex === 0) return [1, 1];
  return columnIndex === 1 ? [1, CONNECTION_GROUP_COLUMN_SPAN] : [0, 0];
}

const sshOptions = computed(() => connections.value.filter((item) => item.type === "ssh" && item.id !== editingId.value));
const canManageWorkspace = computed(() => ["owner", "admin"].includes(session.workspace?.role ?? ""));
const editingConnection = computed(() => inventory.value.find((item) => item.id === editingId.value) ?? connections.value.find((item) => item.id === editingId.value));
const preservesLegacyPrivateKey = computed(() => Boolean(editingConnection.value?.authType === "privateKey" && editingConnection.value.hasPrivateKey && !editingConnection.value.sshKeyId));
const availableGroups = computed(() => connectionGroups.value.filter((item) => item.type === form.type));
const availableParentGroups = computed(() => connectionGroups.value.filter((item) => item.type === groupForm.type));
const importItemsForTab = computed(() => importBatch.value?.items.filter((item) => item.type === activeImportTab.value) ?? []);
const activeImportConflictCount = computed(() => importItemsForTab.value.filter((item) => item.status === "conflict").length);
const authLabels: Record<string, string> = {
  password: tr("密码"),
  privateKey: tr("SSH 密钥"),
  keyboardInteractive: tr("键盘交互"),
};

const modeLabels: Record<string, string> = {
  tcp: "TCP",
  sshTunnel: "SSH Tunnel",
  httpTunnel: "HTTP Tunnel",
};

function connectionTypeLabel(connection: Pick<ConnectionItem, "type" | "engine">) {
  if (connection.type === "ssh") return "SSH";
  if (connection.type === "redis") return "REDIS";
  return (connection.engine ?? "mysql").toUpperCase();
}

async function load() {
  loading.value = true;
  try {
    const query = new URLSearchParams({ assignment: assignment.value, type: type.value });
    if (keyword.value.trim()) query.set("q", keyword.value.trim());
    const [connectionResponse, inventoryResponse, environmentResponse, environmentGroupResponse, connectionGroupResponse, keyResponse] = await Promise.all([
      api<{ items: ConnectionItem[] }>(`/api/v1/connections?${query.toString()}`),
      api<{ items: ConnectionItem[] }>("/api/v1/connections?assignment=all&type=all"),
      api<{ items: EnvironmentItem[] }>("/api/v1/environments"),
      api<{ items: EnvironmentGroup[] }>("/api/v1/environment-groups"),
      api<{ items: ConnectionGroup[] }>("/api/v1/connection-groups"),
      canManageWorkspace.value ? api<{ items: SshKeyOption[] }>("/api/v1/ssh-keys") : Promise.resolve({ items: [] as SshKeyOption[] }),
    ]);
    connections.value = connectionResponse.items;
    expandedConnectionGroupIds.value = groupedConnectionRows.value.map((group) => group.id);
    inventory.value = inventoryResponse.items;
    environments.value = environmentResponse.items;
    environmentGroups.value = environmentGroupResponse.items;
    connectionGroups.value = connectionGroupResponse.items;
    sshKeys.value = keyResponse.items;
    selection.value = [];
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载连接资源池失败"));
  } finally {
    loading.value = false;
  }
}

function applyInventoryFilter(value: "all" | "ssh" | "database" | "redis" | "unassigned") {
  assignment.value = value === "unassigned" ? "unassigned" : "all";
  type.value = value === "ssh" || value === "database" || value === "redis" ? value : "all";
  void load();
}

function resetForm(connectionType: "ssh" | "database" | "redis" = "ssh") {
  editingId.value = "";
  Object.assign(form, {
    type: connectionType,
    environmentIds: [],
    connectionGroupId: null,
    name: "",
    host: "",
    port: connectionType === "ssh" ? 22 : connectionType === "redis" ? 6379 : 3306,
    username: "",
    authType: "password",
    sshKeyId: null,
    password: "",
    jumpConnectionId: null,
    tags: [],
    loginScriptEnabled: false,
    loginScript: "",
    engine: "mysql",
    defaultDatabase: connectionType === "redis" ? 0 : "",
    connectionMode: "tcp",
    sshConnectionId: null,
    sslEnabled: false,
    rejectUnauthorized: true,
    httpTunnelUrl: "",
    httpTunnelUsername: "",
    httpTunnelPassword: "",
    httpTunnelRejectUnauthorized: true,
    keySeparator: ":",
    readOnly: false,
    tlsServerName: "",
    tlsCa: "",
    tlsCertificate: "",
    tlsPrivateKey: "",
    tlsPassphrase: "",
  });
  connectionDialog.value = true;
}

function editConnection(item: ConnectionItem) {
  editingId.value = item.id;
  Object.assign(form, {
    type: item.type,
    environmentIds: [...item.environmentIds],
    connectionGroupId: item.connectionGroupId,
    name: item.name,
    host: item.host,
    port: item.port,
    username: item.username,
    authType: item.authType ?? "password",
    sshKeyId: item.sshKeyId ?? null,
    password: "",
    jumpConnectionId: item.jumpConnectionId ?? null,
    tags: [...(item.tags ?? [])],
    loginScriptEnabled: Boolean(item.options.loginScriptEnabled),
    loginScript: String(item.options.loginScript ?? ""),
    engine: item.engine ?? "mysql",
    defaultDatabase: item.defaultDatabase ?? (item.type === "redis" ? 0 : ""),
    connectionMode: item.connectionMode ?? "tcp",
    sshConnectionId: (item.options.sshConnectionId as string | null | undefined) ?? null,
    sslEnabled: Boolean(((item.options.ssl ?? item.options.tls) as { enabled?: boolean } | undefined)?.enabled),
    rejectUnauthorized: ((item.options.ssl ?? item.options.tls) as { rejectUnauthorized?: boolean } | undefined)?.rejectUnauthorized !== false,
    httpTunnelUrl: String(item.options.httpTunnelUrl ?? ""),
    httpTunnelUsername: "",
    httpTunnelPassword: "",
    httpTunnelRejectUnauthorized: item.options.httpTunnelRejectUnauthorized !== false,
    keySeparator: String(item.options.keySeparator ?? ":"),
    readOnly: Boolean(item.options.readOnly),
    tlsServerName: String((item.options.tls as { serverName?: string } | undefined)?.serverName ?? ""),
    tlsCa: "",
    tlsCertificate: "",
    tlsPrivateKey: "",
    tlsPassphrase: "",
  });
  connectionDialog.value = true;
}

async function saveConnection() {
  if (!form.name.trim() || !form.host.trim() || (form.type !== "redis" && !form.username.trim())) {
    return ElMessage.warning(form.type === "redis" ? tr("请填写连接名称和主机") : tr("请填写连接名称、主机和用户名"));
  }
  saving.value = true;
  try {
    if (form.type === "ssh") {
      if (form.authType === "privateKey" && !form.sshKeyId && !preservesLegacyPrivateKey.value) {
        return ElMessage.warning(tr("请选择用于连接的 SSH 密钥"));
      }
      const credentialChanged = form.authType !== "privateKey" && Boolean(form.password);
      const payload: Record<string, unknown> = {
        environmentIds: form.environmentIds,
        connectionGroupId: form.connectionGroupId,
        name: form.name,
        host: form.host,
        port: form.port,
        username: form.username,
        authType: form.authType,
        sshKeyId: form.authType === "privateKey" ? form.sshKeyId : null,
        jumpConnectionId: form.jumpConnectionId,
        tags: form.tags,
        options: {
          terminalType: "xterm-256color",
          keepAliveSeconds: 30,
          encoding: "utf-8",
          hostKeySha256: "",
          loginScriptEnabled: form.loginScriptEnabled,
          loginScript: form.loginScript,
        },
      };
      if (!editingId.value || credentialChanged) {
        payload.credential = { password: form.password };
      }
      await api(editingId.value ? `/api/v1/ssh-connections/${editingId.value}` : "/api/v1/ssh-connections", {
        method: editingId.value ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
    } else if (form.type === "database") {
      const credentialChanged = Boolean(form.password || form.httpTunnelUsername || form.httpTunnelPassword);
      const payload: Record<string, unknown> = {
        environmentIds: form.environmentIds,
        connectionGroupId: form.connectionGroupId,
        name: form.name,
        engine: form.engine,
        host: form.host,
        port: form.port,
        username: form.username,
        defaultDatabase: form.defaultDatabase,
        connectionMode: form.connectionMode,
        options: {
          charset: "utf8mb4",
          timezone: "local",
          connectTimeoutMs: 10000,
          sshConnectionId: form.sshConnectionId,
          ssl: {
            enabled: form.sslEnabled,
            rejectUnauthorized: form.rejectUnauthorized,
            ca: "",
            certificate: "",
            privateKey: "",
            passphrase: "",
          },
          httpTunnelUrl: form.httpTunnelUrl,
          httpTunnelRejectUnauthorized: form.httpTunnelRejectUnauthorized,
        },
      };
      if (!editingId.value || credentialChanged) payload.credential = { password: form.password, httpTunnelUsername: form.httpTunnelUsername, httpTunnelPassword: form.httpTunnelPassword };
      await api(editingId.value ? `/api/v1/database-connections/${editingId.value}` : "/api/v1/database-connections", {
        method: editingId.value ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
    } else {
      const credentialChanged = Boolean(form.password || form.tlsCa || form.tlsCertificate || form.tlsPrivateKey || form.tlsPassphrase);
      const payload: Record<string, unknown> = {
        environmentIds: form.environmentIds,
        connectionGroupId: form.connectionGroupId,
        name: form.name,
        host: form.host,
        port: form.port,
        username: form.username,
        defaultDatabase: Number(form.defaultDatabase) || 0,
        connectionMode: form.connectionMode === "sshTunnel" ? "sshTunnel" : "tcp",
        options: {
          connectTimeoutMs: 10000,
          keySeparator: form.keySeparator,
          readOnly: form.readOnly,
          sshConnectionId: form.sshConnectionId,
          tls: {
            enabled: form.sslEnabled,
            rejectUnauthorized: form.rejectUnauthorized,
            serverName: form.tlsServerName,
          },
        },
      };
      if (!editingId.value || credentialChanged) {
        payload.credential = {
          password: form.password,
          tlsCa: form.tlsCa,
          tlsCertificate: form.tlsCertificate,
          tlsPrivateKey: form.tlsPrivateKey,
          tlsPassphrase: form.tlsPassphrase,
        };
      }
      await api(editingId.value ? `/api/v1/redis-connections/${editingId.value}` : "/api/v1/redis-connections", {
        method: editingId.value ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
    }
    connectionDialog.value = false;
    ElMessage.success(editingId.value ? tr("连接已更新") : tr("连接已创建并进入资源池"));
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存连接失败"));
  } finally {
    saving.value = false;
  }
}

function openGroupCreate() {
  Object.assign(groupForm, { type: form.type, parentId: null, name: "" });
  groupDialog.value = true;
}

async function createConnectionGroup() {
  if (!groupForm.name.trim()) return ElMessage.warning(tr("请输入连接组名称"));
  saving.value = true;
  try {
    const response = await api<{ id: string }>("/api/v1/connection-groups", { method: "POST", body: JSON.stringify(groupForm) });
    await load();
    form.connectionGroupId = response.id;
    groupDialog.value = false;
    ElMessage.success(tr("连接组已创建"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("创建连接组失败"));
  } finally {
    saving.value = false;
  }
}

function openEnvironmentCreate() {
  Object.assign(environmentForm, {
    name: "",
    groupId: null,
    description: "",
    tags: "",
  });
  environmentDialog.value = true;
}

function openEnvironmentGroupCreate() {
  Object.assign(environmentGroupForm, { name: "", description: "", color: "#1d8a74" });
  environmentGroupDialog.value = true;
}

async function createEnvironmentFromConnection() {
  if (!environmentForm.name.trim()) return ElMessage.warning(tr("请输入环境名称"));
  saving.value = true;
  try {
    const response = await api<{ id: string }>("/api/v1/environments", {
      method: "POST",
      body: JSON.stringify({
        name: environmentForm.name,
        groupId: environmentForm.groupId,
        description: environmentForm.description,
        tags: environmentForm.tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      }),
    });
    environments.value = [...environments.value, { id: response.id, name: environmentForm.name.trim() }]
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    form.environmentIds = [...form.environmentIds, response.id];
    environmentDialog.value = false;
    ElMessage.success(tr("环境已创建并选中"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("创建环境失败"));
  } finally {
    saving.value = false;
  }
}

async function createEnvironmentGroupFromConnection() {
  if (!environmentGroupForm.name.trim()) return ElMessage.warning(tr("请输入环境组名称"));
  saving.value = true;
  try {
    const response = await api<{ id: string }>("/api/v1/environment-groups", {
      method: "POST",
      body: JSON.stringify(environmentGroupForm),
    });
    environmentGroups.value = [...environmentGroups.value, {
      id: response.id,
      name: environmentGroupForm.name.trim(),
      description: environmentGroupForm.description.trim(),
      color: environmentGroupForm.color,
      environmentCount: 0,
    }].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    environmentForm.groupId = response.id;
    environmentGroupDialog.value = false;
    ElMessage.success(tr("环境组已创建并选中"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("创建环境组失败"));
  } finally {
    saving.value = false;
  }
}

async function assignSelected(environmentIds: string[]) {
  if (!selection.value.length) return ElMessage.warning(tr("请先选择连接"));
  saving.value = true;
  try {
    await api("/api/v1/connections/assign", {
      method: "POST",
      body: JSON.stringify({
        environmentIds,
        items: selection.value.map((item) => ({ type: item.type, id: item.id })),
      }),
    });
    assignDialog.value = false;
    ElMessage.success(environmentIds.length ? tr("已关联 {0} 个连接", [selection.value.length]) : tr("已将 {0} 个连接移回待分配", [selection.value.length]));
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("分配连接失败"));
  } finally {
    saving.value = false;
  }
}

async function removeConnection(item: ConnectionItem) {
  try {
    await ElMessageBox.confirm(tr("确定删除连接“{0}”吗？凭据也会一并删除。", [item.name]), tr("删除连接"), {
      confirmButtonText: tr("删除"),
      cancelButtonText: tr("取消"),
      type: "warning",
    });
    const path = item.type === "ssh" ? `/api/v1/ssh-connections/${item.id}` : item.type === "database" ? `/api/v1/database-connections/${item.id}` : `/api/v1/redis-connections/${item.id}`;
    await api(path, {
      method: "DELETE",
    });
    ElMessage.success(tr("连接已删除"));
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除连接失败"));
  }
}

async function copyConnection(item: ConnectionItem) {
  if (item.type !== "redis") return;
  saving.value = true;
  try {
    await api("/api/v1/redis-connections", {
      method: "POST",
      body: JSON.stringify({
        copyFromId: item.id,
        environmentIds: item.environmentIds,
        connectionGroupId: item.connectionGroupId,
        name: tr("{0} 副本", [item.name]),
        host: item.host,
        port: item.port,
        username: item.username,
        defaultDatabase: Number(item.defaultDatabase) || 0,
        connectionMode: item.connectionMode === "sshTunnel" ? "sshTunnel" : "tcp",
        options: item.options,
      }),
    });
    ElMessage.success(tr("Redis 连接及加密凭据已复制"));
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("复制 Redis 连接失败"));
  } finally {
    saving.value = false;
  }
}

async function removeSelected() {
  if (!selection.value.length) return;
  const selected = [...selection.value];
  const sshCount = selected.filter((item) => item.type === "ssh").length;
  const databaseCount = selected.filter((item) => item.type === "database").length;
  const redisCount = selected.filter((item) => item.type === "redis").length;
  try {
    await ElMessageBox.confirm(
      tr("确定删除选中的 {0} 个连接吗？其中 SSH {1} 个、数据库 {2} 个、Redis {3} 个，相关凭据也会一并删除。", [selected.length, sshCount, databaseCount, redisCount]),
      tr("批量删除连接"),
      { confirmButtonText: tr("批量删除"), cancelButtonText: tr("取消"), type: "warning" },
    );
    const response = await api<{ deleted: number }>("/api/v1/connections/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ items: selected.map((item) => ({ type: item.type, id: item.id })) }),
    });
    ElMessage.success(tr("已删除 {0} 个连接", [response.deleted]));
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("批量删除连接失败"));
  }
}

function inspectionStatusText(item: ConnectionItem) {
  if (item.lastInspectionStatus === "available") return tr("上次连接结果：可用");
  if (item.lastInspectionStatus === "unavailable") return tr("上次连接结果：不可用");
  return tr("尚未巡检");
}

function inspectionTime(value: string | null) {
  return value ? new Date(value).toLocaleString(currentLocale()) : "";
}

function resetImport() {
  importStep.value = "upload";
  importType.value = "securecrt";
  importPassphrase.value = "";
  importFile.value = null;
  importBatch.value = null;
  importDecisions.value = {};
  activeImportTab.value = "ssh";
  importDialog.value = true;
}

function chooseImportFile(event: Event) {
  importFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

function initialImportDecision(batch: ImportBatch, item: ImportItem): { action: ImportAction; targetId?: string } {
  if (item.status === "new") return { action: "import" };
  if (item.status === "invalid") return { action: "skip" };
  if (batch.type === "navicat" && item.type === "ssh" && item.conflicts.length === 1) {
    return { action: "reuse", targetId: item.conflicts[0].id };
  }
  return { action: "" };
}

function applyExistingAction(action: "skip" | "keep" | "overwrite") {
  if (!importBatch.value) return;
  for (const item of importItemsForTab.value.filter((candidate) => candidate.status === "conflict")) {
    importDecisions.value[item.id] = {
      action,
      targetId: action === "overwrite" && item.conflicts.length === 1 ? item.conflicts[0].id : undefined,
    };
  }
}

async function previewImport() {
  if (!importFile.value) return ElMessage.warning(tr("请选择连接导出文件"));
  saving.value = true;
  try {
    const formData = new FormData();
    formData.append("type", importType.value);
    formData.append("passphrase", importPassphrase.value);
    formData.append("file", importFile.value);
    const response = await api<{ batch: ImportBatch }>("/api/v1/connection-imports/preview", { method: "POST", body: formData });
    importBatch.value = response.batch;
    importDecisions.value = Object.fromEntries(response.batch.items.map((item) => [item.id, initialImportDecision(response.batch, item)]));
    activeImportTab.value = response.batch.summary.ssh ? "ssh" : "database";
    importStep.value = "preview";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("解析连接文件失败"));
  } finally {
    saving.value = false;
  }
}

async function openImportBatch(batchId: string) {
  try {
    const response = await api<{ batch: ImportBatch }>(`/api/v1/connection-imports/${batchId}`);
    importBatch.value = response.batch;
    importDecisions.value = Object.fromEntries(response.batch.items.map((item) => [item.id, initialImportDecision(response.batch, item)]));
    activeImportTab.value = response.batch.summary.ssh ? "ssh" : "database";
    importStep.value = "preview";
    importDialog.value = true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载同步冲突失败"));
  }
}

async function confirmImport() {
  if (!importBatch.value) return;
  const unresolved = importBatch.value.items.find((item) => !importDecisions.value[item.id]?.action);
  if (unresolved) return ElMessage.warning(tr("请为冲突连接“{0}”选择处理方式", [unresolved.name]));
  const missingTarget = importBatch.value.items.find((item) => ["overwrite", "reuse"].includes(importDecisions.value[item.id]?.action) && !importDecisions.value[item.id]?.targetId);
  if (missingTarget) return ElMessage.warning(tr("请选择“{0}”对应的已有连接", [missingTarget.name]));
  saving.value = true;
  try {
    const response = await api<{ imported: number; reused: number; skipped: number }>(`/api/v1/connection-imports/${importBatch.value.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({
        decisions: importBatch.value.items.map((item) => ({ itemId: item.id, ...importDecisions.value[item.id] })),
      }),
    });
    importDialog.value = false;
    ElMessage.success(tr("导入完成：新增 {0} 个，复用 SSH {1} 个，跳过 {2} 个", [response.imported, response.reused, response.skipped]));
    if (route.query.importBatch) await router.replace({ path: "/connections" });
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("确认导入失败"));
  } finally {
    saving.value = false;
  }
}

async function cancelImport() {
  if (importBatch.value && importStep.value === "preview" && importBatch.value.sourceType !== "securecrt_sync") {
    try {
      await api(`/api/v1/connection-imports/${importBatch.value.id}`, { method: "DELETE" });
    } catch {
      // Preview cleanup is best-effort when closing the dialog.
    }
  }
  importDialog.value = false;
  if (route.query.importBatch) await router.replace({ path: "/connections" });
}

function changeConnectionType(value: "ssh" | "database" | "redis") {
  form.type = value;
  form.connectionGroupId = null;
  form.port = value === "ssh" ? 22 : value === "redis" ? 6379 : 3306;
  form.defaultDatabase = value === "redis" ? 0 : "";
}

watch(() => route.query.create, (value) => {
  if (value === "redis") resetForm("redis");
}, { immediate: true });

onMounted(async () => {
  await load();
  const batchId = typeof route.query.importBatch === "string" ? route.query.importBatch : "";
  if (batchId) await openImportBatch(batchId);
});
</script>

<template>
  <div class="connection-pool" v-loading="loading">
    <PageHeader :title="$t('连接资源池')">
      <template #actions>
        <el-button :aria-label="$t('打开连接工具')" @click="router.push({ name: 'connection-tools' })"><Wrench :size="16" />{{ $t('连接工具') }}</el-button>
        <el-button :aria-label="$t('导入连接')" @click="resetImport"><Upload :size="16" />{{ $t('导入') }}</el-button>
        <el-dropdown split-button type="primary" :aria-label="$t('新建连接')" @click="resetForm('ssh')">
          <span class="button-content"><Plus :size="16" />{{ $t('新建连接') }}</span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="resetForm('ssh')"><TerminalSquare :size="15" />{{ $t('SSH 连接') }}</el-dropdown-item>
              <el-dropdown-item @click="resetForm('database')"><Database :size="15" />{{ $t('数据库连接') }}</el-dropdown-item>
              <el-dropdown-item @click="resetForm('redis')"><MemoryStick :size="15" />{{ $t('Redis 连接') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </template>
    </PageHeader>

    <section class="pool-statline">
      <button :class="{ 'is-active': assignment === 'all' && type === 'all' }" @click="applyInventoryFilter('all')"><span><Boxes :size="17" />{{ $t('全部连接') }}</span><strong>{{ counts.total }}</strong></button>
      <button :class="{ 'is-active': assignment === 'all' && type === 'ssh' }" @click="applyInventoryFilter('ssh')"><span><TerminalSquare :size="17" />SSH</span><strong>{{ counts.ssh }}</strong></button>
      <button :class="{ 'is-active': assignment === 'all' && type === 'database' }" @click="applyInventoryFilter('database')"><span><Database :size="17" />{{ $t('数据库') }}</span><strong>{{ counts.database }}</strong></button>
      <button :class="{ 'is-active': assignment === 'all' && type === 'redis' }" @click="applyInventoryFilter('redis')"><span><MemoryStick :size="17" />Redis</span><strong>{{ counts.redis }}</strong></button>
      <button :class="{ 'is-alert': counts.unassigned > 0, 'is-active': assignment === 'unassigned' }" @click="applyInventoryFilter('unassigned')"><span><Unplug :size="17" />{{ $t('待分配') }}</span><strong>{{ counts.unassigned }}</strong></button>
    </section>

    <section class="pool-panel">
      <header class="pool-toolbar">
        <div class="segmented-control" :aria-label="$t('分配状态')">
          <button v-for="item in [{ value: 'all', label: $t('全部') }, { value: 'unassigned', label: $t('待分配') }, { value: 'assigned', label: $t('已分配') }]" :key="item.value" :class="{ 'is-active': assignment === item.value }" @click="assignment = item.value as typeof assignment; load()">{{ item.label }}</button>
        </div>
        <el-input v-model="keyword" clearable :placeholder="$t('名称、主机、用户名、标签、来源路径')" @keyup.enter="load">
          <template #prefix><Search :size="16" /></template>
        </el-input>
        <el-select v-model="type" @change="load">
          <el-option :label="$t('全部类型')" value="all" />
          <el-option label="SSH" value="ssh" />
          <el-option :label="$t('数据库')" value="database" />
          <el-option label="Redis" value="redis" />
        </el-select>
        <el-button class="refresh-button" :aria-label="$t('刷新连接')" @click="load"><RefreshCw :size="16" /></el-button>
        <div class="pool-toolbar-actions">
          <el-button :disabled="!groupedConnectionRows.length" :aria-label="allConnectionGroupsExpanded ? $t('全部折叠') : $t('全部展开')" @click="toggleAllConnectionGroups">
            <ChevronsDownUp v-if="allConnectionGroupsExpanded" :size="16" />
            <ChevronsUpDown v-else :size="16" />
            {{ allConnectionGroupsExpanded ? $t('全部折叠') : $t('全部展开') }}
          </el-button>
        </div>
      </header>

      <div v-if="selection.length" class="selection-bar">
        <span>{{ $t('已选择') }} <strong>{{ selection.length }}</strong> {{ $t('个连接') }}</span>
        <div>
          <el-button size="small" @click="targetEnvironmentIds = []; assignDialog = true"><Link2 :size="15" />{{ $t('关联环境') }}</el-button>
          <el-button size="small" @click="assignSelected([])"><Unplug :size="15" />{{ $t('移回待分配') }}</el-button>
          <el-button size="small" type="danger" plain @click="removeSelected"><Trash2 :size="15" />{{ $t('批量删除') }}</el-button>
        </div>
      </div>

      <el-table :data="groupedConnectionRows" row-key="id" :expand-row-keys="expandedConnectionGroupIds" :tree-props="{ children: 'children' }" :row-class-name="connectionRowClass" :span-method="connectionCellSpan" class="connection-table" :empty-text='$t("当前筛选下没有连接")' @expand-change="handleConnectionGroupExpansion" @selection-change="handleSelectionChange">
        <el-table-column type="selection" width="48" :selectable="rowSelectable" />
        <el-table-column :label="$t('连接名称')" min-width="230">
          <template #default="{ row }: { row: ConnectionTableRow }">
            <div v-if="isGroupRow(row)" class="connection-group-identity"><FolderTree :size="16" /><strong :title="row.groupPath">{{ row.groupPath }}</strong><small>{{ row.count }} {{ $t('个连接') }}</small></div>
            <div v-else class="connection-identity">
              <span :class="['connection-type-icon', `is-${row.type}`]"><TerminalSquare v-if="row.type === 'ssh'" :size="17" /><MemoryStick v-else-if="row.type === 'redis'" :size="17" /><Database v-else :size="17" /></span>
              <div class="connection-identity-copy"><el-tooltip :content="row.name" placement="bottom-start" :show-after="0" :hide-after="0" :enterable="false" transition="none"><strong>{{ row.name }}</strong></el-tooltip><span v-if="row.type === 'ssh' && row.tags?.length" class="connection-tag-list"><i v-for="tag in row.tags" :key="tag">{{ tag }}</i></span></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="$t('连接类型')" width="120">
          <template #default="{ row }: { row: ConnectionTableRow }"><span v-if="!isGroupRow(row)" class="soft-badge">{{ connectionTypeLabel(row) }}</span></template>
        </el-table-column>
        <el-table-column :label="$t('目标地址')" min-width="210">
          <template #default="{ row }: { row: ConnectionTableRow }"><template v-if="!isGroupRow(row)"><code class="host-address">{{ row.username ? `${row.username}@` : '' }}{{ row.host }}:{{ row.port }}</code><small v-if="row.type === 'redis' || row.defaultDatabase" class="cell-note">/db{{ row.defaultDatabase }}</small></template></template>
        </el-table-column>
        <el-table-column :label="$t('连接方式')" width="145">
          <template #default="{ row }: { row: ConnectionTableRow }"><span v-if="!isGroupRow(row)" class="soft-badge">{{ row.type === 'ssh' ? authLabels[row.authType || 'password'] : modeLabels[row.connectionMode || 'tcp'] }}</span></template>
        </el-table-column>
        <el-table-column :label="$t('关联环境')" min-width="200">
          <template #default="{ row }: { row: ConnectionTableRow }"><template v-if="!isGroupRow(row)"><span v-for="environment in row.environments" :key="environment.id" class="environment-binding"><i></i>{{ environment.name }}</span><span v-if="!row.environments.length" class="unassigned-binding"><Unplug :size="14" />{{ $t('待分配') }}</span></template></template>
        </el-table-column>
        <el-table-column :label="$t('连接组')" min-width="150">
          <template #default="{ row }: { row: ConnectionTableRow }"><template v-if="!isGroupRow(row)"><span v-if="row.connectionGroupPath" class="soft-badge">{{ row.connectionGroupPath }}</span><span v-else class="cell-note">{{ $t('未分组') }}</span></template></template>
        </el-table-column>
        <el-table-column :label="$t('来源')" min-width="145">
          <template #default="{ row }: { row: ConnectionTableRow }"><div v-if="!isGroupRow(row)" class="source-cell"><span>{{ row.sourceName }}</span><small v-if="row.sourcePath">{{ row.sourcePath }}</small></div></template>
        </el-table-column>
        <el-table-column :label="$t('上次巡检')" min-width="190">
          <template #default="{ row }: { row: ConnectionTableRow }">
            <div v-if="!isGroupRow(row)" class="inspection-state" :class="row.lastInspectionStatus ? `is-${row.lastInspectionStatus}` : 'is-unchecked'" :title="row.lastInspectionMessage || inspectionStatusText(row)">
              <span><CircleCheck v-if="row.lastInspectionStatus === 'available'" :size="14" /><CircleX v-else-if="row.lastInspectionStatus === 'unavailable'" :size="14" /><Clock3 v-else :size="14" />{{ inspectionStatusText(row) }}</span>
              <small v-if="row.lastInspectedAt">{{ inspectionTime(row.lastInspectedAt) }}<template v-if="row.lastInspectionLatencyMs !== null"> · {{ row.lastInspectionLatencyMs }} ms</template></small>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="$t('凭据')" width="100" align="center">
          <template #default="{ row }: { row: ConnectionTableRow }"><span v-if="!isGroupRow(row)" class="credential-state" :title="row.hasPassword || row.hasPrivateKey ? $t('凭据已加密保存') : $t('未保存凭据')"><ShieldCheck v-if="row.hasPassword || row.hasPrivateKey" :size="17" /><Unplug v-else :size="16" /></span></template>
        </el-table-column>
        <el-table-column :label="$t('操作')" width="132" fixed="right">
          <template #default="{ row }: { row: ConnectionTableRow }">
            <div v-if="!isGroupRow(row)" class="row-actions"><button v-if="row.type === 'redis'" :aria-label="$t('复制 Redis 连接')" @click="copyConnection(row)"><Copy :size="15" /></button><button :aria-label="$t('编辑连接')" @click="editConnection(row)"><Pencil :size="15" /></button><button :aria-label="$t('删除连接')" class="is-danger" @click="removeConnection(row)"><Trash2 :size="15" /></button></div>
          </template>
        </el-table-column>
      </el-table>

      <div class="mobile-connection-list" :aria-label="$t('连接列表')">
        <section v-for="group in groupedConnectionRows" :key="`mobile:${group.id}`">
          <header><FolderTree :size="15" /><strong>{{ group.groupPath }}</strong><small>{{ group.count }} {{ $t('个连接') }}</small></header>
          <article v-for="row in group.children" :key="`mobile:${row.type}:${row.id}`">
            <label class="mobile-connection-select" :aria-label="$t('选择连接 {0}', [row.name])">
              <input type="checkbox" :checked="mobileConnectionSelected(row)" @change="toggleMobileConnectionSelection(row, $event)" />
            </label>
            <span :class="['connection-type-icon', `is-${row.type}`]"><TerminalSquare v-if="row.type === 'ssh'" :size="16" /><MemoryStick v-else-if="row.type === 'redis'" :size="16" /><Database v-else :size="16" /></span>
            <div class="mobile-connection-copy">
              <el-tooltip :content="row.name" placement="bottom-start" :show-after="0" :hide-after="0" :enterable="false" transition="none"><strong>{{ row.name }}</strong></el-tooltip>
              <code>{{ row.username ? `${row.username}@` : '' }}{{ row.host }}:{{ row.port }}</code>
              <span><em>{{ connectionTypeLabel(row) }}</em><em>{{ row.type === 'ssh' ? authLabels[row.authType || 'password'] : modeLabels[row.connectionMode || 'tcp'] }}</em><em :class="{ 'is-warning': !row.environments.length }">{{ row.environments.length ? row.environments.map((environment) => environment.name).join('、') : $t('待分配') }}</em></span>
            </div>
            <div class="row-actions">
              <button v-if="row.type === 'redis'" :aria-label="$t('复制 Redis 连接')" @click="copyConnection(row)"><Copy :size="15" /></button>
              <button :aria-label="$t('编辑连接')" @click="editConnection(row)"><Pencil :size="15" /></button>
              <button :aria-label="$t('删除连接')" class="is-danger" @click="removeConnection(row)"><Trash2 :size="15" /></button>
            </div>
          </article>
        </section>
        <div v-if="!groupedConnectionRows.length" class="mobile-connection-empty">{{ $t('当前筛选下没有连接') }}</div>
      </div>
    </section>

    <el-dialog v-model="connectionDialog" align-center class="envman-dialog connection-editor-dialog" width="760px" destroy-on-close append-to-body>
      <template #header><div class="dialog-title"><span class="dialog-title__icon"><Pencil v-if="editingId" :size="19" /><Plus v-else :size="19" /></span><div><h3>{{ editingId ? $t('编辑连接') : $t('新建连接') }}</h3></div><TipIcon :content="$t('密码、SSH 密钥与证书使用 AES-256-GCM 加密保存，不会返回到连接列表。')" placement="left" /></div></template>
      <el-form label-position="top" class="connection-form">
        <section class="form-section form-section--type">
          <el-form-item :label="$t('连接类型')">
            <el-radio-group :model-value="form.type" :disabled="Boolean(editingId)" @update:model-value="changeConnectionType">
              <el-radio-button value="ssh"><TerminalSquare :size="15" />{{ $t('SSH 服务器') }}</el-radio-button>
              <el-radio-button value="database"><Database :size="15" />MySQL / MariaDB</el-radio-button>
              <el-radio-button value="redis"><MemoryStick :size="15" />Redis</el-radio-button>
            </el-radio-group>
          </el-form-item>
        </section>

        <section class="form-section">
          <header class="form-section__header"><strong>{{ $t('基本信息') }}</strong></header>
          <div class="form-grid form-grid--two">
            <el-form-item :label="$t('连接名称')" required><el-input v-model="form.name" :placeholder="$t('便于识别的名称')" /></el-form-item>
            <el-form-item :label="$t('连接组')"><div class="inline-create-field"><el-select v-model="form.connectionGroupId" clearable :placeholder="$t('未分组')"><el-option v-for="group in availableGroups" :key="group.id" :label="group.path" :value="group.id" /></el-select><el-button :aria-label="$t('新建连接组')" :title="$t('新建连接组')" @click="openGroupCreate"><Plus :size="14" /></el-button></div></el-form-item>
            <el-form-item :label="$t('关联环境')" class="form-span-2"><div class="inline-create-field"><el-select v-model="form.environmentIds" multiple collapse-tags collapse-tags-tooltip clearable filterable :placeholder="$t('暂不关联')"><el-option v-for="environment in environments" :key="environment.id" :label="environment.name" :value="environment.id" /></el-select><el-button :aria-label="$t('新建环境')" :title="$t('新建环境')" @click="openEnvironmentCreate"><Plus :size="14" /></el-button></div></el-form-item>
            <el-form-item v-if="form.type === 'ssh'" :label="$t('标签')" class="form-span-2"><el-select v-model="form.tags" multiple filterable allow-create default-first-option :placeholder="$t('例如 NACOS、网关、应用服务')" style="width:100%" /></el-form-item>
          </div>
        </section>

        <section class="form-section">
          <header class="form-section__header"><strong>{{ $t('访问地址') }}</strong></header>
          <div class="form-grid form-grid--endpoint">
            <el-form-item :label="$t('主机')" required><el-input v-model="form.host" :placeholder="$t('IP 地址或域名')" /></el-form-item>
            <el-form-item :label="$t('端口')" required><el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" style="width:100%" /></el-form-item>
            <el-form-item :label="form.type === 'redis' ? $t('ACL 用户名（可选）') : $t('用户名')" :required="form.type !== 'redis'"><el-input v-model="form.username" /></el-form-item>
          </div>
        </section>

        <section class="form-section form-section--last">
          <header class="form-section__header"><strong>{{ form.type === 'ssh' ? $t('认证与登录') : form.type === 'redis' ? $t('Redis 与安全') : $t('数据库与安全') }}</strong></header>
          <div class="form-grid form-grid--two">
            <template v-if="form.type === 'ssh'">
              <el-form-item :label="$t('认证方式')"><el-select v-model="form.authType" style="width:100%"><el-option :label="$t('密码')" value="password" /><el-option :label="$t('SSH 密钥')" value="privateKey" /><el-option :label="$t('键盘交互')" value="keyboardInteractive" /></el-select></el-form-item>
              <el-form-item :label="$t('单级跳板机')"><el-select v-model="form.jumpConnectionId" clearable :placeholder="$t('不使用跳板机')" style="width:100%"><el-option v-for="connection in sshOptions" :key="connection.id" :label="`${connection.name} · ${connection.host}`" :value="connection.id" /></el-select></el-form-item>
              <el-form-item v-if="form.authType !== 'privateKey'" :label="$t('密码')" class="form-span-2"><el-input v-model="form.password" type="password" show-password :placeholder="editingId ? $t('留空表示保持原密码') : $t('连接密码')" /></el-form-item>
              <el-form-item v-else :label="$t('SSH 密钥')" class="form-span-2" required>
                <div class="inline-create-field"><el-select v-model="form.sshKeyId" clearable filterable :placeholder="preservesLegacyPrivateKey ? $t('沿用旧版内嵌私钥，或选择托管密钥') : $t('选择当前工作空间的密钥')" style="width:100%"><el-option v-for="key in sshKeys" :key="key.id" :label="`${key.name} · ${key.fingerprint}`" :value="key.id" /></el-select><el-button :aria-label="$t('打开 SSH 密钥管理')" :title="$t('密钥管理')" @click="connectionDialog = false; router.push({ name: 'ssh-keys' })"><KeyRound :size="14" /></el-button></div>
                <small v-if="preservesLegacyPrivateKey && !form.sshKeyId">{{ $t('当前连接仍使用旧版内嵌私钥；选择托管密钥后将改为统一引用。') }}</small><small v-else-if="!sshKeys.length">{{ $t('当前空间没有可用密钥，请先进入 SSH 密钥管理导入或生成。') }}</small>
              </el-form-item>
              <el-form-item :label="$t('登录脚本')" class="form-span-2">
                <SshLoginScriptEditor v-model="form.loginScript" v-model:enabled="form.loginScriptEnabled" />
              </el-form-item>
            </template>

            <template v-else-if="form.type === 'database'">
              <el-form-item :label="$t('数据库类型')"><el-select v-model="form.engine" style="width:100%"><el-option label="MySQL" value="mysql" /><el-option label="MariaDB" value="mariadb" /></el-select></el-form-item>
              <el-form-item :label="$t('默认数据库')"><el-input v-model="form.defaultDatabase" :placeholder="$t('可留空')" /></el-form-item>
              <el-form-item :label="$t('密码')" class="form-span-2"><el-input v-model="form.password" type="password" show-password :placeholder="editingId ? $t('留空表示保持原密码') : $t('数据库密码')" /></el-form-item>
              <el-form-item :label="$t('连接方式')"><el-select v-model="form.connectionMode" style="width:100%"><el-option :label="$t('TCP 直连')" value="tcp" /><el-option label="SSH Tunnel" value="sshTunnel" /><el-option label="HTTP Tunnel" value="httpTunnel" /></el-select></el-form-item>
              <el-form-item v-if="form.connectionMode === 'sshTunnel'" :label="$t('SSH 隧道连接')"><el-select v-model="form.sshConnectionId" :placeholder="$t('选择已有 SSH 连接')" style="width:100%"><el-option v-for="connection in sshOptions" :key="connection.id" :label="`${connection.name} · ${connection.host}`" :value="connection.id" /></el-select></el-form-item>
              <template v-if="form.connectionMode === 'httpTunnel'"><el-form-item label="HTTP Tunnel URL" class="form-span-2"><el-input v-model="form.httpTunnelUrl" placeholder="https://host/path/ntunnel_mysql.php" /><small>{{ $t('兼容 Navicat ntunnel_mysql.php 协议。') }}</small></el-form-item><el-form-item :label="$t('HTTP Basic Auth 用户名')"><el-input v-model="form.httpTunnelUsername" :placeholder="editingId ? $t('留空表示保持原认证') : $t('可选')" /></el-form-item><el-form-item :label="$t('HTTP Basic Auth 密码')"><el-input v-model="form.httpTunnelPassword" type="password" show-password :placeholder="editingId ? $t('留空表示保持原认证') : $t('可选')" /></el-form-item><el-form-item :label="$t('校验 Tunnel HTTPS 证书')"><el-switch v-model="form.httpTunnelRejectUnauthorized" /></el-form-item></template>
              <el-form-item :label="$t('启用 SSL/TLS')"><el-switch v-model="form.sslEnabled" /></el-form-item>
              <el-form-item v-if="form.sslEnabled" :label="$t('校验服务器证书')"><el-switch v-model="form.rejectUnauthorized" /></el-form-item>
            </template>
            <template v-else>
              <el-form-item :label="$t('默认逻辑库')"><el-input-number v-model="form.defaultDatabase" :min="0" :max="1023" controls-position="right" style="width:100%" /></el-form-item>
              <el-form-item :label="$t('键名分隔符')"><el-input v-model="form.keySeparator" maxlength="16" placeholder=":" /></el-form-item>
              <el-form-item :label="$t('密码')" class="form-span-2"><el-input v-model="form.password" type="password" show-password :placeholder="editingId ? $t('留空表示保持原密码') : $t('Redis 密码，可留空')" /></el-form-item>
              <el-form-item :label="$t('连接方式')"><el-select v-model="form.connectionMode" style="width:100%"><el-option :label="$t('TCP 直连')" value="tcp" /><el-option label="SSH Tunnel" value="sshTunnel" /></el-select></el-form-item>
              <el-form-item v-if="form.connectionMode === 'sshTunnel'" :label="$t('SSH 隧道连接')"><el-select v-model="form.sshConnectionId" :placeholder="$t('选择已有 SSH 连接')" style="width:100%"><el-option v-for="connection in sshOptions" :key="connection.id" :label="`${connection.name} · ${connection.host}`" :value="connection.id" /></el-select></el-form-item>
              <el-form-item><template #label><span class="form-label-with-tip">{{ $t('只读模式') }}<TipIcon :content="$t('开启后，可信执行端会拒绝所有写命令。')" placement="right" /></span></template><el-switch v-model="form.readOnly" /></el-form-item>
              <el-form-item :label="$t('启用 TLS')"><el-switch v-model="form.sslEnabled" /></el-form-item>
              <template v-if="form.sslEnabled">
                <el-form-item :label="$t('校验服务器证书')"><el-switch v-model="form.rejectUnauthorized" /></el-form-item>
                <el-form-item :label="$t('TLS 服务器名称')"><el-input v-model="form.tlsServerName" :placeholder="$t('默认使用连接主机')" /></el-form-item>
                <el-form-item :label="$t('CA 证书')" class="form-span-2 form-item--code"><el-input v-model="form.tlsCa" type="textarea" :rows="3" :placeholder="editingId ? $t('留空表示保持原 CA') : $t('可选 PEM')" /></el-form-item>
                <el-form-item :label="$t('客户端证书')" class="form-span-2 form-item--code"><el-input v-model="form.tlsCertificate" type="textarea" :rows="3" :placeholder="editingId ? $t('留空表示保持原证书') : $t('可选 PEM')" /></el-form-item>
                <el-form-item :label="$t('客户端私钥')" class="form-span-2 form-item--code"><el-input v-model="form.tlsPrivateKey" type="textarea" :rows="4" :placeholder="editingId ? $t('留空表示保持原私钥') : $t('可选 PEM')" /></el-form-item>
                <el-form-item :label="$t('私钥口令')"><el-input v-model="form.tlsPassphrase" type="password" show-password :placeholder="editingId ? $t('留空表示保持原口令') : $t('可选')" /></el-form-item>
              </template>
            </template>
          </div>
        </section>
      </el-form>
      <template #footer><el-button @click="connectionDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="saveConnection">{{ editingId ? $t('保存修改') : $t('创建连接') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="environmentDialog" align-center class="envman-dialog connection-environment-dialog" width="620px" append-to-body>
      <template #header><div class="dialog-title"><span class="dialog-title__icon"><Layers3 :size="19" /></span><div><h3>{{ $t('新建环境') }}</h3></div><TipIcon :content="$t('创建后会自动选中该环境，当前连接表单不会被清空。')" placement="left" /></div></template>
      <el-form label-position="top" class="dialog-form-grid">
        <el-form-item :label="$t('环境名称')" required><el-input v-model="environmentForm.name" maxlength="120" :placeholder="$t('例如：NCCP 生产环境')" /></el-form-item>
        <el-form-item :label="$t('环境组')"><div class="inline-create-field"><el-select v-model="environmentForm.groupId" clearable :placeholder="$t('未分组')"><el-option v-for="group in environmentGroups" :key="group.id" :label="group.name" :value="group.id" /></el-select><el-button :aria-label="$t('新建环境组')" :title="$t('新建环境组')" @click="openEnvironmentGroupCreate"><Plus :size="14" /></el-button></div></el-form-item>
        <el-form-item :label="$t('标签')" class="form-span-2"><el-input v-model="environmentForm.tags" :placeholder="$t('多个标签用逗号分隔')" /></el-form-item>
        <el-form-item :label="$t('环境说明')" class="form-span-2"><el-input v-model="environmentForm.description" type="textarea" :rows="3" maxlength="2000" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="environmentDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="createEnvironmentFromConnection">{{ $t('创建并选中') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="environmentGroupDialog" align-center class="envman-dialog compact-dialog" width="500px" append-to-body>
      <template #header><div class="dialog-title"><span class="dialog-title__icon"><FolderPlus :size="19" /></span><div><h3>{{ $t('新建环境组') }}</h3></div></div></template>
      <el-form label-position="top" class="polished-dialog-form">
        <el-form-item :label="$t('环境组名称')" required><el-input v-model="environmentGroupForm.name" maxlength="80" /></el-form-item>
        <el-form-item :label="$t('说明')"><el-input v-model="environmentGroupForm.description" type="textarea" :rows="3" maxlength="500" /></el-form-item>
        <el-form-item :label="$t('识别色')"><el-color-picker v-model="environmentGroupForm.color" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="environmentGroupDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="createEnvironmentGroupFromConnection">{{ $t('创建并选中') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="groupDialog" align-center class="envman-dialog compact-dialog" width="500px" append-to-body>
      <template #header><div class="dialog-title"><span class="dialog-title__icon"><Boxes :size="19" /></span><div><h3>{{ $t('新建连接组') }}</h3></div><TipIcon :content="$t('连接组独立于环境，仅用于整理同类型连接。')" placement="left" /></div></template>
      <el-form label-position="top" class="polished-dialog-form">
        <el-form-item :label="$t('连接类型')"><el-radio-group v-model="groupForm.type"><el-radio-button value="ssh">SSH</el-radio-button><el-radio-button value="database">{{ $t('数据库') }}</el-radio-button><el-radio-button value="redis">Redis</el-radio-button></el-radio-group></el-form-item>
        <el-form-item :label="$t('上级连接组')"><el-select v-model="groupForm.parentId" clearable :placeholder="$t('顶级连接组')" style="width:100%"><el-option v-for="group in availableParentGroups" :key="group.id" :label="group.path" :value="group.id" /></el-select></el-form-item>
        <el-form-item :label="$t('连接组名称')" required><el-input v-model="groupForm.name" maxlength="80" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="groupDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="createConnectionGroup">{{ $t('创建') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="assignDialog" align-center class="envman-dialog compact-dialog" width="540px" append-to-body>
      <template #header><div class="dialog-title"><span class="dialog-title__icon"><Link2 :size="19" /></span><div><h3>{{ $t('关联环境') }}</h3></div><TipIcon :content="$t('所选连接会使用同一组环境，原有关联将被替换。')" placement="left" /></div></template>
      <el-form label-position="top" class="polished-dialog-form"><el-form-item :label="$t('目标环境')" required><el-select v-model="targetEnvironmentIds" multiple filterable :placeholder="$t('选择一个或多个环境')" style="width:100%"><el-option v-for="environment in environments" :key="environment.id" :label="environment.name" :value="environment.id" /></el-select></el-form-item></el-form>
      <template #footer><el-button @click="assignDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :disabled="!targetEnvironmentIds.length" :loading="saving" @click="assignSelected(targetEnvironmentIds)">{{ $t('确认关联') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="importDialog" align-center class="envman-dialog import-dialog" width="1040px" append-to-body :close-on-click-modal="false" @close="cancelImport">
      <template #header><div class="dialog-title"><span class="dialog-title__icon"><RefreshCw v-if="importBatch?.sourceType === 'securecrt_sync'" :size="19" /><Upload v-else :size="19" /></span><div><h3>{{ importBatch?.sourceType === 'securecrt_sync' ? $t('处理同步连接') : $t('导入连接') }}</h3></div><TipIcon :content="$t('导入口令只在服务端内存中解密，凭据会立即转换为 Viron 加密格式；预览不会返回明文。')" placement="left" /></div></template>
      <div class="import-steps"><span :class="{ 'is-active': importStep === 'upload' }"><i>01</i>{{ $t('选择来源') }}</span><em></em><span :class="{ 'is-active': importStep === 'preview' }"><i>02</i>{{ $t('预览与已存在连接处理') }}</span></div>
      <template v-if="importStep === 'upload'">
        <div class="import-source-switch">
          <button :class="{ 'is-active': importType === 'securecrt' }" @click="importType = 'securecrt'; importFile = null"><TerminalSquare :size="20" /><span><strong>SecureCRT</strong><small>{{ $t('INI、Session 或配置目录 ZIP') }}</small></span></button>
          <button :class="{ 'is-active': importType === 'navicat' }" @click="importType = 'navicat'; importFile = null"><Database :size="20" /><span><strong>Navicat</strong><small>Navicat 15–17 NCX / XML</small></span></button>
        </div>
        <button class="import-dropzone" @click="importInput?.click()"><Upload :size="26" /><strong>{{ importFile?.name || $t('选择连接导出文件') }}</strong><span>{{ importFile ? `${(importFile.size / 1024).toFixed(1)} KB` : importType === 'securecrt' ? 'INI / Session / ZIP' : 'NCX / XML / ZIP' }}</span></button>
        <input ref="importInput" type="file" hidden :accept="importType === 'securecrt' ? '.ini,.session,.zip' : '.ncx,.xml,.zip'" @change="chooseImportFile" />
        <el-form v-if="importType === 'securecrt'" label-position="top" class="import-options"><el-form-item><template #label><span class="form-label-with-tip">{{ $t('SecureCRT 配置口令（可选）') }}<TipIcon :content="$t('Password V2 解密失败时连接仍会导入，并标记为需要补录凭据。')" placement="right" /></span></template><el-input v-model="importPassphrase" type="password" show-password :placeholder="$t('没有设置配置口令时留空')" /></el-form-item></el-form>
      </template>
      <template v-else-if="importBatch">
        <div class="import-summary">
          <article><span>{{ $t('识别连接') }}</span><strong>{{ importBatch.summary.total }}</strong></article><article><span>SSH</span><strong>{{ importBatch.summary.ssh }}</strong></article><article><span>{{ $t('数据库') }}</span><strong>{{ importBatch.summary.database }}</strong></article><article class="is-conflict"><span>{{ $t('连接已存在') }}</span><strong>{{ importBatch.summary.conflict }}</strong></article><article class="is-invalid"><span>{{ $t('不可导入') }}</span><strong>{{ importBatch.summary.invalid }}</strong></article>
        </div>
        <nav class="import-type-tabs" :aria-label="$t('导入连接类型')">
          <button :class="{ 'is-active': activeImportTab === 'ssh' }" @click="activeImportTab = 'ssh'"><TerminalSquare :size="17" /><span>{{ $t('SSH 连接') }}</span><b>{{ importBatch.summary.ssh }}</b><small v-if="importBatch.summary.conflictSsh">{{ importBatch.summary.conflictSsh }} {{ $t('已存在') }}</small></button>
          <button :class="{ 'is-active': activeImportTab === 'database' }" @click="activeImportTab = 'database'"><Database :size="17" /><span>{{ $t('数据库连接') }}</span><b>{{ importBatch.summary.database }}</b><small v-if="importBatch.summary.conflictDatabase">{{ importBatch.summary.conflictDatabase }} {{ $t('已存在') }}</small></button>
        </nav>
        <div v-if="activeImportConflictCount" class="import-bulk-actions"><span><AlertTriangle :size="16" /><span><strong>{{ activeImportConflictCount }}</strong> {{ $t('条') }}{{ activeImportTab === 'ssh' ? ' SSH' : $t('数据库') }}{{ $t('连接已存在') }}<small>{{ $t('批量操作仅作用于当前 Tab') }}</small></span></span><div><el-button @click="applyExistingAction('skip')">{{ $t('当前页全部跳过') }}</el-button><el-button @click="applyExistingAction('keep')">{{ $t('当前页全部保留副本') }}</el-button><el-button type="primary" plain @click="applyExistingAction('overwrite')">{{ $t('当前页全部覆盖') }}</el-button></div></div>
        <div class="import-preview-list">
          <article v-for="item in importItemsForTab" :key="item.id" class="import-preview-row" :class="`is-${item.status}`">
            <span class="connection-type-icon" :class="`is-${item.type === 'ssh' ? 'ssh' : 'database'}`"><TerminalSquare v-if="item.type === 'ssh'" :size="16" /><Database v-else :size="16" /></span>
            <div class="import-preview-identity"><strong>{{ item.name }}</strong><code>{{ item.endpoint }}</code><small>{{ item.sourcePath }}</small><div v-if="item.status === 'conflict'" class="existing-match-list"><span v-for="existing in item.conflicts" :key="existing.id"><i>{{ $t('已存在') }}</i><b>{{ existing.name }}</b><em>{{ existing.connectionGroupPath || $t('未分组') }}<template v-if="existing.environmentName"> · {{ existing.environmentName }}</template></em></span></div><p v-for="warning in item.warnings" :key="warning"><AlertTriangle :size="12" />{{ warning }}</p></div>
            <span class="credential-state-label" :class="{ 'has-credential': item.hasCredential }"><ShieldCheck :size="14" />{{ item.hasCredential ? $t('凭据已解析') : $t('需要补录凭据') }}</span>
            <div class="import-decision">
              <template v-if="item.status === 'conflict'">
                <el-select v-model="importDecisions[item.id].action" :placeholder="$t('选择处理方式')"><el-option v-if="importBatch.type === 'navicat' && item.type === 'ssh'" :label="$t('复用已有 SSH（推荐）')" value="reuse" /><el-option :label="$t('保留为副本')" value="keep" /><el-option :label="$t('覆盖已有连接')" value="overwrite" /><el-option :label="$t('跳过此次连接')" value="skip" /></el-select>
                <el-select v-if="['overwrite', 'reuse'].includes(importDecisions[item.id].action)" v-model="importDecisions[item.id].targetId" :placeholder="importDecisions[item.id].action === 'reuse' ? $t('选择复用目标') : $t('选择覆盖目标')"><el-option v-for="conflict in item.conflicts" :key="conflict.id" :label="`${conflict.name} · ${conflict.connectionGroupPath || $t('未分组')}`" :value="conflict.id" /></el-select>
              </template>
              <span v-else-if="item.status === 'invalid'" class="decision-label is-invalid">{{ $t('跳过 · 信息不完整') }}</span>
              <span v-else class="decision-label">{{ $t('新增到资源池') }}</span>
            </div>
          </article>
          <div v-if="!importItemsForTab.length" class="import-tab-empty"><Database v-if="activeImportTab === 'database'" :size="25" /><TerminalSquare v-else :size="25" /><strong>{{ $t('没有') }}{{ activeImportTab === 'ssh' ? ' SSH' : $t('数据库') }}{{ $t('连接') }}</strong><span>{{ $t('切换到另一个 Tab 查看已识别的连接。') }}</span></div>
        </div>
      </template>
      <template #footer><el-button @click="cancelImport">{{ importBatch?.sourceType === 'securecrt_sync' ? $t('稍后处理') : $t('取消') }}</el-button><el-button v-if="importStep === 'upload'" type="primary" :loading="saving" :disabled="!importFile" @click="previewImport">{{ $t('解析并预览') }}</el-button><el-button v-else type="primary" :loading="saving" @click="confirmImport">{{ $t('确认导入') }}</el-button></template>
    </el-dialog>
  </div>
</template>
