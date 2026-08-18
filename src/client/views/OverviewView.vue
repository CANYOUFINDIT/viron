<script setup lang="ts">import { translate as tr } from "../i18n";

import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  ChevronDown,
  Database,
  EllipsisVertical,
  FolderPlus,
  Globe2,
  GripVertical,
  MemoryStick,
  Plus,
  Pencil,
  Search,
  Server,
  Star,
  TerminalSquare,
  Trash2,
  X,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import { api } from "../api";
import PageHeader from "../components/PageHeader.vue";
import TipIcon from "../components/TipIcon.vue";
import { session } from "../session";

interface EnvironmentGroup {
  id: string;
  name: string;
  description: string;
  color: string;
  environmentCount: number;
}

interface EnvironmentItem {
  id: string;
  groupId: string | null;
  groupName: string | null;
  name: string;
  alias: string;
  description: string;
  tags: string[];
  favorite: boolean;
  webCount: number;
  sshCount: number;
  databaseCount: number;
  redisCount: number;
  sortOrder: number;
  updatedAt: string;
}

interface EnvironmentDisplayGroup {
  id: string;
  name: string;
  color: string;
  items: EnvironmentItem[];
  isFavorite?: boolean;
}

const FAVORITES_GROUP_ID = "favorites";
const FAVORITES_GROUP_COLOR = "#d49a2a";

const loading = ref(true);
const groups = ref<EnvironmentGroup[]>([]);
const environments = ref<EnvironmentItem[]>([]);
const activeGroup = ref("");
const keyword = ref("");
const environmentDialog = ref(false);
const groupDialog = ref(false);
const saving = ref(false);
const editingGroupId = ref("");
const collapsedGroupIds = ref<Set<string>>(new Set());
const draggingGroupId = ref("");
const draggingEnvironmentId = ref("");
const dragOverGroupId = ref("");
const movingEnvironmentId = ref("");
const suppressCardClick = ref(false);
const savingGroupOrder = ref(false);
const savingEnvironmentOrder = ref(false);
const editingAliasKey = ref("");
const aliasDraft = ref("");
const aliasInput = ref<HTMLInputElement | null>(null);
const savingAliasId = ref("");
const savingFavoriteIds = ref<Set<string>>(new Set());
let groupDragOriginalOrder: string[] = [];
let groupDropCommitted = false;
let environmentDragOriginal: EnvironmentItem[] = [];
let environmentDropCommitted = false;
const sectionElements = new Map<string, HTMLElement>();

const environmentForm = reactive({
  name: "",
  groupId: null as string | null,
  description: "",
  tags: "",
});
const groupForm = reactive({ name: "", description: "", color: "#1d8a74" });
const canManageWorkspace = computed(() => session.workspace?.role === "owner" || session.workspace?.role === "admin");
const isOrganizationWorkspace = computed(() => session.workspace?.type === "organization");
const canSort = computed(() => canManageWorkspace.value && !keyword.value.trim() && !savingGroupOrder.value && !savingEnvironmentOrder.value);

const groupedEnvironments = computed<EnvironmentDisplayGroup[]>(() => {
  const result: EnvironmentDisplayGroup[] = [{
    id: FAVORITES_GROUP_ID,
    name: tr("收藏"),
    color: FAVORITES_GROUP_COLOR,
    items: environments.value.filter((environment) => environment.favorite),
    isFavorite: true,
  }];
  for (const group of groups.value) {
    const items = environments.value.filter((environment) => environment.groupId === group.id);
    result.push({ id: group.id, name: group.name, color: group.color, items });
  }
  const items = environments.value.filter((environment) => !environment.groupId);
  result.push({ id: "ungrouped", name: tr("未分组"), color: "#7d8891", items });
  return result;
});

