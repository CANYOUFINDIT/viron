<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../../api";
import { RESOURCE_TYPE_LABELS, type ResourceType } from "../../../shared/organization-rbac";
import { useOrganizationContext } from "./context";
import RolePermissionList from "./RolePermissionList.vue";
import GrantRequestDetail from "./GrantRequestDetail.vue";
import OrganizationGrantTargetPicker from "./OrganizationGrantTargetPicker.vue";
import {
  approvalFlowGroups,
  catalogLabel,
  durationMilliseconds,
  DURATION_PRESETS,
  featuresForTargets,
  featuresSubmittable,
  grantRequestStatusLabel,
  hasEnvironmentTarget,
  pendingResourceGrant,
  toggleResource,
  type ApprovalFlowGroup,
  type FeatureFlags,
  type NamedCatalogItem,
} from "./grant-selection";

const { activePanel, currentOrganizationId, session } = useOrganizationContext();
const { dataRevision } = useOrganizationContext();

interface ScopeProject { id: string; name: string }
interface ManagementScopeView { kind: "organization" | "project" | "resources"; includeChildren: boolean; projects: ScopeProject[] }
interface Holder { id: string; name: string }
interface AccessRole {
  id: string;
  roleId: string;
  name: string;
  permissionCodes: string[];
  source: "direct" | "inherited";
  subjectName: string;
  managementScope: ManagementScopeView;
  holders: Holder[];
  startsAt: string | null;
  expiresAt: string | null;
  usable: boolean;
  invalidReason: string | null;
}
interface AccessGrantTarget { type: ResourceType; id: string; name: string }
interface DataGrant {
  id: string;
  roleName: string;
  target: AccessGrantTarget;
  permissionCodes: string[];
  sources: Array<{ source: "direct" | "inherited"; subjectName: string }>;
  startsAt: string | null;
  expiresAt: string | null;
  usable: boolean;
  invalidReason: string | null;
}
interface FeatureGrant {
  id: string;
  targets: AccessGrantTarget[];
  features: FeatureFlags;
  source: "direct" | "inherited";
  subjectName: string;
  startsAt: string | null;
  expiresAt: string | null;
  usable: boolean;
  invalidReason: string | null;
}
interface AccessPayload { roles: AccessRole[]; dataGrants: DataGrant[]; featureGrants: FeatureGrant[] }
interface RequestSummary { id: string; kind: "data" | "feature"; status: string; reason: string; pauseReason?: string; blockReason?: string; flowName?: string }
interface PendingSplit {
  features: FeatureFlags | null;
  groups: ApprovalFlowGroup[];
}

const access = ref<AccessPayload>({ roles: [], dataGrants: [], featureGrants: [] });
const requests = ref<RequestSummary[]>([]);
const catalog = ref<NamedCatalogItem[]>([]);
const error = ref("");
const message = ref("");
const loading = ref(false);
const requestDialog = ref<"data" | "feature" | null>(null);
const dataRoleId = ref("");
const dataTargets = ref<Array<{ type: ResourceType; id: string }>>([]);
const featureTargets = ref<Array<{ type: ResourceType; id: string }>>([]);
const dataReason = ref("");
const featureReason = ref("");
const dataDuration = ref("forever");
const featureDuration = ref("forever");
const dataAmount = ref(1);
const dataUnit = ref<"minute" | "hour" | "day">("hour");
const featureAmount = ref(1);
const featureUnit = ref<"minute" | "hour" | "day">("hour");
const featureFlags = ref<FeatureFlags>({ mcp: false, agent: false, webPlugins: false });
const dataQuery = ref("");
const featureQuery = ref("");
const dataSplit = ref<PendingSplit | null>(null);
const featureSplit = ref<PendingSplit | null>(null);
const detailId = ref("");
const detailOpen = ref(false);
const permissionsOpen = ref(false);
const permissionDetail = ref<{ name: string; codes: string[]; resource?: string } | null>(null);

const tab = computed(() => activePanel.value === "requests" || activePanel.value === "todo" ? activePanel.value : "mine");
const requestRoles = computed(() => {
  const seen = new Set<string>();
  return access.value.roles.filter((role) => {
    if (!role.usable || seen.has(role.roleId)) return false;
    seen.add(role.roleId);
    return true;
  });
});
const selectedRole = computed(() => requestRoles.value.find((role) => role.roleId === dataRoleId.value) ?? null);
const visibleRequests = computed(() => tab.value === "mine" ? [] : requests.value);

