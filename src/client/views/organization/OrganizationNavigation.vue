<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Building2, ChevronDown, History, KeyRound, Layers, Network, Plus, ShieldCheck, Link2, RefreshCw } from "@lucide/vue";
import { nameInitials } from "../../../shared/name-initials";
import { useOrganizationContext } from "./context";
import { STRUCTURE_TREE_MAX, STRUCTURE_TREE_MIN, STRUCTURE_TREE_TEXT_MIN, STRUCTURE_TREE_WIDTH_KEY, clampStructureTreeWidth, preferredStructureTreeWidth, settleStructureTreeWidth } from "./structure-tree-width";
const emit = defineEmits<{ openPanel: [panel: "structure" | "resources" | "roles" | "approval" | "mine" | "platform"] }>();
const { activePanel, activateWorkspace, organizations, createOrganizationDialog, joinOrganizationDialog, synchronize, loading, canManageOrganization, detail, openCreateProject, selectedNode, session, structureTree } = useOrganizationContext();
const personal = computed(() => ["mine", "requests", "todo"].includes(activePanel.value));
const maintenance = [
  { id: "resources", label: "资源总览", icon: Layers },
  { id: "roles", label: "角色", icon: KeyRound },
  { id: "approval", label: "审批与台账", icon: History },
] as const;
const organizationTree = computed(() => {
  function membersBelow(node: (typeof structureTree.value)[number], ids = new Set<string>()) {
    if (node.type === "member") ids.add(node.entityId);
    node.children?.forEach(child => membersBelow(child, ids));
    return ids;
  }
  function prune(nodes: typeof structureTree.value): typeof structureTree.value {
    return nodes.filter(node => node.type !== "member").map(node => ({ ...node, label: node.type === "organization" ? "整个组织" : node.label, meta: String(membersBelow(node).size), children: node.children ? prune(node.children) : undefined }));
  }
  const root = structureTree.value[0];
  return root ? [{ ...root, label: "整个组织", children: undefined }, ...prune(root.children ?? [])] : [];
});
function selectNode(node: (typeof structureTree.value)[number]) {
  selectedNode.value = { type: node.type, id: node.entityId };
  emit("openPanel", "structure");
}
const workbenchElement = ref<HTMLElement | null>(null);
const containerWidth = ref(0);
const preferredTreeWidth = ref(preferredStructureTreeWidth(readStoredTreeWidth() ?? "250"));
const treeWidth = computed(() => clampStructureTreeWidth(preferredTreeWidth.value, containerWidth.value));
const narrow = ref(window.innerWidth <= 900);
const avatarRail = computed(() => !narrow.value && treeWidth.value < STRUCTURE_TREE_TEXT_MIN);
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
    narrow.value = window.innerWidth <= 900;
  });
  treeResizeObserver.observe(element.parentElement ?? element);
});

onBeforeUnmount(() => {
  treeResizeObserver?.disconnect();
  stopTreeResize?.();
});