async function load() {
  loading.value = true;
  try {
    const query = new URLSearchParams();
    if (keyword.value.trim()) query.set("q", keyword.value.trim());
    const [groupResponse, environmentResponse] = await Promise.all([
      api<{ items: EnvironmentGroup[] }>("/api/v1/environment-groups"),
      api<{ items: EnvironmentItem[] }>(`/api/v1/environments?${query.toString()}`),
    ]);
    groups.value = groupResponse.items;
    environments.value = environmentResponse.items;
    const groupIds = new Set([FAVORITES_GROUP_ID, ...groups.value.map((group) => group.id), "ungrouped"]);
    if (!groupIds.has(activeGroup.value)) activeGroup.value = FAVORITES_GROUP_ID;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载环境失败"));
  } finally {
    loading.value = false;
  }
}

function resetEnvironmentForm() {
  Object.assign(environmentForm, { name: "", groupId: null, description: "", tags: "" });
  environmentDialog.value = true;
}

async function createEnvironment() {
  if (!environmentForm.name.trim()) return ElMessage.warning(tr("请输入环境名称"));
  saving.value = true;
  try {
    await api("/api/v1/environments", {
      method: "POST",
      body: JSON.stringify({
        name: environmentForm.name,
        groupId: environmentForm.groupId,
        description: environmentForm.description,
        tags: environmentForm.tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      }),
    });
    environmentDialog.value = false;
    ElMessage.success(tr("环境已创建"));
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("创建环境失败"));
  } finally {
    saving.value = false;
  }
}

async function createGroup() {
  if (!groupForm.name.trim()) return ElMessage.warning(tr("请输入环境组名称"));
  saving.value = true;
  try {
    const wasEditing = Boolean(editingGroupId.value);
    const response = await api<{ id?: string; ok?: boolean }>(editingGroupId.value ? `/api/v1/environment-groups/${editingGroupId.value}` : "/api/v1/environment-groups", { method: editingGroupId.value ? "PUT" : "POST", body: JSON.stringify(groupForm) });
    groupDialog.value = false;
    Object.assign(groupForm, { name: "", description: "", color: "#1d8a74" });
    ElMessage.success(wasEditing ? tr("环境组已更新") : tr("环境组已创建"));
    await load();
    if (!wasEditing && response.id) await scrollToGroup(response.id);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("创建环境组失败"));
  } finally {
    saving.value = false;
  }
}

function openGroupCreate() {
  editingGroupId.value = "";
  Object.assign(groupForm, { name: "", description: "", color: "#1d8a74" });
  groupDialog.value = true;
}

function openGroupEdit(groupId: string) {
  const group = groups.value.find((item) => item.id === groupId);
  if (!group) return;
  editingGroupId.value = group.id;
  Object.assign(groupForm, { name: group.name, description: group.description, color: group.color });
  groupDialog.value = true;
}

async function removeGroup() {
  if (!editingGroupId.value) return;
  try {
    await ElMessageBox.confirm(tr("删除环境组后，组内环境会保留并移入未分组。"), tr("删除环境组"), { type: "warning", confirmButtonText: tr("删除"), cancelButtonText: tr("取消") });
    await api(`/api/v1/environment-groups/${editingGroupId.value}`, { method: "DELETE" });
    groupDialog.value = false;
    ElMessage.success(tr("环境组已删除"));
    activeGroup.value = "ungrouped";
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除环境组失败"));
  }
}

function setSectionRef(element: unknown, groupId: string) {
  if (element instanceof HTMLElement) sectionElements.set(groupId, element);
  else sectionElements.delete(groupId);
}

function isGroupCollapsed(groupId: string) {
  return collapsedGroupIds.value.has(groupId);
}

function environmentGroupColor(environment: EnvironmentItem) {
  return groups.value.find((group) => group.id === environment.groupId)?.color ?? "#7d8891";
}

function setGroupCollapsed(groupId: string, collapsed: boolean) {
  const next = new Set(collapsedGroupIds.value);
  if (collapsed) next.add(groupId);
  else next.delete(groupId);
  collapsedGroupIds.value = next;
}

function toggleGroup(groupId: string) {
  setGroupCollapsed(groupId, !isGroupCollapsed(groupId));
}

function sortHandleTitle(kind: string) {
  return keyword.value.trim() ? tr("清除筛选后可拖动{0}排序", [kind]) : tr("拖动{0}排序", [kind]);
}

function explainUnavailableSorting() {
  if (keyword.value.trim()) ElMessage.info(tr("清除搜索筛选后可调整顺序"));
}