function openTab(next: "mine" | "requests" | "todo") {
  activePanel.value = next;
}
function period(startsAt: string | null, expiresAt: string | null) {
  return [
    startsAt ? `生效 ${new Date(startsAt).toLocaleString()}` : "立即生效",
    expiresAt ? `到期 ${new Date(expiresAt).toLocaleString()}` : "长期有效",
  ];
}
function openPermissions(name: string, codes: string[], resource?: string) {
  permissionDetail.value = { name, codes, resource };
  permissionsOpen.value = true;
}
function scopeText(scope: ManagementScopeView) {
  if (scope.kind === "organization") return `组织${scope.includeChildren ? "，包含下级" : "，不含下级"}`;
  if (scope.kind === "project") {
    const names = scope.projects.map((project) => project.name || "未命名子组织").join("、") || "未指定子组织";
    return `子组织 ${names}${scope.includeChildren ? "，包含下级" : "，不含下级"}`;
  }
  return "资源范围，不表示可管理子组织";
}
function sourceText(source: "direct" | "inherited", subjectName: string) {
  return `${source === "direct" ? "直接" : "继承"} · ${subjectName || "未记录来源"}`;
}
function capability(usable: boolean, invalidReason: string | null) {
  return usable ? "当前有效" : invalidReason || "当前不可用";
}
function featureText(features: FeatureFlags) {
  return [features.mcp && "MCP", features.agent && "Agent", features.webPlugins && "Web 插件"].filter(Boolean).join("、") || "未选功能";
}
function durationValue(preset: string, amount: number, unit: "minute" | "hour" | "day") {
  if (preset === "forever") return { ms: null } as const;
  if (preset === "custom") {
    const ms = durationMilliseconds(amount, unit);
    return ms === null ? { error: "请填写大于 0 的分钟、小时或天数" } as const : { ms } as const;
  }
  const found = DURATION_PRESETS.find((item) => item.id === preset);
  return { ms: found ? found.ms : null } as const;
}

async function load() {
  const organizationId = currentOrganizationId.value;
  if (!organizationId) return;
  loading.value = true;
  error.value = "";
  try {
    const view = tab.value === "todo" ? "todo" : "mine";
    const [mine, list] = await Promise.all([
      api<AccessPayload>(`/api/v1/organizations/${organizationId}/my-access`),
      api<{ items: RequestSummary[] }>(`/api/v1/organizations/${organizationId}/grant-requests?view=${view}`),
    ]);
    access.value = mine;
    requests.value = list.items;
    try {
      catalog.value = (await api<{ catalog: NamedCatalogItem[] }>(`/api/v1/organizations/${organizationId}/approval-flows`)).catalog;
    } catch {
      catalog.value = [];
    }
    if (!requestRoles.value.some((role) => role.roleId === dataRoleId.value)) dataRoleId.value = requestRoles.value[0]?.roleId ?? "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "我的授权加载失败";
  } finally {
    loading.value = false;
  }
}
watch(() => [currentOrganizationId.value, tab.value, dataRevision?.value] as const, load, { immediate: true });
watch(() => [currentOrganizationId.value, tab.value] as const, () => {
  permissionsOpen.value = false;
  permissionDetail.value = null;
});
watch(pendingResourceGrant, (target) => {
  if (!target) return;
  dataTargets.value = toggleResource(dataTargets.value, target, true);
  featureTargets.value = toggleResource(featureTargets.value, target, true);
  pendingResourceGrant.value = null;
  if (tab.value !== "requests") openTab("requests");
}, { immediate: true });
watch(featureTargets, (targets) => {
  if (!hasEnvironmentTarget(targets)) featureFlags.value.webPlugins = false;
}, { deep: true });

