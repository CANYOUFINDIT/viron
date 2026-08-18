<script setup lang="ts">import { translate as tr } from "../i18n";

import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  Download,
  Eye,
  FileText,
  Folder,
  FolderPlus,
  FolderRoot,
  ImagePlus,
  Link2,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCcw,
  Save,
  ShieldCheck,
  Tags,
  Trash2,
  Upload,
} from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { api, ApiError } from "../api";
import { copyTextToClipboard } from "../clipboard";
import { downloadApiFile } from "../desktop";
import { renderKnowledgeMarkdown } from "../knowledge-markdown";
import { session } from "../session";
import MarkdownEditor from "./MarkdownEditor.vue";

const props = defineProps<{ environmentId?: string }>();
const emit = defineEmits<{ countChange: [count: number] }>();

type KnowledgeNodeType = "folder" | "document";
type EditorMode = "edit" | "split" | "preview";
type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

interface KnowledgeNode {
  id: string;
  parentId: string | null;
  storageParentId: string | null;
  type: KnowledgeNodeType;
  name: string;
  revision: number;
  createdBy: { id: string; username: string } | null;
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
  canDelete: boolean;
  canManagePermissions: boolean;
  directEnvironmentIds: string[];
  effectiveEnvironmentIds: string[];
  isContextOnly: boolean;
}

interface KnowledgeEnvironment { id: string; name: string }
interface AssociationCandidate extends KnowledgeNode { path: string }

interface KnowledgeAsset {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
  dataUrl: string;
  createdAt: string;
}

interface KnowledgeResponse {
  items: KnowledgeNode[];
  environments: KnowledgeEnvironment[];
  canManage: boolean;
  canCreateDocument: boolean;
  canCreateRootFolder: boolean;
  imageLimitBytes: number;
  environmentRootId: string | null;
}

interface OrganizationDirectory {
  members: Array<{ id: string; username: string; role: "admin" | "member"; status: string }>;
  projects: Array<{ id: string; name: string; parentId: string | null }>;
}

interface KnowledgeGrant {
  id: string;
  granteeType: "user" | "project";
  granteeId: string;
  granteeName: string;
  createdAt: string;
}

const loading = ref(true);
const loadingDocument = ref(false);
const nodes = ref<KnowledgeNode[]>([]);
const environments = ref<KnowledgeEnvironment[]>([]);
const canManage = ref(false);
const canCreateRootFolder = ref(false);
const environmentRootId = ref<string | null>(null);
const imageLimitBytes = ref(30 * 1024 * 1024);
const expandedFolderIds = ref<Set<string>>(new Set());
const selectedNodeId = ref("");
const content = ref("");
const lastSavedContent = ref("");
const assets = ref<KnowledgeAsset[]>([]);
const editorMode = ref<EditorMode>("split");
const saveState = ref<SaveState>("saved");
const saveError = ref("");
const editor = ref<InstanceType<typeof MarkdownEditor> | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);
const importInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);
const uploadingImages = ref(false);
const draggingNodeId = ref("");
const dropFolderId = ref<string | null | undefined>(undefined);
const createDocumentDialog = ref(false);
const documentName = ref("");
const documentNameError = ref("");
const creatingDocument = ref(false);
const grantDialog = ref(false);
const grantLoading = ref(false);
const grants = ref<KnowledgeGrant[]>([]);
const organizationDirectory = ref<OrganizationDirectory | null>(null);
const grantType = ref<"user" | "project">("user");
const grantGranteeId = ref("");
const tagDialog = ref(false);
const tagSelection = ref<string[]>([]);
const tagSaving = ref(false);
const associationDialog = ref(false);
const associationLoading = ref(false);
const associationCandidates = ref<AssociationCandidate[]>([]);
const associationSelection = ref<string[]>([]);
const associationSearch = ref("");
let autoSaveTimer: number | undefined;
let savingPromise: Promise<boolean> | null = null;
let documentLoadVersion = 0;

const nodeById = computed(() => new Map(nodes.value.map((node) => [node.id, node])));
const selectedNode = computed(() => nodeById.value.get(selectedNodeId.value) ?? null);
const currentDocument = computed(() => selectedNode.value?.type === "document" ? selectedNode.value : null);
const dirty = computed(() => Boolean(currentDocument.value?.canEdit) && content.value !== lastSavedContent.value);
const assetDataUrls = computed(() => Object.fromEntries(assets.value.map((asset) => [asset.id, asset.dataUrl])));
const renderedContent = computed(() => renderKnowledgeMarkdown(content.value, assetDataUrls.value));
const documentCount = computed(() => nodes.value.filter((node) => node.type === "document").length);
const knowledgeBasePath = computed(() => props.environmentId ? `/api/v1/environments/${props.environmentId}/knowledge` : "/api/v1/knowledge");
const knowledgeNodesPath = computed(() => props.environmentId ? `/api/v1/environments/${props.environmentId}/knowledge/nodes` : "/api/v1/knowledge/nodes");
const knowledgeImportPath = computed(() => props.environmentId ? `/api/v1/environments/${props.environmentId}/knowledge/import` : "/api/v1/knowledge/import");
const knowledgeExportPath = computed(() => props.environmentId ? `/api/v1/environments/${props.environmentId}/knowledge/export` : "/api/v1/knowledge/export");
const environmentById = computed(() => new Map(environments.value.map((environment) => [environment.id, environment])));
const currentEnvironmentTags = computed(() => (currentDocument.value?.effectiveEnvironmentIds ?? [])
  .map((id) => environmentById.value.get(id))
  .filter((environment): environment is KnowledgeEnvironment => Boolean(environment)));
const filteredAssociationCandidates = computed(() => {
  const query = associationSearch.value.trim().toLocaleLowerCase();
  return query ? associationCandidates.value.filter((candidate) => candidate.path.toLocaleLowerCase().includes(query)) : associationCandidates.value;
});

const saveLabel = computed(() => ({
  saved: tr("已保存"),
  dirty: tr("等待自动保存"),
  saving: tr("保存中…"),
  error: tr("保存失败"),
  conflict: tr("保存冲突"),
}[saveState.value]));

const saveTone = computed(() => saveState.value === "error" || saveState.value === "conflict" ? "is-danger" : saveState.value === "saved" ? "is-saved" : "is-working");

const currentPath = computed(() => {
  const parts: string[] = [];
  let current = currentDocument.value;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    parts.unshift(current.name);
    visited.add(current.id);
    current = current.parentId ? nodeById.value.get(current.parentId) ?? null : null;
  }
  return parts;
});

const targetFolderId = computed(() => {
  if (selectedNode.value?.type === "folder") return selectedNode.value.id;
  return selectedNode.value?.parentId ?? environmentRootId.value;
});

const targetFolder = computed(() => targetFolderId.value ? nodeById.value.get(targetFolderId.value) ?? null : null);
const canCreateFolderHere = computed(() => targetFolder.value ? targetFolder.value.canEdit : canCreateRootFolder.value);
const grantCandidates = computed(() => {
  if (!organizationDirectory.value) return [];
  if (grantType.value === "user") {
    return organizationDirectory.value.members
      .filter((member) => member.role === "member" && member.status === "active")
      .map((member) => ({ id: member.id, name: member.username }));
  }
  return organizationDirectory.value.projects.map((project) => ({ id: project.id, name: project.name }));
});

interface FlatNode {
  node: KnowledgeNode;
  depth: number;
  isLast: boolean;
  continuationDepths: number[];
}
const flatNodes = computed<FlatNode[]>(() => {
  const children = new Map<string | null, KnowledgeNode[]>();
  for (const node of nodes.value) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  for (const siblings of children.values()) siblings.sort((left, right) => {
    if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
  });
  const result: FlatNode[] = [];
  const append = (parentId: string | null, depth: number, continuationDepths: number[]) => {
    const siblings = children.get(parentId) ?? [];
    siblings.forEach((node, index) => {
      const isLast = index === siblings.length - 1;
      result.push({ node, depth, isLast, continuationDepths });
      if (node.type === "folder" && expandedFolderIds.value.has(node.id)) {
        const childContinuations = depth > 0 && !isLast ? [...continuationDepths, depth] : continuationDepths;
        append(node.id, depth + 1, childContinuations);
      }
    });
  };
  append(null, 0, []);
  return result;
});

