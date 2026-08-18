<script setup lang="ts">import { translate as tr } from "../i18n";

import { KeyRound, Search, UserRound } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, ref, watch } from "vue";
import { api } from "../api";

interface DatabaseUser { user: string; host: string; plugin: string }
interface ManagedGrant { privileges: string[]; unmanagedPrivileges: string[]; grantOption: boolean }

const props = defineProps<{
  visible: boolean;
  connectionId: string;
  database: string;
  objectType: "table" | "view" | "procedure" | "function";
  objectName: string;
}>();
const emit = defineEmits<{ close: [] }>();

const loading = ref(false);
const saving = ref(false);
const search = ref("");
const users = ref<DatabaseUser[]>([]);
const selectedKey = ref("");
const privileges = ref<string[]>([]);
const unmanagedPrivileges = ref<string[]>([]);
const grantOption = ref(false);
const rawGrants = ref<string[]>([]);

const privilegeOptions = computed(() => props.objectType === "procedure" || props.objectType === "function"
  ? ["EXECUTE", "ALTER ROUTINE"]
  : ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "REFERENCES", "TRIGGER", "CREATE VIEW", "SHOW VIEW"]);
const filteredUsers = computed(() => users.value.filter((item) => !search.value || `${item.user} ${item.host} ${item.plugin}`.toLowerCase().includes(search.value.toLowerCase())));
const selected = computed(() => users.value.find((item) => `${item.user}@${item.host}` === selectedKey.value) ?? null);
const scopeType = computed(() => props.objectType === "view" ? "table" : props.objectType);

async function loadUsers() {
  if (!props.connectionId) return;
  loading.value = true;
  try {
    const response = await api<{ items: DatabaseUser[] }>(`/api/v1/database-connections/${props.connectionId}/users`);
    users.value = response.items;
    selectedKey.value = response.items[0] ? `${response.items[0].user}@${response.items[0].host}` : "";
    await loadPrivileges();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载数据库用户失败"));
  } finally {
    loading.value = false;
  }
}

async function loadPrivileges() {
  if (!selected.value) {
    privileges.value = [];
    unmanagedPrivileges.value = [];
    grantOption.value = false;
    rawGrants.value = [];
    return;
  }
  loading.value = true;
  try {
    const query = new URLSearchParams({
      user: selected.value.user,
      host: selected.value.host,
      scopeType: scopeType.value,
      database: props.database,
      objectName: props.objectName,
    });
    const response = await api<{ grant: ManagedGrant; grants: string[] }>(`/api/v1/database-connections/${props.connectionId}/user-object-privileges?${query}`);
    privileges.value = response.grant.privileges.filter((item) => privilegeOptions.value.includes(item));
    unmanagedPrivileges.value = response.grant.unmanagedPrivileges;
    grantOption.value = response.grant.grantOption;
    rawGrants.value = response.grants;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("读取对象权限失败"));
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (!selected.value) return;
  saving.value = true;
  try {
    await api(`/api/v1/database-connections/${props.connectionId}/user-privileges`, {
      method: "POST",
      body: JSON.stringify({
        user: selected.value.user,
        host: selected.value.host,
        scopeType: scopeType.value,
        database: props.database,
        objectName: props.objectName,
        privileges: privileges.value,
        grantOption: grantOption.value,
      }),
    });
    ElMessage.success(tr("对象权限已保存"));
    await loadPrivileges();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("保存对象权限失败"));
  } finally {
    saving.value = false;
  }
}

watch(() => props.visible, (visible) => { if (visible) void loadUsers(); });
watch(selectedKey, () => { if (props.visible) void loadPrivileges(); });
</script>

<template>
  <el-dialog :model-value="visible" class="database-navicat-dialog" :title="$t('设置权限 · {0}.{1}', [database, objectName])" width="790px" append-to-body destroy-on-close @close="emit('close')">
    <div class="database-object-privilege" v-loading="loading">
      <aside><el-input v-model="search" clearable :placeholder="$t('搜索用户')"><template #prefix><Search :size="13" /></template></el-input><button v-for="user in filteredUsers" :key="`${user.user}@${user.host}`" :class="{ 'is-selected': selectedKey === `${user.user}@${user.host}` }" @click="selectedKey = `${user.user}@${user.host}`"><UserRound :size="14" /><span><strong>{{ user.user }}</strong><small>{{ user.host }} · {{ user.plugin || $t('默认插件') }}</small></span></button></aside>
      <main><header><KeyRound :size="17" /><span><strong>{{ selected ? `${selected.user}@${selected.host}` : $t('请选择数据库用户') }}</strong><small>{{ objectType }} · {{ database }}.{{ objectName }}</small></span></header><el-checkbox-group v-model="privileges"><el-checkbox v-for="privilege in privilegeOptions" :key="privilege" :value="privilege">{{ privilege }}</el-checkbox></el-checkbox-group><el-checkbox v-model="grantOption">{{ $t('允许授予这些权限') }}</el-checkbox><p v-if="unmanagedPrivileges.length" class="database-privilege-manager__notice">{{ $t('该对象还包含 Viron 未直接编辑的权限：') }}{{ unmanagedPrivileges.join('、') }}{{ $t('。应用时会原样保留。') }}</p><details><summary>{{ $t('当前 SHOW GRANTS') }}</summary><code v-for="grant in rawGrants" :key="grant">{{ grant }}</code></details></main>
    </div>
    <template #footer><el-button @click="emit('close')">{{ $t('关闭') }}</el-button><el-button type="primary" :loading="saving" :disabled="!selected" @click="save">{{ $t('应用') }}</el-button></template>
  </el-dialog>
</template>