async function scrollToGroup(groupId: string) {
  activeGroup.value = groupId;
  setGroupCollapsed(groupId, false);
  await nextTick();
  sectionElements.get(groupId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function restoreGroupOrder(orderedIds: string[]) {
  const byId = new Map(groups.value.map((group) => [group.id, group]));
  groups.value = orderedIds.map((id) => byId.get(id)).filter((group): group is EnvironmentGroup => Boolean(group));
}

function handleGroupDragStart(groupId: string, event: DragEvent) {
  if (!canSort.value) {
    event.preventDefault();
    explainUnavailableSorting();
    return;
  }
  draggingGroupId.value = groupId;
  groupDragOriginalOrder = groups.value.map((group) => group.id);
  groupDropCommitted = false;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `environment-group:${groupId}`);
  }
}

function handleGroupDragOver(targetGroupId: string, event: DragEvent) {
  if (!draggingGroupId.value || targetGroupId === FAVORITES_GROUP_ID) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const dragged = groups.value.find((group) => group.id === draggingGroupId.value);
  if (!dragged) return;
  const remaining = groups.value.filter((group) => group.id !== dragged.id);
  if (targetGroupId === "ungrouped") {
    remaining.push(dragged);
  } else {
    const targetIndex = remaining.findIndex((group) => group.id === targetGroupId);
    if (targetIndex < 0) return;
    const element = event.currentTarget;
    const insertAfter = element instanceof HTMLElement && event.clientY > element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2;
    remaining.splice(targetIndex + (insertAfter ? 1 : 0), 0, dragged);
  }
  groups.value = remaining;
  dragOverGroupId.value = targetGroupId;
}

async function handleGroupDrop(event: DragEvent) {
  if (!draggingGroupId.value) return;
  event.preventDefault();
  event.stopPropagation();
  groupDropCommitted = true;
  dragOverGroupId.value = "";
  const changed = groupDragOriginalOrder.some((id, index) => groups.value[index]?.id !== id);
  if (!changed) {
    draggingGroupId.value = "";
    groupDragOriginalOrder = [];
    groupDropCommitted = false;
    return;
  }
  savingGroupOrder.value = true;
  try {
    await api("/api/v1/environment-groups/order", {
      method: "PUT",
      body: JSON.stringify({ orderedIds: groups.value.map((group) => group.id) }),
    });
    ElMessage.success(tr("环境组顺序已保存"));
  } catch (error) {
    restoreGroupOrder(groupDragOriginalOrder);
    ElMessage.error(error instanceof Error ? error.message : tr("保存环境组顺序失败"));
  } finally {
    savingGroupOrder.value = false;
    draggingGroupId.value = "";
    groupDragOriginalOrder = [];
    groupDropCommitted = false;
  }
}

function handleGroupDragEnd() {
  if (!groupDropCommitted && groupDragOriginalOrder.length) restoreGroupOrder(groupDragOriginalOrder);
  draggingGroupId.value = "";
  dragOverGroupId.value = "";
  if (!groupDropCommitted) groupDragOriginalOrder = [];
}

function handleEnvironmentDragStart(environment: EnvironmentItem, event: DragEvent) {
  if (!canSort.value) {
    event.preventDefault();
    explainUnavailableSorting();
    return;
  }
  draggingEnvironmentId.value = environment.id;
  environmentDragOriginal = environments.value.map((item) => ({ ...item }));
  environmentDropCommitted = false;
  suppressCardClick.value = true;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `environment:${environment.id}`);
  }
}

