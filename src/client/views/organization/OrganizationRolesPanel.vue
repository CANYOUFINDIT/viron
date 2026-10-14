<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { Plus, Copy, RefreshCw, ShieldCheck, KeyRound } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../../api";
import { loadSession } from "../../session";
import { useOrganizationContext } from "./context";
import {
  PERMISSION_DEFINITIONS,
  RESOURCE_TYPE_LABELS,
  resourceKey,
  validAt,
  type OrganizationRole,
  type RoleAccessState,
  type RoleAssignment,
  type RoleDataGrant,
  type FeatureGrant,
  type ResourceCatalogItem,
} from "../../../shared/organization-rbac";
import RolePermissionList from "./RolePermissionList.vue";
import OrganizationResourceAuthorizationDialog from "./OrganizationResourceAuthorizationDialog.vue";
import { pendingResourceGrant } from "./grant-selection";
const { currentOrganizationId, detail } = useOrganizationContext();
const { dataRevision } = useOrganizationContext();
const state = ref<RoleAccessState | null>(null),
  catalog = ref<ResourceCatalogItem[]>([]),
  selected = ref(""),
  tab = ref("permissions"),
  loading = ref(false),
  error = ref("");
const events = ref<
  Array<{
    id: string;
    actorName: string;
    action: string;
    reason: string;
    createdAt: string;
  }>
>([]);
const selectedRole = computed(() =>
  state.value?.roles.find((r) => r.id === selected.value),
);
const dataGrants = computed(
  () =>
    state.value?.dataGrants.filter((g) => g.roleId === selected.value) ?? [],
);
const assignments = computed(
  () =>
    state.value?.assignments.filter((g) => g.roleId === selected.value) ?? [],
);
const modules = [...new Set(PERMISSION_DEFINITIONS.map((p) => p.module))];
const roleDialog = ref(false),
  roleEditing = ref<OrganizationRole | null>(null),
  saving = ref(false);
const roleForm = reactive({
  name: "",
  description: "",
  permissionCodes: [] as string[],
  enabled: true,
  reason: "",
});
const assignmentDialog = ref(false),
  assignmentEditing = ref<RoleAssignment | null>(null);
const assignmentForm = reactive({
  subjectType: "user" as "user" | "project" | "organization",
  subjectId: "",
  managementKind: "resources" as "resources" | "organization" | "project",
  managementIds: [] as string[],
  includeChildren: true,
  enabled: true,
  startsAt: null as string | null,
  expiresAt: null as string | null,
  reason: "",
});
const grantDialog = ref(false),
  editData = ref<RoleDataGrant>(),
  editFeature = ref<FeatureGrant>(),
  grantTargets = ref(pendingResourceGrant.value ? [pendingResourceGrant.value] : []);
