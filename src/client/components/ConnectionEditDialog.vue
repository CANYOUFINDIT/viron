<script setup lang="ts">import { translate as tr } from "../i18n";

import { BadgeCheck, Copy, Database, KeyRound, Pencil, Plus, TerminalSquare, Trash2 } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import { session } from "../session";
import SshLoginScriptEditor from "./SshLoginScriptEditor.vue";
import TipIcon from "./TipIcon.vue";

interface EnvironmentItem { id: string; name: string }
interface ConnectionGroup { id: string; type: "ssh" | "database"; path: string }
interface SshOption { id: string; name: string; host: string }
interface SshKeyOption { id: string; name: string; fingerprint: string; algorithm: string }

interface EditableConnection {
  id: string;
  profileParentId?: string | null;
  profileName?: string;
  type: "ssh" | "database";
  environmentId: string | null;
  environmentIds?: string[];
  connectionGroupId: string | null;
  name: string;
  host: string;
  port: number;
  username: string;
  authType?: "password" | "privateKey" | "keyboardInteractive";
  sshKeyId?: string | null;
  hasPrivateKey?: boolean;
  jumpConnectionId?: string | null;
  tags?: string[];
  engine?: "mysql" | "mariadb";
  defaultDatabase?: string;
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
  connectionType?: "ssh" | "database";
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
  authType: "password" as "password" | "privateKey" | "keyboardInteractive",
  sshKeyId: null as string | null,
  password: "",
  jumpConnectionId: null as string | null,
  tags: [] as string[],
  loginScriptEnabled: false,
  loginScript: "",
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
});

const isCopying = computed(() => Boolean(props.connection && props.copyMode));
const isProfile = computed(() => Boolean(props.connection && props.profileParentId));
const isEditingProfile = computed(() => Boolean(isProfile.value && props.connection?.profileParentId === props.profileParentId));
const isCreatingProfile = computed(() => isProfile.value && !isEditingProfile.value);
const isEditing = computed(() => Boolean(props.connection && !props.copyMode && (!props.profileParentId || isEditingProfile.value)));
const preservesCredential = computed(() => isEditing.value || isCopying.value || isProfile.value);
const preservesLegacyPrivateKey = computed(() => Boolean(props.connection?.authType === "privateKey" && props.connection.hasPrivateKey && !props.connection.sshKeyId));
const activeConnectionType = computed<"ssh" | "database">(() => props.connection?.type ?? props.connectionType ?? "ssh");
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

function close() {
  emit("update:modelValue", false);
}