function openDetail(id: string) {
  detailId.value = id;
  detailOpen.value = true;
}
async function submit(kind: "data" | "feature", group?: ApprovalFlowGroup) {
  const organizationId = currentOrganizationId.value;
  if (!organizationId) return;
  message.value = "";
  const reason = (kind === "data" ? dataReason.value : featureReason.value).trim();
  if (!reason) {
    message.value = "请填写申请理由";
    return;
  }
  const duration = durationValue(
    kind === "data" ? dataDuration.value : featureDuration.value,
    kind === "data" ? dataAmount.value : featureAmount.value,
    kind === "data" ? dataUnit.value : featureUnit.value,
  );
  if ("error" in duration) {
    message.value = duration.error || "请填写大于 0 的分钟、小时或天数";
    return;
  }
  const targets = group ? group.targets : kind === "data" ? dataTargets.value : featureTargets.value;
  if (!targets.length) {
    message.value = "请选择实际资源";
    return;
  }
  const features = kind === "feature" ? featuresForTargets(featureFlags.value, targets) : null;
  if (kind === "feature" && (!features || !featuresSubmittable(features))) {
    message.value = group ? `${group.flowName} 这一组没有可提交的功能。Web 插件只跟随环境目标。` : "请至少选择一项对所选目标有效的功能";
    return;
  }
  if (kind === "data" && !dataRoleId.value) {
    message.value = "请选择自己当前有效持有的角色";
    return;
  }
  try {
    await api(`/api/v1/organizations/${organizationId}/grant-requests`, {
      method: "POST",
      body: JSON.stringify({
        kind,
        roleId: kind === "data" ? dataRoleId.value : null,
        features,
        targets,
        durationMs: duration.ms,
        reason,
        ...(group ? { flowId: group.flowId } : {}),
      }),
    });
    message.value = group ? `已提交 ${group.flowName}` : "申请已提交";
    const split = kind === "data" ? dataSplit : featureSplit;
    if (group && split.value) {
      split.value = { ...split.value, groups: split.value.groups.filter((item) => item.flowId !== group.flowId) };
      if (!split.value.groups.length) split.value = null;
    } else split.value = null;
    await load();
    requestDialog.value = null;
  } catch (cause) {
    const groups = approvalFlowGroups(cause);
    if (groups) {
      const split = { features, groups };
      if (kind === "data") dataSplit.value = split;
      else featureSplit.value = split;
      message.value = "这些资源分属不同审批流程，请按下面每一组分别提交。不会自动改用其中一条。";
      return;
    }
    message.value = cause instanceof Error ? cause.message : "申请提交失败";
  }
}
function groupFlagText(group: ApprovalFlowGroup) {
  const flags = featuresForTargets(featureFlags.value, group.targets);
  return { flags, text: featureText(flags), ready: featuresSubmittable(flags) };
}
</script>

