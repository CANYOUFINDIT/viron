<script setup lang="ts">import { translate as tr } from "../i18n";

import { KeyRound, Plus, RefreshCw, Search, ShieldCheck, Trash2, UserRound } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive, ref, watch } from "vue";
import { api } from "../api";

interface DatabaseUser {
  user: string;
  host: string;
  plugin: string;
  passwordExpired: boolean;
  maxQueries: number;
  maxUpdates: number;
  maxConnections: number;
  maxUserConnections: number;
  sslType: string;
  sslCipher: string;
  issuer: string;
  subject: string;
}

interface ManagedGrantScope {
  database: string;
  privileges: string[];
  unmanagedPrivileges: string[];
  grantOption: boolean;
}

const props = defineProps<{ connectionId: string; engine?: "mysql" | "mariadb"; schemas: Array<{ name: string }> }>();

const privilegeNames = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "REFERENCES", "CREATE VIEW", "SHOW VIEW", "TRIGGER", "EVENT", "EXECUTE", "CREATE ROUTINE", "ALTER ROUTINE", "CREATE TEMPORARY TABLES", "LOCK TABLES"];
const loading = ref(false);
const search = ref("");
const items = ref<DatabaseUser[]>([]);
const selectedKey = ref("");
const editorOpen = ref(false);
const editorMode = ref<"create" | "edit">("create");
const editorSection = ref<"general" | "advanced">("general");
const privilegeOpen = ref(false);
const privilegeScope = ref("");
const privilegeSelection = ref<string[]>([]);
const grantOption = ref(false);
const grantsText = ref<string[]>([]);
const unmanagedPrivileges = ref<string[]>([]);
const grantScopes = ref<Record<string, ManagedGrantScope>>({});
const originalPlugin = ref("");
const form = reactive({
  user: "", host: "%", password: "", updatePassword: true,
  plugin: "", requireSsl: false, passwordExpire: "default", passwordExpireDays: 90,
  maxQueries: 0, maxUpdates: 0, maxConnections: 0, maxUserConnections: 0,
});

const filteredItems = computed(() => items.value.filter((item) => !search.value || `${item.user} ${item.host} ${item.plugin}`.toLowerCase().includes(search.value.toLowerCase())));
const selected = computed(() => items.value.find((item) => `${item.user}@${item.host}` === selectedKey.value) ?? null);
const pluginOptions = computed(() => {
  const values = props.engine === "mariadb"
    ? ["", "mysql_native_password", "ed25519"]
    : ["", "caching_sha2_password", "mysql_native_password", "sha256_password"];
  if (form.plugin && !values.includes(form.plugin)) values.push(form.plugin);
  return values;
});

async function load() {
  if (!props.connectionId) return;
  loading.value = true;
  try {
    const response = await api<{ items: DatabaseUser[] }>(`/api/v1/database-connections/${props.connectionId}/users`);
    items.value = response.items;
    if (selectedKey.value && !selected.value) selectedKey.value = "";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载数据库用户失败"));
  } finally {
    loading.value = false;
  }
}

function resetForm() {
  Object.assign(form, { user: "", host: "%", password: "", updatePassword: true, plugin: "", requireSsl: false, passwordExpire: "default", passwordExpireDays: 90, maxQueries: 0, maxUpdates: 0, maxConnections: 0, maxUserConnections: 0 });
  originalPlugin.value = "";
}

function newUser() {
  editorMode.value = "create";
  resetForm();
  editorSection.value = "general";
  editorOpen.value = true;
}

function editUser(item: DatabaseUser) {
  editorMode.value = "edit";
  Object.assign(form, {
    user: item.user, host: item.host, password: "", updatePassword: false, plugin: item.plugin || "",
    requireSsl: Boolean(item.sslType), passwordExpire: item.passwordExpired ? "default" : "never", passwordExpireDays: 90,
    maxQueries: item.maxQueries, maxUpdates: item.maxUpdates, maxConnections: item.maxConnections, maxUserConnections: item.maxUserConnections,
  });
  originalPlugin.value = item.plugin || "";
  editorSection.value = "general";
  editorOpen.value = true;
}

