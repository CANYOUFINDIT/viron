<script setup lang="ts">import { translate as tr } from "../i18n";

import { BadgeCheck, Copy, Database, KeyRound, Pencil, Plus, Trash2 } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import { session } from "../session";
import ConnectionMethodPicker from "./ConnectionMethodPicker.vue";
import DatabaseTlsSettings from "./DatabaseTlsSettings.vue";
import SshLoginScriptEditor from "./SshLoginScriptEditor.vue";
import TipIcon from "./TipIcon.vue";

interface EnvironmentItem { id: string; name: string }
interface ConnectionGroup { id: string; type: "ssh" | "database" | "redis"; path: string }
interface SshOption { id: string; name: string; host: string }
interface SshKeyOption { id: string; name: string; fingerprint: string; algorithm: string }

interface EditableConnection {
  id: string;
  profileParentId?: string | null;
  profileName?: string;
  type: "ssh" | "database" | "redis";
  environmentId: string | null;
  environmentIds?: string[];
  connectionGroupId: string | null;
  name: string;
  host: string;
  port: number;
  username: string;
  authType?: "password" | "privateKey" | "keyboardInteractive" | "sshAgent";
  sshKeyId?: string | null;
  hasPrivateKey?: boolean;
  hasTlsCa?: boolean;
  hasTlsCertificate?: boolean;
  hasTlsPrivateKey?: boolean;
  hasTlsPassphrase?: boolean;
  jumpConnectionId?: string | null;
  tags?: string[];
  engine?: "mysql" | "mariadb";
  defaultDatabase?: string | number;
  connectionMode?: "tcp" | "sshTunnel" | "httpTunnel";
  options: Record<string, unknown>;
}

const props = defineProps<{
  modelValue: boolean;
  connection: EditableConnection | null;
  copyMode?: boolean;
  profileParentId?: string;
  profiles?: EditableConnection[];
  activeProfileId?: string;
  connected?: boolean;
  connectionType?: "ssh" | "database" | "redis";
  defaultEnvironmentId?: string | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  saved: [];
  profileAction: [action: "create" | "edit" | "duplicate" | "delete" | "set-active", profileId?: string];
}>();

const router = useRouter();

const loadingOptions = ref(false);
const saving = ref(false);
const environments = ref<EnvironmentItem[]>([]);
const connectionGroups = ref<ConnectionGroup[]>([]);
const sshOptions = ref<SshOption[]>([]);
const sshKeys = ref<SshKeyOption[]>([]);
const selectedProfileId = ref("main");
const form = reactive({
  environmentIds: [] as string[],
  connectionGroupId: null as string | null,
  name: "",
  host: "",
  port: 22,
  username: "",
  authType: "password" as "password" | "privateKey" | "keyboardInteractive" | "sshAgent",
  sshKeyId: null as string | null,
  password: "",
  jumpConnectionId: null as string | null,
  tags: [] as string[],
  loginScriptEnabled: false,
  loginScript: "",
  terminalType: "xterm-256color",
  keepAliveSeconds: 30,
  hostKeySha256: "",
  connectTimeoutSeconds: 15,
  ipVersion: "auto" as "auto" | "ipv4" | "ipv6",
  compression: false,
  agentForwarding: false,
  agentSocket: "",
  algorithmPreset: "default" as "default" | "modern" | "compatible",
  proxyType: "none" as "none" | "http" | "socks5",
  proxyHost: "",
  proxyPort: 1080,
  proxyUsername: "",
  proxyPassword: "",
  engine: "mysql" as "mysql" | "mariadb",
  defaultDatabase: "",
  connectionMode: "tcp" as "tcp" | "sshTunnel" | "httpTunnel",
  sshConnectionId: null as string | null,
  sslEnabled: false,
  rejectUnauthorized: true,
  httpTunnelUrl: "",
  httpTunnelUsername: "",
  httpTunnelPassword: "",
  httpTunnelRejectUnauthorized: true,
  charset: "utf8mb4",
  timezone: "local",
  connectTimeoutMs: 10000,
  tlsCa: "",
  tlsCertificate: "",
  tlsPrivateKey: "",
  tlsPassphrase: "",
  redisDatabase: 0,
  keySeparator: ":",
  readOnly: false,
  tlsServerName: "",
});

