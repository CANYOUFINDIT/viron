<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowRight, Building2, Info, Link2, MoreHorizontal, Network, Pencil, Plus, Search, Trash2, Users } from "@lucide/vue";
import { nameInitials } from "../../../shared/name-initials";
import { useOrganizationContext } from "./context";
import OrganizationInvitationPanel from "./OrganizationInvitationPanel.vue";
import OrganizationResourceOverview from "./OrganizationResourceOverview.vue";
import MemberPermissionDialog from "./MemberPermissionDialog.vue";
const { activateWorkspace, canManageOrganization, changeRole, createOrganizationDialog, currentOrganizationId, deleteProject, detail, openEditProject, openInvitationDialog, openProjectMembersById, organizations, removeMember, selectedMember, selectedNode, selectedProject, selectedProjectPath } = useOrganizationContext();
const memberPermissionOpen = ref(false);
const inspectedMember = ref<{ id: string; username: string } | null>(null);
const detailTab = ref<"members" | "resources">("members");
const memberKeyword = ref("");
const showInvitations = ref(false);
const scopeMembers = computed(() => {
  if (!selectedProject.value) return detail.value?.members ?? [];
  const ids = new Set([selectedProject.value.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const project of detail.value?.projects ?? []) if (project.parentId && ids.has(project.parentId) && !ids.has(project.id)) { ids.add(project.id); grew = true; }
  }
  return detail.value?.members.filter(member => member.projectIds.some(id => ids.has(id))) ?? [];
});
const filteredMembers = computed(() => scopeMembers.value.filter(member => member.username.toLowerCase().includes(memberKeyword.value.trim().toLowerCase())));
watch(() => selectedNode.value.id, () => { memberKeyword.value = ""; showInvitations.value = false; memberPermissionOpen.value = false; inspectedMember.value = null; });
function showMember(id: string) { inspectedMember.value = detail.value?.members.find(member => member.id === id) ?? null; memberPermissionOpen.value = true; }
</script>