<template>
  <section class="console-panel mine-panel" aria-label="我的">
    <header class="mine-panel__heading">
      <div>
        <h1>{{ session.user?.username }}</h1>
        <p>查看自己的授权，提交数据或功能申请，并处理当前轮到自己的审批。</p>
      </div>
      <div class="mine-panel__actions"><el-button @click="requestDialog = 'data'">申请数据授权</el-button><el-button type="primary" @click="requestDialog = 'feature'">申请功能授权</el-button></div>
    </header>
    <nav class="console-tabs mine-tabs" aria-label="我的授权、我的申请、待我审批">
      <button type="button" :class="{ 'is-active': tab === 'mine' }" @click="openTab('mine')">我的授权</button>
      <button type="button" :class="{ 'is-active': tab === 'requests' }" @click="openTab('requests')">我的申请</button>
      <button type="button" :class="{ 'is-active': tab === 'todo' }" @click="openTab('todo')">待我审批</button>
    </nav>
    <p v-if="error" class="mine-error">{{ error }}</p>
    <p v-if="message" class="mine-note">{{ message }}</p>
    <div v-loading="loading">
      <template v-if="tab === 'mine'">
        <section>
          <h4>已分配角色</h4>
          <div class="organization-table mine-access-table"><table aria-label="已分配角色">
            <colgroup><col class="mine-access-table__subject"><col><col class="mine-access-table__validity"><col class="mine-access-table__action"></colgroup>
            <thead><tr><th scope="col">成员 / 子组织</th><th scope="col">角色</th><th scope="col">分配有效期 / 状态</th><th scope="col">操作</th></tr></thead><tbody>
            <tr v-for="role in access.roles" :key="role.id">
              <td><strong>{{ role.subjectName }}</strong><small>{{ sourceText(role.source, role.subjectName) }}</small></td>
              <td><strong>{{ role.name }}</strong><small>{{ scopeText(role.managementScope) }}</small><small>{{ role.permissionCodes.length }} 项操作权限</small></td>
              <td><span class="organization-status" :class="{ 'is-active': role.usable }">{{ capability(role.usable, role.invalidReason) }}</span><small v-for="line in period(role.startsAt, role.expiresAt)" :key="line">{{ line }}</small></td>
              <td><el-button link type="primary" :aria-label="`查看 ${role.name} 的操作权限`" @click="openPermissions(role.name, role.permissionCodes)">查看权限</el-button></td>
            </tr>
            <tr v-if="!access.roles.length"><td colspan="4" class="organization-table__empty">暂无角色</td></tr>
          </tbody></table></div>
        </section>
        <section>
          <h4>角色的数据授权</h4>
          <div class="organization-table mine-access-table"><table aria-label="角色的数据授权">
            <colgroup><col class="mine-access-table__role"><col><col class="mine-access-table__validity"><col class="mine-access-table__action"></colgroup>
            <thead><tr><th scope="col">角色</th><th scope="col">授权资源</th><th scope="col">有效期 / 状态</th><th scope="col">操作</th></tr></thead><tbody>
            <tr v-for="grant in access.dataGrants" :key="grant.id">
              <td><strong>{{ grant.roleName }}</strong><small>{{ grant.sources.map(item => sourceText(item.source, item.subjectName)).join('、') }}</small></td>
              <td><strong>{{ grant.target.name || '目标已删除' }}</strong><small>{{ RESOURCE_TYPE_LABELS[grant.target.type] }} · {{ grant.permissionCodes.length }} 项操作权限</small></td>
              <td><span class="organization-status" :class="{ 'is-active': grant.usable }">{{ grant.usable ? '当前可操作' : (grant.invalidReason || '当前不可用') }}</span><small v-for="line in period(grant.startsAt, grant.expiresAt)" :key="line">{{ line }}</small></td>
              <td><el-button link type="primary" :aria-label="`查看 ${grant.target.name || '目标已删除'} 的授权操作权限`" @click="openPermissions(grant.roleName, grant.permissionCodes, grant.target.name || '目标已删除')">查看权限</el-button></td>
            </tr>
            <tr v-if="!access.dataGrants.length"><td colspan="4" class="organization-table__empty">暂无数据授权</td></tr>
          </tbody></table></div>
        </section>
        <section>
          <h4>功能授权 · 环境与连接</h4>
          <div class="organization-table mine-access-table"><table aria-label="功能授权">
            <colgroup><col class="mine-access-table__subject"><col><col class="mine-access-table__features"><col class="mine-access-table__validity"></colgroup>
            <thead><tr><th scope="col">成员 / 子组织</th><th scope="col">资源范围</th><th scope="col">允许的功能</th><th scope="col">有效期 / 状态</th></tr></thead><tbody>
            <tr v-for="grant in access.featureGrants" :key="grant.id"><td><strong>{{ grant.subjectName }}</strong><small>{{ sourceText(grant.source, grant.subjectName) }}</small></td><td><div v-for="target in grant.targets" :key="`${target.type}:${target.id}`" class="mine-access-table__target"><strong>{{ target.name || '目标已删除' }}</strong><small>{{ RESOURCE_TYPE_LABELS[target.type] }}</small></div></td><td>{{ featureText(grant.features) }}</td><td><span class="organization-status" :class="{ 'is-active': grant.usable }">{{ capability(grant.usable, grant.invalidReason) }}</span><small v-for="line in period(grant.startsAt, grant.expiresAt)" :key="line">{{ line }}</small></td></tr>
            <tr v-if="!access.featureGrants.length"><td colspan="4" class="organization-table__empty">暂无功能授权</td></tr>
          </tbody></table></div>
        </section>
      </template>

      <template v-else-if="tab === 'requests'">


      </template>

      <section v-if="tab !== 'mine'">
        <h4>{{ tab === "todo" ? "待我审批" : "我的申请" }}</h4>
        <p v-if="!visibleRequests.length">暂无记录</p>
        <article v-for="item in visibleRequests" :key="item.id">
          <strong>{{ item.kind === "data" ? "数据申请" : "功能申请" }} · {{ grantRequestStatusLabel[item.status] ?? item.status }}</strong>
          <small>{{ item.flowName || "流程见详情" }} · {{ item.reason }}</small>
          <small v-if="item.pauseReason || item.blockReason">{{ item.pauseReason || item.blockReason }}</small>
          <button type="button" @click="openDetail(item.id)">查看详情</button>
        </article>
      </section>
    </div>