function rebuildEnvironmentOrder(targetGroupId: string, targetEnvironmentId: string | null, insertAfter: boolean) {
  const environment = environments.value.find((item) => item.id === draggingEnvironmentId.value);
  if (!environment || targetEnvironmentId === environment.id) return;
  const normalizedGroupId = targetGroupId === "ungrouped" ? null : targetGroupId;
  const targetGroup = groups.value.find((group) => group.id === normalizedGroupId);
  const groupIds: Array<string | null> = [...groups.value.map((group) => group.id), null];
  const buckets = new Map(groupIds.map((groupId) => [groupId, [] as EnvironmentItem[]]));
  for (const item of environments.value) {
    if (item.id === environment.id) continue;
    (buckets.get(item.groupId) ?? buckets.get(null)!).push(item);
  }
  environment.groupId = normalizedGroupId;
  environment.groupName = targetGroup?.name ?? null;
  const targetItems = buckets.get(normalizedGroupId)!;
  const targetIndex = targetEnvironmentId ? targetItems.findIndex((item) => item.id === targetEnvironmentId) : -1;
  targetItems.splice(targetIndex < 0 ? targetItems.length : targetIndex + (insertAfter ? 1 : 0), 0, environment);
  for (const items of buckets.values()) items.forEach((item, index) => { item.sortOrder = index; });
  environments.value = groupIds.flatMap((groupId) => buckets.get(groupId) ?? []);
}

function handleEnvironmentCardDragOver(groupId: string, environmentId: string, event: DragEvent) {
  if (!draggingEnvironmentId.value) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const element = event.currentTarget;
  let insertAfter = false;
  if (element instanceof HTMLElement) {
    const bounds = element.getBoundingClientRect();
    const nearMiddleRow = Math.abs(event.clientY - (bounds.top + bounds.height / 2)) < bounds.height / 4;
    insertAfter = nearMiddleRow ? event.clientX > bounds.left + bounds.width / 2 : event.clientY > bounds.top + bounds.height / 2;
  }
  rebuildEnvironmentOrder(groupId, environmentId, insertAfter);
  dragOverGroupId.value = groupId;
}

function handleEnvironmentGroupDragOver(groupId: string, event: DragEvent) {
  if (!draggingEnvironmentId.value || groupId === FAVORITES_GROUP_ID) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  rebuildEnvironmentOrder(groupId, null, true);
  dragOverGroupId.value = groupId;
}

function handleSectionHeaderDragOver(groupId: string, event: DragEvent) {
  if (groupId === FAVORITES_GROUP_ID) return;
  if (draggingGroupId.value) handleGroupDragOver(groupId, event);
  else handleEnvironmentGroupDragOver(groupId, event);
}

function handleDragLeave(groupId: string, event: DragEvent) {
  const nextTarget = event.relatedTarget;
  if (nextTarget instanceof Node && event.currentTarget instanceof HTMLElement && event.currentTarget.contains(nextTarget)) return;
  if (dragOverGroupId.value === groupId) dragOverGroupId.value = "";
}

function handleEnvironmentDragEnd() {
  if (!environmentDropCommitted && environmentDragOriginal.length) environments.value = environmentDragOriginal;
  draggingEnvironmentId.value = "";
  dragOverGroupId.value = "";
  if (!environmentDropCommitted) environmentDragOriginal = [];
  window.setTimeout(() => {
    suppressCardClick.value = false;
  }, 0);
}

function preventDraggedNavigation(event: MouseEvent) {
  if (!suppressCardClick.value && !movingEnvironmentId.value) return;
  event.preventDefault();
  event.stopPropagation();
}

function aliasEditKey(environmentId: string, groupId: string) {
  return `${groupId}:${environmentId}`;
}

function isEditingAlias(environmentId: string, groupId: string) {
  return editingAliasKey.value === aliasEditKey(environmentId, groupId);
}

async function startAliasEdit(environment: EnvironmentItem, groupId: string) {
  editingAliasKey.value = aliasEditKey(environment.id, groupId);
  aliasDraft.value = environment.alias;
  await nextTick();
  aliasInput.value?.focus();
  aliasInput.value?.select();
}

function setAliasInput(element: unknown) {
  aliasInput.value = element instanceof HTMLInputElement ? element : null;
}

function cancelAliasEdit() {
  editingAliasKey.value = "";
  aliasDraft.value = "";
}

