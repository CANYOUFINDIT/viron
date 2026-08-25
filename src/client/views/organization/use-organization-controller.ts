import { translate as tr } from "../../i18n";

import { ElMessage, ElMessageBox } from "element-plus";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../../api";
import { copyTextToClipboard } from "../../clipboard";
import { desktopState, isDesktopApp } from "../../desktop";
import { parseOrganizationInvitationToken } from "../../organization-invitation";
import { loadSession, session, switchWorkspace, type Workspace } from "../../session";

interface Organization { id: string; name: string; description: string; role: "admin" | "member" }
interface Member {
  id: string;
  username: string;
  status: "active" | "disabled";
  role: "admin" | "member";
  projectIds: string[];
  invitedBy: { id: string; username: string } | null;
}
interface Project { id: string; parentId: string | null; name: string; description: string; memberCount: number }
interface Grant { id: string; granteeType: "user" | "project"; granteeId: string; granteeName: string; resourceType: ResourceType; resourceId: string }
interface OrganizationDetail { organization: Organization; members: Member[]; projects: Project[]; grants: Grant[] }
interface PlatformUser { id: string; username: string; status: "active" | "disabled"; isPlatformAdmin: boolean; organizationCount: number }
interface ManagedInvitation {
  id: string;
  token: string | null;
  createdBy: { id: string; username: string };
  project: { id: string; name: string } | null;
  expiresAt: string;
  maxUses: number | null;
  usedCount: number;
  remainingUses: number | null;
  status: "active" | "expired" | "exhausted" | "revoked";
  revokedAt: string | null;
  createdAt: string;
  acceptedUsers: AcceptedInvitationUser[];
}
interface AcceptedInvitationUser {
  id: string;
  username: string;
  acceptedAt: string;
  joinedOrganization: boolean;
  joinedProject: boolean;
}
type ResourceType = "environment_group" | "environment" | "ssh_connection" | "database_connection" | "redis_connection";
interface ResourceOption { id: string; name: string; type: ResourceType }
interface StructureNode {
  key: string;
  type: "organization" | "project" | "member";
  entityId: string;
  label: string;
  meta: string;
  children?: StructureNode[];
}
type Panel = "structure" | "invitations" | "platform";
type InvitationDuration = 1 | 24 | 168 | 720;
type InvitationLimitPreset = 1 | 3 | 5 | 10 | "unlimited" | "custom";