const isCopying = computed(() => Boolean(props.connection && props.copyMode));
const isProfile = computed(() => Boolean(props.connection && props.profileParentId));
const isEditingProfile = computed(() => Boolean(isProfile.value && props.connection?.profileParentId === props.profileParentId));
const isCreatingProfile = computed(() => isProfile.value && !isEditingProfile.value);
const isEditing = computed(() => Boolean(props.connection && !props.copyMode && (!props.profileParentId || isEditingProfile.value)));
const preservesCredential = computed(() => isEditing.value || isCopying.value || isProfile.value);
const preservesLegacyPrivateKey = computed(() => Boolean(props.connection?.authType === "privateKey" && props.connection.hasPrivateKey && !props.connection.sshKeyId));
const activeConnectionType = computed<"ssh" | "database" | "redis">(() => props.connection?.type ?? props.connectionType ?? "ssh");
const availableGroups = computed(() => connectionGroups.value.filter((item) => item.type === activeConnectionType.value));
const availableSshOptions = computed(() => sshOptions.value.filter((item) => !isEditing.value || item.id !== props.connection?.id));
const profileManagerVisible = computed(() => Boolean(
  props.connection
  && activeConnectionType.value === "database"
  && !props.copyMode
  && !props.profileParentId
  && !props.connection.profileParentId,
));
const selectedProfile = computed(() => props.profiles?.find((profile) => profile.id === selectedProfileId.value) ?? null);
const selectedProfileIsActive = computed(() => selectedProfileId.value === (props.activeProfileId || "main"));
const dialogTitle = computed(() => {
  if (isCreatingProfile.value) return tr("新建连接配置文件");
  if (isEditingProfile.value) return tr("编辑连接配置文件");
  const type = activeConnectionType.value;
  if (isCopying.value) return type === "ssh" ? tr("复制 SSH 连接") : type === "redis" ? tr("复制 Redis 连接") : tr("复制数据库连接");
  if (isEditing.value) return type === "ssh" ? tr("编辑 SSH 连接") : type === "redis" ? tr("编辑 Redis 连接") : tr("编辑数据库连接");
  return type === "ssh" ? tr("新建 SSH 连接") : type === "redis" ? tr("新建 Redis 连接") : tr("新建数据库连接");
});
const sshAuthChoices = computed(() => [
  { value: "password", title: tr("密码"), description: tr("标准用户名与密码认证，适合常规主机。"), badge: tr("通用") },
  { value: "privateKey", title: tr("SSH 密钥"), description: tr("引用工作空间托管密钥，适合生产环境。"), badge: tr("推荐") },
  { value: "keyboardInteractive", title: tr("键盘交互"), description: tr("应对 PAM、堡垒机与动态挑战提示。"), badge: "PAM" },
  { value: "sshAgent", title: "SSH Agent", description: tr("使用执行端 ssh-agent 或 Pageant 中已解锁的密钥。"), badge: tr("免密钥落库") },
]);
const databaseModeChoices = computed(() => [
  { value: "tcp", title: tr("TCP 直连"), description: tr("直接访问数据库地址，适合内网、VPN 与云网络。"), badge: tr("标准") },
  { value: "sshTunnel", title: "SSH Tunnel", description: tr("复用已托管的 SSH 认证与跳板链路。"), badge: tr("安全") },
  { value: "httpTunnel", title: "HTTP Tunnel", description: tr("通过兼容 Navicat 的 HTTP 端点访问受限网络。"), badge: tr("兼容") },
]);

function close() {
  emit("update:modelValue", false);
}

function initializeForm() {
  const connection = props.connection;
  const connectionType = activeConnectionType.value;
  const options = connection?.options ?? {};
  const security = (connectionType === "redis" ? options.tls : options.ssl) as { enabled?: boolean; rejectUnauthorized?: boolean; serverName?: string } | undefined;
  Object.assign(form, {
    environmentIds: [...(connection?.environmentIds ?? (connection?.environmentId ? [connection.environmentId] : props.defaultEnvironmentId ? [props.defaultEnvironmentId] : []))],
    connectionGroupId: connection?.connectionGroupId ?? null,
    name: isCreatingProfile.value ? "" : isEditingProfile.value ? connection?.profileName ?? "" : connection ? (isCopying.value ? tr("{0} 副本", [connection.name.slice(0, 157)]) : connection.name) : "",
    host: connection?.host ?? "",
    port: connection?.port ?? (connectionType === "ssh" ? 22 : connectionType === "redis" ? 6379 : 3306),
    username: connection?.username ?? "",
    authType: connection?.authType ?? "password",
    sshKeyId: connection?.sshKeyId ?? null,
    password: "",
    jumpConnectionId: connection?.jumpConnectionId ?? null,
    tags: [...(connection?.tags ?? [])],
    loginScriptEnabled: Boolean(options.loginScriptEnabled),
    loginScript: String(options.loginScript ?? ""),
    terminalType: String(options.terminalType ?? "xterm-256color"),
    keepAliveSeconds: Number(options.keepAliveSeconds ?? 30),
    hostKeySha256: String(options.hostKeySha256 ?? ""),
    connectTimeoutSeconds: Number(options.connectTimeoutSeconds ?? 15),
    ipVersion: (options.ipVersion as "auto" | "ipv4" | "ipv6" | undefined) ?? "auto",
    compression: Boolean(options.compression),
    agentForwarding: Boolean(options.agentForwarding),
    agentSocket: String(options.agentSocket ?? ""),
    algorithmPreset: (options.algorithmPreset as "default" | "modern" | "compatible" | undefined) ?? "default",
    proxyType: (options.proxyType as "none" | "http" | "socks5" | undefined) ?? "none",
    proxyHost: String(options.proxyHost ?? ""),
    proxyPort: Number(options.proxyPort ?? 1080),
    proxyUsername: String(options.proxyUsername ?? ""),
    proxyPassword: "",
    engine: connection?.engine ?? "mysql",
    defaultDatabase: typeof connection?.defaultDatabase === "string" ? connection.defaultDatabase : "",
    redisDatabase: connectionType === "redis" ? Number(connection?.defaultDatabase ?? 0) || 0 : 0,
    connectionMode: connectionType === "redis" && connection?.connectionMode === "httpTunnel" ? "tcp" : connection?.connectionMode ?? "tcp",
    sshConnectionId: (options.sshConnectionId as string | null | undefined) ?? null,
    sslEnabled: Boolean(security?.enabled),
    rejectUnauthorized: security?.rejectUnauthorized !== false,
    httpTunnelUrl: String(options.httpTunnelUrl ?? ""),
    httpTunnelUsername: "",
    httpTunnelPassword: "",
    httpTunnelRejectUnauthorized: options.httpTunnelRejectUnauthorized !== false,
    charset: String(options.charset ?? "utf8mb4"),
    timezone: String(options.timezone ?? "local"),
    connectTimeoutMs: Number(options.connectTimeoutMs ?? 10000),
    keySeparator: String(options.keySeparator ?? ":"),
    readOnly: Boolean(options.readOnly),
    tlsServerName: String(security?.serverName ?? ""),
    tlsCa: "",
    tlsCertificate: "",
    tlsPrivateKey: "",
    tlsPassphrase: "",
  });
}