function folderDescendantCounts(folderId: string) {
  const ids = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes.value) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        changed = true;
      }
    }
  }
  return {
    folders: nodes.value.filter((node) => ids.has(node.id) && node.type === "folder").length,
    documents: nodes.value.filter((node) => ids.has(node.id) && node.type === "document").length,
  };
}

function expandAncestors(node: KnowledgeNode) {
  const expanded = new Set(expandedFolderIds.value);
  let parentId = node.parentId;
  while (parentId) {
    expanded.add(parentId);
    parentId = nodeById.value.get(parentId)?.parentId ?? null;
  }
  expandedFolderIds.value = expanded;
}

function toggleFolder(folderId: string) {
  const expanded = new Set(expandedFolderIds.value);
  if (expanded.has(folderId)) expanded.delete(folderId);
  else expanded.add(folderId);
  expandedFolderIds.value = expanded;
}

function scheduleAutoSave() {
  window.clearTimeout(autoSaveTimer);
  if (!dirty.value || saveState.value === "conflict") return;
  autoSaveTimer = window.setTimeout(() => { void saveNow(true); }, 1_000);
}

async function saveNow(silent = false): Promise<boolean> {
  window.clearTimeout(autoSaveTimer);
  if (!currentDocument.value?.canEdit || !dirty.value) {
    if (saveState.value !== "conflict" && saveState.value !== "error") saveState.value = "saved";
    return true;
  }
  if (savingPromise) {
    await savingPromise;
    if (!dirty.value) return saveState.value === "saved";
  }
  const document = currentDocument.value;
  const savingContent = content.value;
  const savingRevision = document.revision;
  saveState.value = "saving";
  saveError.value = "";
  savingPromise = (async () => {
    try {
      const response = await api<{ revision: number; updatedAt: string }>(`/api/v1/knowledge-documents/${document.id}/content`, {
        method: "PUT",
        body: JSON.stringify({ content: savingContent, revision: savingRevision }),
      });
      const latest = nodeById.value.get(document.id);
      if (latest) {
        latest.revision = response.revision;
        latest.updatedAt = response.updatedAt;
      }
      lastSavedContent.value = savingContent;
      if (content.value === savingContent) saveState.value = "saved";
      else {
        saveState.value = "dirty";
        scheduleAutoSave();
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === "KNOWLEDGE_CONFLICT") {
        saveState.value = "conflict";
        saveError.value = tr("远端文档已有新版本，本地内容尚未覆盖远端。");
      } else {
        saveState.value = "error";
        saveError.value = error instanceof Error ? error.message : tr("自动保存失败");
      }
      if (!silent) ElMessage.error(saveError.value);
      return false;
    } finally {
      savingPromise = null;
    }
  })();
  return savingPromise;
}

async function confirmLeaveUnsaved(): Promise<boolean> {
  if (!dirty.value) return true;
  if (await saveNow(true)) return true;
  try {
    await ElMessageBox.confirm(tr("当前文档尚未保存。离开会丢弃本地修改，是否继续？"), tr("未保存的修改"), {
      confirmButtonText: tr("丢弃并继续"),
      cancelButtonText: tr("留在当前文档"),
      type: "warning",
    });
    return true;
  } catch {
    return false;
  }
}

async function loadDocument(nodeId: string) {
  const version = ++documentLoadVersion;
  loadingDocument.value = true;
  try {
    const response = await api<{ item: KnowledgeNode & { content: string }; assets: KnowledgeAsset[] }>(`/api/v1/knowledge-documents/${nodeId}`);
    if (version !== documentLoadVersion) return;
    const treeNode = nodeById.value.get(nodeId);
    if (treeNode) {
      const visibleParentId = treeNode.parentId;
      Object.assign(treeNode, response.item, { parentId: visibleParentId });
    }
    content.value = response.item.content;
    lastSavedContent.value = response.item.content;
    assets.value = response.assets;
    saveState.value = "saved";
    saveError.value = "";
    if (!response.item.canEdit) editorMode.value = "preview";
    await nextTick();
    editor.value?.focus();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载文档失败"));
  } finally {
    if (version === documentLoadVersion) loadingDocument.value = false;
  }
}

async function selectNode(node: KnowledgeNode) {
  if (selectedNodeId.value === node.id) {
    if (node.type === "folder") toggleFolder(node.id);
    return;
  }
  if (!await confirmLeaveUnsaved()) return;
  selectedNodeId.value = node.id;
  expandAncestors(node);
  if (node.type === "folder") {
    toggleFolder(node.id);
    content.value = "";
    lastSavedContent.value = "";
    assets.value = [];
    return;
  }
  await loadDocument(node.id);
}

async function selectRoot() {
  if (!selectedNodeId.value || !await confirmLeaveUnsaved()) return;
  documentLoadVersion += 1;
  loadingDocument.value = false;
  selectedNodeId.value = "";
  content.value = "";
  lastSavedContent.value = "";
  assets.value = [];
  saveState.value = "saved";
  saveError.value = "";
}

async function loadKnowledge(preferredNodeId = selectedNodeId.value) {
  loading.value = true;
  try {
    const response = await api<KnowledgeResponse>(knowledgeBasePath.value);
    nodes.value = response.items;
    environments.value = response.environments;
    canManage.value = response.canManage;
    canCreateRootFolder.value = response.canCreateRootFolder;
    environmentRootId.value = response.environmentRootId;
    imageLimitBytes.value = response.imageLimitBytes;
    emit("countChange", documentCount.value);
    const preferred = nodes.value.find((node) => node.id === preferredNodeId);
    const next = preferred ?? nodes.value.find((node) => node.type === "document") ?? nodes.value[0];
    if (next) {
      selectedNodeId.value = next.id;
      expandAncestors(next);
      if (next.type === "document") await loadDocument(next.id);
    } else {
      selectedNodeId.value = "";
      content.value = "";
      lastSavedContent.value = "";
      assets.value = [];
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("加载知识库失败"));
  } finally {
    loading.value = false;
  }
}

async function promptName(title: string, initialValue: string, inputPlaceholder: string) {
  try {
    const result = await ElMessageBox.prompt(inputPlaceholder, title, {
      inputValue: initialValue,
      inputPattern: /^(?!\.{1,2}$)[^/\\\r\n\0]+$/,
      inputErrorMessage: tr("名称不能为空，也不能包含路径分隔符"),
      confirmButtonText: tr("确定"),
      cancelButtonText: tr("取消"),
    });
    return result.value.trim();
  } catch {
    return "";
  }
}

function createDocument() {
  documentName.value = "";
  documentNameError.value = "";
  createDocumentDialog.value = true;
}

