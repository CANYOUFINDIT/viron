<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Check, ShieldCheck } from "@lucide/vue";
import { api } from "../../api";
import { currentLocale } from "../../i18n";
import { ACTION_LABELS, CAPABILITY_LABELS } from "../../../shared/access-permissions";
import { grantEnvironmentIds, grantPermissionRows, type GrantDetailSource, type GrantScopeCatalog, type GrantScopeResource } from "./grant-permission-details";

const props = defineProps<{
  grant: GrantDetailSource;
  source: string;
  status: string;
  tone: string;
  start: number;
  end: number | null;
  organizationId?: string;
  resources?: GrantScopeResource[];
}>();

const catalog = ref<GrantScopeCatalog>({});
const loading = ref(false);
const failed = ref(false);
const loaded = ref(false);
const visible = ref(false);
const popperOptions = {
  modifiers: [{ name: "preventOverflow", options: { altAxis: true, tether: false, padding: 16 } }],
};
let requestVersion = 0;
const environmentIds = computed(() => grantEnvironmentIds(props.grant, props.resources ?? []));
const scopeKey = computed(() => JSON.stringify([props.organizationId, environmentIds.value, props.grant.items]));
const rows = computed(() => grantPermissionRows(props.grant, catalog.value, props.resources ?? []));

watch(scopeKey, () => {
  requestVersion++;
  catalog.value = {};
  loading.value = false;
  failed.value = false;
  loaded.value = false;
  if (visible.value) void loadCatalog();
});
onBeforeUnmount(() => { requestVersion++; });

