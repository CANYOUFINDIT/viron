<script setup lang="ts">
import { ArrowRight, Ban, Building2, Check, Clock3, Copy, KeyRound, Link2, Network, Plus, RefreshCw, ShieldCheck, UserPlus } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import TipIcon from "../components/TipIcon.vue";
import { provideOrganizationContext } from "./organization/context";
import OrganizationInvitationPanel from "./organization/OrganizationInvitationPanel.vue";
import OrganizationPlatformPanel from "./organization/OrganizationPlatformPanel.vue";
import OrganizationStructurePanel from "./organization/OrganizationStructurePanel.vue";
import { useOrganizationController } from "./organization/use-organization-controller";

const context = useOrganizationController();
provideOrganizationContext(context);
const {
  activateWorkspace, activePanel, availableParentProjects, availableResources, canManageOrganization,
  copiedInvitationKey, copyInvitationLink, createGrant, createInvitation, createOrganization,
  createOrganizationDialog, creatingInvitation, creatingOrganization, currentOrganizationId,
  customInvitationLimit, customInvitationLimitInput, detail, editingProject, generatedInvitation,
  grantDialog, grantForm, grantingResource, invitationDialog, invitationDuration, invitationDurations,
  invitationJoinResult, invitationLimitDescription, invitationLimitPreset, invitationLimits,
  invitationLinkInput, invitationProjectId, invitationUsersDialog, joinOrganizationDialog, load,
  loadError, loading, openInvitationFromLink, organizationForm, organizations, projectDialog,
  projectDialogMode, projectForm, projectMemberDialog, resourceTypeLabels, saveProject,
  saveProjectMembers, selectInvitationLimit, selectedGrantTarget, selectedInvitation,
  selectedProjectMembers, session, unattributedInvitationUses,
} = context;
</script>