async function submitCreateDocument() {
  if (creatingDocument.value) return;
  const name = documentName.value.trim();
  if (!name || /[/\\\r\n\0]/.test(name) || name === "." || name === "..") {
    documentNameError.value = tr("名称不能为空，也不能包含路径分隔符");
    return;
  }
  creatingDocument.value = true;
  try {
    const response = await api<{ id: string }>(knowledgeNodesPath.value, {
      method: "POST",
      body: JSON.stringify({ type: "document", name, parentId: targetFolderId.value }),
    });
    if (targetFolderId.value) expandedFolderIds.value = new Set(expandedFolderIds.value).add(targetFolderId.value);
    await loadKnowledge(response.id);
    editorMode.value = "split";
    createDocumentDialog.value = false;
    ElMessage.success(tr("文档已创建"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("创建文档失败"));
  } finally {
    creatingDocument.value = false;
  }
}

async function createFolder() {
  if (!canCreateFolderHere.value) return ElMessage.warning(tr("你没有在此位置创建文件夹的权限"));
  const name = await promptName(tr("新建文件夹"), "", tr("输入文件夹名称"));
  if (!name) return;
  try {
    const response = await api<{ id: string }>(knowledgeNodesPath.value, {
      method: "POST",
      body: JSON.stringify({ type: "folder", name, parentId: targetFolderId.value }),
    });
    if (targetFolderId.value) expandedFolderIds.value = new Set(expandedFolderIds.value).add(targetFolderId.value);
    await loadKnowledge(response.id);
    ElMessage.success(tr("文件夹已创建"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("创建文件夹失败"));
  }
}

async function renameNode(node: KnowledgeNode) {
  if (node.id === currentDocument.value?.id && !await saveNow()) return;
  const name = await promptName(node.type === "folder" ? tr("重命名文件夹") : tr("重命名文档"), node.name, tr("输入新名称"));
  if (!name || name === node.name) return;
  try {
    const response = await api<{ name: string; revision: number; updatedAt: string }>(`/api/v1/knowledge-nodes/${node.id}`, {
      method: "PUT",
      body: JSON.stringify({ name, parentId: node.storageParentId }),
    });
    node.name = response.name;
    node.revision = response.revision;
    node.updatedAt = response.updatedAt;
    ElMessage.success(tr("名称已更新"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("重命名失败"));
  }
}

async function deleteNode(node: KnowledgeNode) {
  if (node.id === currentDocument.value?.id && !await saveNow()) return;
  const counts = node.type === "folder" ? folderDescendantCounts(node.id) : { folders: 0, documents: 1 };
  const description = node.type === "folder"
    ? tr("将递归删除 {0} 个文件夹、{1} 篇文档及其图片，操作不可恢复。", [counts.folders, counts.documents])
    : tr("文档及其图片将被删除，操作不可恢复。");
  try {
    await ElMessageBox.confirm(description, tr("删除“{0}”？", [node.name]), { confirmButtonText: tr("删除"), cancelButtonText: tr("取消"), type: "warning" });
    await api(`/api/v1/knowledge-nodes/${node.id}`, { method: "DELETE" });
    const nextSelected = node.parentId ?? "";
    await loadKnowledge(nextSelected);
    ElMessage.success(tr("已删除"));
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof Error ? error.message : tr("删除失败"));
  }
}

function startNodeDrag(node: KnowledgeNode, event: DragEvent) {
  if (!node.canEdit) return event.preventDefault();
  draggingNodeId.value = node.id;
  event.dataTransfer?.setData("text/plain", `knowledge-node:${node.id}`);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function allowDrop(parentId: string | null, event: DragEvent) {
  if (!draggingNodeId.value || draggingNodeId.value === parentId) return;
  event.preventDefault();
  dropFolderId.value = parentId;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

async function moveDraggedNode(parentId: string | null, event: DragEvent) {
  event.preventDefault();
  const node = nodeById.value.get(draggingNodeId.value);
  draggingNodeId.value = "";
  dropFolderId.value = undefined;
  if (!node || node.parentId === parentId) return;
  if (node.id === currentDocument.value?.id && !await saveNow()) return;
  const storageParentId = parentId ?? environmentRootId.value;
  try {
    const response = await api<{ revision: number; updatedAt: string }>(`/api/v1/knowledge-nodes/${node.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: node.name, parentId: storageParentId }),
    });
    node.parentId = parentId;
    node.storageParentId = storageParentId;
    node.revision = response.revision;
    node.updatedAt = response.updatedAt;
    if (parentId) expandedFolderIds.value = new Set(expandedFolderIds.value).add(parentId);
    ElMessage.success(tr("已移动"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("移动失败"));
  }
}

function finishNodeDrag() {
  draggingNodeId.value = "";
  dropFolderId.value = undefined;
}

async function uploadImageFiles(files: File[]) {
  if (!currentDocument.value?.canEdit || !files.length) return;
  uploadingImages.value = true;
  try {
    for (const file of files) {
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) {
        ElMessage.error(tr("{0} 不是受支持的图片格式", [file.name]));
        continue;
      }
      if (file.size > imageLimitBytes.value) {
        ElMessage.error(tr("{0} 超过 30 MB", [file.name]));
        continue;
      }
      const form = new FormData();
      form.append("file", file);
      const response = await api<{ asset: KnowledgeAsset; markdown: string }>(`/api/v1/knowledge-documents/${currentDocument.value.id}/assets`, { method: "POST", body: form });
      assets.value.push(response.asset);
      editor.value?.insertText(`${response.markdown}\n`);
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("图片上传失败"));
  } finally {
    uploadingImages.value = false;
    if (imageInput.value) imageInput.value.value = "";
  }
}

function selectImages(event: Event) {
  const files = [...((event.target as HTMLInputElement).files ?? [])];
  void uploadImageFiles(files);
}

async function importKnowledge(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  importing.value = true;
  try {
    const form = new FormData();
    form.append("parentId", targetFolderId.value ?? "");
    form.append("file", file);
    const response = await api<{ firstDocumentId: string; documents: number; folders: number }>(knowledgeImportPath.value, { method: "POST", body: form });
    await loadKnowledge(response.firstDocumentId);
    ElMessage.success(tr("已导入 {0} 篇文档{1}", [response.documents, response.folders ? tr("、{{0}} 个文件夹", [response.folders]) : ""]));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("导入失败"));
  } finally {
    importing.value = false;
    if (importInput.value) importInput.value.value = "";
  }
}

async function exportSelection() {
  try {
    const path = selectedNode.value
      ? `/api/v1/knowledge-nodes/${selectedNode.value.id}/export`
      : knowledgeExportPath.value;
    await downloadApiFile(path, selectedNode.value?.type === "document" ? selectedNode.value.name : undefined);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("导出失败"));
  }
}

async function exportAll() {
  try { await downloadApiFile(knowledgeExportPath.value); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : tr("导出失败")); }
}

function handleExportCommand(command: string) {
  if (command === "selection") void exportSelection();
  else if (command === "all") void exportAll();
}

async function reloadRemoteDocument() {
  if (!currentDocument.value) return;
  await loadDocument(currentDocument.value.id);
  ElMessage.success(tr("已加载远端版本"));
}

async function copyLocalContent() {
  try {
    await copyTextToClipboard(content.value);
    ElMessage.success(tr("本地内容已复制"));
  } catch {
    ElMessage.error(tr("复制失败"));
  }
}

function openTagDialog(node: KnowledgeNode) {
  if (!node.canEdit) return;
  selectedNodeId.value = node.id;
  tagSelection.value = [...node.directEnvironmentIds];
  tagDialog.value = true;
}

async function saveEnvironmentTags() {
  if (!selectedNode.value?.canEdit) return;
  const previous = new Set(selectedNode.value.directEnvironmentIds);
  const next = new Set(tagSelection.value);
  const add = [...next].filter((id) => !previous.has(id));
  const remove = [...previous].filter((id) => !next.has(id));
  if (!add.length && !remove.length) {
    tagDialog.value = false;
    return;
  }
  tagSaving.value = true;
  try {
    await api(`/api/v1/knowledge-nodes/${selectedNode.value.id}/environments`, {
      method: "PATCH",
      body: JSON.stringify({ add, remove }),
    });
    const nodeId = selectedNode.value.id;
    tagDialog.value = false;
    await loadKnowledge(nodeId);
    ElMessage.success(tr("环境标签已更新"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("更新环境标签失败"));
  } finally {
    tagSaving.value = false;
  }
}

async function openAssociationDialog() {
  if (!props.environmentId) return;
  associationDialog.value = true;
  associationLoading.value = true;
  associationSelection.value = [];
  associationSearch.value = "";
  try {
    associationCandidates.value = (await api<{ items: AssociationCandidate[] }>(`/api/v1/environments/${props.environmentId}/knowledge/association-candidates`)).items;
  } catch (error) {
    associationDialog.value = false;
    ElMessage.error(error instanceof Error ? error.message : tr("读取可关联文档失败"));
  } finally {
    associationLoading.value = false;
  }
}

async function associateDocuments() {
  if (!props.environmentId || !associationSelection.value.length) return;
  associationLoading.value = true;
  try {
    const response = await api<{ associated: number }>(`/api/v1/environments/${props.environmentId}/knowledge/associations`, {
      method: "POST",
      body: JSON.stringify({ nodeIds: associationSelection.value }),
    });
    const firstNodeId = associationSelection.value[0];
    associationDialog.value = false;
    await loadKnowledge(firstNodeId);
    ElMessage.success(tr("已关联 {0} 篇文档", [response.associated]));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("关联文档失败"));
  } finally {
    associationLoading.value = false;
  }
}

async function openGrantDialog(node: KnowledgeNode) {
  if (!node.canManagePermissions || session.workspace?.type !== "organization") return;
  grantDialog.value = true;
  grantLoading.value = true;
  grantGranteeId.value = "";
  try {
    const [grantResponse, directory] = await Promise.all([
      api<{ items: KnowledgeGrant[] }>(`/api/v1/knowledge-nodes/${node.id}/grants`),
      organizationDirectory.value
        ? Promise.resolve(organizationDirectory.value)
        : api<OrganizationDirectory>(`/api/v1/organizations/${session.workspace.id}`),
    ]);
    grants.value = grantResponse.items;
    organizationDirectory.value = directory;
  } catch (error) {
    grantDialog.value = false;
    ElMessage.error(error instanceof Error ? error.message : tr("加载授权失败"));
  } finally {
    grantLoading.value = false;
  }
}

async function addGrant() {
  if (!selectedNode.value || !grantGranteeId.value) return;
  grantLoading.value = true;
  try {
    await api(`/api/v1/knowledge-nodes/${selectedNode.value.id}/grants`, {
      method: "POST",
      body: JSON.stringify({ granteeType: grantType.value, granteeId: grantGranteeId.value }),
    });
    grants.value = (await api<{ items: KnowledgeGrant[] }>(`/api/v1/knowledge-nodes/${selectedNode.value.id}/grants`)).items;
    grantGranteeId.value = "";
    ElMessage.success(tr("编辑权限已分配"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("授权失败"));
  } finally {
    grantLoading.value = false;
  }
}

async function removeGrant(grant: KnowledgeGrant) {
  grantLoading.value = true;
  try {
    await api(`/api/v1/knowledge-grants/${grant.id}`, { method: "DELETE" });
    grants.value = grants.value.filter((item) => item.id !== grant.id);
    ElMessage.success(tr("编辑权限已撤销"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : tr("撤销授权失败"));
  } finally {
    grantLoading.value = false;
  }
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value) return;
  event.preventDefault();
  event.returnValue = "";
}

watch(content, () => {
  if (loadingDocument.value || !currentDocument.value?.canEdit) return;
  if (dirty.value) {
    if (saveState.value !== "conflict") saveState.value = "dirty";
    scheduleAutoSave();
  } else if (saveState.value !== "saving") saveState.value = "saved";
});

watch(grantType, () => { grantGranteeId.value = ""; });
watch(() => props.environmentId, () => { void loadKnowledge(""); });

onMounted(() => {
  window.addEventListener("beforeunload", beforeUnload);
  void loadKnowledge();
});
onActivated(() => { if (!nodes.value.length) void loadKnowledge(); });
onDeactivated(() => { void saveNow(true); });
onBeforeUnmount(() => {
  window.clearTimeout(autoSaveTimer);
  window.removeEventListener("beforeunload", beforeUnload);
  void saveNow(true);
});
</script>

<template>
  <section class="knowledge-base-panel" :class="{ 'is-loading': loading }">
    <aside class="knowledge-sidebar">
      <header class="knowledge-sidebar__header">
        <div>
          <span class="knowledge-kicker">{{ environmentId ? 'ENVIRONMENT KNOWLEDGE' : 'WORKSPACE KNOWLEDGE' }}</span>
          <strong><BookOpen :size="17" />{{ $t('知识库') }}</strong>
        </div>
        <em>{{ documentCount }}</em>
      </header>

      <div
        class="knowledge-root-drop"
        :class="{ 'is-drop-target': dropFolderId === null }"
        @dragover="allowDrop(null, $event)"
        @drop="moveDraggedNode(null, $event)"
      >
        <div class="knowledge-tree-actions" :class="{ 'has-associate': environmentId }">
          <button type="button" :title="$t('新建文档')" :aria-label="$t('新建文档')" @click="createDocument"><Plus :size="16" /></button>
          <button type="button" :title="$t('新建文件夹')" :aria-label="$t('新建文件夹')" :disabled="!canCreateFolderHere" @click="createFolder"><FolderPlus :size="16" /></button>
          <button v-if="environmentId" type="button" :title="$t('关联文档')" :aria-label="$t('关联文档')" @click="openAssociationDialog"><Link2 :size="16" /></button>
          <button type="button" :title="$t('导入 Markdown 或 ZIP')" :aria-label="$t('导入 Markdown 或 ZIP')" :disabled="importing" @click="importInput?.click()"><Upload :size="16" /></button>
          <el-dropdown class="knowledge-export-menu" trigger="click" @command="handleExportCommand">
            <button type="button" :title="$t('导出')" :aria-label="$t('导出')"><Download :size="16" /></button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="selection" :disabled="!selectedNode">{{ $t('导出所选') }}</el-dropdown-item>
                <el-dropdown-item command="all">{{ $t('导出整个知识库') }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
        <input ref="importInput" class="visually-hidden" type="file" accept=".md,.zip,text/markdown,application/zip" @change="importKnowledge" />
      </div>

      <div v-if="loading" class="knowledge-tree-empty"><span class="knowledge-spinner"></span>{{ $t('正在读取知识库…') }}</div>
      <div v-else-if="!nodes.length" class="knowledge-tree-empty">
        <BookOpen :size="28" />
        <strong>{{ $t('还没有文档') }}</strong>
        <span>{{ $t('创建第一篇 Markdown 运行手册') }}</span>
        <button type="button" @click="createDocument"><Plus :size="15" />{{ $t('新建文档') }}</button>
      </div>
      <div v-else class="knowledge-tree" role="tree" :aria-label="$t('知识库目录')">
        <button
          class="knowledge-root-node"
          :class="{ 'is-selected': !selectedNodeId, 'is-drop-target': dropFolderId === null }"
          type="button"
          role="treeitem"
          :aria-selected="!selectedNodeId"
          @click="selectRoot"
          @dragover="allowDrop(null, $event)"
          @drop="moveDraggedNode(null, $event)"
        >
          <FolderRoot :size="16" />
          <span>{{ $t('知识库根目录') }}</span>
          <small>{{ $t('新建内容将保存在这里') }}</small>
        </button>
        <article
          v-for="item in flatNodes"
          :key="item.node.id"
          class="knowledge-tree-row"
          :class="{
            'is-selected': selectedNodeId === item.node.id,
            'is-dragging': draggingNodeId === item.node.id,
            'is-drop-target': item.node.type === 'folder' && dropFolderId === item.node.id,
            'is-context-only': item.node.isContextOnly,
          }"
          :style="{ '--tree-indent': `${item.depth * 15}px` }"
          role="treeitem"
          :aria-selected="selectedNodeId === item.node.id"
          :draggable="item.node.canEdit"
          @click="selectNode(item.node)"
          @dragstart="startNodeDrag(item.node, $event)"
          @dragend="finishNodeDrag"
          @dragover="item.node.type === 'folder' && allowDrop(item.node.id, $event)"
          @drop="item.node.type === 'folder' && moveDraggedNode(item.node.id, $event)"
        >
          <span v-if="item.depth" class="knowledge-tree-row__branches" aria-hidden="true">
            <i
              v-for="depth in item.continuationDepths"
              :key="`continuation:${depth}`"
              class="is-continuation"
              :style="{ '--branch-left': `${12 + (depth - 1) * 15}px` }"
            ></i>
            <i class="is-current" :class="{ 'is-last': item.isLast }" :style="{ '--branch-left': `${12 + (item.depth - 1) * 15}px` }"></i>
            <i class="is-elbow" :style="{ '--branch-left': `${12 + (item.depth - 1) * 15}px` }"></i>
          </span>
          <button
            v-if="item.node.type === 'folder'"
            class="knowledge-tree-row__toggle"
            type="button"
            :aria-label="expandedFolderIds.has(item.node.id) ? $t('折叠文件夹') : $t('展开文件夹')"
            @click.stop="toggleFolder(item.node.id)"
          ><ChevronDown v-if="expandedFolderIds.has(item.node.id)" :size="13" /><ChevronRight v-else :size="13" /></button>
          <span v-else class="knowledge-tree-row__spacer"></span>
          <Folder v-if="item.node.type === 'folder'" class="is-folder" :size="16" />
          <FileText v-else :size="16" />
          <span class="knowledge-tree-row__name" :title="item.node.name">{{ item.node.name }}</span>
          <span v-if="item.node.type === 'document' && item.node.createdBy?.id === session.user?.id" class="knowledge-owner-dot" :title="$t('我创建的文档')"></span>
          <div v-if="selectedNodeId === item.node.id" class="knowledge-tree-row__actions">
            <button v-if="item.node.canManagePermissions" type="button" :title="$t('编辑权限')" :aria-label="$t('编辑权限')" @click.stop="openGrantDialog(item.node)"><ShieldCheck :size="13" /></button>
            <button v-if="item.node.canEdit" type="button" :title="$t('环境标签')" :aria-label="$t('环境标签')" @click.stop="openTagDialog(item.node)"><Tags :size="13" /></button>
            <button v-if="item.node.canEdit" type="button" :title="$t('重命名')" :aria-label="$t('重命名')" @click.stop="renameNode(item.node)"><Pencil :size="13" /></button>
            <button v-if="item.node.canDelete" class="is-danger" type="button" :title="$t('删除')" :aria-label="$t('删除')" @click.stop="deleteNode(item.node)"><Trash2 :size="13" /></button>
          </div>
          <span v-else-if="!item.node.canEdit" class="knowledge-readonly" :title="$t('只读')">{{ $t('只读') }}</span>
        </article>
      </div>

      <footer class="knowledge-sidebar__footer">
        <span>{{ $t('拖到文件夹可移动分类') }}</span>
      </footer>
    </aside>

    <main class="knowledge-workspace">
      <template v-if="currentDocument">
        <header class="knowledge-toolbar">
          <div class="knowledge-document-identity">
            <div class="knowledge-breadcrumbs" :title="currentPath.join(' / ')">
              <template v-for="(part, index) in currentPath" :key="`${part}:${index}`">
                <span v-if="index">/</span><strong>{{ part }}</strong>
              </template>
            </div>
            <small>
              {{ currentDocument.createdBy?.username || $t('未知创建者') }} {{ $t('创建') }} <span>·</span>
              {{ new Date(currentDocument.updatedAt).toLocaleString($locale()) }} {{ $t('更新') }} </small>
            <div v-if="currentEnvironmentTags.length" class="knowledge-environment-tags">
              <span v-for="environment in currentEnvironmentTags" :key="environment.id">{{ environment.name }}</span>
            </div>
          </div>

          <div class="knowledge-toolbar__center">
            <div class="knowledge-mode-switch" :aria-label="$t('编辑器显示模式')">
              <button type="button" :class="{ 'is-active': editorMode === 'edit' }" :disabled="!currentDocument.canEdit" :title="$t('编辑')" @click="editorMode = 'edit'"><PanelLeft :size="15" /><span>{{ $t('编辑') }}</span></button>
              <button type="button" :class="{ 'is-active': editorMode === 'split' }" :disabled="!currentDocument.canEdit" :title="$t('分栏')" @click="editorMode = 'split'"><Columns2 :size="15" /><span>{{ $t('分栏') }}</span></button>
              <button type="button" :class="{ 'is-active': editorMode === 'preview' }" :title="$t('预览')" @click="editorMode = 'preview'"><Eye :size="15" /><span>{{ $t('预览') }}</span></button>
            </div>
          </div>

          <div class="knowledge-toolbar__actions">
            <input ref="imageInput" class="visually-hidden" type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" @change="selectImages" />
            <button v-if="currentDocument.canEdit" type="button" :title="$t('插入图片，单图不超过 30 MB')" :disabled="uploadingImages" @click="imageInput?.click()"><ImagePlus :size="16" /></button>
            <button v-if="currentDocument.canEdit" class="knowledge-save-button" type="button" :disabled="saveState === 'saving' || !dirty" @click="saveNow(false)"><Save :size="15" />{{ $t('保存') }}</button>
          </div>
        </header>

        <div v-if="saveState === 'conflict' || saveState === 'error'" class="knowledge-save-alert" :class="{ 'is-conflict': saveState === 'conflict' }">
          <span>{{ saveError }}</span>
          <div>
            <button v-if="saveState === 'conflict'" type="button" @click="copyLocalContent"><Copy :size="13" />{{ $t('复制本地内容') }}</button>
            <button v-if="saveState === 'conflict'" type="button" @click="reloadRemoteDocument"><RefreshCcw :size="13" />{{ $t('加载远端版本') }}</button>
            <button v-else type="button" @click="saveNow(false)"><RefreshCcw :size="13" />{{ $t('重试保存') }}</button>
          </div>
        </div>

        <div class="knowledge-editor-stage" :class="`is-${editorMode}`">
          <section v-if="editorMode !== 'preview'" class="knowledge-editor-pane" :aria-label="$t('Markdown 编辑器')">
            <div v-if="loadingDocument" class="knowledge-pane-loading"><span class="knowledge-spinner"></span>{{ $t('正在载入文档…') }}</div>
            <MarkdownEditor
              v-else
              ref="editor"
              v-model="content"
              :readonly="!currentDocument.canEdit"
              @save="saveNow(false)"
              @image-files="uploadImageFiles"
            />
          </section>
          <section v-if="editorMode !== 'edit'" class="knowledge-preview-pane" :aria-label="$t('Markdown 预览')">
            <article v-if="content.trim()" class="knowledge-markdown" v-html="renderedContent"></article>
            <div v-else class="knowledge-preview-empty"><FileText :size="28" /><strong>{{ $t('空白文档') }}</strong><span v-if="currentDocument.canEdit">{{ $t('从左侧开始编写 Markdown') }}</span></div>
          </section>
        </div>

        <footer class="knowledge-statusbar">
          <span class="knowledge-save-state" :class="saveTone"><i></i>{{ saveLabel }}</span>
          <span v-if="!currentDocument.canEdit"><ShieldCheck :size="13" />{{ $t('只读文档') }}</span>
          <span v-else>{{ $t('停止输入 1 秒后自动保存') }}</span>
          <span>{{ content.length.toLocaleString($locale()) }} {{ $t('字符') }}</span>
          <span>{{ assets.length }} {{ $t('张图片') }}</span>
        </footer>
      </template>

      <div v-else-if="selectedNode?.type === 'folder'" class="knowledge-folder-overview">
        <span class="knowledge-folder-illustration"><Folder :size="38" /></span>
        <span class="knowledge-kicker">KNOWLEDGE FOLDER</span>
        <h3>{{ selectedNode.name }}</h3>
        <p>{{ $t('在此文件夹中创建文档，或把现有文档拖到这里完成分类。') }}</p>
        <div>
          <button type="button" @click="createDocument"><Plus :size="16" />{{ $t('新建文档') }}</button>
          <button type="button" :disabled="!canCreateFolderHere" @click="createFolder"><FolderPlus :size="16" />{{ $t('新建子文件夹') }}</button>
          <button type="button" @click="importInput?.click()"><Upload :size="16" />{{ $t('导入') }}</button>
        </div>
      </div>

      <div v-else class="knowledge-folder-overview is-empty">
        <span class="knowledge-folder-illustration"><BookOpen :size="38" /></span>
        <span class="knowledge-kicker">{{ environmentId ? 'ENVIRONMENT KNOWLEDGE' : 'WORKSPACE KNOWLEDGE' }}</span>
        <h3>{{ nodes.length ? $t('知识库根目录') : environmentId ? $t('建立环境知识库') : $t('建立工作区知识库') }}</h3>
        <p>{{ nodes.length ? $t('当前已回到根目录，新建的文档、文件夹和导入内容不会放入任何现有文件夹。') : environmentId ? $t('集中记录部署步骤、故障处理、架构说明和交接信息。') : $t('集中管理工作区内的文档，并通过环境标签按需分发。') }}</p>
        <div>
          <button type="button" @click="createDocument"><Plus :size="16" />{{ nodes.length ? $t('新建文档') : $t('创建第一篇文档') }}</button>
          <button v-if="nodes.length" type="button" :disabled="!canCreateFolderHere" @click="createFolder"><FolderPlus :size="16" />{{ $t('新建文件夹') }}</button>
          <button v-if="nodes.length" type="button" @click="importInput?.click()"><Upload :size="16" />{{ $t('导入') }}</button>
        </div>
      </div>
    </main>

    <el-dialog
      v-model="createDocumentDialog"
      align-center
      class="envman-dialog knowledge-create-document-dialog"
      :title="$t('新建 Markdown 文档')"
      width="440px"
      :close-on-click-modal="!creatingDocument"
      :close-on-press-escape="!creatingDocument"
      :show-close="!creatingDocument"
    >
      <el-input
        v-model="documentName"
        class="knowledge-document-name-input"
        :placeholder="$t('文档名称')"
        :aria-label="$t('文档名称，扩展名固定为 .md')"
        maxlength="157"
        @input="documentNameError = ''"
        @keyup.enter="submitCreateDocument"
      >
        <template #suffix><span class="knowledge-document-name-suffix">.md</span></template>
      </el-input>
      <div v-if="documentNameError" class="knowledge-document-name-error">{{ documentNameError }}</div>
      <template #footer>
        <el-button :disabled="creatingDocument" @click="createDocumentDialog = false">{{ $t('取消') }}</el-button>
        <el-button type="primary" :loading="creatingDocument" @click="submitCreateDocument">{{ $t('创建') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="tagDialog" align-center class="envman-dialog knowledge-tag-dialog" :title="$t('环境标签 · {0}', [selectedNode?.name || ''])" width="520px">
      <p class="knowledge-grant-note"><Tags :size="17" />{{ $t('文件夹的环境标签会自动覆盖所有后代；文档可以同时关联多个环境。') }}</p>
      <el-select v-model="tagSelection" multiple filterable clearable collapse-tags :placeholder="$t('选择环境')" style="width: 100%">
        <el-option v-for="environment in environments" :key="environment.id" :label="environment.name" :value="environment.id" />
      </el-select>
      <template #footer>
        <el-button :disabled="tagSaving" @click="tagDialog = false">{{ $t('取消') }}</el-button>
        <el-button type="primary" :loading="tagSaving" @click="saveEnvironmentTags">{{ $t('保存') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="associationDialog" align-center class="envman-dialog knowledge-association-dialog" :title="$t('关联文档')" width="640px">
      <div v-loading="associationLoading" class="knowledge-association-content">
        <p class="knowledge-grant-note"><Link2 :size="17" />{{ $t('将可编辑的工作区文档关联到当前环境；已通过文件夹标签展示的文档不会重复出现。') }}</p>
        <el-input v-model="associationSearch" clearable :placeholder="$t('搜索文档或文件夹路径')" />
        <el-checkbox-group v-model="associationSelection" class="knowledge-association-list">
          <el-checkbox v-for="candidate in filteredAssociationCandidates" :key="candidate.id" :value="candidate.id">
            <span><FileText :size="15" /><strong>{{ candidate.name }}</strong><small>{{ candidate.path }}</small></span>
          </el-checkbox>
        </el-checkbox-group>
        <div v-if="!associationLoading && !filteredAssociationCandidates.length" class="knowledge-grant-empty">{{ $t('没有可关联的文档') }}</div>
      </div>
      <template #footer>
        <el-button :disabled="associationLoading" @click="associationDialog = false">{{ $t('取消') }}</el-button>
        <el-button type="primary" :loading="associationLoading" :disabled="!associationSelection.length" @click="associateDocuments">{{ $t('关联所选文档') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="grantDialog" align-center class="envman-dialog knowledge-grant-dialog" :title="$t('编辑权限 · {0}', [selectedNode?.name || ''])" width="620px">
      <div v-loading="grantLoading" class="knowledge-grant-content">
        <p class="knowledge-grant-note"><ShieldCheck :size="17" />{{ $t('组织管理员始终拥有全部权限；文件夹授权自动覆盖当前和未来的所有子文件夹及文档。') }}</p>
        <div class="knowledge-grant-form">
          <el-segmented v-model="grantType" :options="[{ label: $t('组织成员'), value: 'user' }, { label: $t('项目组'), value: 'project' }]" />
          <el-select v-model="grantGranteeId" filterable clearable :placeholder="grantType === 'user' ? $t('选择普通成员') : $t('选择项目组')">
            <el-option v-for="candidate in grantCandidates" :key="candidate.id" :label="candidate.name" :value="candidate.id" />
          </el-select>
          <el-button type="primary" :disabled="!grantGranteeId" @click="addGrant">{{ $t('授予编辑权') }}</el-button>
        </div>
        <div class="knowledge-grant-list">
          <article v-for="grant in grants" :key="grant.id">
            <span><ShieldCheck :size="15" /><strong>{{ grant.granteeName }}</strong><small>{{ grant.granteeType === 'user' ? $t('组织成员') : $t('项目组') }}</small></span>
            <button type="button" @click="removeGrant(grant)">{{ $t('撤销') }}</button>
          </article>
          <div v-if="!grants.length" class="knowledge-grant-empty">{{ $t('当前节点没有直接编辑授权') }}</div>
        </div>
      </div>
      <template #footer><el-button @click="grantDialog = false">{{ $t('完成') }}</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.knowledge-base-panel {
  --knowledge-sidebar-width: 268px;
  width: 100%; height: 100%; min-height: 0;
  border: 1px solid var(--ink-100); border-radius: 12px; background: var(--surface);
  box-shadow: var(--shadow-sm); display: grid; grid-template-columns: var(--knowledge-sidebar-width) minmax(0, 1fr); overflow: hidden;
}
.knowledge-sidebar { min-width: 0; min-height: 0; border-right: 1px solid var(--ink-100); background: color-mix(in srgb, var(--ink-50) 54%, var(--surface)); display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; }
.knowledge-sidebar__header { min-height: 74px; padding: 15px 16px 13px; border-bottom: 1px solid var(--ink-100); background: linear-gradient(145deg, color-mix(in srgb, var(--teal-50) 60%, var(--surface)), var(--surface)); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.knowledge-kicker { color: var(--teal-600); font-family: var(--font-mono); font-size: 9px; font-weight: 800; letter-spacing: .14em; }
.knowledge-sidebar__header strong { margin-top: 7px; color: var(--ink-800); display: flex; align-items: center; gap: 8px; font-size: 15px; }
.knowledge-sidebar__header em { min-width: 27px; height: 24px; padding: 0 7px; border-radius: 12px; background: var(--teal-100); color: var(--teal-700); display: grid; place-items: center; font-size: 11px; font-style: normal; font-weight: 800; }
.knowledge-root-drop { padding: 10px 12px; border-bottom: 1px solid var(--ink-100); transition: background .14s ease; }
.knowledge-root-drop.is-drop-target { background: var(--teal-50); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--teal-500) 58%, var(--ink-100)); }
.knowledge-tree-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.knowledge-tree-actions.has-associate { grid-template-columns: repeat(5, 1fr); }
.knowledge-tree-actions .knowledge-export-menu, .knowledge-tree-actions .knowledge-export-menu > button { width: 100%; }
.knowledge-tree-actions button, .knowledge-toolbar__actions button, .knowledge-mode-switch button, .knowledge-sidebar__footer button, .knowledge-folder-overview button, .knowledge-save-alert button { border: 1px solid var(--ink-100); border-radius: 7px; background: var(--surface); color: var(--ink-600); display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; }
.knowledge-tree-actions button { height: 31px; }
button:disabled { opacity: .42; cursor: not-allowed; }
.knowledge-tree-actions button:hover:not(:disabled), .knowledge-toolbar__actions button:hover:not(:disabled), .knowledge-mode-switch button:hover:not(:disabled) { border-color: color-mix(in srgb, var(--teal-500) 58%, var(--ink-100)); color: var(--teal-700); }
.knowledge-tree { min-height: 0; padding: 8px; overflow: auto; scrollbar-width: thin; scrollbar-color: var(--ink-200) transparent; }
.knowledge-root-node { width: 100%; min-height: 38px; margin-bottom: 6px; padding: 0 7px; border: 1px dashed var(--ink-200); border-radius: 7px; background: color-mix(in srgb, var(--surface) 74%, var(--ink-50)); color: var(--ink-500); display: grid; grid-template-columns: 18px minmax(0, 1fr); grid-template-rows: auto auto; align-items: center; column-gap: 7px; text-align: left; cursor: pointer; }
.knowledge-root-node svg { grid-row: 1 / 3; color: var(--teal-600); }
.knowledge-root-node span, .knowledge-root-node small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.knowledge-root-node span { align-self: end; color: var(--ink-700); font-size: 10px; font-weight: 750; }
.knowledge-root-node small { align-self: start; color: var(--ink-400); font-size: 8px; }
.knowledge-root-node:hover, .knowledge-root-node.is-drop-target { border-color: var(--teal-500); background: var(--teal-50); }
.knowledge-root-node.is-selected { border-style: solid; border-color: color-mix(in srgb, var(--teal-500) 54%, var(--ink-100)); background: var(--teal-50); }
.knowledge-tree-row { position: relative; min-width: 0; min-height: 35px; margin: 1px 0; padding: 0 6px 0 calc(5px + var(--tree-indent)); border: 1px solid transparent; border-radius: 7px; color: var(--ink-600); display: grid; grid-template-columns: 16px 17px minmax(0, 1fr) auto auto; align-items: center; gap: 5px; cursor: pointer; }
.knowledge-tree-row__branches { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.knowledge-tree-row__branches i { position: absolute; left: var(--branch-left); width: 1px; border-left: 1px solid var(--ink-200); }
.knowledge-tree-row__branches .is-continuation { top: -2px; bottom: -2px; }
.knowledge-tree-row__branches .is-current { top: -19px; bottom: -2px; }
.knowledge-tree-row__branches .is-current.is-last { bottom: 50%; }
.knowledge-tree-row__branches .is-elbow { top: 50%; width: 8px; border-top: 1px solid var(--ink-200); border-left: 0; }
.knowledge-tree-row:hover { background: var(--ink-50); color: var(--ink-800); }
.knowledge-tree-row.is-selected { border-color: color-mix(in srgb, var(--teal-500) 54%, var(--ink-100)); background: var(--teal-50); color: var(--teal-700); }
.knowledge-tree-row.is-dragging { opacity: .45; }
.knowledge-tree-row.is-drop-target { border-color: var(--teal-500); background: var(--teal-100); }
.knowledge-tree-row.is-context-only { color: var(--ink-400); }
.knowledge-tree-row.is-context-only .knowledge-tree-row__name { font-style: italic; font-weight: 600; }
.knowledge-tree-row__toggle { position: relative; z-index: 1; width: 18px; height: 24px; padding: 0; border: 0; background: transparent; color: inherit; display: grid; place-items: center; cursor: pointer; }
.knowledge-tree-row__spacer { width: 16px; }
.knowledge-tree-row > svg { position: relative; z-index: 1; }
.knowledge-tree-row > svg.is-folder { color: var(--amber-600); fill: color-mix(in srgb, var(--amber-100) 70%, transparent); }
.knowledge-tree-row__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 680; }
.knowledge-owner-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--teal-500); }
.knowledge-readonly { padding: 2px 5px; border-radius: 8px; background: var(--ink-100); color: var(--ink-400); font-size: 8px; font-weight: 700; }
.knowledge-tree-row__actions { display: flex; align-items: center; gap: 2px; }
.knowledge-tree-row__actions button { width: 23px; height: 23px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--ink-500); display: grid; place-items: center; cursor: pointer; }
.knowledge-tree-row__actions button:hover { background: var(--surface); color: var(--teal-700); }
.knowledge-tree-row__actions button.is-danger:hover { color: var(--red-600); }
.knowledge-tree-empty { min-height: 210px; padding: 28px 18px; color: var(--ink-400); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; text-align: center; }
.knowledge-tree-empty strong { color: var(--ink-700); font-size: 12px; }
.knowledge-tree-empty span { font-size: 10px; }
.knowledge-tree-empty button { height: 30px; margin-top: 4px; padding: 0 11px; border: 1px solid color-mix(in srgb, var(--teal-500) 58%, var(--ink-100)); border-radius: 7px; background: var(--teal-50); color: var(--teal-700); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; font-size: 10px; font-weight: 700; }
.knowledge-spinner { width: 16px; height: 16px; border: 2px solid var(--ink-100); border-top-color: var(--teal-500); border-radius: 50%; animation: knowledge-spin .8s linear infinite; }
@keyframes knowledge-spin { to { transform: rotate(360deg); } }
.knowledge-sidebar__footer { min-height: 43px; padding: 8px 11px; border-top: 1px solid var(--ink-100); color: var(--ink-400); display: flex; align-items: center; justify-content: space-between; gap: 7px; font-size: 9px; }
.knowledge-sidebar__footer button { height: 26px; padding: 0 8px; font-size: 9px; }
.knowledge-workspace { min-width: 0; min-height: 0; background: var(--surface); display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; }
.knowledge-toolbar { grid-row: 1; min-width: 0; min-height: 63px; padding: 9px 13px 9px 16px; border-bottom: 1px solid var(--ink-100); background: var(--surface); display: grid; grid-template-columns: minmax(190px, 1fr) auto minmax(190px, 1fr); align-items: center; gap: 12px; }
.knowledge-document-identity { min-width: 0; }
.knowledge-breadcrumbs { min-width: 0; display: flex; align-items: center; gap: 5px; overflow: hidden; color: var(--ink-400); }
.knowledge-breadcrumbs strong { min-width: 0; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-800); font-size: 12px; }
.knowledge-breadcrumbs strong:not(:last-child) { color: var(--ink-500); font-weight: 600; }
.knowledge-document-identity small { margin-top: 5px; color: var(--ink-400); display: flex; align-items: center; gap: 5px; font-size: 9px; white-space: nowrap; }
.knowledge-environment-tags { min-width: 0; margin-top: 5px; display: flex; align-items: center; gap: 4px; overflow: hidden; }
.knowledge-environment-tags span { max-width: 120px; padding: 2px 6px; border: 1px solid color-mix(in srgb, var(--teal-500) 32%, var(--ink-100)); border-radius: 9px; background: var(--teal-50); color: var(--teal-700); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 8px; font-weight: 700; }
.knowledge-mode-switch { padding: 3px; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--ink-50); display: flex; align-items: center; gap: 2px; }
.knowledge-mode-switch button { height: 29px; padding: 0 9px; border-color: transparent; background: transparent; font-size: 10px; }
.knowledge-mode-switch button.is-active { border-color: var(--ink-100); background: var(--surface); color: var(--teal-700); box-shadow: 0 1px 4px rgba(14, 43, 48, .08); }
.knowledge-toolbar__actions { min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.knowledge-toolbar__actions button { height: 32px; min-width: 32px; padding: 0 8px; }
.knowledge-toolbar__actions .knowledge-save-button { padding: 0 11px; border-color: var(--teal-500); background: var(--teal-600); color: white; font-size: 10px; font-weight: 750; }
.knowledge-save-alert { grid-row: 2; min-height: 38px; padding: 6px 12px; border-bottom: 1px solid color-mix(in srgb, var(--red-600) 34%, var(--ink-100)); background: var(--red-100); color: var(--red-600); display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 10px; }
.knowledge-save-alert > div { display: flex; gap: 6px; }
.knowledge-save-alert button { min-height: 25px; padding: 0 8px; border-color: color-mix(in srgb, var(--red-600) 35%, var(--ink-100)); font-size: 9px; }
.knowledge-editor-stage { grid-row: 3; min-width: 0; min-height: 0; display: grid; }
.knowledge-editor-stage.is-edit, .knowledge-editor-stage.is-preview { grid-template-columns: minmax(0, 1fr); }
.knowledge-editor-stage.is-split { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.knowledge-editor-pane, .knowledge-preview-pane { min-width: 0; min-height: 0; overflow: hidden; }
.knowledge-editor-pane { border-right: 1px solid var(--ink-100); background: var(--surface); }
.knowledge-preview-pane { padding: 0; background: color-mix(in srgb, var(--ink-50) 30%, var(--surface)); overflow: auto; }
.knowledge-pane-loading { height: 100%; color: var(--ink-400); display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 11px; }
.knowledge-markdown { width: min(760px, calc(100% - 48px)); min-height: calc(100% - 42px); margin: 21px auto; padding: 30px clamp(24px, 5vw, 58px) 48px; border: 1px solid var(--ink-100); border-radius: 4px; background: var(--surface); box-shadow: 0 8px 24px rgba(12, 35, 40, .07); color: var(--ink-800); font-size: 13px; line-height: 1.78; overflow-wrap: anywhere; }
.knowledge-markdown :deep(h1), .knowledge-markdown :deep(h2), .knowledge-markdown :deep(h3) { color: var(--ink-900); line-height: 1.3; }
.knowledge-markdown :deep(h1) { margin: 0 0 25px; padding-bottom: 13px; border-bottom: 2px solid var(--teal-500); font-size: 27px; }
.knowledge-markdown :deep(h2) { margin: 30px 0 13px; padding-bottom: 7px; border-bottom: 1px solid var(--ink-100); font-size: 20px; }
.knowledge-markdown :deep(h3) { margin: 24px 0 10px; font-size: 16px; }
.knowledge-markdown :deep(p), .knowledge-markdown :deep(ul), .knowledge-markdown :deep(ol), .knowledge-markdown :deep(blockquote), .knowledge-markdown :deep(pre), .knowledge-markdown :deep(table) { margin: 0 0 16px; }
.knowledge-markdown :deep(a) { color: var(--teal-700); text-decoration-thickness: 1px; text-underline-offset: 3px; }
.knowledge-markdown :deep(code) { padding: 2px 5px; border-radius: 4px; background: var(--ink-50); color: var(--red-600); font-family: var(--font-mono); font-size: .9em; }
.knowledge-markdown :deep(pre) { padding: 15px 17px; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--ink-900); color: #e8f2f0; overflow: auto; }
.knowledge-markdown :deep(pre code) { padding: 0; background: transparent; color: inherit; }
.knowledge-markdown :deep(blockquote) { padding: 9px 16px; border-left: 3px solid var(--teal-500); background: var(--teal-50); color: var(--ink-600); }
.knowledge-markdown :deep(table) { width: 100%; border-collapse: collapse; }
.knowledge-markdown :deep(th), .knowledge-markdown :deep(td) { padding: 8px 10px; border: 1px solid var(--ink-100); text-align: left; }
.knowledge-markdown :deep(th) { background: var(--ink-50); color: var(--ink-700); }
.knowledge-markdown :deep(img) { max-width: 100%; height: auto; border: 1px solid var(--ink-100); border-radius: 8px; box-shadow: 0 5px 16px rgba(10, 31, 36, .1); }
.knowledge-preview-empty { height: 100%; min-height: 260px; color: var(--ink-400); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; }
.knowledge-preview-empty strong { color: var(--ink-700); font-size: 13px; }
.knowledge-preview-empty span { font-size: 10px; }
.knowledge-statusbar { grid-row: 4; min-height: 32px; padding: 0 12px; border-top: 1px solid var(--ink-100); background: var(--ink-50); color: var(--ink-400); display: flex; align-items: center; gap: 15px; font-size: 9px; }
.knowledge-statusbar > span { display: flex; align-items: center; gap: 5px; }
.knowledge-statusbar > span:nth-last-child(2) { margin-left: auto; }
.knowledge-save-state i { width: 7px; height: 7px; border-radius: 50%; background: var(--amber-600); }
.knowledge-save-state.is-saved i { background: var(--teal-500); }
.knowledge-save-state.is-danger { color: var(--red-600); }
.knowledge-save-state.is-danger i { background: var(--red-600); }
.knowledge-folder-overview { min-height: 0; padding: 48px; grid-row: 1 / -1; background: radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--teal-50) 75%, transparent), transparent 42%); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.knowledge-folder-illustration { width: 78px; height: 78px; margin-bottom: 18px; border: 1px solid color-mix(in srgb, var(--amber-600) 28%, var(--ink-100)); border-radius: 22px; background: linear-gradient(145deg, var(--amber-100), var(--surface)); color: var(--amber-600); box-shadow: 0 12px 28px rgba(103, 72, 12, .1); display: grid; place-items: center; }
.knowledge-folder-overview h3 { margin: 9px 0 8px; color: var(--ink-900); font-size: 22px; }
.knowledge-folder-overview p { max-width: 460px; margin: 0; color: var(--ink-500); font-size: 12px; line-height: 1.7; }
.knowledge-folder-overview > div { margin-top: 20px; display: flex; gap: 8px; }
.knowledge-folder-overview button { min-height: 35px; padding: 0 13px; font-size: 10px; font-weight: 700; }
.knowledge-document-name-suffix { color: var(--ink-500); font-family: var(--font-mono); font-size: 12px; font-weight: 700; }
.knowledge-document-name-error { margin-top: 7px; color: var(--red-600); font-size: 11px; }
.knowledge-grant-content { min-height: 220px; }
.knowledge-grant-note { margin: 0 0 16px; padding: 11px 13px; border: 1px solid color-mix(in srgb, var(--teal-500) 34%, var(--ink-100)); border-radius: 8px; background: var(--teal-50); color: var(--ink-600); display: flex; align-items: flex-start; gap: 8px; font-size: 11px; line-height: 1.55; }
.knowledge-grant-note svg { flex: 0 0 auto; color: var(--teal-700); }
.knowledge-grant-form { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 9px; align-items: center; }
.knowledge-grant-list { margin-top: 16px; border-top: 1px solid var(--ink-100); }
.knowledge-grant-list article { min-height: 48px; padding: 8px 3px; border-bottom: 1px solid var(--ink-100); display: flex; align-items: center; justify-content: space-between; }
.knowledge-grant-list article > span { display: grid; grid-template-columns: 20px auto auto; align-items: center; gap: 7px; }
.knowledge-grant-list article svg { color: var(--teal-600); }
.knowledge-grant-list article strong { color: var(--ink-700); font-size: 11px; }
.knowledge-grant-list article small { padding: 2px 6px; border-radius: 8px; background: var(--ink-50); color: var(--ink-400); font-size: 9px; }
.knowledge-grant-list article button { padding: 4px 8px; border: 0; background: transparent; color: var(--red-600); cursor: pointer; font-size: 10px; }
.knowledge-grant-empty { min-height: 82px; color: var(--ink-400); display: grid; place-items: center; font-size: 10px; }
.knowledge-association-content { min-height: 300px; }
.knowledge-association-list { max-height: 310px; margin-top: 12px; padding: 2px; display: grid; gap: 5px; overflow: auto; }
.knowledge-association-list :deep(.el-checkbox) { width: 100%; min-height: 48px; height: auto; margin: 0; padding: 7px 10px; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--surface); display: flex; align-items: center; }
.knowledge-association-list :deep(.el-checkbox:hover), .knowledge-association-list :deep(.el-checkbox.is-checked) { border-color: color-mix(in srgb, var(--teal-500) 48%, var(--ink-100)); background: var(--teal-50); }
.knowledge-association-list :deep(.el-checkbox__label) { min-width: 0; flex: 1; }
.knowledge-association-list :deep(.el-checkbox__label > span) { min-width: 0; display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: center; gap: 2px 7px; }
.knowledge-association-list :deep(svg) { grid-row: 1 / 3; color: var(--teal-600); }
.knowledge-association-list :deep(strong), .knowledge-association-list :deep(small) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.knowledge-association-list :deep(strong) { color: var(--ink-700); font-size: 11px; }
.knowledge-association-list :deep(small) { color: var(--ink-400); font-size: 9px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 1120px) {
  .knowledge-base-panel { --knowledge-sidebar-width: 236px; }
  .knowledge-toolbar { grid-template-columns: minmax(150px, 1fr) auto auto; }
  .knowledge-mode-switch button span { display: none; }
  .knowledge-breadcrumbs strong:not(:last-child), .knowledge-document-identity small { display: none; }
}
@media (max-width: 820px) {
  .knowledge-base-panel { grid-template-columns: 210px minmax(0, 1fr); }
  .knowledge-editor-stage.is-split { grid-template-columns: minmax(0, 1fr); }
  .knowledge-editor-stage.is-split .knowledge-preview-pane { display: none; }
  .knowledge-toolbar { grid-template-columns: minmax(0, 1fr) auto; }
  .knowledge-toolbar__center { display: none; }
  .knowledge-markdown { width: calc(100% - 24px); margin: 12px; padding: 22px; }
}
@media (prefers-reduced-motion: reduce) { .knowledge-spinner { animation: none; } }
</style>