<el-dialog append-to-body :model-value="requestDialog === 'feature'" @update:model-value="requestDialog = null" title="申请功能授权" width="min(680px, calc(100% - 32px))" align-center class="envman-dialog"><p v-if="message" class="mine-note">{{ message }}</p><form class="mine-form" @submit.prevent="submit('feature')">
          <h4>申请功能授权</h4>
          <p class="mine-note">功能申请不选择角色，只作用在本人。单个连接不能申请 Web 插件。</p>
          <fieldset>
            <legend>功能</legend>
            <el-checkbox v-model="featureFlags.mcp">MCP</el-checkbox>
            <el-checkbox v-model="featureFlags.agent">Agent</el-checkbox>
            <el-checkbox v-model="featureFlags.webPlugins" :disabled="!hasEnvironmentTarget(featureTargets)">Web 插件</el-checkbox>
            <small v-if="!hasEnvironmentTarget(featureTargets)">当前选择没有环境，不能勾选 Web 插件。</small>
          </fieldset>
          <OrganizationGrantTargetPicker v-model="featureTargets" v-model:query="featureQuery" :catalog="catalog" />
          <fieldset>
            <legend>时长</legend>
            <small>从最终生效时开始计算。</small>
            <el-radio-group v-model="featureDuration">
              <el-radio v-for="item in DURATION_PRESETS" :key="item.id" :value="item.id">{{ item.label }}</el-radio>
              <el-radio value="custom">自定义</el-radio>
            </el-radio-group>
            <div v-if="featureDuration === 'custom'" class="mine-duration">
              <el-input-number v-model="featureAmount" :min="1" :step="1" />
              <el-select v-model="featureUnit" style="width: 120px">
                <el-option label="分钟" value="minute" />
                <el-option label="小时" value="hour" />
                <el-option label="天" value="day" />
              </el-select>
            </div>
          </fieldset>
          <label>理由 <el-input v-model="featureReason" maxlength="2000" /></label>
          <el-button type="primary" native-type="submit">提交功能申请</el-button>
          <div v-if="featureSplit" class="mine-groups">
            <h5>按流程分别提交</h5>
            <article v-for="group in featureSplit.groups" :key="group.flowId">
              <strong>{{ group.flowName }}</strong>
              <p v-for="target in group.targets" :key="`${target.type}:${target.id}`">{{ catalogLabel(catalog, target) }}</p>
              <p>本组功能：{{ groupFlagText(group).text }}</p>
              <el-button type="primary" :disabled="!groupFlagText(group).ready" @click="submit('feature', group)">提交这一组</el-button>
            </article>
          </div>
        </form><template #footer><el-button @click="requestDialog = null">关闭</el-button></template></el-dialog>
<el-dialog append-to-body :model-value="requestDialog === 'data'" @update:model-value="requestDialog = null" title="申请数据授权" width="min(680px, calc(100% - 32px))" align-center class="envman-dialog"><p v-if="message" class="mine-note">{{ message }}</p><form class="mine-form" @submit.prevent="submit('data')">
          <h4>申请数据授权</h4>
          <p class="mine-note">只为自己当前有效持有的角色申请。通过后，该角色的全部有效成员共享这些资源权限。时长从最终生效时开始。</p>
          <label>角色
            <el-select v-model="dataRoleId" placeholder="选择有效角色" style="width: 100%">
              <el-option v-for="role in requestRoles" :key="role.roleId" :label="role.name" :value="role.roleId" />
            </el-select>
          </label>
          <p v-if="!requestRoles.length">没有可申请的有效角色。停用、未生效或已失效的分配不能选。</p>
          <template v-if="selectedRole">
            <p>共享成员：{{ selectedRole.holders.map((holder) => holder.name).join("、") }}</p>
            <RolePermissionList :codes="selectedRole.permissionCodes" />
          </template>
          <OrganizationGrantTargetPicker v-model="dataTargets" v-model:query="dataQuery" :catalog="catalog" />
          <fieldset>
            <legend>时长</legend>
            <small>从最终生效时开始计算。</small>
            <el-radio-group v-model="dataDuration">
              <el-radio v-for="item in DURATION_PRESETS" :key="item.id" :value="item.id">{{ item.label }}</el-radio>
              <el-radio value="custom">自定义</el-radio>
            </el-radio-group>
            <div v-if="dataDuration === 'custom'" class="mine-duration">
              <el-input-number v-model="dataAmount" :min="1" :step="1" />
              <el-select v-model="dataUnit" style="width: 120px">
                <el-option label="分钟" value="minute" />
                <el-option label="小时" value="hour" />
                <el-option label="天" value="day" />
              </el-select>
            </div>
          </fieldset>
          <label>理由 <el-input v-model="dataReason" maxlength="2000" /></label>
          <el-button type="primary" native-type="submit">提交数据申请</el-button>
          <div v-if="dataSplit" class="mine-groups">
            <h5>按流程分别提交</h5>
            <article v-for="group in dataSplit.groups" :key="group.flowId">
              <strong>{{ group.flowName }}</strong>
              <p v-for="target in group.targets" :key="`${target.type}:${target.id}`">{{ catalogLabel(catalog, target) }}</p>
              <el-button type="primary" @click="submit('data', group)">提交这一组</el-button>
            </article>
          </div>
        </form><template #footer><el-button @click="requestDialog = null">关闭</el-button></template></el-dialog>
    <el-dialog v-model="permissionsOpen" title="操作权限" width="min(780px, calc(100% - 32px))" append-to-body align-center destroy-on-close class="envman-dialog">
      <template v-if="permissionDetail">
        <div class="mine-permission-detail">
          <strong>{{ permissionDetail.name }}</strong>
          <p v-if="permissionDetail.resource">授权资源：{{ permissionDetail.resource }}</p>
        </div>
        <RolePermissionList :codes="permissionDetail.codes" />
      </template>
      <template #footer><el-button @click="permissionsOpen = false">关闭</el-button></template>
    </el-dialog>
    <GrantRequestDetail v-if="detailOpen && currentOrganizationId" v-model="detailOpen" :organization-id="currentOrganizationId" :request-id="detailId" @changed="load" />
  </section>