async function loadCatalog(): Promise<void> {
  if (loaded.value || loading.value || !props.organizationId || !environmentIds.value.length) return;
  const version = ++requestVersion;
  loading.value = true;
  failed.value = false;
  try {
    const next = await api<GrantScopeCatalog>(`/api/v1/organizations/${encodeURIComponent(props.organizationId)}/access-request-catalog?environmentIds=${encodeURIComponent(environmentIds.value.join(","))}`);
    if (version !== requestVersion) return;
    catalog.value = next;
    loaded.value = true;
  } catch {
    if (version === requestVersion) failed.value = true;
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}

function formatTime(time: number): string {
  return new Date(time).toLocaleString(currentLocale(), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function showDetails(): void {
  visible.value = true;
  void loadCatalog();
}
</script>

<template>
  <el-popover
    trigger="hover"
    placement="top-start"
    :show-after="180"
    :hide-after="160"
    :width="760"
    :persistent="false"
    :show-arrow="false"
    :popper-options="popperOptions"
    popper-class="grant-details-popper"
    @show="showDetails"
    @hide="visible = false"
  >
    <template #reference><slot /></template>
    <section class="grant-details" :aria-label="$t('授权详情')">
      <header class="grant-details__head">
        <ShieldCheck :size="18" />
        <div><small>{{ $t('授权资源') }}</small><strong>{{ grant.label || grant.resourceId }}</strong></div>
        <span class="grant-details__status" :class="`is-${tone}`">{{ status }}</span>
      </header>
      <div class="grant-details__scroll">
        <table class="grant-details__matrix" :aria-label="$t('操作权限')">
          <colgroup><col class="grant-details__resource-col"><col class="grant-details__actions-col"><col></colgroup>
          <thead><tr><th>{{ $t('资源') }}</th><th>{{ $t('操作') }}</th><th>{{ $t('范围') }}</th></tr></thead>
          <tbody>
            <tr v-for="row in rows" :key="row.capability" :data-capability="row.capability">
              <th scope="row"><span class="grant-details__resource"><span class="grant-details__check is-selected" aria-hidden="true"><Check :size="11" /></span>{{ $t(CAPABILITY_LABELS[row.capability]) }}</span></th>
              <td>
                <div class="grant-details__actions">
                  <span v-for="action in row.actions" :key="action.id" class="grant-details__action" :class="{ 'is-selected': action.selected }" :aria-label="`${$t((ACTION_LABELS[row.capability] as Record<string, string>)[action.id])} · ${$t(action.selected ? '已授权' : '未授权')}`">
                    <span class="grant-details__check" :class="{ 'is-selected': action.selected }" aria-hidden="true"><Check v-if="action.selected" :size="11" /></span>
                    {{ $t((ACTION_LABELS[row.capability] as Record<string, string>)[action.id]) }}
                  </span>
                </div>
              </td>
              <td>
                <div class="grant-details__scope">
                  <div class="grant-details__scope-head">
                    <strong>{{ $t(row.all ? '全部' : '指定资源') }}</strong>
                    <small v-if="row.all" class="grant-details__future">{{ $t('含新增') }}</small>
                    <span v-if="!loading && !failed">{{ row.items.length }}</span>
                  </div>
                  <p v-if="loading" class="grant-details__note">{{ $t('正在读取可选项') }}</p>
                  <p v-else-if="failed" class="grant-details__note">{{ $t('范围明细加载失败') }} <button type="button" @click="loadCatalog">{{ $t('重试') }}</button></p>
                  <ul v-else-if="row.items.length" class="grant-details__items">
                    <li v-for="item in row.items" :key="item.id" :class="{ 'is-unavailable': item.unavailable }">
                      <Check :size="12" aria-hidden="true" /><span>{{ item.unavailable ? $t(item.name) : item.name }}<small v-if="item.environmentName">{{ item.environmentName }}</small></span>
                    </li>
                  </ul>
                  <p v-else class="grant-details__note">{{ $t(grant.wholeGroup ? '整个组使用同一套操作' : '还没有可选项') }}</p>
                </div>
              </td>
            </tr>
            <tr v-if="!rows.length"><td colspan="3" class="grant-details__note">{{ $t('暂无权限明细') }}</td></tr>
          </tbody>
        </table>
      </div>
      <dl class="grant-details__facts">
        <div><dt>{{ $t('授权来源') }}</dt><dd>{{ source }}</dd></div>
        <div><dt>{{ $t('起始时间') }}</dt><dd>{{ formatTime(start) }}</dd></div>
        <div><dt>{{ $t('截止时间') }}</dt><dd>{{ end === null ? $t('永久有效') : formatTime(end) }}</dd></div>
      </dl>
    </section>
  </el-popover>
</template>

<style>
.el-popper.grant-details-popper {
  width: min(760px, calc(100vw - 32px)) !important;
  max-height: calc(100vh - 32px);
  padding: 0 !important;
  overflow: hidden;
  border: 1px solid var(--color-rule-strong) !important;
  border-radius: 12px !important;
  background: var(--color-paper-raised) !important;
  color: var(--color-ink) !important;
  box-shadow: 0 8px 32px color-mix(in srgb, var(--color-ink) 16%, transparent) !important;
}
</style>

<style scoped>
.grant-details { display: flex; flex-direction: column; min-height: 0; max-height: calc(100vh - 34px); font-size: 12px; line-height: 1.5; }
.grant-details__head { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; padding: 14px 16px; }
.grant-details__head > svg { flex-shrink: 0; color: var(--color-accent); }
.grant-details__head > div { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.grant-details__head small { color: var(--color-muted); font-size: 10px; }
.grant-details__head strong { font-size: 14px; overflow-wrap: anywhere; }
.grant-details__status { flex: 0 0 auto; padding: 3px 8px; border-radius: 5px; background: var(--color-accent-soft); color: var(--color-accent); font-size: 11px; }
.grant-details__status.is-expired { background: var(--color-paper-muted); color: var(--color-muted); }
.grant-details__status.is-soon { background: var(--color-danger-soft); color: var(--color-danger); }
.grant-details__status.is-week { background: var(--color-warning-soft); color: var(--color-warning); }
.grant-details__status.is-later { background: var(--color-info-soft); color: var(--color-info); }
.grant-details__scroll { min-height: 0; max-height: 440px; overflow: auto; overscroll-behavior: contain; }
.grant-details__matrix { width: 100%; table-layout: fixed; border-collapse: collapse; font: inherit; }
.grant-details__resource-col { width: 18%; }
.grant-details__actions-col { width: 39%; }
.grant-details__matrix thead { position: sticky; top: 0; z-index: 1; background: var(--color-paper-muted); color: var(--color-muted); }
.grant-details__matrix th, .grant-details__matrix td { padding: 10px 12px; border-top: 1px solid var(--color-rule); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.grant-details__matrix thead th { font-size: 11px; font-weight: 500; }
.grant-details__matrix tbody th { font-weight: 600; }
.grant-details__resource, .grant-details__action { display: flex; align-items: flex-start; gap: 6px; }
.grant-details__actions { display: flex; flex-wrap: wrap; gap: 8px 12px; }
.grant-details__action { color: var(--color-faint); }
.grant-details__action.is-selected { color: var(--color-ink-soft); }
.grant-details__check { display: inline-flex; flex: 0 0 14px; align-items: center; justify-content: center; height: 14px; margin-top: 2px; border: 1px solid var(--color-rule-strong); border-radius: 3px; }
.grant-details__check.is-selected { border-color: var(--color-accent); background: var(--color-accent); color: var(--color-accent-ink); }
.grant-details__scope { overflow: hidden; border: 1px solid var(--color-rule); border-radius: 7px; }
.grant-details__scope-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 5px 8px; background: var(--color-paper-muted); font-size: 11px; }
.grant-details__scope-head strong { font-weight: 600; }
.grant-details__scope-head > span { margin-left: auto; color: var(--color-muted); font-family: var(--font-mono); }
.grant-details__future { padding: 0 4px; border-radius: 3px; background: var(--color-accent-soft); color: var(--color-accent); font-size: 10px; }
.grant-details__items { display: flex; flex-direction: column; gap: 3px; margin: 0; padding: 5px; list-style: none; }
.grant-details__items li { display: flex; gap: 6px; padding: 5px 7px; border-radius: 4px; background: var(--color-accent-soft); color: var(--color-accent); }
.grant-details__items li > svg { flex-shrink: 0; margin-top: 3px; }
.grant-details__items small { display: block; color: var(--color-muted); font-size: 10px; }
.grant-details__items .is-unavailable { background: var(--color-paper-muted); color: var(--color-muted); }
.grant-details__note { margin: 0; padding: 8px; color: var(--color-muted); font-size: 11px; }
.grant-details__note button { border: 0; background: none; color: var(--color-accent); font: inherit; cursor: pointer; }
.grant-details__facts { display: grid; flex: 0 0 auto; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin: 0; padding: 12px 16px; border-top: 1px solid var(--color-rule); }
.grant-details__facts dt { color: var(--color-muted); font-size: 10px; }
.grant-details__facts dd { margin: 2px 0 0; color: var(--color-ink-soft); overflow-wrap: anywhere; font-size: 11px; }
@media (max-width: 600px) {
  .grant-details__resource-col { width: 21%; }
  .grant-details__actions-col { width: 36%; }
  .grant-details__matrix th, .grant-details__matrix td { padding: 8px 6px; }
  .grant-details__facts { grid-template-columns: 1fr 1fr; }
}
</style>