async function loadOptions() {
  loadingOptions.value = true;
  try {
    const [environmentResponse, groupResponse, sshResponse, keyResponse] = await Promise.all([
      api<{ items: EnvironmentItem[] }>("/api/v1/environments"),
      api<{ items: ConnectionGroup[] }>("/api/v1/connection-groups"),
      api<{ items: SshOption[] }>("/api/v1/connections?type=ssh"),
      ["owner", "admin"].includes(session.workspace?.role ?? "") ? api<{ items: SshKeyOption[] }>("/api/v1/ssh-keys") : Promise.resolve({ items: [] as SshKeyOption[] }),
    ]);
    environments.value = environmentResponse.items;
    connectionGroups.value = groupResponse.items;
    sshOptions.value = sshResponse.items;
    sshKeys.value = keyResponse.items;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载连接编辑选项失败"));
  } finally {
    loadingOptions.value = false;
  }
}

async function save() {
  const connection = props.connection;
  const connectionType = activeConnectionType.value;
  if (!form.name.trim() || !form.host.trim() || (connectionType !== "redis" && !form.username.trim())) {
    return ElMessage.warning(connectionType === "redis" ? tr("请填写连接名称和主机") : tr("请填写连接名称、主机和用户名"));
  }
  saving.value = true;
  try {
    if (connectionType === "ssh") {
      if (form.authType === "privateKey" && !form.sshKeyId && !preservesLegacyPrivateKey.value) return ElMessage.warning(tr("请选择用于连接的 SSH 密钥"));
      if (form.jumpConnectionId && form.proxyType !== "none") return ElMessage.warning(tr("ProxyJump 与出站代理不能同时配置；请把代理配置在最外层跳板机上"));
      if (form.proxyType !== "none" && !form.proxyHost.trim()) return ElMessage.warning(tr("请填写代理服务器地址"));
      const currentOptions = connection?.options ?? {};
      const payload: Record<string, unknown> = {
        copyFromId: isCopying.value ? connection?.id : undefined,
        environmentIds: form.environmentIds,
        connectionGroupId: form.connectionGroupId,
        name: form.name,
        profileName: isProfile.value ? form.name : undefined,
        host: form.host,
        port: form.port,
        username: form.username,
        authType: form.authType,
        sshKeyId: form.authType === "privateKey" ? form.sshKeyId : null,
        jumpConnectionId: form.jumpConnectionId,
        tags: form.tags,
        options: {
          ...currentOptions,
          terminalType: form.terminalType,
          keepAliveSeconds: form.keepAliveSeconds,
          encoding: String(currentOptions.encoding ?? "utf-8"),
          hostKeySha256: form.hostKeySha256.trim(),
          loginScriptEnabled: form.loginScriptEnabled,
          loginScript: form.loginScript,
          connectTimeoutSeconds: form.connectTimeoutSeconds,
          ipVersion: form.ipVersion,
          compression: form.compression,
          agentForwarding: form.agentForwarding,
          agentSocket: form.agentSocket.trim(),
          algorithmPreset: form.algorithmPreset,
          proxyType: form.proxyType,
          proxyHost: form.proxyHost.trim(),
          proxyPort: form.proxyPort,
          proxyUsername: form.proxyUsername,
        },
      };
      const credential: Record<string, string> = {};
      if ((form.authType === "password" || form.authType === "keyboardInteractive") && form.password) credential.password = form.password;
      if (form.proxyPassword) credential.proxyPassword = form.proxyPassword;
      if (!connection || Object.keys(credential).length) payload.credential = credential;
      await api(isEditing.value ? `/api/v1/ssh-connections/${connection!.id}` : "/api/v1/ssh-connections", {
        method: isEditing.value ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
    } else if (connectionType === "database") {
      if (form.connectionMode === "sshTunnel" && !form.sshConnectionId) return ElMessage.warning(tr("请选择用于数据库隧道的 SSH 连接"));
      if (form.connectionMode === "httpTunnel" && !form.httpTunnelUrl.trim()) return ElMessage.warning(tr("请填写 HTTP Tunnel URL"));
      const hasCertificate = Boolean(form.tlsCertificate || connection?.hasTlsCertificate);
      const hasPrivateKey = Boolean(form.tlsPrivateKey || connection?.hasTlsPrivateKey);
      if (form.sslEnabled && hasCertificate !== hasPrivateKey) return ElMessage.warning(tr("双向 TLS 必须同时配置客户端证书和客户端私钥"));
      const currentOptions = connection?.options ?? {};
      const currentSsl = (currentOptions.ssl as Record<string, unknown> | undefined) ?? {};
      const payload: Record<string, unknown> = {
        copyFromId: isCopying.value ? connection?.id : undefined,
        profileName: isProfile.value ? form.name : undefined,
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
          ...currentOptions,
          charset: form.charset,
          timezone: form.timezone,
          connectTimeoutMs: form.connectTimeoutMs,
          sshConnectionId: form.sshConnectionId,
          ssl: { ...currentSsl, enabled: form.sslEnabled, rejectUnauthorized: form.rejectUnauthorized },
          httpTunnelUrl: form.httpTunnelUrl,
          httpTunnelRejectUnauthorized: form.httpTunnelRejectUnauthorized,
        },
      };
      if (!connection || form.password || form.httpTunnelUsername || form.httpTunnelPassword || form.tlsCa || form.tlsCertificate || form.tlsPrivateKey || form.tlsPassphrase) {
        payload.credential = {
          password: form.password,
          httpTunnelUsername: form.httpTunnelUsername,
          httpTunnelPassword: form.httpTunnelPassword,
          tlsCa: form.tlsCa,
          tlsCertificate: form.tlsCertificate,
          tlsPrivateKey: form.tlsPrivateKey,
          tlsPassphrase: form.tlsPassphrase,
        };
      }
      const path = isProfile.value
        ? `/api/v1/database-connections/${props.profileParentId}/profiles${isEditingProfile.value ? `/${connection!.id}` : ""}`
        : isEditing.value ? `/api/v1/database-connections/${connection!.id}` : "/api/v1/database-connections";
      await api(path, {
        method: isEditing.value ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
    } else {
      if (form.connectionMode === "sshTunnel" && !form.sshConnectionId) return ElMessage.warning(tr("请选择用于 Redis 隧道的 SSH 连接"));
      const hasCertificate = Boolean(form.tlsCertificate || connection?.hasTlsCertificate);
      const hasPrivateKey = Boolean(form.tlsPrivateKey || connection?.hasTlsPrivateKey);
      if (form.sslEnabled && hasCertificate !== hasPrivateKey) return ElMessage.warning(tr("双向 TLS 必须同时配置客户端证书和客户端私钥"));
      const credentialChanged = Boolean(form.password || form.tlsCa || form.tlsCertificate || form.tlsPrivateKey || form.tlsPassphrase);
      const payload: Record<string, unknown> = {
        copyFromId: isCopying.value ? connection?.id : undefined,
        environmentIds: form.environmentIds,
        connectionGroupId: form.connectionGroupId,
        name: form.name,
        host: form.host,
        port: form.port,
        username: form.username,
        defaultDatabase: Number(form.redisDatabase) || 0,
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
      if (!connection || credentialChanged) {
        payload.credential = {
          password: form.password,
          tlsCa: form.tlsCa,
          tlsCertificate: form.tlsCertificate,
          tlsPrivateKey: form.tlsPrivateKey,
          tlsPassphrase: form.tlsPassphrase,
        };
      }
      await api(isEditing.value ? `/api/v1/redis-connections/${connection!.id}` : "/api/v1/redis-connections", {
        method: isEditing.value ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
    }
    ElMessage.success(isCreatingProfile.value ? tr("连接配置文件已创建") : isEditingProfile.value ? tr("连接配置文件已更新") : isEditing.value ? tr("连接已更新") : isCopying.value ? tr("连接副本已创建") : tr("连接已创建"));
    close();
    emit("saved");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存连接失败"));
  } finally {
    saving.value = false;
  }
}

watch(() => props.modelValue, (open) => {
  if (!open) return;
  selectedProfileId.value = props.activeProfileId || "main";
  initializeForm();
  void loadOptions();
});

watch(() => [props.connection?.id, props.profileParentId], () => {
  if (props.modelValue) initializeForm();
});

watch(() => props.profiles?.map((profile) => profile.id).join(","), () => {
  if (selectedProfileId.value !== "main" && !props.profiles?.some((profile) => profile.id === selectedProfileId.value)) {
    selectedProfileId.value = "main";
  }
});
</script>

<template>
  <el-dialog :model-value="modelValue" align-center class="envman-dialog connection-editor-dialog" width="760px" destroy-on-close append-to-body @update:model-value="emit('update:modelValue', $event)">
    <template #header><div class="dialog-title"><span class="dialog-title__icon"><Copy v-if="isCopying" :size="19" /><Pencil v-else-if="isEditing" :size="19" /><Plus v-else :size="19" /></span><div><h3>{{ dialogTitle }}</h3></div><TipIcon :content="isProfile ? $t('配置文件使用独立连接参数，未填写的新凭据会沿用主要配置文件并保持加密。') : isCopying ? $t('源凭据会重新加密复制；填写新凭据可覆盖副本字段。') : isEditing ? $t('凭据字段留空会保留当前加密值。') : $t('密码、私钥与 Tunnel 认证会加密保存。')" placement="left" /></div></template>
    <el-form v-loading="loadingOptions" label-position="top" class="connection-form">
      <section v-if="profileManagerVisible" class="form-section connection-profile-manager">
        <header class="form-section__header"><strong>{{ $t('连接配置文件') }}</strong><button type="button" data-navicat-action="new-connection-profile" :disabled="connected" :title="connected ? $t('要创建新的连接配置文件，必须关闭连接') : $t('新建连接配置文件')" @click="emit('profileAction', 'create')"><Plus :size="14" />{{ $t('新建连接配置文件') }}</button></header>
        <div class="connection-profile-manager__list" role="listbox" :aria-label="$t('连接配置文件')">
          <button type="button" role="option" :aria-selected="selectedProfileId === 'main'" :class="{ 'is-selected': selectedProfileId === 'main' }" @click="selectedProfileId = 'main'"><Database :size="14" /><span>{{ $t('主要配置文件') }}</span><BadgeCheck v-if="!activeProfileId" :size="14" /></button>
          <button v-for="profile in profiles" :key="profile.id" type="button" role="option" :aria-selected="selectedProfileId === profile.id" :class="{ 'is-selected': selectedProfileId === profile.id }" @click="selectedProfileId = profile.id" @dblclick="emit('profileAction', 'edit', profile.id)"><Database :size="14" /><span>{{ profile.profileName || profile.name }}</span><BadgeCheck v-if="activeProfileId === profile.id" :size="14" /></button>
        </div>
        <div class="connection-profile-manager__actions">
          <button type="button" data-navicat-action="set-active-profile" :disabled="connected || selectedProfileIsActive" @click="emit('profileAction', 'set-active', selectedProfileId === 'main' ? undefined : selectedProfileId)"><BadgeCheck :size="14" />{{ $t('设为活动配置文件') }}</button>
          <button type="button" :disabled="!selectedProfile" @click="selectedProfile && emit('profileAction', 'edit', selectedProfile.id)"><Pencil :size="14" />{{ $t('编辑') }}</button>
          <button type="button" data-navicat-action="duplicate-profile" :disabled="connected || !selectedProfile" @click="selectedProfile && emit('profileAction', 'duplicate', selectedProfile.id)"><Copy :size="14" />{{ $t('复制配置文件') }}</button>
          <button type="button" data-navicat-action="delete-profile" :disabled="connected || !selectedProfile" class="is-danger" @click="selectedProfile && emit('profileAction', 'delete', selectedProfile.id)"><Trash2 :size="14" />{{ $t('删除配置文件') }}</button>
        </div>
        <small v-if="connected">{{ $t('要创建、切换、复制或删除连接配置文件，必须先关闭连接。') }}</small>
      </section>

      <section class="form-section">
        <header class="form-section__header"><strong>{{ $t('基本信息') }}</strong></header>
        <div class="form-grid form-grid--two">
          <el-form-item :label="isProfile ? $t('配置文件名称') : $t('连接名称')" required><el-input v-model="form.name" /></el-form-item>
          <el-form-item v-if="!isProfile" :label="$t('连接组')"><el-select v-model="form.connectionGroupId" clearable :placeholder="$t('按环境组自动归组')" style="width:100%"><el-option v-for="group in availableGroups" :key="group.id" :label="group.path" :value="group.id" /></el-select></el-form-item>
          <el-form-item v-if="!isProfile" :label="$t('关联环境')" class="form-span-2"><el-select v-model="form.environmentIds" multiple collapse-tags collapse-tags-tooltip clearable filterable :placeholder="$t('暂不关联')" style="width:100%"><el-option v-for="environment in environments" :key="environment.id" :label="environment.name" :value="environment.id" /></el-select></el-form-item>
          <el-form-item v-if="activeConnectionType === 'ssh'" :label="$t('标签')" class="form-span-2"><el-select v-model="form.tags" multiple filterable allow-create default-first-option :placeholder="$t('例如 NACOS、网关、应用服务')" style="width:100%" /></el-form-item>
        </div>
      </section>

      <section class="form-section">
        <header class="form-section__header"><strong>{{ $t('访问地址') }}</strong></header>
        <div class="form-grid form-grid--endpoint">
          <el-form-item :label="$t('主机')" required><el-input v-model="form.host" /></el-form-item>
          <el-form-item :label="$t('端口')" required><el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" style="width:100%" /></el-form-item>
          <el-form-item :label="activeConnectionType === 'redis' ? $t('ACL 用户名（可选）') : $t('用户名')" :required="activeConnectionType !== 'redis'"><el-input v-model="form.username" /></el-form-item>
        </div>
      </section>

      <section class="form-section form-section--last">
        <header class="form-section__header"><strong>{{ activeConnectionType === 'ssh' ? $t('认证与登录') : activeConnectionType === 'redis' ? $t('Redis 与安全') : $t('数据库与安全') }}</strong></header>
        <div class="form-grid form-grid--two">
          <template v-if="activeConnectionType === 'ssh'">
            <ConnectionMethodPicker v-model="form.authType" :label="$t('认证方式')" :choices="sshAuthChoices" />
            <el-form-item v-if="form.authType === 'password' || form.authType === 'keyboardInteractive'" :label="$t('密码')" class="form-span-2"><el-input v-model="form.password" type="password" show-password :placeholder="preservesCredential ? $t('留空表示沿用原密码') : $t('连接密码，可稍后补录')" /></el-form-item>
            <el-form-item v-else-if="form.authType === 'privateKey'" :label="$t('SSH 密钥')" class="form-span-2" required><div class="inline-create-field"><el-select v-model="form.sshKeyId" clearable filterable :placeholder="preservesLegacyPrivateKey ? $t('沿用旧版内嵌私钥，或选择托管密钥') : $t('选择当前工作空间的密钥')" style="width:100%"><el-option v-for="key in sshKeys" :key="key.id" :label="`${key.name} · ${key.fingerprint}`" :value="key.id" /></el-select><el-button :aria-label="$t('打开 SSH 密钥管理')" :title="$t('密钥管理')" @click="close(); router.push({ name: 'ssh-keys' })"><KeyRound :size="14" /></el-button></div><small v-if="preservesLegacyPrivateKey && !form.sshKeyId">{{ $t('当前连接仍使用旧版内嵌私钥；选择托管密钥后将改为统一引用。') }}</small><small v-else-if="!sshKeys.length">{{ $t('当前空间没有可用密钥，请先进入 SSH 密钥管理导入或生成。') }}</small></el-form-item>
            <el-form-item v-if="form.authType === 'sshAgent'" :label="$t('Agent Socket')" class="form-span-2"><el-input v-model="form.agentSocket" class="mono-input" :placeholder="$t('留空自动使用 SSH_AUTH_SOCK；Windows 使用 Pageant')" clearable /><small>{{ $t('桌面直连使用本机 Agent；服务端连接使用服务器上的 Agent。') }}</small></el-form-item>
              <details class="connection-advanced-panel form-span-2" open>
              <summary><span><strong>{{ $t('网络路径') }}</strong><small>{{ $t('直连、代理或多级 ProxyJump') }}</small></span><span class="connection-advanced-panel__status">{{ form.jumpConnectionId ? 'ProxyJump' : form.proxyType === 'none' ? $t('直连') : form.proxyType.toUpperCase() }}</span></summary>
              <div class="form-grid form-grid--two connection-advanced-panel__body">
                <el-form-item class="form-span-2">
                  <template #label><span class="form-label-with-tip">{{ $t('跳板机 / ProxyJump') }}<TipIcon :content="$t('目标连接会沿用所选主机的完整跳板链；最多支持 8 跳，且不能形成循环。')" placement="right" /></span></template>
                  <el-select v-model="form.jumpConnectionId" clearable :disabled="form.proxyType !== 'none'" :placeholder="$t('直连，不使用跳板机')" style="width:100%"><el-option v-for="item in availableSshOptions" :key="item.id" :label="item.name + ' · ' + item.host" :value="item.id" /></el-select>
                </el-form-item>
                <el-form-item :label="$t('出站代理')"><el-select v-model="form.proxyType" :disabled="Boolean(form.jumpConnectionId)" style="width:100%"><el-option :label="$t('不使用代理')" value="none" /><el-option label="HTTP CONNECT" value="http" /><el-option label="SOCKS5" value="socks5" /></el-select></el-form-item>
                <el-form-item v-if="form.proxyType !== 'none'" :label="$t('代理端口')"><el-input-number v-model="form.proxyPort" :min="1" :max="65535" controls-position="right" style="width:100%" /></el-form-item>
                <el-form-item v-if="form.proxyType !== 'none'" :label="$t('代理主机')" class="form-span-2" required><el-input v-model="form.proxyHost" placeholder="proxy.example.com" /></el-form-item>
                <el-form-item v-if="form.proxyType !== 'none'" :label="$t('代理用户名')"><el-input v-model="form.proxyUsername" :placeholder="$t('可选')" /></el-form-item>
                <el-form-item v-if="form.proxyType !== 'none'" :label="$t('代理密码')"><el-input v-model="form.proxyPassword" type="password" show-password :placeholder="preservesCredential ? $t('留空表示沿用原认证') : $t('可选')" /></el-form-item>
              </div>
            </details>
            <details class="connection-advanced-panel form-span-2">
              <summary><span><strong>{{ $t('SSH 协议与兼容性') }}</strong><small>{{ $t('超时、IP、压缩、算法与 Agent 转发') }}</small></span><span class="connection-advanced-panel__status">{{ form.algorithmPreset === 'default' ? $t('安全默认值') : form.algorithmPreset === 'modern' ? $t('现代算法') : $t('兼容旧主机') }}</span></summary>
              <div class="form-grid form-grid--two connection-advanced-panel__body">
                <el-form-item :label="$t('终端类型')"><el-select v-model="form.terminalType" allow-create filterable style="width:100%"><el-option label="xterm-256color" value="xterm-256color" /><el-option label="xterm" value="xterm" /><el-option label="vt100" value="vt100" /><el-option label="linux" value="linux" /></el-select></el-form-item>
                <el-form-item :label="$t('保活间隔')"><el-input-number v-model="form.keepAliveSeconds" :min="0" :max="600" controls-position="right" style="width:100%" /><small>{{ $t('秒；设为 0 可关闭保活') }}</small></el-form-item>
                <el-form-item :label="$t('连接超时')"><el-input-number v-model="form.connectTimeoutSeconds" :min="1" :max="120" controls-position="right" style="width:100%" /><small>{{ $t('秒；包含 TCP 与 SSH 握手') }}</small></el-form-item>
                <el-form-item :label="$t('IP 版本')"><el-select v-model="form.ipVersion" style="width:100%"><el-option :label="$t('自动选择')" value="auto" /><el-option label="IPv4" value="ipv4" /><el-option label="IPv6" value="ipv6" /></el-select></el-form-item>
                <el-form-item :label="$t('算法策略')"><el-select v-model="form.algorithmPreset" style="width:100%"><el-option :label="$t('安全默认值')" value="default" /><el-option :label="$t('仅现代算法')" value="modern" /><el-option :label="$t('兼容旧主机')" value="compatible" /></el-select><small v-if="form.algorithmPreset === 'compatible'" class="form-field-warning">{{ $t('会启用部分旧算法，仅用于无法升级的设备。') }}</small></el-form-item>
                <el-form-item :label="$t('传输优化')"><div class="connection-switch-stack"><label><el-switch v-model="form.compression" />{{ $t('启用压缩') }}</label><label><el-switch v-model="form.agentForwarding" />{{ $t('转发 SSH Agent') }}</label></div></el-form-item>
                <el-form-item v-if="form.authType !== 'sshAgent' && form.agentForwarding" :label="$t('Agent Socket')" class="form-span-2"><el-input v-model="form.agentSocket" class="mono-input" :placeholder="$t('留空自动使用 SSH_AUTH_SOCK；Windows 使用 Pageant')" clearable /></el-form-item>
                <el-form-item class="form-span-2">
                  <template #label><span class="form-label-with-tip">{{ $t('主机密钥 SHA-256') }}<TipIcon :content="$t('填写后会固定服务器主机密钥，密钥不匹配时拒绝连接，可防止中间人攻击。')" placement="right" /></span></template>
                  <el-input v-model="form.hostKeySha256" class="mono-input" placeholder="SHA256:AbCdEf…" clearable />
                </el-form-item>
              </div>
            </details>
            <el-form-item :label="$t('登录脚本')" class="form-span-2"><SshLoginScriptEditor v-model="form.loginScript" v-model:enabled="form.loginScriptEnabled" /></el-form-item>
          </template>

          <template v-else-if="activeConnectionType === 'database'">
            <el-form-item :label="$t('数据库类型')"><el-select v-model="form.engine" style="width:100%"><el-option label="MySQL" value="mysql" /><el-option label="MariaDB" value="mariadb" /></el-select></el-form-item>
            <el-form-item :label="$t('默认数据库')"><el-input v-model="form.defaultDatabase" /></el-form-item>
            <el-form-item :label="$t('密码')" class="form-span-2"><el-input v-model="form.password" type="password" show-password :placeholder="preservesCredential ? $t('留空表示沿用原密码') : $t('数据库密码，可稍后补录')" /></el-form-item>
            <ConnectionMethodPicker v-model="form.connectionMode" :label="$t('网络链路')" :choices="databaseModeChoices" />
            <el-form-item v-if="form.connectionMode === 'sshTunnel'" :label="$t('SSH 隧道连接')" class="form-span-2" required><el-select v-model="form.sshConnectionId" filterable :placeholder="$t('选择已有 SSH 连接')" style="width:100%"><el-option v-for="item in availableSshOptions" :key="item.id" :label="item.name + ' · ' + item.host" :value="item.id" /></el-select><small>{{ $t('隧道会复用该连接的认证、主机指纹与 ProxyJump 配置。') }}</small></el-form-item>
            <template v-if="form.connectionMode === 'httpTunnel'"><el-form-item label="HTTP Tunnel URL" class="form-span-2"><el-input v-model="form.httpTunnelUrl" /></el-form-item><el-form-item :label="$t('HTTP Basic Auth 用户名')"><el-input v-model="form.httpTunnelUsername" :placeholder="preservesCredential ? $t('留空表示沿用原认证') : $t('可选')" /></el-form-item><el-form-item :label="$t('HTTP Basic Auth 密码')"><el-input v-model="form.httpTunnelPassword" type="password" show-password :placeholder="preservesCredential ? $t('留空表示沿用原认证') : $t('可选')" /></el-form-item><el-form-item :label="$t('校验 Tunnel HTTPS 证书')"><el-switch v-model="form.httpTunnelRejectUnauthorized" /></el-form-item></template>
            <DatabaseTlsSettings
              v-model:enabled="form.sslEnabled"
              v-model:reject-unauthorized="form.rejectUnauthorized"
              v-model:ca="form.tlsCa"
              v-model:certificate="form.tlsCertificate"
              v-model:private-key="form.tlsPrivateKey"
              v-model:passphrase="form.tlsPassphrase"
              :preserves-credential="preservesCredential"
              :has-tls-ca="connection?.hasTlsCa"
              :has-tls-certificate="connection?.hasTlsCertificate"
              :has-tls-private-key="connection?.hasTlsPrivateKey"
              :has-tls-passphrase="connection?.hasTlsPassphrase"
            />
            <details class="connection-advanced-panel form-span-2">
              <summary><span><strong>{{ $t('数据库高级参数') }}</strong><small>{{ $t('字符集、会话时区与连接超时') }}</small></span><span class="connection-advanced-panel__status">{{ form.charset }} · {{ form.connectTimeoutMs / 1000 }}s</span></summary>
              <div class="form-grid form-grid--two connection-advanced-panel__body">
                <el-form-item :label="$t('连接字符集')"><el-select v-model="form.charset" filterable allow-create style="width:100%"><el-option label="utf8mb4" value="utf8mb4" /><el-option label="utf8" value="utf8" /><el-option label="latin1" value="latin1" /><el-option label="gbk" value="gbk" /></el-select></el-form-item>
                <el-form-item :label="$t('会话时区')"><el-select v-model="form.timezone" filterable allow-create style="width:100%"><el-option :label="$t('跟随执行端')" value="local" /><el-option label="UTC / Z" value="Z" /><el-option label="+08:00" value="+08:00" /><el-option label="+00:00" value="+00:00" /></el-select></el-form-item>
                <el-form-item :label="$t('连接超时')" class="form-span-2"><el-input-number v-model="form.connectTimeoutMs" :min="1000" :max="120000" :step="1000" controls-position="right" style="width:100%" /><small>{{ $t('毫秒，允许 1–120 秒') }}</small></el-form-item>
              </div>
            </details>
          </template>
          <template v-else-if="activeConnectionType === 'redis'">
            <el-form-item :label="$t('默认逻辑库')"><el-input-number v-model="form.redisDatabase" :min="0" :max="1023" controls-position="right" style="width:100%" /></el-form-item>
            <el-form-item :label="$t('键名分隔符')"><el-input v-model="form.keySeparator" maxlength="16" placeholder=":" /></el-form-item>
            <el-form-item :label="$t('密码')" class="form-span-2"><el-input v-model="form.password" type="password" show-password :placeholder="preservesCredential ? $t('留空表示沿用原密码') : $t('Redis 密码，可留空')" /></el-form-item>
            <el-form-item :label="$t('连接方式')"><el-select v-model="form.connectionMode" style="width:100%"><el-option :label="$t('TCP 直连')" value="tcp" /><el-option label="SSH Tunnel" value="sshTunnel" /></el-select></el-form-item>
            <el-form-item v-if="form.connectionMode === 'sshTunnel'" :label="$t('SSH 隧道连接')" required><el-select v-model="form.sshConnectionId" filterable :placeholder="$t('选择已有 SSH 连接')" style="width:100%"><el-option v-for="item in availableSshOptions" :key="item.id" :label="item.name + ' · ' + item.host" :value="item.id" /></el-select></el-form-item>
            <el-form-item><template #label><span class="form-label-with-tip">{{ $t('只读模式') }}<TipIcon :content="$t('开启后，可信执行端会拒绝所有写命令。')" placement="right" /></span></template><el-switch v-model="form.readOnly" /></el-form-item>
            <el-form-item :label="$t('启用 TLS')"><el-switch v-model="form.sslEnabled" /></el-form-item>
            <template v-if="form.sslEnabled">
              <el-form-item :label="$t('校验服务器证书')"><el-switch v-model="form.rejectUnauthorized" /></el-form-item>
              <el-form-item :label="$t('TLS 服务器名称')"><el-input v-model="form.tlsServerName" :placeholder="$t('默认使用连接主机')" /></el-form-item>
              <el-form-item :label="$t('CA 证书')" class="form-span-2 form-item--code"><el-input v-model="form.tlsCa" type="textarea" :rows="3" :placeholder="preservesCredential ? $t('留空表示保持原 CA') : $t('可选 PEM')" /></el-form-item>
              <el-form-item :label="$t('客户端证书')" class="form-span-2 form-item--code"><el-input v-model="form.tlsCertificate" type="textarea" :rows="3" :placeholder="preservesCredential ? $t('留空表示保持原证书') : $t('可选 PEM')" /></el-form-item>
              <el-form-item :label="$t('客户端私钥')" class="form-span-2 form-item--code"><el-input v-model="form.tlsPrivateKey" type="textarea" :rows="4" :placeholder="preservesCredential ? $t('留空表示保持原私钥') : $t('可选 PEM')" /></el-form-item>
              <el-form-item :label="$t('私钥口令')"><el-input v-model="form.tlsPassphrase" type="password" show-password :placeholder="preservesCredential ? $t('留空表示保持原口令') : $t('可选')" /></el-form-item>
            </template>
          </template>
        </div>
      </section>
    </el-form>
    <template #footer><el-button @click="close">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="save">{{ isCreatingProfile ? $t('创建配置文件') : isEditingProfile ? $t('保存配置文件') : isCopying ? $t('创建副本') : isEditing ? $t('保存修改') : $t('创建连接') }}</el-button></template>
  </el-dialog>
</template>