</template>

<style scoped>
.mine-panel { display: flex; flex-direction: column; gap: 12px; }
.mine-panel__heading { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; }
.mine-panel__heading nav { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
article button { border: 0; background: transparent; color: var(--teal-700, #0f6e56); cursor: pointer; font: inherit; }
.mine-panel__heading p, .mine-note, small { color: var(--el-text-color-secondary); font-size: 12px; }
.mine-error { color: #a33b32; font-size: 12px; }
.mine-form { display: flex; flex-direction: column; gap: 10px; padding: 12px 0; border-top: 1px solid var(--el-border-color-lighter); }
.mine-duration { display: flex; gap: 8px; align-items: center; }
.mine-groups, article { padding: 8px 0; border-top: 1px solid var(--el-border-color-lighter); }
h3, h4, h5 { margin: 0; }
article strong, article small, article p { display: block; }

.mine-panel { gap: 22px; }
.mine-panel__heading h1 { margin: 0; font-size: 28px; color: var(--color-ink); font-weight: 600; }
.mine-panel__heading p { margin: 12px 0 0; font-size: 13px; line-height: 1.6; }
.mine-panel > div > section { margin-bottom: 28px; }
.mine-panel h4 { margin-bottom: 12px; color: var(--color-ink); font-size: 14px; font-weight: 600; }
.mine-panel article { padding: 16px 18px; margin: 10px 0; border: 1px solid var(--color-rule); border-radius: 6px; background: var(--color-paper-raised); font-size: 13px; }
.mine-panel article strong { margin-bottom: 8px; }
.mine-panel article small { margin-top: 5px; line-height: 1.6; }
.mine-form { padding: 18px; border: 1px solid var(--color-rule); border-radius: 6px; background: var(--color-paper-raised); }
.mine-duration { flex-wrap: wrap; }
.mine-panel .mine-access-table table { table-layout: fixed; min-width: 720px; }
.mine-access-table__subject { width: 22%; }
.mine-access-table__role { width: 28%; }
.mine-access-table__validity { width: 210px; }
.mine-access-table__action { width: 100px; }
.mine-access-table__features { width: 120px; }
.mine-panel .mine-access-table :is(th, td) { line-height: 1.65; overflow-wrap: anywhere; }
.mine-panel .mine-access-table td { vertical-align: middle; }
.mine-panel .mine-access-table .organization-status { white-space: normal; }
.mine-panel .mine-access-table .el-button { font-size: 12px; }
.mine-panel .mine-access-table small { line-height: 1.6; }
.mine-access-table__target + .mine-access-table__target { margin-top: 10px; }
.mine-permission-detail { margin-bottom: 16px; overflow-wrap: anywhere; }
.mine-permission-detail strong { font-size: 15px; font-weight: 600; color: var(--el-text-color-primary); }
.mine-permission-detail p { margin: 6px 0 0; font-size: 12px; line-height: 1.6; color: var(--el-text-color-secondary); }
@media (max-width: 700px) {
  .mine-panel__heading { flex-direction: column; }
}
</style>