export function useOrganizationController() {
  const router = useRouter();
  const desktop = isDesktopApp();
  const loading = ref(false);
  const loadError = ref("");
  const serviceOrigin = ref(window.location.origin);
  const organizations = ref<Organization[]>([]);
  const detail = ref<OrganizationDetail | null>(null);
  const users = ref<PlatformUser[]>([]);
  const resources = ref<ResourceOption[]>([]);
  const invitations = ref<ManagedInvitation[]>([]);
  const activePanel = ref<Panel>("structure");
  const selectedNode = ref<{ type: StructureNode["type"]; id: string }>({ type: "organization", id: "" });

  const createOrganizationDialog = ref(false);
  const creatingOrganization = ref(false);
  const joinOrganizationDialog = ref(false);
  const invitationLinkInput = ref("");
  const projectDialog = ref(false);
  const projectDialogMode = ref<"create" | "edit">("create");
  const projectMemberDialog = ref(false);
  const grantDialog = ref(false);
  const grantingResource = ref(false);
  const invitationDialog = ref(false);
  const invitationUsersDialog = ref(false);
  const selectedInvitation = ref<ManagedInvitation | null>(null);
  const editingProject = ref<Project | null>(null);
  const selectedProjectMembers = ref<string[]>([]);
  const savedProjectMembers = ref<string[]>([]);
  const invitationDuration = ref<InvitationDuration>(24);
  const invitationLimitPreset = ref<InvitationLimitPreset>(1);
  const invitationProjectId = ref<string | null>(null);
  const customInvitationLimit = ref<number | null>(20);
  const customInvitationLimitInput = ref<HTMLInputElement | null>(null);
  const creatingInvitation = ref(false);
  const revokingInvitationId = ref("");
  const deletingInvitationId = ref("");
  const copiedInvitationKey = ref("");
  const generatedInvitation = ref<{ link: string; expiresAt: string; maxUses: number | null; project: { id: string; name: string } | null } | null>(null);
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

  const organizationForm = reactive({ name: "", description: "" });
  const projectForm = reactive({ name: "", description: "", parentId: null as string | null });
  const grantForm = reactive({ resourceType: "environment" as ResourceType, resourceIds: [] as string[] });
  const userForm = reactive({ username: "", password: "", isPlatformAdmin: false });

  const currentOrganizationId = computed(() => session.workspace?.type === "organization" ? session.workspace.id : "");
  const canManageOrganization = computed(() => session.workspace?.type === "organization" && session.workspace.role === "admin");
  const resourceTypeLabels: Record<ResourceType, string> = {
    environment_group: tr("环境组"),
    environment: tr("环境"),
    ssh_connection: tr("SSH 连接"),
    database_connection: tr("数据库连接"),
    redis_connection: tr("Redis 连接"),
  };
  const invitationDurations: Array<{ value: InvitationDuration; label: string }> = [
    { value: 1, label: tr("1 小时") },
    { value: 24, label: tr("24 小时") },
    { value: 168, label: tr("7 天") },
    { value: 720, label: tr("30 天") },
  ];
  const invitationLimits: Array<{ value: InvitationLimitPreset; label: string }> = [
    { value: 1, label: tr("1 人") },
    { value: 3, label: tr("3 人") },
    { value: 5, label: tr("5 人") },
    { value: 10, label: tr("10 人") },
    { value: "unlimited", label: tr("不限") },
  ];

  function isValidCustomInvitationLimit(value: number | null): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000;
  }

  const invitationMaxUses = computed<number | null>(() => {
    if (invitationLimitPreset.value === "unlimited") return null;
    if (invitationLimitPreset.value === "custom") return customInvitationLimit.value;
    return invitationLimitPreset.value;
  });
  const invitationLimitDescription = computed(() => {
    if (invitationLimitPreset.value === "unlimited") return tr("不限人数");
    if (invitationLimitPreset.value === "custom") return isValidCustomInvitationLimit(customInvitationLimit.value) ? tr("最多 {0} 人", [customInvitationLimit.value]) : tr("自定义人数");
    return tr("最多 {0} 人", [invitationLimitPreset.value]);
  });
  const resourceNames = computed(() => new Map(resources.value.map((item) => [`${item.type}:${item.id}`, item.name])));
  const projectById = computed(() => new Map((detail.value?.projects ?? []).map((project) => [project.id, project])));
  const memberById = computed(() => new Map((detail.value?.members ?? []).map((member) => [member.id, member])));
  const selectedProject = computed(() => selectedNode.value.type === "project" ? projectById.value.get(selectedNode.value.id) ?? null : null);
  const selectedMember = computed(() => selectedNode.value.type === "member" ? memberById.value.get(selectedNode.value.id) ?? null : null);
  const selectedGrantTarget = computed(() => {
    if (selectedProject.value) return { type: "project" as const, id: selectedProject.value.id, name: selectedProject.value.name };
    if (selectedMember.value) return { type: "user" as const, id: selectedMember.value.id, name: selectedMember.value.username };
    return null;
  });

  function ancestorProjectIds(projectId: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    let current = projectById.value.get(projectId);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      result.push(current.id);
      current = current.parentId ? projectById.value.get(current.parentId) : undefined;
    }
    return result;
  }

  const selectedGrantRows = computed(() => {
    const grants = detail.value?.grants ?? [];
    if (selectedNode.value.type === "organization") {
      return grants.map((grant) => ({ grant, source: grant.granteeName, inherited: false }));
    }
    if (selectedProject.value) {
      const projectIds = new Set(ancestorProjectIds(selectedProject.value.id));
      return grants
        .filter((grant) => grant.granteeType === "project" && projectIds.has(grant.granteeId))
        .map((grant) => ({ grant, source: grant.granteeName, inherited: grant.granteeId !== selectedProject.value!.id }));
    }
    if (selectedMember.value) {
      const projectIds = new Set(selectedMember.value.projectIds.flatMap(ancestorProjectIds));
      return grants
        .filter((grant) => (grant.granteeType === "user" && grant.granteeId === selectedMember.value!.id) || (grant.granteeType === "project" && projectIds.has(grant.granteeId)))
        .map((grant) => ({ grant, source: grant.granteeType === "user" ? tr("个人直授") : grant.granteeName, inherited: grant.granteeType === "project" }));
    }
    return [];
  });
  const selectedGrantResourceKeys = computed(() => new Set(
    selectedGrantRows.value.map(({ grant }) => `${grant.resourceType}:${grant.resourceId}`),
  ));
  const availableResources = computed(() => resources.value.filter((item) => (
    item.type === grantForm.resourceType
    && !selectedGrantResourceKeys.value.has(`${item.type}:${item.id}`)
  )));

  const structureTree = computed<StructureNode[]>(() => {
    if (!detail.value) return [];
    const projects = detail.value.projects;
    const members = detail.value.members;
    const childrenByParent = new Map<string | null, Project[]>();
    for (const project of projects) {
      const siblings = childrenByParent.get(project.parentId) ?? [];
      siblings.push(project);
      childrenByParent.set(project.parentId, siblings);
    }
    const buildProjectNode = (project: Project, path: Set<string>): StructureNode => {
      if (path.has(project.id)) return { key: `project:${project.id}`, type: "project", entityId: project.id, label: project.name, meta: tr("层级异常") };
      const nextPath = new Set(path).add(project.id);
      const projectChildren = (childrenByParent.get(project.id) ?? []).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).map((child) => buildProjectNode(child, nextPath));
      const directMembers = members.filter((member) => member.projectIds.includes(project.id)).sort((a, b) => a.username.localeCompare(b.username));
      return {
        key: `project:${project.id}`,
        type: "project",
        entityId: project.id,
        label: project.name,
        meta: tr("{0} 人", [directMembers.length]),
        children: [
          ...projectChildren,
          ...directMembers.map((member) => ({ key: `member:${project.id}:${member.id}`, type: "member" as const, entityId: member.id, label: member.username, meta: member.role === "admin" ? tr("管理员") : tr("成员") })),
        ],
      };
    };
    const assignedMemberIds = new Set(members.filter((member) => member.projectIds.length).map((member) => member.id));
    const rootProjects = (childrenByParent.get(null) ?? []).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).map((project) => buildProjectNode(project, new Set()));
    const unassignedMembers = members.filter((member) => !assignedMemberIds.has(member.id)).sort((a, b) => a.username.localeCompare(b.username));
    return [{
      key: `organization:${detail.value.organization.id}`,
      type: "organization",
      entityId: detail.value.organization.id,
      label: detail.value.organization.name,
      meta: tr("{0} 个项目组 · {1} 人", [projects.length, members.length]),
      children: [
        ...rootProjects,
        ...unassignedMembers.map((member) => ({ key: `member:root:${member.id}`, type: "member" as const, entityId: member.id, label: member.username, meta: tr("未归组") })),
      ],
    }];
  });

  const selectedProjectPath = computed(() => selectedProject.value
    ? ancestorProjectIds(selectedProject.value.id).reverse().map((id) => projectById.value.get(id)?.name).filter(Boolean).join(" / ")
    : "");
  const selectedMemberProjects = computed(() => selectedMember.value?.projectIds.map((id) => projectById.value.get(id)).filter((project): project is Project => Boolean(project)) ?? []);
  const selectedProjectChildren = computed(() => detail.value?.projects.filter((project) => project.parentId === selectedProject.value?.id) ?? []);
  const availableParentProjects = computed(() => {
    const projects = detail.value?.projects ?? [];
    if (projectDialogMode.value !== "edit" || !editingProject.value) return projects;
    const excludedIds = new Set(projects.filter((project) => ancestorProjectIds(project.id).includes(editingProject.value!.id)).map((project) => project.id));
    excludedIds.add(editingProject.value.id);
    return projects.filter((project) => !excludedIds.has(project.id));
  });

  function selectStructureNode(node: StructureNode) {
    selectedNode.value = { type: node.type, id: node.entityId };
    grantForm.resourceIds = [];
  }

  function openGrantDialog() {
    grantForm.resourceIds = [];
    grantDialog.value = true;
  }

  function openInvitationDialog() {
    generatedInvitation.value = null;
    invitationDialog.value = true;
  }

  function openInvitationUsers(invitation: ManagedInvitation) {
    selectedInvitation.value = invitation;
    invitationUsersDialog.value = true;
  }

  function ensureSelectedNode() {
    if (!detail.value) return;
    if (selectedNode.value.type === "project" && projectById.value.has(selectedNode.value.id)) return;
    if (selectedNode.value.type === "member" && memberById.value.has(selectedNode.value.id)) return;
    selectedNode.value = { type: "organization", id: detail.value.organization.id };
  }

  function resetOrganizationWorkspaceState(organizationId = "") {
    detail.value = null;
    resources.value = [];
    invitations.value = [];
    selectedNode.value = { type: "organization", id: organizationId };
    grantForm.resourceIds = [];
  }

  async function loadResources() {
    if (!canManageOrganization.value) { resources.value = []; return; }
    const [groups, environments, connections] = await Promise.all([
      api<{ items: Array<{ id: string; name: string }> }>("/api/v1/environment-groups"),
      api<{ items: Array<{ id: string; name: string }> }>("/api/v1/environments"),
      api<{ items: Array<{ id: string; name: string; type: "ssh" | "database" | "redis" }> }>("/api/v1/connections"),
    ]);
    resources.value = [
      ...groups.items.map((item) => ({ ...item, type: "environment_group" as const })),
      ...environments.items.map((item) => ({ ...item, type: "environment" as const })),
      ...connections.items.map((item) => ({ id: item.id, name: item.name, type: `${item.type}_connection` as ResourceType })),
    ];
  }

  async function loadInvitations() {
    if (!canManageOrganization.value || !currentOrganizationId.value) { invitations.value = []; return; }
    invitations.value = (await api<{ items: ManagedInvitation[] }>(`/api/v1/organizations/${currentOrganizationId.value}/invitations`)).items;
  }

  async function load() {
    loading.value = true;
    loadError.value = "";
    const organizationId = currentOrganizationId.value;
    try {
      const tasks: Promise<unknown>[] = [api<{ items: Organization[] }>("/api/v1/organizations").then((response) => { organizations.value = response.items; })];
      if (organizationId) {
        tasks.push(api<OrganizationDetail>(`/api/v1/organizations/${organizationId}`).then((response) => {
          if (currentOrganizationId.value === organizationId) detail.value = response;
        }));
        tasks.push(loadResources(), loadInvitations());
      } else {
        resetOrganizationWorkspaceState();
      }
      if (session.user?.isPlatformAdmin) tasks.push(api<{ items: PlatformUser[] }>("/api/v1/users").then((response) => { users.value = response.items; }));
      await Promise.all(tasks);
      ensureSelectedNode();
    } catch (error) {
      const message = error instanceof Error ? error.message : tr("读取组织信息失败");
      loadError.value = message;
      if (organizationId) resetOrganizationWorkspaceState(organizationId);
      ElMessage.error(message);
    } finally {
      loading.value = false;
    }
  }

  async function createOrganization() {
    if (creatingOrganization.value) return;
    if (!organizationForm.name.trim()) return ElMessage.warning(tr("请输入组织名称"));
    creatingOrganization.value = true;
    try {
      const created = await api<{ id: string }>("/api/v1/organizations", { method: "POST", body: JSON.stringify(organizationForm) });
      createOrganizationDialog.value = false;
      Object.assign(organizationForm, { name: "", description: "" });
      await loadSession();
      const workspace = session.workspaces.find((item) => item.type === "organization" && item.id === created.id);
      if (workspace) await activateWorkspace(workspace);
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("创建组织失败"));
    } finally {
      creatingOrganization.value = false;
    }
  }

  async function activateWorkspace(workspace: Workspace) {
    if (workspace.id === session.workspace?.id && workspace.type === session.workspace.type) return;
    await switchWorkspace(workspace);
    resetOrganizationWorkspaceState(workspace.id);
    activePanel.value = "structure";
    if (desktop) {
      await router.replace({ name: "organization" });
      await load();
    } else window.location.assign("/organization");
  }

  async function openInvitationFromLink() {
    const token = parseOrganizationInvitationToken(invitationLinkInput.value);
    if (!token) return ElMessage.warning(tr("请输入完整、有效的组织邀请链接"));
    joinOrganizationDialog.value = false;
    invitationLinkInput.value = "";
    await router.push({ name: "organization-invitation", params: { token } });
  }

  async function selectInvitationLimit(limit: InvitationLimitPreset) {
    invitationLimitPreset.value = limit;
    if (limit !== "custom") return;
    await nextTick();
    customInvitationLimitInput.value?.focus();
    customInvitationLimitInput.value?.select();
  }

  async function createInvitation() {
    if (invitationLimitPreset.value === "custom" && !isValidCustomInvitationLimit(customInvitationLimit.value)) return ElMessage.warning(tr("自定义邀请人数需为 1–10000 的整数"));
    creatingInvitation.value = true;
    try {
      const response = await api<{ token: string; expiresAt: string; maxUses: number | null; project: { id: string; name: string } | null }>(`/api/v1/organizations/${currentOrganizationId.value}/invitations`, {
        method: "POST",
        body: JSON.stringify({ expiresInHours: invitationDuration.value, maxUses: invitationMaxUses.value, projectId: invitationProjectId.value }),
      });
      generatedInvitation.value = { link: `${serviceOrigin.value}/join/${response.token}`, expiresAt: response.expiresAt, maxUses: response.maxUses, project: response.project };
      await loadInvitations();
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : tr("生成邀请链接失败"));
    } finally {
      creatingInvitation.value = false;
    }
  }

  async function copyInvitationLink(link = generatedInvitation.value?.link, key = "generated") {
    if (!link) return;
    try {
      await copyTextToClipboard(link);
      copiedInvitationKey.value = key;
      if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = setTimeout(() => { copiedInvitationKey.value = ""; }, 2500);
    } catch {
      ElMessage.warning(tr("复制失败，请手动选择链接复制"));
    }
  }

  function invitationLink(invitation: ManagedInvitation): string | null {
    return invitation.token ? `${serviceOrigin.value}/join/${invitation.token}` : null;
  }
  function invitationStatusLabel(status: ManagedInvitation["status"]): string {
    return { active: tr("可使用"), expired: tr("已过期"), exhausted: tr("名额已满"), revoked: tr("已撤销") }[status];
  }
  function invitationTimeRemaining(invitation: ManagedInvitation): string {
    if (invitation.status === "revoked") return tr("已手工撤销");
    if (invitation.status === "expired") return tr("有效期已结束");
    const remainingMinutes = Math.max(0, Math.ceil((new Date(invitation.expiresAt).getTime() - Date.now()) / 60_000));
    if (remainingMinutes < 60) return tr("{0} 分钟后过期", [remainingMinutes]);
    const remainingHours = Math.ceil(remainingMinutes / 60);
    if (remainingHours < 24) return tr("{0} 小时后过期", [remainingHours]);
    return tr("{0} 天后过期", [Math.ceil(remainingHours / 24)]);
  }
  async function revokeInvitation(invitation: ManagedInvitation) {
    try {
      await ElMessageBox.confirm(tr("撤销后该邀请链接将立即失效，已加入的成员不受影响。"), tr("撤销邀请链接"), { type: "warning", confirmButtonText: tr("确认撤销") });
      revokingInvitationId.value = invitation.id;
      await api(`/api/v1/organizations/${currentOrganizationId.value}/invitations/${invitation.id}`, { method: "DELETE" });
      await loadInvitations();
    } catch (error) {
      if (error === "cancel" || error === "close") return;
      ElMessage.error(error instanceof Error ? error.message : tr("撤销邀请链接失败"));
    } finally {
      revokingInvitationId.value = "";
    }
  }

  async function deleteInvitationRecord(invitation: ManagedInvitation) {
    try {
      await ElMessageBox.confirm(tr("删除后该记录不再显示，链接也会立即失效；已经加入的用户不受影响。"), tr("删除邀请记录"), { type: "warning", confirmButtonText: tr("删除记录") });
      deletingInvitationId.value = invitation.id;
      await api(`/api/v1/organizations/${currentOrganizationId.value}/invitations/${invitation.id}/record`, { method: "DELETE" });
      if (selectedInvitation.value?.id === invitation.id) invitationUsersDialog.value = false;
      await loadInvitations();
    } catch (error) {
      if (error === "cancel" || error === "close") return;
      ElMessage.error(error instanceof Error ? error.message : tr("删除邀请记录失败"));
    } finally {
      deletingInvitationId.value = "";
    }
  }

  function invitationJoinResult(user: AcceptedInvitationUser): string {
    if (user.joinedOrganization && user.joinedProject) return tr("加入组织并归组");
    if (user.joinedOrganization) return tr("加入组织");
    if (user.joinedProject) return tr("加入项目组");
    return tr("使用邀请链接");
  }

  function unattributedInvitationUses(invitation: ManagedInvitation): number {
    return Math.max(0, invitation.usedCount - invitation.acceptedUsers.length);
  }

  async function changeRole(member: Member) {
    const role = member.role === "admin" ? "member" : "admin";
    try {
      await api(`/api/v1/organizations/${currentOrganizationId.value}/members/${member.id}`, { method: "PUT", body: JSON.stringify({ role }) });
      await loadSession();
      await load();
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : tr("调整角色失败")); }
  }
  async function removeMember(member: Member) {
    try {
      await ElMessageBox.confirm(tr("确定将“{0}”移出组织吗？其组织与项目组权限会立即失效。", [member.username]), tr("移除组织成员"), { type: "warning", confirmButtonText: tr("移除") });
      await api(`/api/v1/organizations/${currentOrganizationId.value}/members/${member.id}`, { method: "DELETE" });
      selectedNode.value = { type: "organization", id: currentOrganizationId.value };
      await loadSession();
      if (session.workspace?.type !== "organization") {
        if (desktop) { await router.replace({ name: "organization" }); await load(); }
        else window.location.assign("/organization");
      } else await load();
    } catch (error) {
      if (error === "cancel" || error === "close") return;
      ElMessage.error(error instanceof Error ? error.message : tr("移除成员失败"));
    }
  }

  function openCreateProject(parentId: string | null = null) {
    projectDialogMode.value = "create";
    editingProject.value = null;
    Object.assign(projectForm, { name: "", description: "", parentId });
    projectDialog.value = true;
  }
  function openEditProject(project: Project) {
    projectDialogMode.value = "edit";
    editingProject.value = project;
    Object.assign(projectForm, { name: project.name, description: project.description, parentId: project.parentId });
    projectDialog.value = true;
  }
  async function saveProject() {
    if (!projectForm.name.trim()) return ElMessage.warning(tr("请输入项目组名称"));
    try {
      const path = projectDialogMode.value === "edit" && editingProject.value
        ? `/api/v1/organizations/${currentOrganizationId.value}/projects/${editingProject.value.id}`
        : `/api/v1/organizations/${currentOrganizationId.value}/projects`;
      const response = await api<{ id?: string }>(path, { method: projectDialogMode.value === "edit" ? "PUT" : "POST", body: JSON.stringify(projectForm) });
      projectDialog.value = false;
      if (response.id) selectedNode.value = { type: "project", id: response.id };
      await load();
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : tr("保存项目组失败")); }
  }
  async function deleteProject(project: Project) {
    try {
      const childCount = detail.value?.projects.filter((item) => ancestorProjectIds(item.id).includes(project.id) && item.id !== project.id).length ?? 0;
      await ElMessageBox.confirm(tr("删除项目组“{0}”会同时删除 {1} 个子项目组，并撤销对应资源授权。", [project.name, childCount]), tr("删除项目组"), { type: "warning", confirmButtonText: tr("删除") });
      await api(`/api/v1/organizations/${currentOrganizationId.value}/projects/${project.id}`, { method: "DELETE" });
      selectedNode.value = { type: "organization", id: currentOrganizationId.value };
      await load();
    } catch (error) {
      if (error === "cancel" || error === "close") return;
      ElMessage.error(error instanceof Error ? error.message : tr("删除项目组失败"));
    }
  }
  async function openProjectMembers(project: Project) {
    try {
      const response = await api<{ items: Array<{ id: string }> }>(`/api/v1/organizations/${currentOrganizationId.value}/projects/${project.id}/members`);
      editingProject.value = project;
      selectedProjectMembers.value = response.items.map((item) => item.id);
      savedProjectMembers.value = [...selectedProjectMembers.value];
      projectMemberDialog.value = true;
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : tr("读取项目组成员失败")); }
  }
  function openProjectMembersById(projectId: string) {
    const project = projectById.value.get(projectId);
    if (project) void openProjectMembers(project);
  }
  async function saveProjectMembers() {
    if (!editingProject.value) return;
    const added = selectedProjectMembers.value.filter((id) => !savedProjectMembers.value.includes(id));
    const removed = savedProjectMembers.value.filter((id) => !selectedProjectMembers.value.includes(id));
    try {
      await Promise.all([
        ...added.map((userId) => api(`/api/v1/organizations/${currentOrganizationId.value}/projects/${editingProject.value!.id}/members`, { method: "POST", body: JSON.stringify({ userId }) })),
        ...removed.map((userId) => api(`/api/v1/organizations/${currentOrganizationId.value}/projects/${editingProject.value!.id}/members/${userId}`, { method: "DELETE" })),
      ]);
      projectMemberDialog.value = false;
      await load();
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : tr("保存项目组成员失败")); }
  }

  async function createGrant() {
    if (!selectedGrantTarget.value || !grantForm.resourceIds.length) return ElMessage.warning(tr("请选择资源"));
    grantingResource.value = true;
    try {
      await api(`/api/v1/organizations/${currentOrganizationId.value}/grants`, {
        method: "POST",
        body: JSON.stringify({ granteeType: selectedGrantTarget.value.type, granteeId: selectedGrantTarget.value.id, resourceType: grantForm.resourceType, resourceIds: grantForm.resourceIds }),
      });
      grantForm.resourceIds = [];
      grantDialog.value = false;
      await load();
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : tr("分配资源失败")); }
    finally { grantingResource.value = false; }
  }
  async function revokeGrant(grant: Grant) {
    try {
      await api(`/api/v1/organizations/${currentOrganizationId.value}/grants/${grant.id}`, { method: "DELETE" });
      await load();
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : tr("撤销授权失败")); }
  }

  async function createUser() {
    if (!userForm.username || !userForm.password) return ElMessage.warning(tr("请输入用户名和初始密码"));
    try {
      await api("/api/v1/users", { method: "POST", body: JSON.stringify(userForm) });
      Object.assign(userForm, { username: "", password: "", isPlatformAdmin: false });
      await load();
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : tr("创建用户失败")); }
  }
  async function toggleUser(user: PlatformUser) {
    const status = user.status === "active" ? "disabled" : "active";
    try {
      await api(`/api/v1/users/${user.id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
      await load();
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : tr("更新用户状态失败")); }
  }
  async function resetPassword(user: PlatformUser) {
    try {
      const result = await ElMessageBox.prompt(tr("输入用户“{0}”的新密码", [user.username]), tr("重置密码"), { inputType: "password", inputValidator: (value) => Boolean(value) || tr("密码不能为空") });
      await api(`/api/v1/users/${user.id}/password`, { method: "PUT", body: JSON.stringify({ password: result.value }) });
      ElMessage.success(tr("密码已重置，用户现有会话已失效"));
    } catch (error) {
      if (error === "cancel" || error === "close") return;
      ElMessage.error(error instanceof Error ? error.message : tr("重置密码失败"));
    }
  }

  onMounted(async () => {
    if (desktop) serviceOrigin.value = (await desktopState())?.endpoint ?? serviceOrigin.value;
    await load();
  });
  onBeforeUnmount(() => {
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
  });

  return {
    activateWorkspace, activePanel, availableParentProjects, availableResources, canManageOrganization, changeRole,
    copiedInvitationKey, copyInvitationLink, createGrant, createInvitation, createOrganization, createOrganizationDialog,
    createUser, creatingInvitation, creatingOrganization, currentOrganizationId, customInvitationLimit, customInvitationLimitInput, deleteInvitationRecord,
    deleteProject, deletingInvitationId, detail, editingProject, generatedInvitation, grantDialog,
    grantForm, grantingResource, invitationDialog, invitationDuration, invitationDurations, invitationJoinResult,
    invitationLimitDescription, invitationLimitPreset, invitationLimits, invitationLink, invitationLinkInput, invitationProjectId,
    invitationStatusLabel, invitationTimeRemaining, invitationUsersDialog, invitations, joinOrganizationDialog, load,
    loadError, loading, openCreateProject, openEditProject, openGrantDialog, openInvitationDialog,
    openInvitationFromLink, openInvitationUsers, openProjectMembersById, organizationForm, organizations, projectDialog,
    projectDialogMode, projectForm, projectMemberDialog, removeMember, resetPassword, resourceNames,
    resourceTypeLabels, revokeGrant, revokeInvitation, revokingInvitationId, saveProject, saveProjectMembers,
    selectInvitationLimit, selectStructureNode, selectedGrantRows, selectedGrantTarget, selectedInvitation, selectedMember,
    selectedMemberProjects, selectedNode, selectedProject, selectedProjectChildren, selectedProjectMembers, selectedProjectPath,
    session, structureTree, toggleUser, unattributedInvitationUses, userForm, users,
  };
}
