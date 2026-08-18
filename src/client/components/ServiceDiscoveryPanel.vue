<script setup lang="ts">
import { Plus, Radar, Search, SearchX } from "@lucide/vue";
import { computed, reactive, watch } from "vue";
import { localizeMessage, translate as tr } from "../i18n";
import {
  candidateDetail,
  candidateKey,
  candidateStatusFacets,
  defaultDiscoveryProvider,
  discoveryProviderFacets,
  discoveryProviderFilters,
  emptyCandidateListFilter,
  filterCandidates,
  isCandidateFilterActive,
  kubernetesContextOptions,
  kubernetesIdentity,
  kubernetesNamespaceOptions,
  kubernetesResourceKindOptions,
  resetDiscoveryFilter,
  type CandidateListFilter,
  type CandidateStatus,
  type MonitorCandidate,
  type Provider,
} from "../service-candidate-tree";

interface DiscoveryService {
  id: string;
  name: string;
}

interface KubernetesConfigItem {
  sourceId: string;
  path?: string;
  context?: string;
  cluster?: string;
  namespace?: string;
  currentContext: boolean;
  selected: boolean;
  status: "discovered" | "connected" | "error" | "unreadable" | "invalid";
  candidateCount: number;
  error?: string;
}

const props = defineProps<{
  hostId: string;
  candidates: MonitorCandidate[];
  kubernetesConfigs: KubernetesConfigItem[];
  services: DiscoveryService[];
  managedKeys: string[];
  canConfigure: boolean;
  canOperate: boolean;
  targetServiceId: string;
}>();

const emit = defineEmits<{
  enroll: [candidate: MonitorCandidate];
  "update:targetServiceId": [serviceId: string];
  "create-service": [];
  "configure-kubernetes": [];
}>();

const filter = reactive<CandidateListFilter>(resetDiscoveryFilter([]));

watch(() => props.hostId, () => {
  Object.assign(filter, resetDiscoveryFilter(props.candidates));
});

watch(() => props.candidates, (candidates) => {
  if (!discoveryProviderFilters.includes(filter.provider as Provider)) {
    filter.provider = defaultDiscoveryProvider(candidates);
  }
}, { immediate: true });

watch(() => filter.provider, (provider) => {
  if (provider !== "kubernetes") {
    filter.kubernetesContext = "";
    filter.kubernetesNamespace = "";
    filter.kubernetesResourceKind = "";
  }
});

watch(() => filter.kubernetesContext, () => {
  filter.kubernetesNamespace = "";
  filter.kubernetesResourceKind = "";
});

watch(() => filter.kubernetesNamespace, () => {
  filter.kubernetesResourceKind = "";
});

const managedKeySet = computed(() => new Set(props.managedKeys));
const providerFacets = computed(() => discoveryProviderFacets(props.candidates));
const scopedCandidates = computed(() => filterCandidates(props.candidates, {
  ...emptyCandidateListFilter(),
  provider: filter.provider,
  kubernetesContext: filter.kubernetesContext,
  kubernetesNamespace: filter.kubernetesNamespace,
  kubernetesResourceKind: filter.kubernetesResourceKind,
}));
const statusFacets = computed(() => candidateStatusFacets(scopedCandidates.value));
const visibleCandidates = computed(() => filterCandidates(props.candidates, filter));
const contextOptions = computed(() => kubernetesContextOptions(props.candidates));
const namespaceOptions = computed(() => kubernetesNamespaceOptions(props.candidates, filter.kubernetesContext));
const resourceKindOptions = computed(() => kubernetesResourceKindOptions(
  props.candidates,
  filter.kubernetesContext,
  filter.kubernetesNamespace,
));
const showKubernetesSection = computed(() => filter.provider === "kubernetes");
const filterActive = computed(() => isCandidateFilterActive(filter));
const targetService = computed(() => props.services.find((item) => item.id === props.targetServiceId) ?? null);
const resultSummary = computed(() => {
  const pool = props.candidates.filter((candidate) => candidate.provider === filter.provider);
  return tr("显示 {{0}} / {{1}}", [visibleCandidates.value.length, pool.length]);
});

function statusLabel(status: CandidateStatus) {
  return ({ running: tr("运行中"), stopped: tr("已停止"), degraded: tr("异常"), unknown: tr("未知") } as Record<CandidateStatus, string>)[status];
}

