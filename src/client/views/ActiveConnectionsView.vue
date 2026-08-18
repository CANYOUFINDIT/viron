<script setup lang="ts">import { translate as tr, currentLocale } from "../i18n";

import { Activity, Database, FileText, Globe2, MemoryStick, RefreshCw, Search, Server, TerminalSquare, Unplug } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import type { ActiveConnectionItem, ActiveConnectionType } from "../../shared/active-connection";
import { activeConnectionNavigationTarget } from "../active-connection-navigation";
import { pruneActiveConnectionOrigins, rememberedActiveConnectionOrigin } from "../active-connection-origin";
import { activeConnections, closeActiveConnection, loadActiveConnections } from "../active-connections";
import PageHeader from "../components/PageHeader.vue";
import TipIcon from "../components/TipIcon.vue";
import { session } from "../session";

const search = ref("");
const typeFilter = ref<"all" | ActiveConnectionType>("all");
const closingId = ref("");
const navigatingId = ref("");
const router = useRouter();

const typeDefinitions: Record<ActiveConnectionType, { label: string; icon: typeof Activity }> = {
  web: { label: "Web", icon: Globe2 },
  ssh: { label: "SSH", icon: TerminalSquare },
  logs: { label: tr("日志"), icon: FileText },
  sftp: { label: "SFTP", icon: Server },
  database: { label: tr("数据库"), icon: Database },
  redis: { label: "Redis", icon: MemoryStick },
};

const filteredItems = computed(() => {
  const query = search.value.trim().toLowerCase();
  return activeConnections.items.filter((item) => {
    if (typeFilter.value !== "all" && item.type !== typeFilter.value) return false;
    if (!query) return true;
    return [item.label, item.ownerUsername, ...item.environmentNames, typeDefinitions[item.type].label]
      .join(" ").toLowerCase().includes(query);
  });
});

const platformTotal = computed(() => activeConnections.items.length);
const usagePercent = computed(() => Math.min(100, Math.round(activeConnections.current / Math.max(1, activeConnections.limit) * 100)));

function displayTime(value: string) {
  return new Date(value).toLocaleString(currentLocale(), { hour12: false });
}

function environmentLabel(item: ActiveConnectionItem) {
  return item.environmentNames.length ? item.environmentNames.join("、") : tr("未分配环境");
}

function executionLabel(item: ActiveConnectionItem) {
  if (item.client === "web") return tr("普通 Web · 服务端");
  return item.executionMode === "local" ? tr("桌面 App · 本机") : tr("桌面 App · 服务端");
}

async function refresh() {
  await loadActiveConnections()
    .then(() => pruneActiveConnectionOrigins(activeConnections.items.map((item) => item.id)))
    .catch((error) => ElMessage.error(error instanceof Error ? error.message : tr("刷新连接失败")));
}

async function closeItem(item: ActiveConnectionItem) {
  const otherUser = item.ownerId !== session.user?.id;
  try {
    await ElMessageBox.confirm(
      tr("{0}“{1}”会立即释放远端连接，但当前客户端会保留已有交互内容并标记为已断开。", [otherUser ? tr("关闭 {{0}} 的", [item.ownerUsername]) : tr("关闭"), item.label]),
      tr("关闭活动连接"),
      { type: "warning", confirmButtonText: tr("关闭连接"), cancelButtonText: tr("取消") },
    );
    closingId.value = item.id;
    await closeActiveConnection(item);
    ElMessage.success(tr("连接已关闭"));
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("关闭连接失败"));
  } finally {
    closingId.value = "";
  }
}

async function openItem(item: ActiveConnectionItem) {
  if (navigatingId.value) return;
  const currentWorkspace = session.workspace;
  if (!currentWorkspace || currentWorkspace.type !== item.workspaceType || currentWorkspace.id !== item.workspaceId) {
    ElMessage.warning(tr("该连接属于“{0}”，当前不能无损跳转；切换工作空间会关闭活动连接。", [item.workspaceName]));
    return;
  }
  navigatingId.value = item.id;
  try {
    await router.push(activeConnectionNavigationTarget(item, rememberedActiveConnectionOrigin(item.id)));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("无法打开连接位置"));
  } finally {
    navigatingId.value = "";
  }
}

onMounted(refresh);
</script>

