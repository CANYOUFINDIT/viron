<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ArrowRight, Building2, FolderKanban, FolderPlus, Pencil, Plus, Server, ShieldCheck, Trash2, Users } from "@lucide/vue";
import TipIcon from "../../components/TipIcon.vue";
import { currentLocale, translate } from "../../i18n";
import { nameInitials } from "../../../shared/name-initials";
import { useOrganizationContext } from "./context";
import GrantTimelineView from "./GrantTimelineView.vue";
import { STRUCTURE_TREE_MAX, STRUCTURE_TREE_MIN, STRUCTURE_TREE_TEXT_MIN, STRUCTURE_TREE_WIDTH_KEY, clampStructureTreeWidth, preferredStructureTreeWidth, settleStructureTreeWidth } from "./structure-tree-width";

const { activateWorkspace, canManageOrganization, changeRole, createOrganizationDialog, deleteProject, detail, openCreateProject, openEditGrant, openEditProject, openGrantDialog, openGrantHistory, openProjectMembersById, organizations, removeMember, revokeGrant, selectStructureNode, selectedGrantRows, selectedGrantTarget, selectedMember, selectedMemberProjects, selectedNode, selectedProject, selectedProjectChildren, selectedProjectPath, structureTree } = useOrganizationContext();

const grantView = ref<"list" | "timeline">("list");
const workbenchElement = ref<HTMLElement | null>(null);
const containerWidth = ref(0);
const preferredTreeWidth = ref(preferredStructureTreeWidth(readStoredTreeWidth()));
const treeWidth = computed(() => clampStructureTreeWidth(preferredTreeWidth.value, containerWidth.value));
const avatarRail = computed(() => treeWidth.value < STRUCTURE_TREE_TEXT_MIN);
const workbenchStyle = computed(() => ({ "--structure-tree-width": `${treeWidth.value}px` }));
let treeResizeObserver: ResizeObserver | undefined;
let stopTreeResize: (() => void) | undefined;

function readStoredTreeWidth(): string | null {
  try {
    return localStorage.getItem(STRUCTURE_TREE_WIDTH_KEY);
  } catch {
    return null;
  }
}

function previewTreeWidth(raw: number): void {
  if (!Number.isFinite(raw)) return;
  preferredTreeWidth.value = Math.round(Math.min(STRUCTURE_TREE_MAX, Math.max(STRUCTURE_TREE_MIN, raw)));
}

function rememberTreeWidth(value: number): void {
  preferredTreeWidth.value = settleStructureTreeWidth(value);
  try {
    localStorage.setItem(STRUCTURE_TREE_WIDTH_KEY, String(preferredTreeWidth.value));
  } catch {
    // Private browsing can reject storage; the width still applies for this visit.
  }
}

function startTreeResize(event: PointerEvent): void {
  if (!event.isPrimary || event.button !== 0 || !workbenchElement.value) return;
  event.preventDefault();
  const bounds = workbenchElement.value.getBoundingClientRect();
  const pointerId = event.pointerId;
  const body = document.body;
  const previousCursor = body.style.cursor;
  const previousUserSelect = body.style.userSelect;
  body.style.cursor = "col-resize";
  body.style.userSelect = "none";
  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    previewTreeWidth(moveEvent.clientX - bounds.left);
  };
  const cleanup = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", finish);
    document.removeEventListener("pointercancel", cancel);
    body.style.cursor = previousCursor;
    body.style.userSelect = previousUserSelect;
    stopTreeResize = undefined;
  };
  const finish = (upEvent: PointerEvent) => {
    if (upEvent.pointerId !== pointerId) return;
    rememberTreeWidth(upEvent.clientX - bounds.left);
    cleanup();
  };
  const cancel = (cancelEvent: PointerEvent) => {
    if (cancelEvent.pointerId !== pointerId) return;
    rememberTreeWidth(preferredTreeWidth.value);
    cleanup();
  };
  stopTreeResize = cleanup;
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", finish);
  document.addEventListener("pointercancel", cancel);
}

