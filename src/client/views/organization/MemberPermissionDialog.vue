<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../../api";
import { session } from "../../session";
import { RESOURCE_CAPABILITIES, RESOURCE_TYPE_LABELS, type ResourceType } from "../../../shared/organization-rbac";
import RolePermissionList from "./RolePermissionList.vue";

const props = defineProps<{ modelValue: boolean; organizationId: string; memberId: string; username: string }>();
const emit = defineEmits<{ "update:modelValue": [boolean] }>();
const open = computed({ get: () => props.modelValue, set: (value) => emit("update:modelValue", value) });
const loading = ref(false);
const error = ref("");

type SourceName = "direct" | "ancestor" | "organization";
interface PermissionTarget { type: ResourceType; id: string; name: string }
interface PermissionView {
  effectiveRoleNames: string[];
  partialReason: string | null;
  roles: Array<{ id: string; name: string; usable: boolean; permissionCodes: string[] }>;
  assignments: Array<{ id: string; roleName: string; subjectName: string; source: SourceName; startsAt: string | null; expiresAt: string | null; usable: boolean; invalidReason: string | null }>;
  dataGrants: Array<{ id: string; roleName: string; target: PermissionTarget; permissionCodes: string[]; sources: Array<{ source: SourceName; subjectName: string }>; startsAt: string | null; expiresAt: string | null; usable: boolean; invalidReason: string | null }>;
  featureGrants: Array<{ id: string; subjectName: string; source: SourceName; features: { mcp: boolean; agent: boolean; webPlugins: boolean }; targets: PermissionTarget[]; hiddenTargetCount: number; startsAt: string | null; expiresAt: string | null; usable: boolean; invalidReason: string | null }>;
}
const state = ref<PermissionView | null>(null);
const sourceLabel: Record<SourceName, string> = { direct: "直接", ancestor: "祖先继承", organization: "组织" };

function operationCodes(codes: string[], target: PermissionTarget) {
  const capability = RESOURCE_CAPABILITIES[target.type];
  return codes.filter((code) => {
    const [head, mid] = code.split(".");
    return head === capability || (head === "resource" && mid === capability);
  });
}
function sourceOf(source: string, subjectType: string): SourceName {
  if (subjectType === "organization" || source === "organization") return "organization";
  if (source === "ancestor" || source === "inherited" || subjectType === "project") return subjectType === "project" && source === "direct" ? "direct" : "ancestor";
  return "direct";
}
function period(startsAt: string | null, expiresAt: string | null) {
  return `${startsAt || "立即"} 至 ${expiresAt || "不限"}`;
}
function capability(usable: boolean, invalidReason: string | null) {
  return usable ? "有效" : invalidReason || "当前不可用";
}
function featureMarks(features: { mcp: boolean; agent: boolean; webPlugins: boolean }) {
  return [features.mcp && "MCP", features.agent && "Agent", features.webPlugins && "Web 插件"].filter(Boolean).join(" / ") || "未选功能";
}
function sourceText(sources: Array<{ source: SourceName; subjectName: string }>) {
  return sources.map((item) => [item.subjectName, sourceLabel[item.source]].filter(Boolean).join(" · ")).join("、") || "—";
}

function fromMine(payload: { roles: Array<Record<string, any>>; dataGrants: Array<Record<string, any>>; featureGrants: Array<Record<string, any>> }): PermissionView {
  const roles = new Map<string, PermissionView["roles"][number]>();
  for (const role of payload.roles) {
    const current = roles.get(String(role.roleId));
    const usable = role.status === "active";
    if (!current) roles.set(String(role.roleId), { id: String(role.roleId), name: String(role.name || ""), usable, permissionCodes: role.permissionCodes ?? [] });
    else if (usable) current.usable = true;
  }
  return {
    effectiveRoleNames: payload.roles.filter((role) => role.status === "active").map((role) => String(role.name)),
    partialReason: null,
    roles: [...roles.values()],
    assignments: payload.roles.map((role) => ({
      id: String(role.id),
      roleName: String(role.name || ""),
      subjectName: "",
      source: sourceOf(String(role.source || ""), String(role.subjectType || "")),
      startsAt: role.startsAt ?? null,
      expiresAt: role.expiresAt ?? null,
      usable: role.status === "active",
      invalidReason: role.status === "active" ? null : role.status === "pending" ? "分配尚未生效" : role.status === "expired" ? "分配已到期" : "分配已停用",
    })),
    dataGrants: payload.dataGrants.map((grant) => {
      const role = payload.roles.find((item) => item.roleId === grant.roleId);
      const target = { type: grant.target.type as ResourceType, id: String(grant.target.id), name: String(grant.name || "") };
      return {
        id: String(grant.id),
        roleName: String(grant.roleName || ""),
        target,
        permissionCodes: operationCodes(role?.permissionCodes ?? [], target),
        sources: payload.roles.filter((item) => item.roleId === grant.roleId).map((item) => ({ source: sourceOf(String(item.source || ""), String(item.subjectType || "")), subjectName: "" })),
        startsAt: grant.startsAt ?? null,
        expiresAt: grant.expiresAt ?? null,
        usable: grant.status === "active" && role?.status === "active",
        invalidReason: grant.status === "active" ? (role?.status === "active" ? null : "分配当前不可用") : grant.status === "pending" ? "授权尚未生效" : grant.status === "expired" ? "授权已过期" : "授权已停用",
      };
    }),
    featureGrants: payload.featureGrants.map((grant) => ({
      id: String(grant.id),
      subjectName: "",
      source: sourceOf(String(grant.source || ""), String(grant.subjectType || "")),
      features: grant.features,
      targets: (grant.targets as Array<{ type: ResourceType; id: string }>).map((target) => ({ type: target.type, id: target.id, name: "" })),
      hiddenTargetCount: 0,
      startsAt: grant.startsAt ?? null,
      expiresAt: grant.expiresAt ?? null,
      usable: grant.status === "active",
      invalidReason: grant.status === "active" ? null : grant.status === "pending" ? "授权尚未生效" : grant.status === "expired" ? "授权已过期" : "授权已停用",
    })),
  };
}