function candidateCaption(candidate: MonitorCandidate) {
  if (candidate.provider !== "kubernetes") {
    return [candidateDetail(candidate), candidate.pid ? `PID ${candidate.pid}` : ""].filter(Boolean).join(" · ");
  }
  const identity = kubernetesIdentity(candidate);
  const location = [identity.context || identity.cluster, identity.namespace, identity.resourceKind].filter(Boolean).join(" / ");
  return [location, candidateDetail(candidate)].filter(Boolean).join(" · ");
}

function candidateMetrics(candidate: MonitorCandidate) {
  const parts: string[] = [];
  if (Number.isFinite(candidate.cpuUsedPercent)) parts.push(`${Number(candidate.cpuUsedPercent).toFixed(1)}% CPU`);
  if (Number.isFinite(candidate.memoryBytes) && candidate.memoryBytes) {
    const units = ["B", "KiB", "MiB", "GiB"];
    let current = Number(candidate.memoryBytes);
    let index = 0;
    while (current >= 1024 && index < units.length - 1) {
      current /= 1024;
      index += 1;
    }
    parts.push(`${current >= 100 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`);
  }
  return parts.join(" · ");
}

function setProvider(provider: CandidateListFilter["provider"]) {
  filter.provider = provider;
}

function setStatus(status: CandidateListFilter["status"]) {
  filter.status = status;
}

function clearFilters() {
  Object.assign(filter, resetDiscoveryFilter(props.candidates));
}

function kubernetesConfigStatusLabel(item: KubernetesConfigItem) {
  if (item.status === "connected") return tr("已连接");
  if (item.status === "discovered") return tr("待选择");
  if (item.status === "unreadable") return tr("无法读取");
  if (item.status === "invalid") return tr("配置无效");
  return tr("连接失败");
}
</script>