async function saveAlias(environment: EnvironmentItem, groupId: string) {
  if (!isEditingAlias(environment.id, groupId) || savingAliasId.value === environment.id) return;
  const alias = aliasDraft.value.trim();
  const previousAlias = environment.alias;
  cancelAliasEdit();
  if (alias === previousAlias) return;
  savingAliasId.value = environment.id;
  environment.alias = alias;
  try {
    const response = await api<{ alias: string }>(`/api/v1/environments/${environment.id}/preferences`, {
      method: "PUT",
      body: JSON.stringify({ alias }),
    });
    environment.alias = response.alias;
    if (keyword.value.trim()) await load();
  } catch (error) {
    environment.alias = previousAlias;
    ElMessage.error(error instanceof Error ? error.message : tr("保存环境别称失败"));
  } finally {
    savingAliasId.value = "";
  }
}

function isSavingFavorite(environmentId: string) {
  return savingFavoriteIds.value.has(environmentId);
}

function setSavingFavorite(environmentId: string, saving: boolean) {
  const next = new Set(savingFavoriteIds.value);
  if (saving) next.add(environmentId);
  else next.delete(environmentId);
  savingFavoriteIds.value = next;
}

async function toggleFavorite(environment: EnvironmentItem) {
  if (isSavingFavorite(environment.id)) return;
  const previousFavorite = environment.favorite;
  environment.favorite = !previousFavorite;
  setSavingFavorite(environment.id, true);
  try {
    const response = await api<{ favorite: boolean }>(`/api/v1/environments/${environment.id}/preferences`, {
      method: "PUT",
      body: JSON.stringify({ favorite: environment.favorite }),
    });
    environment.favorite = response.favorite;
  } catch (error) {
    environment.favorite = previousFavorite;
    ElMessage.error(error instanceof Error ? error.message : tr("保存环境收藏失败"));
  } finally {
    setSavingFavorite(environment.id, false);
  }
}

