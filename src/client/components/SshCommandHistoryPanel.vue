<script setup lang="ts">import { currentLocale, translate as tr } from "../i18n";

import { Clock3, History, LoaderCircle, MapPin, Star, Trash2, WandSparkles, X } from "@lucide/vue";
import { ref } from "vue";
import type { SshCommandFavoriteEntry, SshCommandHistoryEntry } from "../ssh-command-history";
import TipIcon from "./TipIcon.vue";

const props = defineProps<{
  entries: SshCommandHistoryEntry[];
  favorites: SshCommandFavoriteEntry[];
  favoritesLoading: boolean;
  connectionName?: string;
  suggestionsEnabled: boolean;
}>();

const emit = defineEmits<{
  close: [];
  use: [entry: SshCommandHistoryEntry];
  useFavorite: [entry: SshCommandFavoriteEntry];
  favorite: [entry: SshCommandHistoryEntry];
  unfavorite: [entry: SshCommandFavoriteEntry];
  remove: [entry: SshCommandHistoryEntry];
  clear: [];
  suggestionsChange: [value: string | number | boolean];
}>();

const activeTab = ref<"history" | "favorites">("history");

function favoriteFor(entry: SshCommandHistoryEntry): SshCommandFavoriteEntry | undefined {
  return props.favorites.find((favorite) => favorite.command === entry.command);
}