<template>
  <section class="service-discovery">
    <div class="discovery-toolbar">
      <el-input v-model="filter.query" clearable :placeholder="$t('搜索名称、标识、状态或命名空间')">
        <template #prefix><Search :size="15" /></template>
      </el-input>
      <label v-if="canConfigure" class="discovery-target" :class="{ 'has-select': services.length }">
        <span>{{ $t('纳管到') }}</span>
        <el-select
          v-if="services.length"
          :model-value="targetServiceId"
          :placeholder="$t('选择服务')"
          @update:model-value="emit('update:targetServiceId', String($event || ''))"
        >
          <el-option v-for="service in services" :key="service.id" :value="service.id" :label="service.name" />
        </el-select>
        <el-button v-else type="primary" plain @click="emit('create-service')"><Plus :size="14" />{{ $t('录入服务') }}</el-button>
      </label>
    </div>

    <nav class="discovery-provider-tabs" role="tablist" :aria-label="$t('服务类型')">
      <button
        v-for="facet in providerFacets"
        :key="facet.provider"
        type="button"
        role="tab"
        :aria-selected="filter.provider === facet.provider"
        :class="{ 'is-active': filter.provider === facet.provider }"
        @click="setProvider(facet.provider)"
      >{{ facet.label }}<small>{{ facet.total }}</small></button>
    </nav>

    <div v-if="statusFacets.length || (showKubernetesSection && contextOptions.length)" class="discovery-facets" role="group" :aria-label="$t('扫描候选筛选')">
      <div v-if="statusFacets.length" class="discovery-chips is-status">
        <button type="button" :class="{ 'is-active': filter.status === 'all' }" @click="setStatus('all')">{{ $t('全部状态') }}</button>
        <button v-for="facet in statusFacets" :key="facet.status" type="button" :class="['is-status', `is-${facet.status}`, { 'is-active': filter.status === facet.status }]" @click="setStatus(facet.status)">{{ statusLabel(facet.status) }}<small>{{ facet.total }}</small></button>
      </div>
      <div v-if="showKubernetesSection && contextOptions.length" class="discovery-k8s-filters">
        <el-select v-model="filter.kubernetesContext" clearable :placeholder="$t('全部 context')">
          <el-option v-for="option in contextOptions" :key="option.key" :value="option.key" :label="option.caption ? `${option.label} · ${option.caption}` : option.label" />
        </el-select>
        <el-select v-model="filter.kubernetesNamespace" clearable :placeholder="$t('全部命名空间')">
          <el-option v-for="namespace in namespaceOptions" :key="namespace" :value="namespace" :label="namespace" />
        </el-select>
        <el-select v-model="filter.kubernetesResourceKind" clearable :placeholder="$t('全部资源类型')">
          <el-option v-for="kind in resourceKindOptions" :key="kind" :value="kind" :label="kind" />
        </el-select>
      </div>
    </div>

    <section v-if="showKubernetesSection && kubernetesConfigs.length" class="kubernetes-discovery">
      <header>
        <div>
          <strong>{{ $t('Kubernetes 配置') }}</strong>
          <small>{{ kubernetesConfigs.length }} {{ $t('个 context') }}</small>
        </div>
        <el-button v-if="canOperate" size="small" :disabled="!kubernetesConfigs.some((item) => item.context && !['invalid', 'unreadable'].includes(item.status))" @click="emit('configure-kubernetes')">{{ $t('选择扫描 context') }}</el-button>
      </header>
      <div class="kubernetes-discovery__items">
        <article v-for="item in kubernetesConfigs" :key="`${item.sourceId}:${item.context || item.path}`" :class="`is-${item.status}`">
          <div class="kubernetes-discovery__identity">
            <span><i></i>{{ kubernetesConfigStatusLabel(item) }}</span>
            <strong>{{ item.context || $t('无法解析 context') }}<small v-if="item.currentContext">{{ $t('当前') }}</small></strong>
          </div>
          <p v-if="item.context || item.path">{{ [item.path || item.sourceId, item.cluster, item.namespace || 'default', item.context ? `${item.candidateCount} ${$t('个工作负载')}` : ''].filter(Boolean).join(' · ') }}</p>
          <p v-if="item.error" class="is-error">{{ localizeMessage(item.error) }}</p>
        </article>
      </div>
    </section>

    <div class="discovery-result-meta">
      <span>{{ resultSummary }}</span>
      <small v-if="targetService">{{ $t('当前服务') }} · {{ targetService.name }}</small>
    </div>

    <div v-if="visibleCandidates.length" class="discovery-list" role="list">
      <article v-for="item in visibleCandidates" :key="candidateKey(item)" class="discovery-row" :class="`is-${item.status}`" role="listitem">
        <i :class="`is-${item.status}`" :title="statusLabel(item.status)"></i>
        <div class="discovery-row__body">
          <strong>{{ item.name }}</strong>
          <code>{{ candidateCaption(item) }}</code>
          <small v-if="candidateMetrics(item)">{{ candidateMetrics(item) }}</small>
        </div>
        <div class="discovery-row__actions">
          <span v-if="managedKeySet.has(candidateKey(item))" class="discovery-row__managed">{{ $t('已纳管') }}</span>
          <button
            v-if="canConfigure"
            type="button"
            class="discovery-row__enroll"
            :title="$t('纳管到服务')"
            @click="emit('enroll', item)"
          >
            <Plus :size="14" />{{ $t('纳管') }}
          </button>
        </div>
      </article>
    </div>

    <div v-else-if="candidates.length" class="discovery-empty">
      <SearchX :size="22" />
      <div>
        <strong>{{ $t('没有符合筛选条件的候选') }}</strong>
        <p>{{ $t('试试改搜索词，或换一种类型、状态、命名空间。') }}</p>
      </div>
      <el-button v-if="filterActive" @click="clearFilters">{{ $t('清除筛选') }}</el-button>
    </div>

    <div v-else class="discovery-empty">
      <Radar :size="22" />
      <div>
        <strong>{{ $t('尚未扫描到服务') }}</strong>
        <p>{{ $t('点击“刷新”后，这里会列出 systemd、容器和 Kubernetes 工作负载。') }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.service-discovery {
  --ops-green: var(--color-accent-strong);
  --ops-amber: var(--color-warning);
  min-width: 0;
  min-height: 100%;
  height: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.kubernetes-discovery { min-width: 0; display: grid; gap: .5rem; }
.kubernetes-discovery > header {
  min-width: 0;
  min-height: 2rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
}
.kubernetes-discovery > header > div { min-width: 0; display: flex; align-items: baseline; flex-wrap: wrap; gap: .375rem .5rem; }
.kubernetes-discovery > header strong { font-size: var(--text-sm); }
.kubernetes-discovery > header small { color: var(--color-muted); font-size: var(--text-2xs); }
.kubernetes-discovery > header :deep(.el-button) { margin: 0; flex: 0 0 auto; }
.kubernetes-discovery__items { min-width: 0; display: grid; gap: .375rem; }
.kubernetes-discovery__items article {
  min-width: 0;
  padding: .625rem .75rem;
  border: 1px solid var(--color-rule);
  border-radius: 8px;
  display: grid;
  gap: .25rem;
  background: var(--color-paper);
}
.kubernetes-discovery__identity { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: .375rem .625rem; }
.kubernetes-discovery__identity > span { display: inline-flex; align-items: center; gap: .25rem; color: var(--color-muted); font-size: var(--text-2xs); }
.kubernetes-discovery__identity > span i { width: .375rem; height: .375rem; border-radius: 50%; background: var(--color-rule-strong); }
.kubernetes-discovery__items article.is-connected .kubernetes-discovery__identity > span { color: var(--ops-green); }
.kubernetes-discovery__items article.is-connected .kubernetes-discovery__identity > span i { background: var(--ops-green); }
.kubernetes-discovery__items article.is-error .kubernetes-discovery__identity > span,
.kubernetes-discovery__items article.is-invalid .kubernetes-discovery__identity > span,
.kubernetes-discovery__items article.is-unreadable .kubernetes-discovery__identity > span { color: var(--ops-amber); }
.kubernetes-discovery__items article.is-error .kubernetes-discovery__identity > span i,
.kubernetes-discovery__items article.is-invalid .kubernetes-discovery__identity > span i,
.kubernetes-discovery__items article.is-unreadable .kubernetes-discovery__identity > span i { background: var(--ops-amber); }
.kubernetes-discovery__identity strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
.kubernetes-discovery__identity strong small { margin-inline-start: .375rem; padding: 0 .375rem; border-radius: 999px; background: var(--color-info-soft); color: var(--color-info); font-size: var(--text-2xs); }
.kubernetes-discovery__items article > p { min-width: 0; margin: 0; overflow: hidden; color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.kubernetes-discovery__items article > p.is-error { color: var(--ops-amber); font-family: inherit; white-space: normal; }

.discovery-toolbar { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-sm); }
.discovery-target { min-width: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--space-xs); }
.discovery-target > span { color: var(--color-muted); font-size: var(--text-xs); white-space: nowrap; }
.discovery-toolbar :deep(.el-input__wrapper),
.discovery-target :deep(.el-select__wrapper),
.discovery-target :deep(.el-input__wrapper) { min-height: 2.25rem; }
.discovery-target :deep(.el-select) { min-width: 0; width: 100%; }
.discovery-target :deep(.el-button) { margin: 0; }

.discovery-provider-tabs {
  min-width: 0;
  padding: 3px;
  border: 1px solid var(--color-rule);
  border-radius: 8px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
  background: var(--color-paper-muted);
}
.discovery-provider-tabs button {
  min-width: 0;
  min-height: 2.125rem;
  padding: 0 .75rem;
  border: 0;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .375rem;
  background: transparent;
  color: var(--color-muted);
  font: inherit;
  font-size: var(--text-sm);
  font-weight: 750;
  cursor: pointer;
  transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out), box-shadow var(--dur-micro) var(--ease-out);
}
.discovery-provider-tabs button.is-active {
  background: var(--color-paper-raised);
  color: var(--color-accent-strong);
  box-shadow: 0 1px 5px rgba(8, 22, 25, .1);
}
.discovery-provider-tabs small {
  min-width: 1.25rem;
  height: 1.25rem;
  padding: 0 .35rem;
  border-radius: 999px;
  display: inline-grid;
  place-items: center;
  background: var(--color-rule);
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}
.discovery-provider-tabs button.is-active small { background: var(--color-accent-soft); color: var(--color-accent-strong); }
.discovery-provider-tabs button:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }

.discovery-facets { min-width: 0; display: grid; gap: var(--space-sm); }
.discovery-chips { min-width: 0; display: flex; flex-wrap: wrap; gap: .375rem; }
.discovery-chips button {
  min-height: 1.75rem;
  padding: 0 .625rem;
  border: 1px solid var(--color-rule);
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: .375rem;
  background: var(--color-paper);
  color: var(--color-ink-soft);
  font: inherit;
  font-size: var(--text-2xs);
  font-weight: 650;
  cursor: pointer;
  transition: border-color var(--dur-micro) var(--ease-out), background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out);
}
.discovery-chips button small {
  min-width: 1rem;
  color: var(--color-muted);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.discovery-chips button.is-active {
  border-color: color-mix(in srgb, var(--color-accent) 55%, var(--color-rule));
  background: var(--color-accent-soft);
  color: var(--color-accent-strong);
}
.discovery-chips button.is-active small { color: inherit; }
.discovery-chips button.is-status.is-running.is-active { border-color: color-mix(in srgb, var(--ops-green) 45%, var(--color-rule)); }
.discovery-chips button.is-status.is-stopped.is-active,
.discovery-chips button.is-status.is-degraded.is-active { border-color: color-mix(in srgb, var(--ops-amber) 45%, var(--color-rule)); }
.discovery-k8s-filters { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-xs); }