<template>
  <div class="organization-view" v-loading="loading">
    <PageHeader :title="$t('组织与用户')">
      <template #actions>
        <el-button :aria-label="$t('通过邀请链接加入组织')" @click="joinOrganizationDialog = true"><Link2 :size="16" />{{ $t('加入组织') }}</el-button>
        <el-button :aria-label="$t('创建组织')" @click="createOrganizationDialog = true"><Plus :size="16" />{{ $t('创建组织') }}</el-button>
        <el-button type="primary" :aria-label="$t('同步组织数据')" :loading="loading" @click="load"><RefreshCw v-if="!loading" :size="16" />{{ $t('同步数据') }}</el-button>
      </template>
    </PageHeader>

    <div class="identity-layout">
      <aside class="organization-directory">
        <header><span>{{ $t('组织') }}</span><small>{{ organizations.length }} {{ $t('个已加入组织') }}</small></header>
        <div class="workspace-list">
          <button v-for="organization in organizations" :key="organization.id" type="button" :class="{ 'is-active': organization.id === currentOrganizationId }" @click="activateWorkspace({ type: 'organization', id: organization.id, name: organization.name, role: organization.role })">
            <span class="workspace-mark"><Building2 :size="16" /></span>
            <span><strong>{{ organization.name }}</strong><small>{{ organization.role === 'admin' ? $t('组织管理员') : $t('普通成员') }}</small></span>
            <Check v-if="organization.id === currentOrganizationId" :size="15" />
          </button>
          <p v-if="!organizations.length" class="workspace-list__empty">{{ $t('尚未加入任何组织') }}</p>
        </div>
      </aside>

      <main class="workspace-console">
        <template v-if="detail">
          <header class="workspace-console__heading">
            <div class="organization-symbol">{{ detail.organization.name.slice(0, 1).toUpperCase() }}</div>
            <div><span>{{ detail.organization.role === 'admin' ? 'MANAGED WORKSPACE' : 'ORGANIZATION WORKSPACE' }}</span><h2>{{ detail.organization.name }}</h2><p v-if="detail.organization.description">{{ detail.organization.description }}</p></div>
            <em>{{ detail.organization.role === 'admin' ? $t('管理员') : $t('成员') }}</em>
          </header>
          <nav class="console-tabs" :aria-label="$t('组织管理模块')">
            <button type="button" :class="{ 'is-active': activePanel === 'structure' }" @click="activePanel = 'structure'"><Network :size="16" />{{ $t('组织架构') }}</button>
            <button v-if="canManageOrganization" type="button" :class="{ 'is-active': activePanel === 'invitations' }" @click="activePanel = 'invitations'"><Link2 :size="16" />{{ $t('邀请') }}</button>
            <button v-if="session.user?.isPlatformAdmin" type="button" :class="{ 'is-active': activePanel === 'platform' }" @click="activePanel = 'platform'"><KeyRound :size="16" />{{ $t('平台账号') }}</button>
          </nav>
          <OrganizationStructurePanel v-if="activePanel === 'structure'" />
          <OrganizationInvitationPanel v-else-if="activePanel === 'invitations' && canManageOrganization" />
          <OrganizationPlatformPanel v-else-if="activePanel === 'platform' && session.user?.isPlatformAdmin" />
        </template>

        <template v-else>
          <header class="workspace-console__heading"><div class="organization-symbol"><Building2 :size="24" /></div><div><h2>{{ $t('组织') }}</h2></div><em>{{ organizations.length }} {{ $t('个') }}</em></header>
          <section v-if="loadError" class="console-panel organization-overview"><div class="panel-empty organization-empty organization-load-error"><Ban :size="30" /><strong>{{ $t('组织信息加载失败') }}</strong><span>{{ loadError }}</span><el-button type="primary" :loading="loading" @click="load"><RefreshCw v-if="!loading" :size="15" />{{ $t('重试') }}</el-button></div></section>
          <template v-else>
            <nav v-if="session.user?.isPlatformAdmin" class="console-tabs"><button type="button" :class="{ 'is-active': activePanel !== 'platform' }" @click="activePanel = 'structure'"><Building2 :size="16" />{{ $t('组织') }}</button><button type="button" :class="{ 'is-active': activePanel === 'platform' }" @click="activePanel = 'platform'"><KeyRound :size="16" />{{ $t('平台账号') }}</button></nav>
            <OrganizationStructurePanel v-if="activePanel !== 'platform'" />
            <OrganizationPlatformPanel v-else-if="session.user?.isPlatformAdmin" />
          </template>
        </template>
      </main>
    </div>

    <el-dialog v-model="createOrganizationDialog" align-center class="envman-dialog compact-dialog" :title="$t('创建新组织')" width="500px">
      <el-form label-position="top"><el-form-item :label="$t('组织名称')"><el-input v-model="organizationForm.name" maxlength="120" :placeholder="$t('例如：基础架构团队')" @keyup.enter="createOrganization" /></el-form-item><el-form-item :label="$t('组织说明')"><el-input v-model="organizationForm.description" type="textarea" :rows="3" maxlength="1000" :placeholder="$t('这个组织负责什么？')" /></el-form-item></el-form>
      <template #footer><el-button :disabled="creatingOrganization" @click="createOrganizationDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="creatingOrganization" @click="createOrganization">{{ $t('创建组织') }}<ArrowRight :size="15" /></el-button></template>
    </el-dialog>
    <el-dialog v-model="joinOrganizationDialog" align-center class="envman-dialog compact-dialog" :title="$t('通过邀请链接加入组织')" width="540px" @closed="invitationLinkInput = ''">
      <el-form label-position="top" @submit.prevent="openInvitationFromLink">
        <el-form-item><template #label><span class="form-label-with-tip">{{ $t('邀请链接') }}<TipIcon :content="$t('加入组织不会自动获得业务资源；验证后仍需确认邀请信息。')" placement="right" /></span></template><el-input v-model="invitationLinkInput" clearable autofocus autocomplete="off" :placeholder="$t('例如：https://viron.example.com/join/...')" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="joinOrganizationDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :disabled="!invitationLinkInput.trim()" @click="openInvitationFromLink">{{ $t('验证邀请链接') }}<ArrowRight :size="15" /></el-button></template>
    </el-dialog>
    <el-dialog v-model="projectDialog" align-center class="envman-dialog compact-dialog" :title="projectDialogMode === 'create' ? $t('创建项目组') : $t('编辑项目组')" width="520px">
      <el-form label-position="top">
        <el-form-item :label="$t('项目组名称')"><el-input v-model="projectForm.name" maxlength="120" :placeholder="$t('例如：生产运维')" @keyup.enter="saveProject" /></el-form-item>
        <el-form-item :label="$t('上级项目组')"><el-select v-model="projectForm.parentId" clearable style="width:100%" :placeholder="$t('组织根节点')"><el-option v-for="project in availableParentProjects" :key="project.id" :label="project.name" :value="project.id" /></el-select></el-form-item>
        <el-form-item :label="$t('项目组说明')"><el-input v-model="projectForm.description" type="textarea" :rows="3" maxlength="1000" :placeholder="$t('说明职责范围')" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="projectDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" @click="saveProject">{{ projectDialogMode === 'create' ? $t('创建项目组') : $t('保存修改') }}</el-button></template>
    </el-dialog>
    <el-dialog v-model="projectMemberDialog" align-center class="envman-dialog compact-dialog" :title="$t('项目组成员 · {0}', [editingProject?.name || ''])" width="480px"><el-select v-model="selectedProjectMembers" multiple filterable style="width:100%" :placeholder="$t('选择组织成员')"><el-option v-for="member in detail?.members || []" :key="member.id" :label="member.username" :value="member.id" /></el-select><template #footer><el-button @click="projectMemberDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" @click="saveProjectMembers">{{ $t('保存') }}</el-button></template></el-dialog>
    <el-dialog v-model="grantDialog" align-center class="envman-dialog compact-dialog operation-dialog" :title="$t('授权资源')" width="min(520px, calc(100% - 32px))" @closed="grantForm.resourceIds = []">
      <div v-if="selectedGrantTarget" class="dialog-subject"><span class="dialog-subject__icon"><ShieldCheck :size="18" /></span><div><small>{{ $t('授权对象') }}</small><strong>{{ selectedGrantTarget.name }}</strong><p>{{ selectedGrantTarget.type === 'project' ? $t('项目组及其子项目组会继承这项授权') : $t('仅授权给该成员个人') }}</p></div></div>
      <el-form label-position="top" @submit.prevent="createGrant">
        <el-form-item :label="$t('资源类型')"><el-select v-model="grantForm.resourceType" style="width:100%" @change="grantForm.resourceIds = []"><el-option v-for="(label, type) in resourceTypeLabels" :key="type" :label="label" :value="type" /></el-select></el-form-item>
        <el-form-item :label="$t('资源')"><el-select v-model="grantForm.resourceIds" multiple filterable clearable collapse-tags collapse-tags-tooltip style="width:100%" :placeholder="$t('选择要授权的资源')"><el-option v-for="item in availableResources" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item>
      </el-form>
      <template #footer><el-button :disabled="grantingResource" @click="grantDialog = false">{{ $t('取消') }}</el-button><el-button type="primary" :loading="grantingResource" :disabled="!grantForm.resourceIds.length" @click="createGrant"><ShieldCheck v-if="!grantingResource" :size="15" />{{ $t('确认授权') }}</el-button></template>
    </el-dialog>
    <el-dialog v-model="invitationDialog" align-center class="envman-dialog compact-dialog operation-dialog invitation-dialog" :title="$t('生成邀请链接')" width="min(620px, calc(100% - 32px))">
      <el-form class="invitation-dialog-form" label-position="top" @submit.prevent="createInvitation">
        <el-form-item>
          <template #label><span class="form-label-with-tip">{{ $t('加入项目组') }}<TipIcon :content="$t('设置后，使用该链接的成员会自动进入所选项目组；不设置则只加入组织。')" placement="right" /></span></template>
          <el-select v-model="invitationProjectId" class="invitation-project-select" :placeholder="$t('组织直属成员（不指定项目组）')" clearable><el-option v-for="project in detail?.projects || []" :key="project.id" :label="project.name" :value="project.id" /></el-select>
        </el-form-item>
        <el-form-item :label="$t('链接有效期')">
          <div class="choice-grid duration-picker" role="radiogroup" :aria-label="$t('邀请链接有效期')"><button v-for="duration in invitationDurations" :key="duration.value" type="button" role="radio" :aria-checked="invitationDuration === duration.value" :class="{ 'is-active': invitationDuration === duration.value }" @click="invitationDuration = duration.value"><strong>{{ duration.label }}</strong></button></div>
        </el-form-item>
        <el-form-item>
          <template #label><span class="form-label-with-tip">{{ $t('可加入人数') }}<TipIcon :content="$t('自定义人数范围为 1–10000。')" placement="right" /></span></template>
          <div class="choice-grid usage-picker" role="group" :aria-label="$t('邀请链接可加入人数')">
            <button v-for="limit in invitationLimits" :key="limit.value" type="button" :aria-pressed="invitationLimitPreset === limit.value" :class="{ 'is-active': invitationLimitPreset === limit.value }" @click="selectInvitationLimit(limit.value)"><strong>{{ limit.label }}</strong></button>
            <label v-if="invitationLimitPreset === 'custom'" class="custom-limit-field is-active"><span><input ref="customInvitationLimitInput" v-model.number="customInvitationLimit" type="number" min="1" max="10000" step="1" inputmode="numeric" autocomplete="off" :aria-label="$t('自定义邀请人数')" @keydown.enter.prevent="createInvitation" /><em>{{ $t('人') }}</em></span></label>
            <button v-else type="button" :aria-pressed="false" @click="selectInvitationLimit('custom')"><strong>{{ $t('自定义') }}</strong></button>
          </div>
        </el-form-item>
      </el-form>
      <div v-if="generatedInvitation" class="invitation-result" aria-live="polite">
        <span class="invitation-result__icon"><Check :size="17" /></span>
        <div><strong>{{ $t('邀请链接已生成') }}</strong><p>{{ generatedInvitation.project ? $t('加入后自动进入 {0}', [generatedInvitation.project.name]) : $t('加入为组织直属成员') }} · {{ generatedInvitation.maxUses === null ? $t('名额不限') : $t('最多 {0} 人', [generatedInvitation.maxUses]) }}</p></div>
        <div class="invitation-result__link"><input :value="generatedInvitation.link" readonly :aria-label="$t('新生成的邀请链接')" @focus="($event.target as HTMLInputElement).select()" /><button type="button" :class="{ 'is-success': copiedInvitationKey === 'generated' }" @click="copyInvitationLink()"><Check v-if="copiedInvitationKey === 'generated'" :size="15" /><Copy v-else :size="15" /><span>{{ copiedInvitationKey === 'generated' ? $t('已复制') : $t('复制链接') }}</span></button></div>
        <time><Clock3 :size="13" />{{ $t('有效至') }} {{ new Date(generatedInvitation.expiresAt).toLocaleString($locale()) }}</time>
      </div>
      <template #footer><el-button :disabled="creatingInvitation" @click="invitationDialog = false">{{ $t('关闭') }}</el-button><span class="dialog-summary">{{ invitationLimitDescription }} · {{ invitationDurations.find((item) => item.value === invitationDuration)?.label }}{{ $t('有效') }}</span><el-button type="primary" :loading="creatingInvitation" @click="createInvitation"><UserPlus v-if="!creatingInvitation" :size="15" />{{ $t('生成链接') }}</el-button></template>
    </el-dialog>
    <el-dialog v-model="invitationUsersDialog" align-center class="envman-dialog compact-dialog operation-dialog invitation-users-dialog" :title="$t('通过链接加入的用户')" width="min(620px, calc(100% - 32px))">
      <div v-if="selectedInvitation" class="invitation-users-summary"><span><Link2 :size="16" /></span><div><strong>{{ selectedInvitation.token ? `…${selectedInvitation.token.slice(-10)}` : $t('历史邀请') }}</strong><small>{{ selectedInvitation.project?.name || $t('组织直属') }} · {{ selectedInvitation.acceptedUsers.length }} {{ $t('名可追溯用户') }}</small></div></div>
      <div v-if="selectedInvitation?.acceptedUsers.length" class="accepted-user-list" role="table" :aria-label="$t('邀请链接加入用户')">
        <div class="accepted-user-list__head" role="row"><span>{{ $t('用户') }}</span><span>{{ $t('加入结果') }}</span><span>{{ $t('使用时间') }}</span></div>
        <div v-for="user in selectedInvitation.acceptedUsers" :key="user.id" class="accepted-user-list__row" role="row"><span class="member-identity"><i>{{ user.username.slice(0, 1).toUpperCase() }}</i><strong>{{ user.username }}</strong></span><span><em>{{ invitationJoinResult(user) }}</em></span><time>{{ new Date(user.acceptedAt).toLocaleString($locale()) }}</time></div>
      </div>
      <p v-if="selectedInvitation && unattributedInvitationUses(selectedInvitation)" class="history-use-note">{{ $t('另有') }} {{ unattributedInvitationUses(selectedInvitation) }} {{ $t('次早期使用记录没有可关联的用户信息。') }}</p>
      <template #footer><el-button @click="invitationUsersDialog = false">{{ $t('关闭') }}</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped src="./organization/organization-parent.css"></style>