const base = computed(
  () => `/api/v1/organizations/${currentOrganizationId.value}`,
);
let sequence = 0;
async function load() {
  const current = ++sequence;
  loading.value = true;
  error.value = "";
  try {
    const [result, resources] = await Promise.all([
      api<RoleAccessState>(base.value + "/role-access"),
      api<{ items: ResourceCatalogItem[] }>(
        base.value + "/role-resource-catalog",
      ),
    ]);
    if (current !== sequence) return;
    state.value = result;
    catalog.value = resources.items;
    if (!result.roles.some((r) => r.id === selected.value))
      selected.value = result.roles[0]?.id ?? "";
    events.value = [];
    if (
      result.permissions &&
      result.roles.some((r) => r.permissionCodes.includes("audit.view"))
    ) {
      try {
        const response = await api<{ items: typeof events.value }>(
          base.value + "/role-events",
        );
        if (current === sequence) events.value = response.items;
      } catch {
        /* Resource-scoped auditors use resource records. */
      }
    }
  } catch (e) {
    if (current === sequence)
      error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (current === sequence) loading.value = false;
  }
}
function status(record: {
  enabled: boolean;
  startsAt: string | null;
  expiresAt: string | null;
}) {
  return !record.enabled
    ? "已停用"
    : record.expiresAt && Date.parse(record.expiresAt) <= Date.now()
      ? "已到期"
      : record.startsAt && Date.parse(record.startsAt) > Date.now()
        ? "未生效"
        : validAt(record)
          ? "生效中"
          : "已失效";
}
function resourceName(target: RoleDataGrant["target"]) {
  return (
    catalog.value.find((t) => resourceKey(t) === resourceKey(target))?.name ??
    "资源已删除"
  );
}
function subjectName(record: { subjectType: string; subjectId: string }) {
  return record.subjectType === "organization"
    ? "组织及所有成员"
    : record.subjectType === "user"
      ? (detail.value?.members.find((m) => m.id === record.subjectId)
          ?.username ?? "成员已移除")
      : (detail.value?.projects.find((p) => p.id === record.subjectId)?.name ??
        "子组织已删除");
}
function validity(record: {
  startsAt: string | null;
  expiresAt: string | null;
}) {
  return `${record.startsAt ? new Date(record.startsAt).toLocaleString() : "立即"} → ${record.expiresAt ? new Date(record.expiresAt).toLocaleString() : "永久"}`;
}
function openRole(role?: OrganizationRole, copy = false) {
  roleEditing.value = copy ? null : (role ?? null);
  Object.assign(roleForm, {
    name: role ? role.name + (copy ? " · 副本" : "") : "",
    description: role?.description ?? "",
    permissionCodes: [...(role?.permissionCodes ?? [])],
    enabled: role?.enabled ?? true,
    reason: "",
  });
  roleDialog.value = true;
}
async function saveRole() {
  if (!roleForm.name.trim() || !roleForm.reason.trim() || saving.value) return;
  saving.value = true;
  try {
    await api(
      base.value +
        "/roles" +
        (roleEditing.value ? `/${roleEditing.value.id}` : ""),
      {
        method: roleEditing.value ? "PUT" : "POST",
        body: JSON.stringify({
          ...roleForm,
          ...(roleEditing.value ? { version: roleEditing.value.version } : {}),
        }),
      },
    );
    roleDialog.value = false;
    await loadSession();
    await load();
    ElMessage.success("角色已保存");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}
async function revoke(segment: string, id: string, label: string) {
  try {
    const result = await ElMessageBox.prompt(
      `请填写${label}的原因。角色变更会立即中断组织现有执行连接。`,
      label,
      {
        inputValidator: (v) => Boolean(v?.trim()) || "请输入变更原因",
        confirmButtonText: "确认",
        cancelButtonText: "取消",
      },
    );
    await api(`${base.value}/${segment}/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ reason: result.value.trim() }),
    });
    await loadSession();
    await load();
    ElMessage.success("已完成");
  } catch (e) {
    if (e !== "cancel" && e !== "close")
      ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}
function openAssignment(record?: RoleAssignment) {
  assignmentEditing.value = record ?? null;
  Object.assign(assignmentForm, {
    subjectType: record?.subjectType ?? "user",
    subjectId: record?.subjectId ?? "",
    managementKind: record?.managementScope.kind ?? "resources",
    managementIds: [...(record?.managementScope.ids ?? [])],
    includeChildren: record?.managementScope.includeChildren ?? true,
    enabled: record?.enabled ?? true,
    startsAt: record?.startsAt ?? null,
    expiresAt: record?.expiresAt ?? null,
    reason: "",
  });
  assignmentDialog.value = true;
}
const iso = (value: unknown) =>
  value ? new Date(value as string).toISOString() : null;
async function saveAssignment() {
  if (!selectedRole.value || saving.value) return;
  saving.value = true;
  try {
    await api(
      base.value +
        "/role-assignments" +
        (assignmentEditing.value ? `/${assignmentEditing.value.id}` : ""),
      {
        method: assignmentEditing.value ? "PUT" : "POST",
        body: JSON.stringify({
          roleId: selectedRole.value.id,
          subjectType: assignmentForm.subjectType,
          subjectId:
            assignmentForm.subjectType === "organization"
              ? currentOrganizationId.value
              : assignmentForm.subjectId,
          managementScope: {
            kind: assignmentForm.managementKind,
            ids:
              assignmentForm.managementKind === "project"
                ? assignmentForm.managementIds
                : [],
            includeChildren: assignmentForm.includeChildren,
          },
          enabled: assignmentForm.enabled,
          startsAt: iso(assignmentForm.startsAt),
          expiresAt: iso(assignmentForm.expiresAt),
          reason: assignmentForm.reason.trim(),
        }),
      },
    );
    assignmentDialog.value = false;
    await loadSession();
    await load();
    ElMessage.success("角色分配已保存");
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}
function openGrant(data?: RoleDataGrant, feature?: FeatureGrant) {
  editData.value = data;
  editFeature.value = feature;
  grantDialog.value = true;
}
watch(pendingResourceGrant, (target) => {
  if (!target) return;
  editData.value = undefined;
  editFeature.value = undefined;
  grantTargets.value = [target];
  grantDialog.value = true;
  pendingResourceGrant.value = null;
}, { immediate: true });
watch(currentOrganizationId, () => {
  selected.value = "";
  roleDialog.value = false;
  assignmentDialog.value = false;
  grantDialog.value = false;
  void load();
});
onMounted(load);
watch(() => dataRevision?.value, () => void load());
</script>
<template>
  <section class="console-panel roles-panel" v-loading="loading">
    <header class="roles-toolbar">
      <div>
        <div class="organization-eyebrow">{{ detail?.organization.name }} / 组织工作空间</div><h1>角色</h1>
        <p>角色定义可执行的操作；数据权限授予角色，已授权对象维护成员与子组织的角色分配。</p>
      </div>
      <div>
        <el-button
          v-if="state?.capabilities.roleCreate"
          type="primary"
          @click="openRole()"
          ><Plus :size="14" />创建角色</el-button
        >
      </div>
    </header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div v-if="state" class="roles-layout">
      <aside class="roles-list" aria-label="角色列表">
        <button
          v-for="role in state.roles"
          :key="role.id"
          :class="{ 'is-selected': selected === role.id }"
          @click="selected = role.id"
        >
          <KeyRound :size="17" /><span><strong>{{ role.name }}</strong
          ><small
            >{{ role.enabled ? "启用" : "已停用" }} ·
            {{ role.permissionCodes.length }} 项操作</small
          ></span>
        </button>
        <p v-if="!state.roles.length">暂无可查看的角色</p>
      </aside>
      <main v-if="selectedRole" class="role-detail">
        <header class="role-heading">
          <div>
            <h3>{{ selectedRole.name }}</h3>
            <p>{{ selectedRole.description || "未填写角色说明" }}</p>
          </div>
          <div>
            <el-button
              v-if="state.capabilities.roleCreate"
              @click="openRole(selectedRole, true)"
              ><Copy :size="14" />复制</el-button
            ><el-button
              v-if="state.capabilities.roleUpdate"
              @click="openRole(selectedRole)"
              >编辑</el-button
            ><el-button
              v-if="state.capabilities.roleDelete"
              :disabled="!!assignments.length || !!dataGrants.length"
              @click="revoke('roles', selectedRole.id, '删除角色')"
              >删除</el-button
            >
          </div>
        </header>
        <el-tabs v-model="tab"
          ><el-tab-pane label="操作权限" name="permissions" /><el-tab-pane
            :label="`数据授权 (${dataGrants.length})`"
            name="data" /><el-tab-pane
            :label="`已授权对象 (${assignments.length})`"
            name="subjects"
        /></el-tabs>
        <RolePermissionList
          v-if="tab === 'permissions'"
          :codes="selectedRole.permissionCodes"
        />
        <template v-if="tab === 'data'">
          <div class="section-actions">
            <span>授权只覆盖所列资源；每行可单独修改或撤销。</span
            ><el-button
              v-if="
                state.capabilities.authorizationCreate ||
                Object.values(state.resourceCapabilities).some((c) => c.create)
              "
              type="primary"
              @click="openGrant()"
              >新增数据授权</el-button
            >
          </div>
          <el-table :data="dataGrants" empty-text="暂无数据授权"
            ><el-table-column label="资源" min-width="170"
              ><template #default="{ row }"
                >{{ resourceName(row.target)
                }}<small class="row-meta"
                  >{{ RESOURCE_TYPE_LABELS[row.target.type as keyof typeof RESOURCE_TYPE_LABELS] }} ·
                  {{
                    row.source === "migration" ? "历史迁移" : "直接授权"
                  }}</small
                ></template
              ></el-table-column
            ><el-table-column label="状态" width="85"
              ><template #default="{ row }">{{
                status(row)
              }}</template></el-table-column
            ><el-table-column label="有效期" min-width="185"
              ><template #default="{ row }">{{
                validity(row)
              }}</template></el-table-column
            ><el-table-column label="操作" width="128"
              ><template #default="{ row }"
                ><el-button
                  v-if="
                    state.resourceCapabilities[resourceKey(row.target)]?.update
                  "
                  link
                  @click="openGrant(row)"
                  >修改</el-button
                ><el-button
                  v-if="
                    state.resourceCapabilities[resourceKey(row.target)]?.revoke
                  "
                  link
                  type="danger"
                  @click="revoke('role-data-grants', row.id, '撤销数据授权')"
                  >撤销</el-button
                ></template
              ></el-table-column
            ></el-table
          >
        </template>
        <template v-if="tab === 'subjects'">
          <div class="section-actions">
            <span>支持成员、多子组织继承和组织根节点分配。</span
            ><el-button
              v-if="state.capabilities.roleUpdate"
              type="primary"
              @click="openAssignment()"
              >分配角色</el-button
            >
          </div>
          <el-table :data="assignments" empty-text="暂无角色分配"
            ><el-table-column label="授权对象" min-width="130"
              ><template #default="{ row }"
                >{{ subjectName(row)
                }}<small class="row-meta">{{
                  row.subjectType === "project"
                    ? "子组织成员及下级成员继承"
                    : row.subjectType === "user"
                      ? "直接分配"
                      : "组织根节点继承"
                }}</small></template
              ></el-table-column
            ><el-table-column label="管理范围" min-width="120"
              ><template #default="{ row }">{{
                row.managementScope.kind === "organization"
                  ? "全组织"
                  : row.managementScope.kind === "project"
                    ? "指定子组织"
                    : "角色数据范围"
              }}</template></el-table-column
            ><el-table-column label="状态" width="85"
              ><template #default="{ row }">{{
                status(row)
              }}</template></el-table-column
            ><el-table-column label="有效期" min-width="185"
              ><template #default="{ row }">{{
                validity(row)
              }}</template></el-table-column
            ><el-table-column
              v-if="state.capabilities.roleUpdate"
              label="操作"
              width="120"
              ><template #default="{ row }"
                ><el-button link @click="openAssignment(row)">修改</el-button
                ><el-button
                  link
                  type="danger"
                  @click="revoke('role-assignments', row.id, '撤销角色分配')"
                  >撤销</el-button
                ></template
              ></el-table-column
            ></el-table
          >
        </template>
      </main>
    </div>
    <section v-if="state" class="feature-section">
      <header class="section-actions">
        <div>
          <h3><ShieldCheck :size="16" />功能授权</h3>
          <p>直接授予成员或子组织；使用资源还需角色及数据授权。</p>
        </div>
        <el-button
          v-if="
            state.capabilities.authorizationCreate ||
            Object.values(state.resourceCapabilities).some((c) => c.create)
          "
          @click="openGrant(undefined, undefined)"
          >维护资源授权</el-button
        >
      </header>
      <el-table :data="state.featureGrants" empty-text="暂无功能授权"
        ><el-table-column label="授权对象"
          ><template #default="{ row }">{{
            subjectName(row)
          }}</template></el-table-column
        ><el-table-column label="功能"
          ><template #default="{ row }">{{
            [
              row.features.mcp ? "MCP" : "",
              row.features.agent ? "Agent" : "",
              row.features.webPlugins ? "Web 插件" : "",
            ]
              .filter(Boolean)
              .join(" / ")
          }}</template></el-table-column
        ><el-table-column label="资源"
          ><template #default="{ row }"
            >{{ row.targets.length }} 个固定资源</template
          ></el-table-column
        ><el-table-column label="状态"
          ><template #default="{ row }">{{
            status(row)
          }}</template></el-table-column
        ><el-table-column label="有效期" min-width="160"
          ><template #default="{ row }">{{
            validity(row)
          }}</template></el-table-column
        ><el-table-column label="操作"
          ><template #default="{ row }"
            ><el-button
              v-if="
                row.targets.every(
                  (t: any) =>
                    state?.resourceCapabilities[resourceKey(t)]?.update,
                )
              "
              link
              @click="openGrant(undefined, row)"
              >修改</el-button
            ><el-button
              v-if="
                row.targets.every(
                  (t: any) =>
                    state?.resourceCapabilities[resourceKey(t)]?.revoke,
                )
              "
              link
              type="danger"
              @click="revoke('feature-grants', row.id, '撤销功能授权')"
              >撤销</el-button
            ></template
          ></el-table-column
        ></el-table
      >
    </section>
    <section v-if="events.length" class="feature-section">
      <h3>最近授权变更</h3>
      <el-table :data="events"
        ><el-table-column prop="action" label="变更" /><el-table-column
          prop="actorName"
          label="操作人"
        /><el-table-column prop="reason" label="原因" /><el-table-column
          label="时间"
          ><template #default="{ row }">{{
            new Date(row.createdAt).toLocaleString()
          }}</template></el-table-column
        ></el-table
      >
    </section>
    <el-dialog
      v-model="roleDialog"
      append-to-body
      align-center
      :title="roleEditing ? '编辑角色' : '创建角色'"
      width="min(780px, calc(100% - 32px))"
      class="envman-dialog"
      ><el-form label-position="top"
        ><el-form-item label="角色名称"
          ><el-input v-model="roleForm.name" maxlength="160" /></el-form-item
        ><el-form-item label="说明"
          ><el-input v-model="roleForm.description" maxlength="2000"
        /></el-form-item>
        <div class="permission-editor">
          <fieldset v-for="module in modules" :key="module">
            <legend>{{ module }}</legend>
            <el-checkbox-group v-model="roleForm.permissionCodes"
              ><el-checkbox
                v-for="item in PERMISSION_DEFINITIONS.filter(
                  (p) => p.module === module,
                )"
                :key="item.code"
                :label="item.label"
                :value="item.code"
            /></el-checkbox-group>
          </fieldset>
        </div>
        <el-form-item label="状态"
          ><el-switch
            v-model="roleForm.enabled"
            active-text="启用"
            inactive-text="停用" /></el-form-item
        ><el-form-item label="变更原因（必填）"
          ><el-input
            v-model="roleForm.reason"
            type="textarea"
            :rows="2"
            maxlength="2000"
        /></el-form-item>
        <p class="muted">
          复制角色仅复制操作权限；数据授权和成员分配需另行维护。角色停用后所有关联授权停止生效。
        </p></el-form
      ><template #footer
        ><el-button @click="roleDialog = false">取消</el-button
        ><el-button
          type="primary"
          :loading="saving"
          :disabled="!roleForm.name.trim() || !roleForm.reason.trim()"
          @click="saveRole"
          >保存角色</el-button
        ></template
      ></el-dialog
    >
    <el-dialog
      v-model="assignmentDialog"
      append-to-body
      align-center
      title="分配角色"
      width="min(620px, calc(100% - 32px))"
      class="envman-dialog"
      ><el-form label-position="top"
        ><el-form-item label="角色"
          ><el-input :model-value="selectedRole?.name" readonly /></el-form-item
        ><el-form-item label="对象类型"
          ><el-select
            v-model="assignmentForm.subjectType"
            @change="assignmentForm.subjectId = ''"
            style="width: 100%"
            ><el-option label="成员" value="user" /><el-option
              label="子组织"
              value="project" /><el-option
              label="组织及所有成员"
              value="organization" /></el-select></el-form-item
        ><el-form-item
          v-if="assignmentForm.subjectType !== 'organization'"
          label="授权对象"
          ><el-select
            v-model="assignmentForm.subjectId"
            filterable
            style="width: 100%"
            ><el-option
              v-for="item in assignmentForm.subjectType === 'user'
                ? detail?.members.filter((m) => m.status === 'active')
                : detail?.projects"
              :key="item.id"
              :value="item.id"
              :label="
                'username' in item ? item.username : item.name
              " /></el-select></el-form-item
        ><el-form-item label="组织与授权管理范围"
          ><el-select
            v-model="assignmentForm.managementKind"
            style="width: 100%"
            ><el-option label="仅角色数据范围" value="resources" /><el-option
              label="全组织"
              value="organization" /><el-option
              label="指定子组织"
              value="project" /></el-select></el-form-item
        ><el-form-item
          v-if="assignmentForm.managementKind === 'project'"
          label="管理子组织"
          ><el-select
            v-model="assignmentForm.managementIds"
            multiple
            style="width: 100%"
            ><el-option
              v-for="item in detail?.projects"
              :key="item.id"
              :label="item.name"
              :value="item.id" /></el-select
          ><el-checkbox v-model="assignmentForm.includeChildren"
            >包含下级子组织</el-checkbox
          ></el-form-item
        >
        <p class="muted">
          管理范围约束组织和授权维护操作；资源执行仍需同一角色的数据授权。角色分配不选择资源或功能。
        </p>
        <el-form-item label="生效时间"
          ><el-date-picker
            v-model="assignmentForm.startsAt"
            type="datetime"
            placeholder="立即" /></el-form-item
        ><el-form-item label="结束时间"
          ><el-date-picker
            v-model="assignmentForm.expiresAt"
            type="datetime"
            placeholder="永久" /></el-form-item
        ><el-form-item label="状态"
          ><el-switch v-model="assignmentForm.enabled" /></el-form-item
        ><el-form-item label="变更原因（必填）"
          ><el-input
            v-model="assignmentForm.reason"
            type="textarea"
            :rows="2" /></el-form-item></el-form
      ><template #footer
        ><el-button @click="assignmentDialog = false">取消</el-button
        ><el-button
          type="primary"
          :loading="saving"
          :disabled="
            !assignmentForm.reason.trim() ||
            (assignmentForm.subjectType !== 'organization' &&
              !assignmentForm.subjectId)
          "
          @click="saveAssignment"
          >保存分配</el-button
        ></template
      ></el-dialog
    >
    <OrganizationResourceAuthorizationDialog
      v-model="grantDialog"
      :organization-id="currentOrganizationId"
      :role-id="selected"
      :targets="grantTargets"
      :edit-data="editData"
      :edit-feature="editFeature"
      @saved="load"
    />
  </section>
</template>
<style scoped>
.roles-panel {
  padding: 24px;
  min-width: 0;
}
.roles-toolbar,
.role-heading,
.section-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.roles-toolbar {
  margin-bottom: 22px;
}
.roles-toolbar h3,
.role-heading h3,
.feature-section h3 {
  margin: 0;
  font-size: 15px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.roles-toolbar p,
.role-heading p,
.feature-section p,
.muted {
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
  margin: 7px 0;
}
.roles-layout {
  display: grid;
  grid-template-columns: 210px minmax(0, 1fr);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  overflow: hidden;
}
.roles-list {
  padding: 10px;
  background: var(--el-fill-color-light);
  border-right: 1px solid var(--el-border-color-lighter);
  max-height: 550px;
  overflow: auto;
}
.roles-list button {
  display: block;
  border: 0;
  background: transparent;
  width: 100%;
  text-align: left;
  padding: 13px 12px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--el-text-color-primary);
  margin-bottom: 3px;
}
.roles-list button.is-selected {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}
.roles-list strong {
  font-size: 13px;
  font-weight: 500;
  display: block;
  overflow-wrap: anywhere;
}
.roles-list small {
  display: block;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  margin-top: 6px;
}
.role-detail {
  padding: 20px;
  min-width: 0;
}
.role-heading {
  align-items: flex-start;
}
.role-heading > div:last-child {
  display: flex;
  flex-shrink: 0;
}
.row-meta {
  display: block;
  color: var(--el-text-color-secondary);
  font-size: 11px;
}
.section-actions {
  margin: 12px 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.feature-section {
  margin-top: 26px;
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 20px;
}
.permission-editor {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  max-height: 350px;
  overflow: auto;
  margin: 18px 0;
}
.permission-editor fieldset {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  padding: 8px 12px;
}
.permission-editor legend {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.permission-editor :deep(.el-checkbox) {
  margin-right: 12px;
  font-size: 12px;
}
@media (max-width: 900px) {
  .roles-layout {
    grid-template-columns: 160px minmax(0, 1fr);
  }
  .role-heading {
    flex-direction: column;
  }
  .roles-panel {
    padding: 14px;
  }
  .permission-editor {
    grid-template-columns: 1fr;
  }
}
</style>