async function handleEnvironmentDrop(event: DragEvent) {
  if (!draggingEnvironmentId.value) return;
  event.preventDefault();
  event.stopPropagation();
  environmentDropCommitted = true;
  const environmentId = draggingEnvironmentId.value;
  dragOverGroupId.value = "";
  const environment = environments.value.find((item) => item.id === environmentId);
  const original = environmentDragOriginal.find((item) => item.id === environmentId);
  if (!environment || !original) {
    environmentDropCommitted = false;
    return;
  }
  const changed = environmentDragOriginal.some((item, index) => item.id !== environments.value[index]?.id || item.groupId !== environments.value[index]?.groupId);
  if (!changed) {
    draggingEnvironmentId.value = "";
    environmentDragOriginal = [];
    environmentDropCommitted = false;
    return;
  }
  movingEnvironmentId.value = environment.id;
  savingEnvironmentOrder.value = true;
  try {
    await api("/api/v1/environments/order", {
      method: "PUT",
      body: JSON.stringify({ items: environments.value.map((item) => ({ id: item.id, groupId: item.groupId })) }),
    });
    activeGroup.value = environment.groupId ?? "ungrouped";
    if (original.groupId === environment.groupId) ElMessage.success(tr("环境顺序已保存"));
    else ElMessage.success(tr("“{0}”已移动到{1}", [environment.name, environment.groupName ?? tr("未分组")]));
  } catch (error) {
    environments.value = environmentDragOriginal;
    ElMessage.error(error instanceof Error ? error.message : tr("保存环境顺序失败"));
  } finally {
    movingEnvironmentId.value = "";
    savingEnvironmentOrder.value = false;
    draggingEnvironmentId.value = "";
    environmentDragOriginal = [];
    environmentDropCommitted = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="overview-view" v-loading="loading">
    <PageHeader :title="$t('环境总览')">
      <template #actions>
        <el-button :aria-label="$t('新建环境组')" @click="openGroupCreate"><FolderPlus :size="16" />{{ $t('新建环境组') }}</el-button>
        <el-button type="primary" :aria-label="$t('新建环境')" @click="resetEnvironmentForm"><Plus :size="16" />{{ $t('新建环境') }}</el-button>
      </template>
    </PageHeader>

    <section class="overview-commandbar" :aria-label="$t('环境筛选')">
      <el-input v-model="keyword" clearable :placeholder="$t('搜索环境名称、别称或标签')" @clear="load" @keyup.enter="load">
        <template #prefix><Search :size="16" /></template>
      </el-input>
      <el-button @click="load">{{ $t('应用筛选') }}</el-button>
      <span>{{ keyword ? $t('找到 {0} 个环境', [environments.length]) : $t('共 {0} 个环境', [environments.length]) }}</span>
    </section>

    <div class="overview-directory-layout">
      <aside class="environment-directory" :aria-label="$t('环境组目录')">
        <div class="environment-directory__title"><Boxes :size="16" /><strong>{{ $t('环境目录') }}</strong><small>{{ environments.length }}</small></div>
        <nav>
          <div
            v-for="group in groupedEnvironments"
            :key="group.id"
            class="environment-directory__item"
            :class="{ 'is-drag-over': dragOverGroupId === group.id, 'is-group-dragging': draggingGroupId === group.id }"
            @dragover="handleSectionHeaderDragOver(group.id, $event)"
            @dragleave="handleDragLeave(group.id, $event)"
            @drop="draggingGroupId ? handleGroupDrop($event) : handleEnvironmentDrop($event)"
          >
            <button class="environment-directory__link" :class="{ 'is-active': activeGroup === group.id }" @click="scrollToGroup(group.id)">
              <span class="group-color" :style="{ background: group.color }"></span>
              <span>{{ group.name }}</span>
              <small>{{ group.items.length }}</small>
            </button>
            <span
              v-if="!group.isFavorite && group.id !== 'ungrouped' && canManageWorkspace"
              class="environment-sort-handle environment-group-sort-handle"
              :class="{ 'is-disabled': !canSort }"
              :draggable="canSort"
              :title="sortHandleTitle($t('环境组'))"
              :aria-label="sortHandleTitle($t('环境组'))"
              @dragstart.stop="handleGroupDragStart(group.id, $event)"
              @dragend="handleGroupDragEnd"
              @click.stop="explainUnavailableSorting"
            ><GripVertical :size="14" /></span>
          </div>
        </nav>
      </aside>

      <main class="environment-sections">
        <section
          v-for="group in groupedEnvironments"
          :key="group.id"
          :ref="(element) => setSectionRef(element, group.id)"
          class="environment-section"
          :class="{ 'is-favorites': group.isFavorite, 'is-collapsed': isGroupCollapsed(group.id), 'is-drag-over': dragOverGroupId === group.id, 'is-group-dragging': draggingGroupId === group.id }"
          @dragover="handleEnvironmentGroupDragOver(group.id, $event)"
          @dragleave="handleDragLeave(group.id, $event)"
          @drop="handleEnvironmentDrop($event)"
        >
          <header
            @dragover="handleSectionHeaderDragOver(group.id, $event)"
            @drop="draggingGroupId ? handleGroupDrop($event) : handleEnvironmentDrop($event)"
          >
            <span
              v-if="!group.isFavorite && group.id !== 'ungrouped' && canManageWorkspace"
              class="environment-sort-handle environment-group-sort-handle is-section-handle"
              :class="{ 'is-disabled': !canSort }"
              :draggable="canSort"
              :title="sortHandleTitle($t('环境组'))"
              :aria-label="sortHandleTitle($t('环境组'))"
              @dragstart.stop="handleGroupDragStart(group.id, $event)"
              @dragend="handleGroupDragEnd"
              @click.stop="explainUnavailableSorting"
            ><GripVertical :size="15" /></span>
            <button class="section-toggle" :aria-expanded="!isGroupCollapsed(group.id)" @click="toggleGroup(group.id)">
              <ChevronDown :size="16" :class="{ 'is-collapsed': isGroupCollapsed(group.id) }" />
              <span class="group-color" :style="{ background: group.color }"></span>
              <h3>{{ group.name }}</h3>
              <small>{{ group.items.length }} {{ $t('个环境') }}</small>
            </button>
            <span v-if="dragOverGroupId === group.id" class="environment-drop-hint">{{ draggingGroupId ? $t('松开以调整组顺序') : $t('松开以放置环境') }}</span>
            <button v-if="!group.isFavorite && group.id !== 'ungrouped'" class="section-edit" :aria-label="$t('编辑环境组')" :title="$t('编辑环境组')" @click="openGroupEdit(group.id)"><Pencil :size="13" /></button>
          </header>

          <template v-if="!isGroupCollapsed(group.id)">
            <div v-if="group.items.length" class="environment-grid">
              <article
                v-for="environment in group.items"
                :key="environment.id"
                class="environment-card-shell"
                :class="{ 'is-dragging': draggingEnvironmentId === environment.id, 'is-moving': movingEnvironmentId === environment.id }"
                @dragover.stop="handleEnvironmentCardDragOver(group.id, environment.id, $event)"
                @drop.stop="handleEnvironmentDrop($event)"
              >
                <RouterLink
                  :to="`/environments/${environment.id}`"
                  class="environment-card"
                  :style="{ '--environment-card-accent': group.isFavorite ? environmentGroupColor(environment) : group.color }"
                  :aria-label="$t('进入 {0} 工作区', [environment.alias || environment.name])"
                  :aria-busy="movingEnvironmentId === environment.id"
                  draggable="false"
                  @click="preventDraggedNavigation"
                >
                  <div class="environment-browser__chrome">
                    <div class="environment-browser__windowbar">
                      <span class="environment-browser__tab" :class="{ 'has-alias-action': isOrganizationWorkspace }">
                        <i></i>
                        <strong v-if="!isEditingAlias(environment.id, group.id)" :title="environment.alias || environment.name">{{ environment.alias || environment.name }}</strong>
                        <input
                          v-else
                          :ref="setAliasInput"
                          v-model="aliasDraft"
                          maxlength="120"
                          :aria-label="$t('环境别称')"
                          @click.stop.prevent
                          @keydown.enter.prevent.stop="saveAlias(environment, group.id)"
                          @keydown.esc.prevent.stop="cancelAliasEdit"
                          @blur="saveAlias(environment, group.id)"
                        />
                        <button
                          v-if="isOrganizationWorkspace && !isEditingAlias(environment.id, group.id)"
                          type="button"
                          class="environment-browser__alias-edit"
                          :disabled="savingAliasId === environment.id"
                          :aria-label="$t('编辑环境别称')"
                          :title="$t('编辑环境别称')"
                          @click.stop.prevent="startAliasEdit(environment, group.id)"
                        ><Pencil :size="11" /></button>
                        <X class="environment-browser__tab-close" :size="11" aria-hidden="true" />
                      </span>
                      <span
                        v-if="canManageWorkspace && !group.isFavorite"
                        class="environment-sort-handle environment-browser__drag-handle"
                        :class="{ 'is-disabled': !canSort }"
                        :draggable="canSort"
                        :title="sortHandleTitle($t('环境'))"
                        :aria-label="sortHandleTitle($t('环境'))"
                        @dragstart.stop="handleEnvironmentDragStart(environment, $event)"
                        @dragend="handleEnvironmentDragEnd"
                        @click.stop.prevent="explainUnavailableSorting"
                      ><GripVertical :size="14" /></span>
                    </div>
                    <div class="environment-browser__toolbar">
                      <ArrowLeft :size="14" class="is-muted" aria-hidden="true" />
                      <ArrowRight :size="14" class="is-muted" aria-hidden="true" />
                      <span class="environment-browser__address">
                        <i></i>
                        <strong>{{ environment.name }}</strong>
                      </span>
                      <button
                        type="button"
                        class="environment-favorite-action"
                        :class="{ 'is-favorite': environment.favorite }"
                        :disabled="isSavingFavorite(environment.id)"
                        :aria-pressed="environment.favorite"
                        :aria-label="environment.favorite ? $t('取消收藏 {0}', [environment.alias || environment.name]) : $t('收藏 {0}', [environment.alias || environment.name])"
                        :title="environment.favorite ? $t('取消收藏') : $t('收藏')"
                        @click.stop.prevent="toggleFavorite(environment)"
                      ><Star :size="13" :fill="environment.favorite ? 'currentColor' : 'none'" /></button>
                      <EllipsisVertical :size="14" aria-hidden="true" />
                    </div>
                  </div>
                  <div class="environment-browser__page">
                    <div class="environment-browser__summary">
                      <span class="environment-avatar">{{ environment.name.slice(0, 2) }}</span>
                      <el-tooltip
                        :content="environment.description"
                        :disabled="!environment.description"
                        placement="top"
                        :show-after="250"
                        popper-class="environment-description-popper"
                      >
                        <p class="environment-card__description">{{ environment.description || $t('暂无环境说明') }}</p>
                      </el-tooltip>
                    </div>
                    <div class="resource-counts" :aria-label="$t('环境资源数量')">
                      <span :title="$t('{0} 个 Web 入口', [environment.webCount])"><Globe2 :size="14" aria-hidden="true" /><strong>{{ environment.webCount }}</strong><small>Web</small></span>
                      <span :title="$t('{0} 个 SSH 连接', [environment.sshCount])"><TerminalSquare :size="14" aria-hidden="true" /><strong>{{ environment.sshCount }}</strong><small>SSH</small></span>
                      <span :title="$t('{0} 个数据库连接', [environment.databaseCount])"><Database :size="14" aria-hidden="true" /><strong>{{ environment.databaseCount }}</strong><small>{{ $t('数据库') }}</small></span>
                      <span :title="$t('{0} 个 Redis 连接', [environment.redisCount])"><MemoryStick :size="14" aria-hidden="true" /><strong>{{ environment.redisCount }}</strong><small>Redis</small></span>
                    </div>
                  </div>
                </RouterLink>
              </article>
            </div>
            <div v-else class="environment-group-empty">
              <Server :size="20" />
              <span>{{ group.isFavorite ? (keyword ? $t('当前筛选下没有收藏环境') : $t('暂无收藏环境')) : (keyword ? $t('当前筛选下没有环境') : $t('暂无环境')) }}</span>
              <TipIcon v-if="group.isFavorite && !keyword" :content="$t('点击环境卡片地址栏中的星星即可收藏。')" placement="right" />
              <TipIcon v-else-if="!keyword" :content="$t('可将其他分组中的环境拖动到这里。')" placement="right" />
            </div>
          </template>
        </section>
      </main>
    </div>

    <el-dialog v-model="environmentDialog" align-center class="envman-dialog" :title="$t('新建环境')" width="620px">
      <el-form label-position="top" class="dialog-form-grid">
        <el-form-item :label="$t('环境名称')" required><el-input v-model="environmentForm.name" :placeholder="$t('例如：NCCP 生产环境')" /></el-form-item>
        <el-form-item :label="$t('环境组')"><el-select v-model="environmentForm.groupId" clearable :placeholder="$t('未分组')" style="width:100%"><el-option v-for="group in groups" :key="group.id" :label="group.name" :value="group.id" /></el-select></el-form-item>
        <el-form-item :label="$t('标签')" class="form-span-2"><el-input v-model="environmentForm.tags" :placeholder="$t('多个标签用逗号分隔')" /></el-form-item>
        <el-form-item :label="$t('环境说明')" class="form-span-2"><el-input v-model="environmentForm.description" type="textarea" :rows="3" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="environmentDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="createEnvironment">{{ $t('创建环境') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="groupDialog" align-center class="envman-dialog compact-dialog" :title="editingGroupId ? $t('编辑环境组') : $t('新建环境组')" width="520px">
      <el-form label-position="top">
        <el-form-item :label="$t('环境组名称')" required><el-input v-model="groupForm.name" /></el-form-item>
        <el-form-item :label="$t('说明')"><el-input v-model="groupForm.description" type="textarea" :rows="3" /></el-form-item>
        <el-form-item :label="$t('识别色')"><el-color-picker v-model="groupForm.color" /></el-form-item>
      </el-form>
      <template #footer><div class="dialog-footer-actions"><el-button @click="groupDialog = false">{{ $t('取消') }}</el-button><div><el-button v-if="editingGroupId" type="danger" plain @click="removeGroup"><Trash2 :size="14" />{{ $t('删除环境组') }}</el-button><el-button type="primary" :loading="saving" @click="createGroup">{{ editingGroupId ? $t('保存修改') : $t('创建环境组') }}</el-button></div></div></template>
    </el-dialog>
  </div>
</template>
