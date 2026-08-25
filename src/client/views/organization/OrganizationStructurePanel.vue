<script setup lang="ts">
import { useOrganizationContext } from "./context";
import { ArrowRight, Building2, FolderKanban, FolderPlus, Pencil, Plus, Server, ShieldCheck, Trash2, UserRound, Users } from "@lucide/vue";
import TipIcon from "../../components/TipIcon.vue";

const { activateWorkspace, canManageOrganization, changeRole, createOrganizationDialog, deleteProject, detail, openCreateProject, openEditProject, openGrantDialog, openProjectMembersById, organizations, removeMember, resourceNames, resourceTypeLabels, revokeGrant, selectStructureNode, selectedGrantRows, selectedGrantTarget, selectedMember, selectedMemberProjects, selectedNode, selectedProject, selectedProjectChildren, selectedProjectPath, structureTree } = useOrganizationContext();
</script>

<template>
<section v-if="detail" class="console-panel structure-panel">
            <article class="structure-workbench">
              <aside class="structure-tree" :aria-label="$t('组织架构树')">
                <header>
                  <div><strong>{{ $t('组织架构') }}</strong><small>{{ detail.projects.length }} {{ $t('个项目组 ·') }} {{ detail.members.length }} {{ $t('名成员') }}</small></div>
                  <button v-if="canManageOrganization" type="button" :aria-label="$t('创建根项目组')" @click="openCreateProject(null)"><FolderPlus :size="16" /></button>
                </header>
                <div class="structure-tree__body">
                  <el-tree :data="structureTree" node-key="key" default-expand-all :expand-on-click-node="false" @node-click="selectStructureNode">
                    <template #default="{ data }">
                      <span class="structure-node" :class="{ 'is-selected': selectedNode.type === data.type && selectedNode.id === data.entityId }">
                        <span class="structure-node__icon" :class="`is-${data.type}`">
                          <Building2 v-if="data.type === 'organization'" :size="15" />
                          <FolderKanban v-else-if="data.type === 'project'" :size="15" />
                          <UserRound v-else :size="14" />
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

              <section class="node-inspector">
                <header class="node-inspector__header">
                  <span class="node-inspector__mark" :class="`is-${selectedNode.type}`">
                    <Building2 v-if="selectedNode.type === 'organization'" :size="22" />
                    <FolderKanban v-else-if="selectedNode.type === 'project'" :size="22" />
                    <UserRound v-else :size="21" />
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
                      <TipIcon :content="$t('子项目组继承父项目组授权；成员权限是个人直授与所属项目组、祖先项目组授权的并集。')" placement="left" />
                      <el-button v-if="selectedGrantTarget" type="primary" @click="openGrantDialog"><ShieldCheck :size="15" />{{ $t('授权资源') }}</el-button>
                    </span>
                  </header>
                  <div v-if="selectedGrantRows.length" class="grant-ledger">
                    <div class="grant-ledger__head"><span>{{ $t('资源') }}</span><span>{{ $t('类型') }}</span><span>{{ $t('授权来源') }}</span><span>{{ $t('操作') }}</span></div>
                    <div v-for="row in selectedGrantRows" :key="row.grant.id" class="grant-ledger__row">
                      <span><Server :size="15" /><strong>{{ resourceNames.get(`${row.grant.resourceType}:${row.grant.resourceId}`) || row.grant.resourceId }}</strong></span>
                      <span>{{ resourceTypeLabels[row.grant.resourceType] }}</span>
                      <span><em :class="{ 'is-inherited': row.inherited }">{{ row.inherited ? $t('继承自 {0}', [row.source]) : row.source }}</em></span>
                      <span><button v-if="!row.inherited || selectedNode.type === 'organization'" type="button" @click="revokeGrant(row.grant)">{{ $t('撤销') }}</button><small v-else>{{ $t('在来源节点管理') }}</small></span>
                    </div>
                  </div>
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
