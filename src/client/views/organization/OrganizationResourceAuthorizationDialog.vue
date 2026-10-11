<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../../api";
import { loadSession } from "../../session";
import {
  RESOURCE_TYPE_LABELS,
  resourceKey,
  type ResourceRef,
  type ResourceCatalogItem,
  type RoleAccessState,
  type RoleDataGrant,
  type FeatureGrant,
} from "../../../shared/organization-rbac";
import RolePermissionList from "./RolePermissionList.vue";
const props = defineProps<{
  modelValue: boolean;
  organizationId: string;
  targets?: ResourceRef[];
  roleId?: string;
  editData?: RoleDataGrant;
  editFeature?: FeatureGrant;
  members?: Array<{ id: string; username: string; status?: string }>;
  projects?: Array<{ id: string; name: string }>;
}>();
const emit = defineEmits<{ "update:modelValue": [boolean]; saved: [] }>();
const open = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});
const tab = ref<"data" | "feature">("data"),
  loading = ref(false),
  saving = ref(false),
  error = ref("");
const state = ref<RoleAccessState | null>(null),
  catalog = ref<ResourceCatalogItem[]>([]),
  members = ref(props.members ?? []),
  projects = ref(props.projects ?? []);
const form = reactive({
  roleId: "",
  targetKeys: [] as string[],
  subjectType: "user" as "user" | "project" | "organization",
  subjectId: "",
  enabled: true,
  startsAt: null as string | null,
  expiresAt: null as string | null,
  reason: "",
  features: { mcp: false, agent: false, webPlugins: false },
});
const selectedRole = computed(() =>
  state.value?.roles.find((r) => r.id === form.roleId),
);
const selectedTargets = computed(() => {
  const selected = catalog.value.filter((t) =>
    form.targetKeys.includes(resourceKey(t)),
  );
  if (props.editData || props.editFeature) return selected;
  const environments = new Set(
    selected.filter((t) => t.type === "environment").map((t) => t.id),
  );
  return catalog.value.filter(
    (t) =>
      form.targetKeys.includes(resourceKey(t)) ||
      t.environmentIds.some((e) => environments.has(e)),
  );
});
const base = computed(() => `/api/v1/organizations/${props.organizationId}`);
const valid = computed(
  () =>
    form.reason.trim() &&
    selectedTargets.value.length &&
    (tab.value === "data"
      ? form.roleId
      : (form.subjectType === "organization" || form.subjectId) &&
        (form.features.mcp || form.features.agent || form.features.webPlugins)),
);
const allowed = computed(
  () =>
    selectedTargets.value.length > 0 &&
    selectedTargets.value.every(
      (t) =>
        state.value?.resourceCapabilities[resourceKey(t)]?.[
          props.editData || props.editFeature ? "update" : "create"
        ],
    ),
);
let sequence = 0;
let mutationKey = crypto.randomUUID();
watch(
  () => props.modelValue,
  async (value) => {
    if (!value) {
      sequence++;
      return;
    }
    mutationKey = crypto.randomUUID();
    const current = ++sequence;
    loading.value = true;
    error.value = "";
    const edit = props.editData ?? props.editFeature;
    tab.value = props.editFeature ? "feature" : "data";
    Object.assign(form, {
      roleId: props.editData?.roleId ?? props.roleId ?? "",
      targetKeys: (props.editData
        ? [props.editData.target]
        : (props.editFeature?.targets ?? props.targets ?? [])
      ).map(resourceKey),
      subjectType: props.editFeature?.subjectType ?? "user",
      subjectId: props.editFeature?.subjectId ?? "",
      enabled: edit?.enabled ?? true,
      startsAt: edit?.startsAt ?? null,
      expiresAt: edit?.expiresAt ?? null,
      reason: "",
      features: props.editFeature
        ? { ...props.editFeature.features }
        : { mcp: false, agent: false, webPlugins: false },
    });
    try {
      const [access, resources, detail] = await Promise.all([
        api<RoleAccessState>(base.value + "/role-access"),
        api<{ items: ResourceCatalogItem[] }>(
          base.value + "/role-resource-catalog",
        ),
        api<{ members: typeof members.value; projects: typeof projects.value }>(
          base.value,
        ),
      ]);
      if (current !== sequence) return;
      state.value = access;
      catalog.value = resources.items;
      members.value = detail.members;
      projects.value = detail.projects;
    } catch (e) {
      if (current === sequence)
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (current === sequence) loading.value = false;
    }
  },
);
async function save() {
  if (!valid.value || !allowed.value || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const validity = {
      enabled: form.enabled,
      startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null,
      expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      reason: form.reason.trim(),
    };
    const refs = selectedTargets.value.map(({ type, id }) => ({ type, id }));
    const edit = tab.value === "data" ? props.editData : props.editFeature;
    await api(
      base.value +
        (tab.value === "data" ? "/role-data-grants" : "/feature-grants") +
        (edit ? `/${edit.id}` : ""),
      {
        headers: { "Idempotency-Key": mutationKey },
        method: edit ? "PUT" : "POST",
        body: JSON.stringify(
          tab.value === "data"
            ? { ...validity, roleId: form.roleId, targets: refs }
            : {
                ...validity,
                subjectType: form.subjectType,
                subjectId:
                  form.subjectType === "organization"
                    ? props.organizationId
                    : form.subjectId,
                targets: refs,
                features: form.features,
              },
        ),
      },
    );
    await loadSession();
    ElMessage.success("授权已保存");
    open.value = false;
    emit("saved");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <el-dialog
    v-model="open"
    append-to-body
    align-center
    title="维护资源授权"
    width="min(760px, calc(100% - 32px))"
    class="envman-dialog"
  >
    <div v-loading="loading" class="resource-grant-form">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-tabs v-model="tab"
        ><el-tab-pane
          label="数据授权"
          name="data"
          :disabled="!!editFeature" /><el-tab-pane
          label="功能授权"
          name="feature"
          :disabled="!!editData"
      /></el-tabs>
      <el-form label-position="top" @submit.prevent="save">
        <template v-if="tab === 'data'">
          <el-form-item label="授权角色"
            ><el-select
              v-model="form.roleId"
              filterable
              :disabled="!!editData"
              style="width: 100%"
              placeholder="选择角色"
              ><el-option
                v-for="role in state?.roles"
                :key="role.id"
                :label="role.name + (role.enabled ? '' : '（已停用）')"
                :value="role.id" /></el-select
          ></el-form-item>
          <RolePermissionList
            v-if="selectedRole"
            :codes="selectedRole.permissionCodes"
          />
          <p class="grant-note">
            数据授权只维护角色的资源范围；成员分配在“已授权对象”中维护。
          </p>
        </template>
        <template v-else>
          <div class="grant-row">
            <el-form-item label="授权对象类型"
              ><el-select
                v-model="form.subjectType"
                @change="form.subjectId = ''"
                style="width: 100%"
                ><el-option label="成员" value="user" /><el-option
                  label="子组织"
                  value="project" /><el-option
                  label="组织及所有成员"
                  value="organization" /></el-select></el-form-item
            ><el-form-item
              v-if="form.subjectType !== 'organization'"
              label="授权对象"
              ><el-select
                v-model="form.subjectId"
                filterable
                style="width: 100%"
                ><el-option
                  v-for="item in form.subjectType === 'user'
                    ? members.filter((m) => !m.status || m.status === 'active')
                    : projects"
                  :key="item.id"
                  :value="item.id"
                  :label="
                    'username' in item ? item.username : item.name
                  " /></el-select
            ></el-form-item>
          </div>
          <el-form-item label="允许使用的功能"
            ><el-checkbox v-model="form.features.mcp">MCP</el-checkbox
            ><el-checkbox v-model="form.features.agent">Agent</el-checkbox
            ><el-checkbox v-model="form.features.webPlugins"
              >Web 插件（按环境）</el-checkbox
            ></el-form-item
          >
          <p class="grant-note">
            功能授权独立保存。执行仍需同时满足角色操作权限和数据授权；组织执行入口在阶段
            6 开放。
          </p>
        </template>
        <el-form-item label="资源范围"
          ><el-select
            v-model="form.targetKeys"
            multiple
            filterable
            :disabled="!!editData"
            style="width: 100%"
            placeholder="选择资源，选择环境将展开当前资源"
            ><el-option
              v-for="item in catalog"
              :key="resourceKey(item)"
              :value="resourceKey(item)"
              :label="`${item.name} · ${RESOURCE_TYPE_LABELS[item.type]}`" /></el-select
        ></el-form-item>
        <details v-if="selectedTargets.length" class="scope-preview">
          <summary>
            本次固定 {{ selectedTargets.length }} 个资源{{
              editData ? "" : "，以后新增的资源需另行授权"
            }}
          </summary>
          <ul>
            <li v-for="item in selectedTargets" :key="resourceKey(item)">
              {{ item.name }} · {{ RESOURCE_TYPE_LABELS[item.type] }}
            </li>
          </ul>
        </details>
        <div class="grant-row">
          <el-form-item label="生效时间"
            ><el-date-picker
              v-model="form.startsAt"
              type="datetime"
              placeholder="立即"
              style="width: 100%" /></el-form-item
          ><el-form-item label="结束时间"
            ><el-date-picker
              v-model="form.expiresAt"
              type="datetime"
              placeholder="永久"
              style="width: 100%"
          /></el-form-item>
        </div>
        <el-form-item label="状态"
          ><el-switch
            v-model="form.enabled"
            active-text="启用"
            inactive-text="停用"
        /></el-form-item>
        <el-form-item label="变更原因（必填）"
          ><el-input
            v-model="form.reason"
            type="textarea"
            :rows="2"
            maxlength="2000"
        /></el-form-item>
      </el-form>
      <el-alert
        v-if="selectedTargets.length && !allowed && !loading"
        title="你没有所选资源的授权维护权限"
        type="warning"
        :closable="false"
      />
    </div>
    <template #footer
      ><el-button @click="open = false">取消</el-button
      ><el-button
        type="primary"
        :loading="saving"
        :disabled="!valid || !allowed || loading"
        @click="save"
        >保存授权</el-button
      ></template
    >
  </el-dialog>
</template>
<style scoped>
.grant-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.grant-note {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
  margin: 12px 0 18px;
}
.scope-preview {
  padding: 12px;
  margin-bottom: 18px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  font-size: 12px;
}
.scope-preview summary {
  cursor: pointer;
}
.scope-preview ul {
  max-height: 140px;
  overflow: auto;
  padding-left: 20px;
  line-height: 1.8;
}
.resource-grant-form {
  min-height: 200px;
}
</style>