<template>
<section v-if="detail" class="console-panel structure-panel">
              <section class="node-inspector">
                <header class="node-inspector__header">
                  <div v-if="selectedNode.type === 'organization'">
                    <small>组织架构 / 整个组织</small>
                    <h1>{{ detail.organization.name }}</h1>
                    <p>{{ detail.organization.description || '—' }}</p>
                  </div>
                  <div v-else-if="selectedProject">
                    <small>{{ selectedProjectPath }}</small>
                    <h1>{{ selectedProject.name }}</h1>
                    <p>{{ selectedProject.description || '—' }}</p>
                  </div>
                  <div v-else-if="selectedMember">
                    <small>{{ $t('组织成员') }}</small>
                    <h1>{{ selectedMember.username }}</h1>
                    <p>{{ selectedMember.invitedBy ? $t('{0} 邀请加入', [selectedMember.invitedBy.username]) : $t('非邀请加入') }}</p>
                  </div>
                  <span v-if="canManageOrganization" class="node-inspector__actions">
                    <template v-if="selectedNode.type === 'organization'">
                      <el-button @click="openInvitationDialog(null)"><Link2 :size="15" />邀请成员</el-button>
                    </template>
                    <template v-else-if="selectedProject">
                      <el-button @click="openInvitationDialog(selectedProject.id)"><Link2 :size="15" />邀请成员</el-button><el-dropdown trigger="click"><button class="organization-node-menu" type="button" aria-label="子组织操作"><MoreHorizontal :size="18" /></button><template #dropdown><el-dropdown-menu><el-dropdown-item @click="openEditProject(selectedProject!)"><Pencil :size="14" />编辑子组织</el-dropdown-item><el-dropdown-item @click="deleteProject(selectedProject!)"><Trash2 :size="14" />删除子组织</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
                    </template>
                    <template v-else-if="selectedMember">
                      <el-button @click="changeRole(selectedMember)">{{ $t('分配角色') }}</el-button>
                      <el-button type="danger" plain @click="removeMember(selectedMember)">{{ $t('移出组织') }}</el-button>
                    </template>
                  </span>
                </header>

                <div class="organization-scope-meta" v-if="!selectedMember"><span><Users :size="16" />{{ scopeMembers.length }} 名成员</span><span><Network :size="16" />{{ selectedProject ? '含下级子组织' : '整个组织' }}</span></div>
                <nav v-if="!selectedMember" class="organization-detail-tabs" aria-label="组织详情"><button type="button" :class="{ 'is-active': detailTab === 'members' }" @click="detailTab = 'members'">成员</button><button type="button" :class="{ 'is-active': detailTab === 'resources' }" @click="detailTab = 'resources'">关联资源</button></nav>
                <template v-if="!selectedMember">
                  <section v-if="detailTab === 'members'" class="organization-members" aria-label="组织成员">
                    <div class="organization-members__toolbar"><el-input v-model="memberKeyword" clearable placeholder="搜索成员名称" aria-label="搜索成员名称"><template #prefix><Search :size="16" /></template></el-input><span>{{ filteredMembers.length }} 名成员</span><el-button v-if="canManageOrganization && !selectedProject" :aria-expanded="showInvitations" @click="showInvitations = !showInvitations">邀请管理</el-button><el-button v-if="selectedProject && canManageOrganization" @click="openProjectMembersById(selectedProject.id)">管理成员</el-button></div>
                    <div class="organization-members__table"><div class="organization-members__head"><span>成员</span><span>角色</span><span>所属子组织</span><span>操作</span></div><div v-for="member in filteredMembers" :key="member.id" class="organization-members__row"><span class="organization-members__identity"><i>{{ nameInitials(member.username) }}</i><strong>{{ member.username }}</strong><small v-if="member.status !== 'active'">已停用</small></span><span>{{ (member.roleNames || []).join('、') || '暂无角色' }}</span><span>{{ member.projectIds.map(id => detail?.projects.find(project => project.id === id)?.name).filter(Boolean).join('、') || '整个组织' }}</span><button type="button" @click="showMember(member.id)">查看权限</button></div></div><p v-if="!filteredMembers.length" class="organization-members__empty">{{ memberKeyword ? '没有匹配的成员' : '暂无成员' }}</p>
                    <OrganizationInvitationPanel v-if="showInvitations && !selectedProject" />
                  </section>
                  <template v-else-if="detailTab === 'resources'"><p class="organization-related-note"><Info :size="15" />按与资源总览相同的方式查看本组织的关联资源；包含下级子组织与独立资源。</p><OrganizationResourceOverview :project-id="selectedProject?.id" /></template>
                </template>
                <section v-if="selectedMember && currentOrganizationId" class="node-grants" aria-label="成员权限">
                  <header><div><strong>成员权限</strong><small>{{ (selectedMember.roleNames || []).join("、") || "暂无有效角色" }}</small></div><el-button type="primary" @click="memberPermissionOpen = true">查看权限</el-button></header>
                </section>
              </section>
<MemberPermissionDialog v-if="(inspectedMember || selectedMember) && currentOrganizationId" v-model="memberPermissionOpen" :organization-id="currentOrganizationId" :member-id="(inspectedMember || selectedMember)!.id" :username="(inspectedMember || selectedMember)!.username" />
</section>
<section v-else class="console-panel organization-overview">
              <div v-if="organizations.length" class="organization-card-grid">
                <button v-for="organization in organizations" :key="organization.id" type="button" @click="activateWorkspace({ type: 'organization', id: organization.id, name: organization.name, role: organization.role })"><span class="workspace-mark"><Building2 :size="18" /></span><span><strong>{{ organization.name }}</strong><small v-if="organization.description">{{ organization.description }}</small><em>{{ organization.role === 'admin' ? $t('组织管理员') : $t('普通成员') }}</em></span><ArrowRight :size="17" /></button>
              </div>
              <div v-else class="panel-empty organization-empty"><Building2 :size="30" /><strong>{{ $t('还没有组织') }}</strong><el-button type="primary" @click="createOrganizationDialog = true"><Plus :size="15" />{{ $t('创建新组织') }}</el-button></div>
            </section>
</template>
<style scoped src="./organization-structure.css"></style>