function initializeForm() {
  const connection = props.connection;
  const connectionType = activeConnectionType.value;
  const options = connection?.options ?? {};
  const ssl = options.ssl as { enabled?: boolean; rejectUnauthorized?: boolean } | undefined;
  Object.assign(form, {
    environmentIds: [...(connection?.environmentIds ?? (connection?.environmentId ? [connection.environmentId] : props.defaultEnvironmentId ? [props.defaultEnvironmentId] : []))],
    connectionGroupId: connection?.connectionGroupId ?? null,
    name: isCreatingProfile.value ? "" : isEditingProfile.value ? connection?.profileName ?? "" : connection ? (isCopying.value ? tr("{0} 副本", [connection.name.slice(0, 157)]) : connection.name) : "",
    host: connection?.host ?? "",
    port: connection?.port ?? (connectionType === "ssh" ? 22 : 3306),
    username: connection?.username ?? "",
    authType: connection?.authType ?? "password",
    sshKeyId: connection?.sshKeyId ?? null,
    password: "",
    jumpConnectionId: connection?.jumpConnectionId ?? null,
    tags: [...(connection?.tags ?? [])],
    loginScriptEnabled: Boolean(options.loginScriptEnabled),
    loginScript: String(options.loginScript ?? ""),
    engine: connection?.engine ?? "mysql",
    defaultDatabase: connection?.defaultDatabase ?? "",
    connectionMode: connection?.connectionMode ?? "tcp",
    sshConnectionId: (options.sshConnectionId as string | null | undefined) ?? null,
    sslEnabled: Boolean(ssl?.enabled),
    rejectUnauthorized: ssl?.rejectUnauthorized !== false,
    httpTunnelUrl: String(options.httpTunnelUrl ?? ""),
    httpTunnelUsername: "",
    httpTunnelPassword: "",
    httpTunnelRejectUnauthorized: options.httpTunnelRejectUnauthorized !== false,
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
  if (!form.name.trim() || !form.host.trim() || !form.username.trim()) return ElMessage.warning(tr("请填写连接名称、主机和用户名"));
  saving.value = true;
  try {
    const connectionType = activeConnectionType.value;
    if (connectionType === "ssh") {
      if (form.authType === "privateKey" && !form.sshKeyId && !preservesLegacyPrivateKey.value) return ElMessage.warning(tr("请选择用于连接的 SSH 密钥"));
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
          terminalType: String(currentOptions.terminalType ?? "xterm-256color"),
          keepAliveSeconds: Number(currentOptions.keepAliveSeconds ?? 30),
          encoding: String(currentOptions.encoding ?? "utf-8"),
          hostKeySha256: String(currentOptions.hostKeySha256 ?? ""),
          loginScriptEnabled: form.loginScriptEnabled,
          loginScript: form.loginScript,
        },
      };
      if (!connection || (form.authType !== "privateKey" && form.password)) payload.credential = { password: form.password };
      await api(isEditing.value ? `/api/v1/ssh-connections/${connection!.id}` : "/api/v1/ssh-connections", {
        method: isEditing.value ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
    } else {
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
          charset: String(currentOptions.charset ?? "utf8mb4"),
          timezone: String(currentOptions.timezone ?? "local"),
          connectTimeoutMs: Number(currentOptions.connectTimeoutMs ?? 10000),
          sshConnectionId: form.sshConnectionId,
          ssl: { ...currentSsl, enabled: form.sslEnabled, rejectUnauthorized: form.rejectUnauthorized },
          httpTunnelUrl: form.httpTunnelUrl,
          httpTunnelRejectUnauthorized: form.httpTunnelRejectUnauthorized,
        },
      };
      if (!connection || form.password || form.httpTunnelUsername || form.httpTunnelPassword) {
        payload.credential = { password: form.password, httpTunnelUsername: form.httpTunnelUsername, httpTunnelPassword: form.httpTunnelPassword };
      }
      const path = isProfile.value
        ? `/api/v1/database-connections/${props.profileParentId}/profiles${isEditingProfile.value ? `/${connection!.id}` : ""}`
        : isEditing.value ? `/api/v1/database-connections/${connection!.id}` : "/api/v1/database-connections";
      await api(path, {
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
    <template #header><div class="dialog-title"><span class="dialog-title__icon"><Copy v-if="isCopying" :size="19" /><Pencil v-else-if="isEditing" :size="19" /><Plus v-else :size="19" /></span><div><h3>{{ isCreatingProfile ? $t('新建连接配置文件') : isEditingProfile ? $t('编辑连接配置文件') : isCopying ? $t('复制连接') : isEditing ? $t('编辑连接') : $t('新建连接') }}</h3></div><TipIcon :content="isProfile ? $t('配置文件使用独立连接参数，未填写的新凭据会沿用主要配置文件并保持加密。') : isCopying ? $t('源凭据会重新加密复制；填写新凭据可覆盖副本字段。') : isEditing ? $t('凭据字段留空会保留当前加密值。') : $t('密码、私钥与 Tunnel 认证会加密保存。')" placement="left" /></div></template>
    <el-form v-loading="loadingOptions" label-position="top" class="connection-form">
      <section class="form-section form-section--type">
        <el-form-item :label="$t('连接类型')">
          <el-radio-group :model-value="activeConnectionType" disabled><el-radio-button value="ssh"><TerminalSquare :size="15" />{{ $t('SSH 服务器') }}</el-radio-button><el-radio-button value="database"><Database :size="15" />MySQL / MariaDB</el-radio-button></el-radio-group>
        </el-form-item>
      </section>

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
          <el-form-item :label="$t('用户名')" required><el-input v-model="form.username" /></el-form-item>
        </div>
      </section>

      <section class="form-section form-section--last">
        <header class="form-section__header"><strong>{{ activeConnectionType === 'ssh' ? $t('认证与登录') : $t('数据库与安全') }}</strong></header>
        <div class="form-grid form-grid--two">
          <template v-if="activeConnectionType === 'ssh'">
            <el-form-item :label="$t('认证方式')"><el-select v-model="form.authType" style="width:100%"><el-option :label="$t('密码')" value="password" /><el-option :label="$t('SSH 密钥')" value="privateKey" /><el-option :label="$t('键盘交互')" value="keyboardInteractive" /></el-select></el-form-item>
            <el-form-item :label="$t('单级跳板机')"><el-select v-model="form.jumpConnectionId" clearable :placeholder="$t('不使用跳板机')" style="width:100%"><el-option v-for="item in availableSshOptions" :key="item.id" :label="`${item.name} · ${item.host}`" :value="item.id" /></el-select></el-form-item>
            <el-form-item v-if="form.authType !== 'privateKey'" :label="$t('密码')" class="form-span-2"><el-input v-model="form.password" type="password" show-password :placeholder="preservesCredential ? $t('留空表示沿用原密码') : $t('连接密码，可稍后补录')" /></el-form-item>
            <el-form-item v-else :label="$t('SSH 密钥')" class="form-span-2" required><div class="inline-create-field"><el-select v-model="form.sshKeyId" clearable filterable :placeholder="preservesLegacyPrivateKey ? $t('沿用旧版内嵌私钥，或选择托管密钥') : $t('选择当前工作空间的密钥')" style="width:100%"><el-option v-for="key in sshKeys" :key="key.id" :label="`${key.name} · ${key.fingerprint}`" :value="key.id" /></el-select><el-button :aria-label="$t('打开 SSH 密钥管理')" :title="$t('密钥管理')" @click="close(); router.push({ name: 'ssh-keys' })"><KeyRound :size="14" /></el-button></div><small v-if="preservesLegacyPrivateKey && !form.sshKeyId">{{ $t('当前连接仍使用旧版内嵌私钥；选择托管密钥后将改为统一引用。') }}</small><small v-else-if="!sshKeys.length">{{ $t('当前空间没有可用密钥，请先进入 SSH 密钥管理导入或生成。') }}</small></el-form-item>
            <el-form-item :label="$t('登录脚本')" class="form-span-2"><SshLoginScriptEditor v-model="form.loginScript" v-model:enabled="form.loginScriptEnabled" /></el-form-item>
          </template>

          <template v-else>
            <el-form-item :label="$t('数据库类型')"><el-select v-model="form.engine" style="width:100%"><el-option label="MySQL" value="mysql" /><el-option label="MariaDB" value="mariadb" /></el-select></el-form-item>
            <el-form-item :label="$t('默认数据库')"><el-input v-model="form.defaultDatabase" /></el-form-item>
            <el-form-item :label="$t('密码')" class="form-span-2"><el-input v-model="form.password" type="password" show-password :placeholder="preservesCredential ? $t('留空表示沿用原密码') : $t('数据库密码，可稍后补录')" /></el-form-item>
            <el-form-item :label="$t('连接方式')"><el-select v-model="form.connectionMode" style="width:100%"><el-option :label="$t('TCP 直连')" value="tcp" /><el-option label="SSH Tunnel" value="sshTunnel" /><el-option label="HTTP Tunnel" value="httpTunnel" /></el-select></el-form-item>
            <el-form-item v-if="form.connectionMode === 'sshTunnel'" :label="$t('SSH 隧道连接')"><el-select v-model="form.sshConnectionId" :placeholder="$t('选择已有 SSH 连接')" style="width:100%"><el-option v-for="item in availableSshOptions" :key="item.id" :label="`${item.name} · ${item.host}`" :value="item.id" /></el-select></el-form-item>
            <template v-if="form.connectionMode === 'httpTunnel'"><el-form-item label="HTTP Tunnel URL" class="form-span-2"><el-input v-model="form.httpTunnelUrl" /></el-form-item><el-form-item :label="$t('HTTP Basic Auth 用户名')"><el-input v-model="form.httpTunnelUsername" :placeholder="preservesCredential ? $t('留空表示沿用原认证') : $t('可选')" /></el-form-item><el-form-item :label="$t('HTTP Basic Auth 密码')"><el-input v-model="form.httpTunnelPassword" type="password" show-password :placeholder="preservesCredential ? $t('留空表示沿用原认证') : $t('可选')" /></el-form-item><el-form-item :label="$t('校验 Tunnel HTTPS 证书')"><el-switch v-model="form.httpTunnelRejectUnauthorized" /></el-form-item></template>
            <el-form-item :label="$t('启用 SSL/TLS')"><el-switch v-model="form.sslEnabled" /></el-form-item>
            <el-form-item v-if="form.sslEnabled" :label="$t('校验服务器证书')"><el-switch v-model="form.rejectUnauthorized" /></el-form-item>
          </template>
        </div>
      </section>
    </el-form>
    <template #footer><el-button @click="close">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="save">{{ isCreatingProfile ? $t('创建配置文件') : isEditingProfile ? $t('保存配置文件') : isCopying ? $t('创建副本') : isEditing ? $t('保存修改') : $t('创建连接') }}</el-button></template>
  </el-dialog>
</template>
