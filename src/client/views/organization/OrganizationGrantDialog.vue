<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ShieldCheck } from "@lucide/vue";
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
type DurationId = "1h" | "8h" | "1d" | "7d" | "30d" | "custom" | "forever";
interface CatalogItem { id: string; name: string; environmentName: string }

const {
  currentOrganizationId, editingGrant, grantDialog, grantingResource, resources, saveGrant, selectedGrantTarget,
} = useOrganizationContext();

const kind = ref<Kind>("environment");
const groupId = ref("");
const wholeGroup = ref(false);
const targetIds = ref<string[]>([]);
const checked = reactive<Record<string, string[]>>({});
const itemMode = reactive<Record<string, "all" | "some">>({});
const pickedItems = reactive<Record<string, string[]>>({});
const duration = ref<DurationId>("8h");
const customEnd = ref("");
const catalog = ref<Record<string, CatalogItem[]>>({});
const hydrating = ref(false);

const durations: Array<{ id: DurationId; hours: number; label: string }> = [
  { id: "1h", hours: 1, label: "1 小时" },
  { id: "8h", hours: 8, label: "8 小时" },
  { id: "1d", hours: 24, label: "1 天" },
  { id: "7d", hours: 168, label: "7 天" },
  { id: "30d", hours: 720, label: "30 天" },
  { id: "custom", hours: 0, label: "自己指定结束时间" },
  { id: "forever", hours: 0, label: "永久" },
];
const kinds: Array<{ value: Kind; label: string }> = [
  { value: "environment_group", label: "环境组" },
  { value: "environment", label: "环境" },
  { value: "ssh_connection", label: "SSH 连接" },
  { value: "database_connection", label: "数据库连接" },
  { value: "redis_connection", label: "Redis 连接" },
];

const groups = computed(() => resources.value.filter((item) => item.type === "environment_group"));
const environments = computed(() => resources.value.filter((item) => item.type === "environment"));
const groupEnvironments = computed(() => environments.value.filter((item) => item.groupId === groupId.value));
const connectionOptions = computed(() => resources.value.filter((item) => item.type === kind.value));
const isConnection = computed(() => kind.value.endsWith("connection"));
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

watch(grantDialog, (open) => { if (open) applyGrant(); });
watch(kind, () => {
  if (hydrating.value) return;
  targetIds.value = [];
  if (kind.value !== "environment_group") {
    groupId.value = "";
    wholeGroup.value = false;
  } else wholeGroup.value = true;
});
watch(groupId, () => { if (!hydrating.value) targetIds.value = []; });
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
  const targetsOk = kind.value === "environment_group"
    ? Boolean(groupId.value) && (wholeGroup.value || targetIds.value.length > 0)
    : targetIds.value.length > 0;
  const itemsOk = visibleCapabilities.value.every((capability) => (
    !(checked[capability] ?? []).length || !showItems.value || itemMode[capability] !== "some" || (pickedItems[capability] ?? []).length > 0
  ));
  return selected && targetsOk && itemsOk && expiryValue() !== "";
});

function submit() {
  if (!canSave.value || grantingResource.value) return;
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
  <el-dialog append-to-body v-model="grantDialog" align-center class="envman-dialog grant-auth-dialog" :title="editingGrant ? $t('修改授权') : $t('授权资源')" width="min(920px, calc(100% - 32px))" @closed="editingGrant = null">
    <div v-if="subject" class="dialog-subject">
      <span class="dialog-subject__icon"><ShieldCheck :size="18" /></span>
      <div>
        <small>{{ $t('授权对象') }}</small>
        <strong>{{ subject.name }}</strong>
        <p>{{ subject.project ? $t('项目组及其子项目组会继承这项授权') : $t('仅授权给该成员个人') }}</p>
      </div>
    </div>
    <el-form label-position="top" @submit.prevent="submit">
      <div class="grant-auth-grid">
        <el-form-item :label="$t('资源类型')">
          <el-select v-model="kind" style="width:100%">
            <el-option v-for="item in kinds" :key="item.value" :label="$t(item.label)" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="kind === 'environment_group'" :label="$t('环境组')">
          <el-select v-model="groupId" filterable style="width:100%" :placeholder="$t('选择环境组')">
            <el-option v-for="item in groups" :key="item.id" :label="item.name" :value="item.id" />
          </el-select>
        </el-form-item>
      </div>
      <div v-if="kind === 'environment_group' && groupId" class="grant-scope-choice" role="radiogroup" :aria-label="$t('环境范围')">
        <button type="button" :class="{ 'is-active': wholeGroup }" @click="wholeGroup = true">{{ $t('整个组，以后新加的环境也算') }}</button>
        <button type="button" :class="{ 'is-active': !wholeGroup }" @click="wholeGroup = false">{{ $t('只选其中几个环境') }}</button>
      </div>
      <el-form-item v-if="kind === 'environment' || (kind === 'environment_group' && groupId && !wholeGroup)" :label="$t('环境')">
        <el-select v-model="targetIds" multiple filterable clearable collapse-tags collapse-tags-tooltip style="width:100%" :placeholder="$t('选择要授权的环境')">
          <el-option v-for="item in (kind === 'environment_group' ? groupEnvironments : environments)" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
      </el-form-item>
      <el-form-item v-else-if="isConnection" :label="$t('资源')">
        <el-select v-model="targetIds" multiple filterable clearable collapse-tags collapse-tags-tooltip style="width:100%" :placeholder="$t('选择要授权的资源')">
          <el-option v-for="item in connectionOptions" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
      </el-form-item>

      <div class="grant-matrix" role="table" :aria-label="$t('操作权限')">
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
            <span v-else class="grant-item-empty">{{ wholeGroup && kind === 'environment_group' ? $t('整个组使用同一套操作') : $t('先选择环境，再决定是整块还是其中几个') }}</span>
          </div>
        </div>
      </div>

      <el-form-item :label="$t('有效期')">
        <div class="grant-duration" role="radiogroup" :aria-label="$t('授权时长')">
          <button v-for="item in durations" :key="item.id" type="button" :class="{ 'is-active': duration === item.id }" @click="duration = item.id">{{ $t(item.label) }}</button>
        </div>
        <input v-if="duration === 'custom'" v-model="customEnd" class="grant-datetime" type="datetime-local" :aria-label="$t('自己指定结束时间')">
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="grantingResource" @click="grantDialog = false">{{ $t('取消') }}</el-button>
      <el-button type="primary" :loading="grantingResource" :disabled="!canSave" @click="submit"><ShieldCheck v-if="!grantingResource" :size="15" />{{ editingGrant ? $t('保存修改') : $t('确认授权') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.grant-auth-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.grant-scope-choice { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
.grant-scope-choice button, .grant-duration button { min-height: 34px; padding: 0 10px; border: 1px solid var(--color-rule-strong); border-radius: 8px; background: var(--color-paper); color: var(--color-ink-soft); cursor: pointer; font-size: 12px; }
.grant-scope-choice button.is-active, .grant-duration button.is-active { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent-strong); }
.grant-matrix { margin: 4px 0 16px; border: 1px solid var(--color-rule); border-radius: 10px; overflow: hidden; }
.grant-matrix__head, .grant-matrix__row { display: grid; grid-template-columns: 112px minmax(220px, 1.1fr) minmax(220px, 1fr); gap: 12px; align-items: start; }
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
@media (max-width: 760px) {
  .grant-auth-grid, .grant-matrix__head, .grant-matrix__row { grid-template-columns: 1fr; }
  .grant-matrix__head span:not(:first-child) { display: none; }
}
</style>