<template>
  <div class="active-connections-page">
    <PageHeader :title="$t('当前连接')">
      <template #actions><el-button :loading="activeConnections.loading" @click="refresh"><RefreshCw v-if="!activeConnections.loading" :size="16" />{{ $t('刷新') }}</el-button></template>
    </PageHeader>

    <section class="connection-runtime-summary" :aria-label="$t('连接额度摘要')">
      <article class="connection-quota-card">
        <div class="connection-quota-card__value"><strong>{{ activeConnections.current }}</strong><span>/ {{ activeConnections.limit }}</span></div>
        <div><span class="heading-with-tip">{{ $t('我的活动连接') }}<TipIcon :content="$t('额度按所有设备、客户端与工作空间合并计数。')" placement="right" /></span></div>
        <div class="connection-quota-meter" aria-hidden="true"><i :style="{ width: `${usagePercent}%` }"></i></div>
      </article>
      <article><Activity :size="20" /><div><strong>{{ session.user?.isPlatformAdmin ? platformTotal : activeConnections.current }}</strong><span>{{ session.user?.isPlatformAdmin ? $t('平台当前连接') : $t('当前可见连接') }}</span></div></article>
      <article><Server :size="20" /><div><strong>{{ activeConnections.idleMinutes }} {{ $t('分钟') }}</strong><span>{{ $t('无数据活动后自动断开') }}</span></div></article>
    </section>

    <section class="active-connection-panel">
      <header>
        <div class="heading-with-tip"><strong>{{ $t('连接信息') }}</strong><TipIcon :content="session.user?.isPlatformAdmin ? $t('平台管理员可查看并关闭全部用户连接。') : $t('当前仅显示你的连接。')" placement="right" /></div>
        <div class="active-connection-filters">
          <el-select v-model="typeFilter" :aria-label="$t('按连接类型筛选')">
            <el-option :label="$t('全部类型')" value="all" />
            <el-option v-for="(definition, key) in typeDefinitions" :key="key" :label="definition.label" :value="key" />
          </el-select>
          <el-input v-model="search" clearable :placeholder="$t('搜索连接、用户或环境')" :aria-label="$t('搜索当前连接')"><template #prefix><Search :size="14" /></template></el-input>
        </div>
      </header>

      <div v-if="filteredItems.length" class="active-connection-list">
        <article v-for="item in filteredItems" :key="item.id" class="active-connection-row" :class="{ 'is-closing': item.status === 'closing', 'is-navigating': navigatingId === item.id, 'has-owner': session.user?.isPlatformAdmin }">
          <button class="active-connection-open" type="button" :aria-label="$t('打开连接位置：{0}', [item.label])" :disabled="item.status === 'closing' || Boolean(navigatingId)" @click="openItem(item)"></button>
          <span class="active-connection-type"><component :is="typeDefinitions[item.type].icon" :size="18" /></span>
          <div class="active-connection-identity">
            <strong>{{ item.label }}</strong>
            <span>{{ executionLabel(item) }}</span>
          </div>
          <div class="active-connection-meta is-type"><small>{{ $t('类型') }}</small><strong>{{ typeDefinitions[item.type].label }}</strong></div>
          <div class="active-connection-meta is-environment"><small>{{ $t('所属环境') }}</small><strong :title="environmentLabel(item)">{{ environmentLabel(item) }}</strong></div>
          <div v-if="session.user?.isPlatformAdmin" class="active-connection-meta is-owner"><small>{{ $t('用户') }}</small><strong>{{ item.ownerUsername }}</strong></div>
          <div class="active-connection-meta is-time"><small>{{ $t('最后活动') }}</small><strong>{{ displayTime(item.lastActivityAt) }}</strong><span>{{ $t('建立于') }} {{ displayTime(item.createdAt) }}</span></div>
          <button class="active-connection-close" type="button" :disabled="closingId === item.id || item.status === 'closing'" @click.stop="closeItem(item)">
            <Unplug :size="15" />{{ item.status === 'closing' ? $t('正在关闭') : $t('关闭') }}
          </button>
        </article>
      </div>
      <div v-else class="active-connection-empty">
        <Activity :size="28" />
        <strong>{{ activeConnections.items.length ? $t('没有匹配的连接') : $t('当前没有活动连接') }}</strong>
        <span>{{ activeConnections.items.length ? $t('调整筛选条件后重试') : $t('建立连接后会在这里显示并计入用户额度') }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.active-connections-page { display: flex; flex-direction: column; gap: 20px; }
.active-connections-hero { min-height: 112px; padding: 4px 2px 18px; border-bottom: 1px solid var(--ink-200); display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
.active-connections-hero h1 { margin: 5px 0 4px; color: var(--ink-900); font-size: 28px; letter-spacing: -.04em; }
.active-connections-hero p { margin: 0; color: var(--ink-500); font-size: 13px; }
.active-connections-refresh { height: 36px; padding: 0 13px; border: 1px solid var(--ink-200); border-radius: 7px; background: var(--surface); color: var(--ink-700); display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-weight: 700; }
.connection-runtime-summary { display: grid; grid-template-columns: minmax(340px, 1.6fr) repeat(2, minmax(190px, .7fr)); gap: 12px; }
.connection-runtime-summary > article { min-height: 92px; padding: 17px 19px; border: 1px solid var(--ink-200); border-radius: 10px; background: linear-gradient(145deg, var(--surface), color-mix(in srgb, var(--teal-50) 38%, var(--surface))); color: var(--teal-700); display: flex; align-items: center; gap: 13px; box-shadow: 0 9px 24px color-mix(in srgb, var(--ink-900) 5%, transparent); }
.connection-runtime-summary article > div { display: flex; flex-direction: column; gap: 3px; }
.connection-runtime-summary article strong { color: var(--ink-900); font-size: 19px; }
.connection-runtime-summary article span { color: var(--ink-500); font-size: 11px; }
.connection-quota-card { position: relative; display: grid !important; grid-template-columns: auto 1fr; align-items: center; }
.connection-quota-card__value { min-width: 110px; flex-direction: row !important; align-items: baseline; gap: 5px !important; }
.connection-quota-card__value strong { font-size: 34px !important; letter-spacing: -.06em; }
.connection-quota-card__value span { font-size: 17px !important; font-weight: 700; }
.connection-quota-card small { color: var(--ink-400); font-size: 10px; }
.connection-quota-meter { position: absolute; right: 19px; bottom: 13px; left: 19px; height: 3px; border-radius: 9px; background: var(--ink-100); overflow: hidden; }
.connection-quota-meter i { height: 100%; border-radius: inherit; background: var(--teal-500); display: block; transition: width .25s ease; }
.active-connection-panel { border: 1px solid var(--ink-200); border-radius: 11px; background: var(--surface); overflow: hidden; box-shadow: 0 14px 34px color-mix(in srgb, var(--ink-900) 5%, transparent); }
.active-connection-panel > header { min-height: 68px; padding: 13px 16px 13px 19px; border-bottom: 1px solid var(--ink-200); background: color-mix(in srgb, var(--ink-50) 62%, var(--surface)); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.active-connection-panel > header > div:first-child { display: flex; flex-direction: column; gap: 3px; }
.active-connection-panel > header strong { color: var(--ink-800); font-size: 14px; }
.active-connection-panel > header span { color: var(--ink-400); font-size: 11px; }
.active-connection-filters { display: grid; grid-template-columns: 132px 250px; gap: 8px; }
.active-connection-list { display: flex; flex-direction: column; }
.active-connection-row { min-height: 82px; padding: 13px 15px 13px 19px; border-bottom: 1px solid var(--ink-100); display: grid; grid-template-columns: 36px minmax(180px, 1.4fr) minmax(80px, .45fr) minmax(150px, .9fr) minmax(150px, .9fr) auto; align-items: center; gap: 13px; position: relative; transition: background-color .16s ease; }
.active-connection-row.has-owner { grid-template-columns: 36px minmax(180px, 1.4fr) minmax(70px, .4fr) minmax(130px, .8fr) minmax(100px, .55fr) minmax(150px, .9fr) auto; }
.active-connection-row:last-child { border-bottom: 0; }
.active-connection-row:hover { background: color-mix(in srgb, var(--teal-50) 35%, transparent); }
.active-connection-row.is-closing, .active-connection-row.is-navigating { opacity: .66; }
.active-connection-open { position: absolute; z-index: 1; inset: 0; width: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; cursor: pointer; }
.active-connection-open:focus-visible { outline: 2px solid var(--teal-500); outline-offset: -3px; }
.active-connection-open:disabled { cursor: wait; }
.active-connection-type { width: 34px; height: 34px; border: 1px solid color-mix(in srgb, var(--teal-500) 28%, var(--ink-200)); border-radius: 9px; background: var(--teal-50); color: var(--teal-700); display: grid; place-items: center; }
.active-connection-identity, .active-connection-meta { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.active-connection-identity strong, .active-connection-meta strong { overflow: hidden; color: var(--ink-800); text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.active-connection-identity span, .active-connection-meta span, .active-connection-meta small { overflow: hidden; color: var(--ink-400); text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
.active-connection-close { z-index: 2; height: 32px; padding: 0 10px; border: 1px solid color-mix(in srgb, #c75a54 38%, var(--ink-200)); border-radius: 6px; background: color-mix(in srgb, #c75a54 7%, var(--surface)); color: #a94742; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 700; }
.active-connection-close:disabled { cursor: wait; opacity: .55; }
.active-connection-empty { min-height: 290px; color: var(--ink-400); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; }
.active-connection-empty strong { color: var(--ink-700); font-size: 14px; }
.active-connection-empty span { font-size: 12px; }
@media (max-width: 1180px) { .active-connection-row { grid-template-columns: 36px 1.2fr .5fr .8fr auto; } .active-connection-row.has-owner { grid-template-columns: 36px 1.2fr .5fr .8fr .6fr auto; } .active-connection-meta.is-time { display: none; } }
@media (max-width: 760px) { .active-connections-hero, .active-connection-panel > header { align-items: stretch; flex-direction: column; } .connection-runtime-summary { grid-template-columns: 1fr; } .active-connection-filters { grid-template-columns: 1fr; } .active-connection-row { grid-template-columns: 36px 1fr auto; } .active-connection-meta { display: none; } }
</style>