.discovery-result-meta {
  min-width: 0;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-sm);
  color: var(--color-muted);
  font-size: var(--text-2xs);
}
.discovery-result-meta small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.discovery-list {
  overflow: hidden;
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-card);
  background: var(--color-paper);
}
.discovery-row {
  min-width: 0;
  min-height: 3.25rem;
  padding: .625rem .75rem;
  border-block-end: 1px solid var(--color-rule);
  display: grid;
  grid-template-columns: .5rem minmax(0, 1fr) auto;
  align-items: center;
  gap: .625rem;
}
.discovery-row__actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: .375rem; }
.discovery-row:last-child { border-block-end: 0; }
.discovery-row > i { width: .375rem; height: .375rem; border-radius: 50%; background: var(--color-rule-strong); }
.discovery-row > i.is-running { background: var(--ops-green); }
.discovery-row > i.is-degraded,
.discovery-row > i.is-stopped { background: var(--ops-amber); }
.discovery-row__body { min-width: 0; display: grid; gap: .125rem; }
.discovery-row__body strong { overflow: hidden; font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.discovery-row__body code,
.discovery-row__body small { overflow: hidden; color: var(--color-muted); font-size: var(--text-2xs); text-overflow: ellipsis; white-space: nowrap; }
.discovery-row__body code { font-family: var(--font-mono); }
.discovery-row__managed {
  padding: .125rem .375rem;
  border-radius: var(--radius-control);
  background: var(--color-paper-muted);
  color: var(--color-muted);
  font-size: var(--text-2xs);
  font-weight: 650;
  white-space: nowrap;
}
.discovery-row__enroll {
  min-height: 1.75rem;
  padding: 0 .625rem;
  border: 1px solid color-mix(in srgb, var(--color-accent) 42%, var(--color-rule));
  border-radius: var(--radius-control);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .25rem;
  background: var(--color-accent-soft);
  color: var(--color-accent-strong);
  font: inherit;
  font-size: var(--text-2xs);
  font-weight: 700;
  cursor: pointer;
  transition: border-color var(--dur-micro) var(--ease-out), background-color var(--dur-micro) var(--ease-out), transform var(--dur-micro) var(--ease-out);
}
.discovery-row__enroll:active { transform: translateY(1px); }

.discovery-empty {
  flex: 1 1 auto;
  min-height: 10rem;
  padding: var(--space-md);
  border: 1px dashed var(--color-rule-strong);
  border-radius: var(--radius-card);
  display: grid;
  place-items: center;
  align-content: center;
  gap: var(--space-sm);
  color: var(--color-muted);
  text-align: center;
}
.discovery-empty > div { display: grid; gap: var(--space-2xs); }
.discovery-empty strong { color: var(--color-ink-soft); font-size: var(--text-sm); }
.discovery-empty p { margin: 0; font-size: var(--text-xs); line-height: 1.5; }

.discovery-chips button:focus-visible,
.discovery-row__enroll:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

@media (hover: hover) and (pointer: fine) {
  .discovery-provider-tabs button:hover:not(.is-active) { color: var(--color-ink-soft); }
  .discovery-chips button:hover:not(.is-active) { background: var(--color-paper-muted); }
  .discovery-row:hover { background: var(--color-paper-muted); }
  .discovery-row__enroll:hover { border-color: var(--color-accent); background: var(--color-paper-raised); }
}

@media (min-width: 48rem) {
  .discovery-toolbar { grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
  .discovery-target.has-select { width: 17.5rem; }
  .discovery-k8s-filters { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (pointer: coarse) {
  .discovery-provider-tabs button { min-height: 2.75rem; }
}

@media (prefers-reduced-motion: reduce) {
  .discovery-provider-tabs button,
  .discovery-chips button,
  .discovery-row__enroll { transition-duration: var(--dur-micro); transform: none !important; }
}
</style>