async function saveUser() {
  if (!form.user.trim() || !form.host.trim()) return ElMessage.warning(tr("请输入用户名和主机"));
  if (editorMode.value === "edit" && form.plugin !== originalPlugin.value && !form.updatePassword) return ElMessage.warning(tr("更改身份验证插件时必须同时设置密码"));
  const payload = { ...form, user: form.user.trim(), host: form.host.trim() };
  try {
    if (editorMode.value === "create") {
      await api(`/api/v1/database-connections/${props.connectionId}/users`, { method: "POST", body: JSON.stringify(payload) });
    } else {
      const query = new URLSearchParams({ user: form.user, host: form.host });
      await api(`/api/v1/database-connections/${props.connectionId}/users?${query}`, { method: "PUT", body: JSON.stringify(payload) });
    }
    editorOpen.value = false;
    await load();
    selectedKey.value = `${form.user}@${form.host}`;
    ElMessage.success(editorMode.value === "create" ? tr("数据库用户已创建") : tr("数据库用户已保存"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存数据库用户失败"));
  }
}

async function deleteUser(item: DatabaseUser) {
  try {
    await ElMessageBox.confirm(tr("确定删除数据库用户“{0}@{1}”吗？", [item.user, item.host]), tr("删除用户"), { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "warning" });
    const query = new URLSearchParams({ user: item.user, host: item.host });
    await api(`/api/v1/database-connections/${props.connectionId}/users?${query}`, { method: "DELETE" });
    selectedKey.value = "";
    await load();
  } catch { /* cancelled */ }
}

async function openPrivilegeManager(item = selected.value) {
  if (!item) return ElMessage.warning(tr("请选择数据库用户"));
  selectedKey.value = `${item.user}@${item.host}`;
  privilegeScope.value = "";
  privilegeSelection.value = [];
  grantOption.value = false;
  unmanagedPrivileges.value = [];
  grantScopes.value = {};
  privilegeOpen.value = true;
  try {
    const query = new URLSearchParams({ user: item.user, host: item.host });
    const response = await api<{ grants: string[]; scopes: ManagedGrantScope[] }>(`/api/v1/database-connections/${props.connectionId}/user-grants?${query}`);
    grantsText.value = response.grants;
    grantScopes.value = Object.fromEntries(response.scopes.map((scope) => [scope.database, scope]));
    selectPrivilegeScope("");
  } catch (error) {
    grantsText.value = [];
    ElMessage.error(error instanceof Error ? error.message : tr("读取用户权限失败"));
  }
}

function selectPrivilegeScope(scope: string) {
  privilegeScope.value = scope;
  const current = grantScopes.value[scope];
  privilegeSelection.value = [...(current?.privileges ?? [])];
  grantOption.value = current?.grantOption ?? false;
  unmanagedPrivileges.value = [...(current?.unmanagedPrivileges ?? [])];
}

async function savePrivileges() {
  if (!selected.value) return;
  try {
    await api(`/api/v1/database-connections/${props.connectionId}/user-privileges`, {
      method: "POST",
      body: JSON.stringify({ user: selected.value.user, host: selected.value.host, database: privilegeScope.value, privileges: privilegeSelection.value, grantOption: grantOption.value }),
    });
    privilegeOpen.value = false;
    ElMessage.success(tr("用户权限已保存"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存用户权限失败"));
  }
}

watch(() => props.connectionId, () => void load());
watch(() => form.plugin, (plugin) => {
  if (editorOpen.value && editorMode.value === "edit" && plugin !== originalPlugin.value) form.updatePassword = true;
});
onMounted(() => void load());
</script>

<template>
  <section class="database-user-workspace" v-loading="loading">
    <header class="database-user-toolbar">
      <div>
        <button data-navicat-action="new-user" :disabled="!connectionId" @click="newUser"><Plus :size="17" />{{ $t('新建用户') }}</button>
        <button data-navicat-action="privilege-manager" :disabled="!selected" @click="openPrivilegeManager()"><ShieldCheck :size="17" />{{ $t('权限管理员') }}</button>
        <button data-navicat-action="refresh" :disabled="!connectionId" @click="load"><RefreshCw :size="17" />{{ $t('刷新') }}</button>
      </div>
      <el-input v-model="search" clearable :placeholder="$t('搜索')"><template #prefix><Search :size="14" /></template></el-input>
    </header>
    <div class="database-object-table-wrap">
      <table class="database-object-table">
        <thead><tr><th>{{ $t('名称') }}</th><th>{{ $t('用户') }}</th><th>{{ $t('主机') }}</th><th>{{ $t('插件') }}</th><th>{{ $t('密码过期策略') }}</th><th>{{ $t('最大查询') }}</th><th>{{ $t('最大更新') }}</th><th>{{ $t('最大连接数') }}</th><th>{{ $t('最大用户连接数') }}</th><th>{{ $t('SSL 类型') }}</th><th>{{ $t('SSL 密码') }}</th><th>{{ $t('发行者') }}</th><th>{{ $t('主旨') }}</th><th></th></tr></thead>
        <tbody><tr v-for="item in filteredItems" :key="`${item.user}@${item.host}`" tabindex="0" :class="{ 'is-selected': selectedKey === `${item.user}@${item.host}` }" @click="selectedKey = `${item.user}@${item.host}`" @dblclick="editUser(item)" @keydown.enter="editUser(item)"><td><span class="object-name-cell"><UserRound :size="15" />{{ item.user }}@{{ item.host }}</span></td><td>{{ item.user }}</td><td>{{ item.host }}</td><td>{{ item.plugin || '—' }}</td><td>{{ item.passwordExpired ? $t('已过期') : $t('默认') }}</td><td>{{ item.maxQueries }}</td><td>{{ item.maxUpdates }}</td><td>{{ item.maxConnections }}</td><td>{{ item.maxUserConnections }}</td><td>{{ item.sslType || '—' }}</td><td>{{ item.sslCipher || '—' }}</td><td>{{ item.issuer || '—' }}</td><td>{{ item.subject || '—' }}</td><td><button class="artifact-row-delete" :title="$t('删除')" @click.stop="deleteUser(item)"><Trash2 :size="13" /></button></td></tr></tbody>
      </table>
      <div v-if="!filteredItems.length" class="object-browser-empty"><UserRound :size="25" /><span>{{ $t('没有数据库用户，或当前账号无权读取 mysql.user') }}</span></div>
    </div>
    <footer><span>{{ filteredItems.length }} {{ $t('个用户') }}</span></footer>
  </section>

  <el-dialog v-model="editorOpen" class="database-navicat-dialog" :title="editorMode === 'create' ? $t('新建用户') : $t('编辑用户 {0}@{1}', [form.user, form.host])" width="620px" append-to-body destroy-on-close>
    <nav class="database-user-dialog-tabs"><button :class="{ 'is-active': editorSection === 'general' }" @click="editorSection = 'general'">{{ $t('常规') }}</button><button :class="{ 'is-active': editorSection === 'advanced' }" @click="editorSection = 'advanced'">{{ $t('高级') }}</button></nav>
    <div v-if="editorSection === 'general'" class="database-user-form">
      <label><span>{{ $t('用户名') }}</span><el-input v-model="form.user" :disabled="editorMode === 'edit'" /></label>
      <label><span>{{ $t('主机') }}</span><el-input v-model="form.host" :disabled="editorMode === 'edit'" /></label>
      <label><span>{{ $t('身份验证插件') }}</span><el-select v-model="form.plugin"><el-option v-for="plugin in pluginOptions" :key="plugin || 'default'" :label="plugin || $t('服务器默认')" :value="plugin" /></el-select></label>
      <label v-if="editorMode === 'edit'" class="database-user-inline"><el-checkbox v-model="form.updatePassword">{{ $t('修改密码') }}</el-checkbox></label>
      <label><span>{{ $t('密码') }}</span><el-input v-model="form.password" type="password" show-password :disabled="editorMode === 'edit' && !form.updatePassword" /></label>
      <label class="database-user-inline"><el-checkbox v-model="form.requireSsl">{{ $t('要求 SSL') }}</el-checkbox></label>
      <label><span>{{ $t('密码过期') }}</span><el-select v-model="form.passwordExpire"><el-option :label="$t('服务器默认')" value="default" /><el-option :label="$t('永不过期')" value="never" /><el-option :label="$t('指定天数')" value="interval" /></el-select></label>
      <label v-if="form.passwordExpire === 'interval'"><span>{{ $t('过期天数') }}</span><el-input-number v-model="form.passwordExpireDays" :min="1" :max="65535" /></label>
    </div>
    <div v-else class="database-user-form"><label><span>{{ $t('每小时最大查询') }}</span><el-input-number v-model="form.maxQueries" :min="0" /></label><label><span>{{ $t('每小时最大更新') }}</span><el-input-number v-model="form.maxUpdates" :min="0" /></label><label><span>{{ $t('每小时最大连接') }}</span><el-input-number v-model="form.maxConnections" :min="0" /></label><label><span>{{ $t('最大用户连接数') }}</span><el-input-number v-model="form.maxUserConnections" :min="0" /></label></div>
    <template #footer><el-button @click="editorOpen = false">{{ $t('取消') }}</el-button><el-button type="primary" @click="saveUser">{{ $t('保存') }}</el-button></template>
  </el-dialog>

  <el-dialog v-model="privilegeOpen" class="database-navicat-dialog" :title="$t('权限管理员 · {0}@{1}', [selected?.user || '', selected?.host || ''])" width="760px" append-to-body destroy-on-close>
    <div class="database-privilege-manager"><aside><button :class="{ 'is-selected': privilegeScope === '' }" @click="selectPrivilegeScope('')">{{ $t('全局权限') }}</button><button v-for="schema in schemas" :key="schema.name" :class="{ 'is-selected': privilegeScope === schema.name }" @click="selectPrivilegeScope(schema.name)">{{ schema.name }}</button></aside><main><header><KeyRound :size="17" /><strong>{{ privilegeScope || $t('全局权限') }}</strong></header><el-checkbox-group v-model="privilegeSelection"><el-checkbox v-for="privilege in privilegeNames" :key="privilege" :value="privilege">{{ privilege }}</el-checkbox></el-checkbox-group><el-checkbox v-model="grantOption">{{ $t('允许授予这些权限') }}</el-checkbox><p v-if="unmanagedPrivileges.length" class="database-privilege-manager__notice">{{ $t('该作用域还包含 Viron 未直接编辑的权限：') }}{{ unmanagedPrivileges.join('、') }}{{ $t('。应用时会原样保留。') }}</p><details><summary>{{ $t('当前 SHOW GRANTS') }}</summary><code v-for="grant in grantsText" :key="grant">{{ grant }}</code></details></main></div>
    <template #footer><el-button @click="privilegeOpen = false">{{ $t('取消') }}</el-button><el-button type="primary" @click="savePrivileges">{{ $t('应用') }}</el-button></template>
  </el-dialog>
</template>