function nudgeTreeWidth(delta: number): void {
  if (treeWidth.value < STRUCTURE_TREE_TEXT_MIN) {
    if (delta > 0) rememberTreeWidth(STRUCTURE_TREE_TEXT_MIN);
    return;
  }
  const next = treeWidth.value + delta;
  rememberTreeWidth(next < STRUCTURE_TREE_TEXT_MIN ? STRUCTURE_TREE_MIN : next);
}

onMounted(() => {
  const element = workbenchElement.value;
  if (!element || typeof ResizeObserver === "undefined") return;
  treeResizeObserver = new ResizeObserver((entries) => {
    containerWidth.value = entries[0]?.contentRect.width ?? 0;
  });
  treeResizeObserver.observe(element);
});

onBeforeUnmount(() => {
  treeResizeObserver?.disconnect();
  stopTreeResize?.();
});

function grantSource(row: { source: string; inherited: boolean }): string {
  return row.inherited ? translate("继承自 {0}", [row.source]) : row.source;
}

function grantExpiry(grant: { expired: boolean; expiresAt?: string | null }): string {
  if (grant.expired) return translate("已过期");
  return grant.expiresAt ? new Date(grant.expiresAt).toLocaleString(currentLocale()) : translate("永久");
}
</script>

<template>
<section v-if="detail" class="console-panel structure-panel">
            <article ref="workbenchElement" class="structure-workbench" :style="workbenchStyle">
              <aside class="structure-tree" :class="{ 'is-avatar-rail': avatarRail }" :aria-label="$t('组织架构树')">
                <header>
                  <div><strong>{{ $t('组织架构') }}</strong><small>{{ detail.projects.length }} {{ $t('个项目组 ·') }} {{ detail.members.length }} {{ $t('名成员') }}</small></div>
                  <button v-if="canManageOrganization" type="button" :aria-label="$t('创建根项目组')" @click="openCreateProject(null)"><FolderPlus :size="16" /></button>
                </header>
                <div class="structure-tree__body">
                  <el-tree :data="structureTree" node-key="key" default-expand-all :expand-on-click-node="false" @node-click="selectStructureNode">
                    <template #default="{ data }">
                      <span class="structure-node" :class="{ 'is-selected': selectedNode.type === data.type && selectedNode.id === data.entityId }" :title="data.label">
                        <span class="structure-node__icon" :class="`is-${data.type}`">
                          <Building2 v-if="data.type === 'organization'" :size="15" />
                          <FolderKanban v-else-if="data.type === 'project'" :size="15" />
                          <span v-else class="structure-node__initials" :class="{ 'is-wide': nameInitials(data.label).length > 1 }">{{ nameInitials(data.label) }}</span>
                        </span>
                        <span class="structure-node__copy"><strong>{{ data.label }}</strong><small>{{ data.meta }}</small></span>
                        <span
                          v-if="canManageOrganization && data.type === 'project' && selectedNode.type === 'project' && selectedNode.id === data.entityId"
                          class="structure-node__actions"
                          :aria-label="$t('项目组操作')"
                        >
                          <button
                            type="button"
                            :aria-label="$t('在“{0}”下新建子项目组', [data.label])"
                            :title="$t('在“{0}”下新建子项目组', [data.label])"
                            @click.stop="openCreateProject(data.entityId)"
                          ><FolderPlus :size="14" /></button>
                          <button
                            type="button"
                            :aria-label="$t('管理“{0}”的成员', [data.label])"
                            :title="$t('管理“{0}”的成员', [data.label])"
                            @click.stop="openProjectMembersById(data.entityId)"
                          ><Users :size="14" /></button>
                        </span>
                      </span>
                    </template>
                  </el-tree>
                </div>
              </aside>
              <button class="structure-tree-resizer" type="button" role="separator" aria-orientation="vertical" :aria-label="$t('调整组织架构宽度')" :aria-valuemin="STRUCTURE_TREE_MIN" :aria-valuemax="STRUCTURE_TREE_MAX" :aria-valuenow="treeWidth" @pointerdown="startTreeResize" @keydown.left.prevent="nudgeTreeWidth(-20)" @keydown.right.prevent="nudgeTreeWidth(20)"><span></span></button>

              <section class="node-inspector">
                <header class="node-inspector__header">
                  <span class="node-inspector__mark" :class="[`is-${selectedNode.type}`, { 'is-wide': selectedMember && nameInitials(selectedMember.username).length > 1 }]">
                    <Building2 v-if="selectedNode.type === 'organization'" :size="22" />
                    <FolderKanban v-else-if="selectedNode.type === 'project'" :size="22" />
                    <span v-else-if="selectedMember" class="node-inspector__initials">{{ nameInitials(selectedMember.username) }}</span>
                  </span>
                  <div v-if="selectedNode.type === 'organization'">
                    <small>{{ $t('组织根节点') }}</small>
                    <h3>{{ detail.organization.name }}</h3>
                    <p>{{ detail.organization.description || '—' }}</p>
                  </div>
                  <div v-else-if="selectedProject">
                    <small>{{ selectedProjectPath }}</small>
                    <h3>{{ selectedProject.name }}</h3>
                    <p>{{ selectedProject.description || '—' }}</p>
                  </div>
                  <div v-else-if="selectedMember">
                    <small>{{ $t('组织成员') }}</small>
                    <h3>{{ selectedMember.username }}</h3>
                    <p>{{ selectedMember.invitedBy ? $t('{0} 邀请加入', [selectedMember.invitedBy.username]) : $t('非邀请加入') }}</p>
                  </div>
                  <span v-if="canManageOrganization" class="node-inspector__actions">
                    <template v-if="selectedNode.type === 'organization'">
                      <el-button @click="openCreateProject(null)"><FolderPlus :size="15" />{{ $t('新建项目组') }}</el-button>
                    </template>
                    <template v-else-if="selectedProject">
                      <el-button @click="openEditProject(selectedProject)"><Pencil :size="15" />{{ $t('编辑') }}</el-button>
                      <el-button type="danger" plain @click="deleteProject(selectedProject)"><Trash2 :size="15" />{{ $t('删除') }}</el-button>
                    </template>
                    <template v-else-if="selectedMember">
                      <el-button @click="changeRole(selectedMember)">{{ selectedMember.role === 'admin' ? $t('降为成员') : $t('设为管理员') }}</el-button>
                      <el-button type="danger" plain @click="removeMember(selectedMember)">{{ $t('移出组织') }}</el-button>
                    </template>
                  </span>
                </header>

                <div class="node-facts">
                  <template v-if="selectedNode.type === 'organization'">
                    <span><small>{{ $t('根项目组') }}</small><strong>{{ detail.projects.filter((project) => !project.parentId).length }}</strong></span>
                    <span><small>{{ $t('项目组总数') }}</small><strong>{{ detail.projects.length }}</strong></span>
                    <span><small>{{ $t('成员总数') }}</small><strong>{{ detail.members.length }}</strong></span>
                    <span><small>{{ $t('授权关系') }}</small><strong>{{ detail.grants.length }}</strong></span>
                  </template>
                  <template v-else-if="selectedProject">
                    <span><small>{{ $t('直属成员') }}</small><strong>{{ selectedProject.memberCount }}</strong></span>
                    <span><small>{{ $t('子项目组') }}</small><strong>{{ selectedProjectChildren.length }}</strong></span>
                    <span><small>{{ $t('有效授权') }}</small><strong>{{ selectedGrantRows.length }}</strong></span>
                    <span><small>{{ $t('节点类型') }}</small><strong>{{ $t('项目组') }}</strong></span>
                  </template>
                  <template v-else-if="selectedMember">
                    <span><small>{{ $t('账号状态') }}</small><strong>{{ selectedMember.status === 'active' ? $t('使用中') : $t('已停用') }}</strong></span>
                    <span><small>{{ $t('组织角色') }}</small><strong>{{ selectedMember.role === 'admin' ? $t('管理员') : $t('普通成员') }}</strong></span>
                    <span><small>{{ $t('所属项目组') }}</small><strong>{{ selectedMemberProjects.length }}</strong></span>
                    <span><small>{{ $t('有效授权') }}</small><strong>{{ selectedGrantRows.length }}</strong></span>
                  </template>
                </div>

                <section v-if="canManageOrganization" class="node-grants">
                  <header>
                    <div><strong>{{ selectedNode.type === 'organization' ? $t('组织授权总览') : $t('连接与资源授权') }}</strong><small>{{ selectedGrantRows.length }} {{ $t('项有效授权') }}</small></div>
                    <span class="node-grants__tools">
                      <div v-if="selectedGrantRows.length" class="grant-view-switch" role="radiogroup" :aria-label="$t('授权视角')">
                        <button type="button" role="radio" :aria-checked="grantView === 'list'" :class="{ 'is-active': grantView === 'list' }" @click="grantView = 'list'">{{ $t('列表') }}</button>
                        <button type="button" role="radio" :aria-checked="grantView === 'timeline'" :class="{ 'is-active': grantView === 'timeline' }" @click="grantView = 'timeline'">{{ $t('时间线') }}</button>
                      </div>
                      <TipIcon :content="$t('子项目组继承父项目组授权；成员权限是个人直授与所属项目组、祖先项目组授权的并集。')" placement="left" />
                      <el-button v-if="selectedGrantTarget" type="primary" @click="openGrantDialog"><ShieldCheck :size="15" />{{ $t('授权资源') }}</el-button>
                    </span>
                  </header>
                  <div v-if="selectedGrantRows.length && grantView === 'list'" class="grant-ledger">
                    <div class="grant-ledger__head"><span>{{ $t('资源') }}</span><span>{{ $t('权限') }}</span><span>{{ $t('到期') }}</span><span>{{ $t('来源') }}</span><span>{{ $t('操作') }}</span></div>
                    <div v-for="row in selectedGrantRows" :key="row.grant.id" class="grant-ledger__row">
                      <span><Server :size="15" /><strong :title="row.grant.label">{{ row.grant.label || row.grant.resourceId }}</strong></span>
                      <span :title="row.grant.permissionText">{{ row.grant.permissionText }}</span>
                      <span :title="grantExpiry(row.grant)">{{ grantExpiry(row.grant) }}</span>
                      <span><em :class="{ 'is-inherited': row.inherited }" :title="grantSource(row)">{{ grantSource(row) }}</em></span>
                      <span class="grant-ledger__actions"><button type="button" class="is-edit" @click="openGrantHistory(row.grant)">{{ $t('记录') }}</button><template v-if="!row.inherited || selectedNode.type === 'organization'"><button type="button" class="is-edit" @click="openEditGrant(row.grant)">{{ $t('修改') }}</button><button type="button" @click="revokeGrant(row.grant)">{{ $t('撤销') }}</button></template><small v-else :title="$t('在来源节点管理')">{{ $t('在来源节点管理') }}</small></span>
                    </div>
                  </div>
                  <GrantTimelineView
                    v-else-if="selectedGrantRows.length"
                    :rows="selectedGrantRows"
                    :selected-node-type="selectedNode.type"
                    @edit="openEditGrant"
                    @revoke="revokeGrant"
                    @history="openGrantHistory"
                  />
                  <div v-else class="grant-empty"><ShieldCheck :size="24" /><span>{{ $t('暂无有效授权') }}</span></div>
                </section>
              </section>
            </article>
          </section>
<section v-else class="console-panel organization-overview">
              <div v-if="organizations.length" class="organization-card-grid">
                <button v-for="organization in organizations" :key="organization.id" type="button" @click="activateWorkspace({ type: 'organization', id: organization.id, name: organization.name, role: organization.role })"><span class="workspace-mark"><Building2 :size="18" /></span><span><strong>{{ organization.name }}</strong><small v-if="organization.description">{{ organization.description }}</small><em>{{ organization.role === 'admin' ? $t('组织管理员') : $t('普通成员') }}</em></span><ArrowRight :size="17" /></button>
              </div>
              <div v-else class="panel-empty organization-empty"><Building2 :size="30" /><strong>{{ $t('还没有组织') }}</strong><el-button type="primary" @click="createOrganizationDialog = true"><Plus :size="15" />{{ $t('创建新组织') }}</el-button></div>
            </section>
</template>

<style scoped src="./organization-structure.css"></style>