watch(() => [props.modelValue, props.memberId] as const, async ([value]) => {
  if (!value) return;
  loading.value = true;
  error.value = "";
  state.value = null;
  try {
    const self = session.user?.id === props.memberId;
    if (self) {
      state.value = fromMine(await api(`/api/v1/organizations/${props.organizationId}/my-access`));
    } else {
      const payload = await api<PermissionView & { featureGrants: Array<PermissionView["featureGrants"][number] & { hiddenTargetCount?: number }> }>(`/api/v1/organizations/${props.organizationId}/members/${props.memberId}/permissions`);
      state.value = { ...payload, featureGrants: payload.featureGrants.map((grant) => ({ ...grant, hiddenTargetCount: grant.hiddenTargetCount ?? 0 })) };
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "成员权限加载失败";
  } finally {
    loading.value = false;
  }
}, { immediate: true });
</script>

<template>
  <el-dialog v-model="open" :title="`${username} 的权限`" width="min(760px, calc(100% - 32px))" append-to-body align-center class="envman-dialog">
    <div v-loading="loading">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <template v-else-if="state">
        <p>有效角色：{{ state.effectiveRoleNames.join("、") || "暂无有效角色" }}</p>
        <el-alert v-if="state.partialReason" :title="state.partialReason" type="info" :closable="false" />
        <h4>角色与操作码</h4>
        <article v-for="role in state.roles" :key="role.id">
          <strong>{{ role.name }}{{ role.usable ? "" : "（当前不可用）" }}</strong>
          <RolePermissionList :codes="role.permissionCodes" />
        </article>
        <p v-if="!state.roles.length">没有可查看的角色</p>
        <h4>角色分配</h4>
        <p v-for="row in state.assignments" :key="row.id">{{ row.roleName }} · {{ row.subjectName || sourceLabel[row.source] }} · {{ sourceLabel[row.source] }} · {{ capability(row.usable, row.invalidReason) }} · {{ period(row.startsAt, row.expiresAt) }}</p>
        <p v-if="!state.assignments.length">没有角色分配</p>
        <h4>数据授权</h4>
        <p v-for="row in state.dataGrants" :key="row.id">{{ row.target.name || "未命名资源" }} · {{ RESOURCE_TYPE_LABELS[row.target.type] }} · {{ row.roleName }} · {{ row.permissionCodes.join("、") || "无对应操作码" }} · {{ sourceText(row.sources) }} · {{ capability(row.usable, row.invalidReason) }} · {{ period(row.startsAt, row.expiresAt) }}</p>
        <p v-if="!state.dataGrants.length">没有数据授权</p>
        <h4>功能授权</h4>
        <p v-for="row in state.featureGrants" :key="row.id">
          <template v-for="(target, index) in row.targets" :key="`${target.type}:${target.id}`">{{ index ? "、" : "" }}{{ target.name || "未命名资源" }}（{{ RESOURCE_TYPE_LABELS[target.type] }}）</template>
          <template v-if="!row.targets.length">未命名资源</template>
          · {{ featureMarks(row.features) }} · {{ row.subjectName || sourceLabel[row.source] }} · {{ sourceLabel[row.source] }} · {{ capability(row.usable, row.invalidReason) }} · {{ period(row.startsAt, row.expiresAt) }}
          <template v-if="row.hiddenTargetCount"> · 另有 {{ row.hiddenTargetCount }} 个目标不在当前查看范围内</template>
        </p>
        <p v-if="!state.featureGrants.length">没有功能授权</p>
      </template>
    </div>
  </el-dialog>
</template>