function toggleFavorite(entry: SshCommandHistoryEntry): void {
  const favorite = favoriteFor(entry);
  if (favorite) emit("unfavorite", favorite);
  else emit("favorite", entry);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return tr("时间未知");
  const now = new Date();
  const time = new Intl.DateTimeFormat(currentLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.getMonth() + 1}/${date.getDate()} ${time.slice(0, 5)}`;
}
</script>

<template>
  <aside class="ssh-command-history" :aria-label="$t('SSH 命令历史')">
    <header class="ssh-command-history__header">
      <div class="ssh-command-history__title">
        <span><History :size="16" /></span>
        <strong>{{ $t('命令历史') }}</strong>
        <TipIcon :content="$t('当前历史保存在浏览器中且不会记录敏感命令；收藏保存在服务端。')" placement="right" />
      </div>
      <button type="button" :aria-label="$t('关闭命令历史')" :title="$t('关闭命令历史')" @click="emit('close')"><X :size="15" /></button>
    </header>

    <nav class="ssh-command-history__tabs" :aria-label="$t('命令历史类型')">
      <button type="button" :class="{ 'is-active': activeTab === 'favorites' }" @click="activeTab = 'favorites'"><Star :size="13" />{{ $t('收藏命令') }} <span>{{ favorites.length }}</span></button>
      <button type="button" :class="{ 'is-active': activeTab === 'history' }" @click="activeTab = 'history'"><History :size="13" />{{ $t('当前历史') }} <span>{{ entries.length }}</span></button>
    </nav>

    <div v-if="!connectionName" class="ssh-command-history__empty">
      <History :size="22" />
      <strong>{{ $t('暂无活动终端') }}</strong>
    </div>
    <div v-else-if="activeTab === 'history' && !entries.length" class="ssh-command-history__empty">
      <History :size="22" />
      <strong>{{ $t('暂无命令记录') }}</strong>
    </div>
    <div v-else-if="activeTab === 'history'" class="ssh-command-history__list">
      <article v-for="entry in entries" :key="entry.id" class="ssh-command-history__item ssh-command-history__item--history">
        <button type="button" class="ssh-command-history__command" :title="$t('填入命令：{0}', [entry.command])" @click="emit('use', entry)">
          <code>{{ entry.command }}</code>
          <span class="ssh-command-history__meta">
            <span :title="entry.cwd"><MapPin :size="11" />{{ entry.cwd }}</span>
            <time :datetime="entry.createdAt" :title="new Date(entry.createdAt).toLocaleString($locale())"><Clock3 :size="11" />{{ formatTime(entry.createdAt) }}</time>
          </span>
        </button>
        <button type="button" class="ssh-command-history__favorite" :class="{ 'is-active': favoriteFor(entry) }" :disabled="favoritesLoading" :aria-label="favoriteFor(entry) ? $t('取消收藏：{0}', [entry.command]) : $t('收藏命令：{0}', [entry.command])" :title="favoriteFor(entry) ? $t('取消收藏') : $t('收藏命令')" @click="toggleFavorite(entry)"><Star :size="13" :fill="favoriteFor(entry) ? 'currentColor' : 'none'" /></button>
        <button type="button" class="ssh-command-history__remove" :aria-label="$t('删除命令：{0}', [entry.command])" :title="$t('删除这条记录')" @click="emit('remove', entry)"><Trash2 :size="13" /></button>
      </article>
    </div>
    <div v-else-if="favoritesLoading" class="ssh-command-history__empty">
      <LoaderCircle :size="22" class="is-spinning" />
      <strong>{{ $t('正在加载收藏') }}</strong>
    </div>
    <div v-else-if="!favorites.length" class="ssh-command-history__empty">
      <Star :size="22" />
      <strong>{{ $t('暂无收藏命令') }}</strong>
    </div>
    <div v-else class="ssh-command-history__list">
      <article v-for="entry in favorites" :key="entry.id" class="ssh-command-history__item ssh-command-history__item--favorite">
        <button type="button" class="ssh-command-history__command" :title="$t('双击填入命令：{0}', [entry.command])" @dblclick="emit('useFavorite', entry)" @keydown.enter="emit('useFavorite', entry)">
          <code>{{ entry.command }}</code>
          <span class="ssh-command-history__meta">
            <span :title="entry.cwd"><MapPin :size="11" />{{ entry.cwd || $t('路径未知') }}</span>
            <time :datetime="entry.updatedAt" :title="new Date(entry.updatedAt).toLocaleString($locale())"><Clock3 :size="11" />{{ formatTime(entry.updatedAt) }}</time>
          </span>
        </button>
        <button type="button" class="ssh-command-history__favorite is-active" :aria-label="$t('取消收藏：{0}', [entry.command])" :title="$t('取消收藏')" @click="emit('unfavorite', entry)"><Star :size="13" fill="currentColor" /></button>
      </article>
    </div>

    <footer class="ssh-command-history__footer">
      <div v-if="activeTab === 'history'" class="terminal-assist-switch ssh-command-history__assist" :title="$t('SSH 历史命令输入辅助')">
        <WandSparkles :size="14" aria-hidden="true" />
        <span>{{ $t('输入辅助') }}</span>
        <el-switch :model-value="suggestionsEnabled" size="small" :aria-label="$t('切换 SSH 历史命令输入辅助')" @change="emit('suggestionsChange', $event)" />
      </div>
      <span v-else class="ssh-command-history__server-note"><Star :size="12" />{{ $t('服务端保存') }}</span>
      <button v-if="activeTab === 'history'" type="button" :disabled="!entries.length" @click="emit('clear')"><Trash2 :size="12" />{{ $t('清空') }}</button>
    </footer>
  </aside>
</template>

<style scoped>
.ssh-command-history { inset: 0 0 0 auto; width: var(--ssh-history-panel-width, 292px); grid-template-rows: 45px 35px minmax(0, 1fr) 37px; }
.ssh-command-history__tabs { padding: 4px 7px; border-bottom: 1px solid #26383b; background: #0d181a; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
.ssh-command-history__tabs button { min-width: 0; height: 26px; padding: 0 6px; border: 0; border-radius: 5px; background: transparent; color: #667c77; display: flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer; font-size: 10px; }
.ssh-command-history__tabs button:hover { background: #18282b; color: #bdd0cb; }
.ssh-command-history__tabs button.is-active { background: #1a332e; color: #72d8b5; }
.ssh-command-history__tabs button span { color: inherit; opacity: .68; }
.ssh-command-history__item--history { grid-template-columns: minmax(0, 1fr) 25px 25px; }
.ssh-command-history__item--favorite { grid-template-columns: minmax(0, 1fr) 25px; }
.ssh-command-history__favorite { width: 25px; height: 25px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: #536964; display: grid; place-items: center; cursor: pointer; }
.ssh-command-history__favorite:hover:not(:disabled), .ssh-command-history__favorite.is-active { background: #2e2d20; color: #e0bd63; }
.ssh-command-history__favorite:disabled { opacity: .4; cursor: wait; }
.ssh-command-history__favorite:focus-visible, .ssh-command-history__tabs button:focus-visible { outline: 2px solid #55bd9b; outline-offset: 1px; }
.ssh-command-history__footer { justify-content: space-between; }
.ssh-command-history__assist { min-width: 0; height: 25px; font-size: 10px; }
.ssh-command-history__server-note { color: #6f8580; display: inline-flex; align-items: center; gap: 5px; }
</style>