</script>
<template>
  <aside ref="workbenchElement" class="organization-navigation structure-tree" :class="{ 'is-avatar-rail': avatarRail }" :style="workbenchStyle" aria-label="组织导航">
    <div class="organization-navigation__workspace">
      <div class="organization-navigation__wordmark">viron<span>.</span></div>
      <el-dropdown trigger="click" placement="bottom-start" popper-class="organization-workspace-menu">
        <button class="organization-workspace-trigger" type="button" aria-label="组织工作空间选项"><Building2 :size="16" /><span>{{ detail?.organization.name || (session.workspace?.type === 'organization' ? session.workspace.name : '选择组织') }}</span><ChevronDown :size="14" /></button>
        <template #dropdown><el-dropdown-menu>
          <el-dropdown-item v-for="organization in organizations" :key="organization.id" @click="activateWorkspace({ type: 'organization', id: organization.id, name: organization.name, role: organization.role })">{{ organization.name }}</el-dropdown-item>
          <el-dropdown-item v-for="workspace in session.workspaces.filter(item => item.type === 'personal')" :key="`personal:${workspace.id}`" divided @click="activateWorkspace(workspace)">{{ session.user?.username }} 的个人空间</el-dropdown-item>
          <el-dropdown-item divided><el-button text @click="joinOrganizationDialog = true"><Link2 :size="15" />加入组织</el-button></el-dropdown-item>
          <el-dropdown-item><el-button text aria-label="创建组织" @click="createOrganizationDialog = true"><Plus :size="15" />创建组织</el-button></el-dropdown-item>
          <el-dropdown-item><el-button text :loading="loading" @click="synchronize"><RefreshCw :size="15" />同步数据</el-button></el-dropdown-item>
        </el-dropdown-menu></template>
      </el-dropdown>
      <small>{{ detail ? '组织工作空间' : '组织管理' }}</small>
    </div>
    <div class="organization-navigation__body">
      <template v-if="detail">
        <button class="organization-navigation__mine" :class="{ 'is-active': personal }" type="button" aria-label="我的授权、申请与待办" :aria-current="personal ? 'page' : undefined" @click="emit('openPanel', 'mine')">
          <span class="organization-navigation__avatar">{{ nameInitials(session.user?.username || '') }}</span><span><strong>{{ session.user?.username }}</strong><small>我的授权 · 申请 · 待办</small></span>
        </button>
        <div class="organization-navigation__label">组织维护</div>
        <nav class="organization-navigation__maintenance" aria-label="组织维护">
          <button v-for="item in maintenance" :key="item.id" type="button" :title="item.label" :class="{ 'is-active': activePanel === item.id }" :aria-current="activePanel === item.id ? 'page' : undefined" @click="emit('openPanel', item.id)"><component :is="item.icon" :size="17" /><span>{{ item.label }}</span></button>
        </nav>
        <div class="organization-navigation__label"><span>组织结构</span><button v-if="canManageOrganization" type="button" aria-label="创建根项目组" title="创建根项目组" @click="openCreateProject(null)"><Plus :size="17" /></button></div>
        <div class="structure-tree__body">
          <el-tree :data="organizationTree" node-key="key" default-expand-all :expand-on-click-node="false" @node-click="selectNode">
            <template #default="{ data }">
              <span class="structure-node" :class="{ 'is-selected': activePanel === 'structure' && selectedNode.type === data.type && selectedNode.id === data.entityId }" :title="data.label">
                <span class="structure-node__icon"><Building2 v-if="data.type === 'organization'" :size="16" /><Network v-else :size="16" /></span>
                <span class="structure-node__copy"><strong>{{ data.label }}</strong></span><small v-if="data.type === 'project'">{{ data.meta }}</small>
              </span>
            </template>
          </el-tree>
        </div>
      </template>
      <nav v-if="session.user?.isPlatformAdmin" class="organization-navigation__maintenance organization-navigation__platform" aria-label="平台管理"><button type="button" :class="{ 'is-active': activePanel === 'platform' }" @click="emit('openPanel', 'platform')"><ShieldCheck :size="17" /><span>平台账号</span></button></nav>
      <div v-if="detail" class="organization-navigation__footer"><span><ShieldCheck :size="13" />统一角色授权</span><p>功能权限：角色定义可执行操作。<br>数据权限：授权限定资源范围。<br>MCP / Agent / Web 插件按资源授权。</p></div>
    </div>
    <button class="structure-tree-resizer" type="button" role="separator" aria-orientation="vertical" aria-label="调整组织导航宽度" :aria-valuemin="STRUCTURE_TREE_MIN" :aria-valuemax="STRUCTURE_TREE_MAX" :aria-valuenow="treeWidth" @pointerdown="startTreeResize" @keydown.left.prevent="nudgeTreeWidth(-20)" @keydown.right.prevent="nudgeTreeWidth(20)"><span></span></button>
  </aside>
</template>
<style scoped src="./organization-navigation.css"></style>
