<script setup lang="ts">
import { useOrganizationContext } from "./context";
import { Ban, Check, Copy, Link2, RefreshCw, Trash2, UserPlus } from "@lucide/vue";

const { copiedInvitationKey, copyInvitationLink, deleteInvitationRecord, deletingInvitationId, invitationLink, invitationStatusLabel, invitationTimeRemaining, invitations, openInvitationDialog, openInvitationUsers, revokeInvitation, revokingInvitationId, unattributedInvitationUses } = useOrganizationContext();
</script>

<template>
<section class="console-panel panel-stack">
            <article class="directory-panel invitation-directory">
              <header class="panel-heading invitation-heading">
                <div class="panel-heading__title"><div><h3>{{ $t('邀请链接') }}</h3><p>{{ $t('查看链接状态、加入用户与使用名额') }}</p></div></div>
                <div class="panel-heading__actions"><em>{{ invitations.length }} {{ $t('条') }}</em><el-button type="primary" @click="openInvitationDialog"><UserPlus :size="15" />{{ $t('生成邀请链接') }}</el-button></div>
              </header>
              <div v-if="invitations.length" class="data-list data-list--invitations" role="table" :aria-label="$t('邀请链接')">
                <div class="data-list__head" role="row"><span>{{ $t('邀请链接') }}</span><span>{{ $t('项目组') }}</span><span>{{ $t('加入用户') }}</span><span>{{ $t('状态') }}</span><span>{{ $t('有效期') }}</span><span>{{ $t('名额') }}</span><span>{{ $t('操作') }}</span></div>
                <div v-for="invitation in invitations" :key="invitation.id" class="data-list__row" role="row">
                  <span class="invitation-identity"><i><Link2 :size="14" /></i><span><strong>{{ invitation.token ? `…${invitation.token.slice(-10)}` : $t('历史邀请') }}</strong><small>{{ invitation.createdBy.username }} {{ $t('创建 ·') }} {{ new Date(invitation.createdAt).toLocaleString($locale()) }}</small></span></span>
                  <span><strong>{{ invitation.project?.name || $t('组织直属') }}</strong><small>{{ invitation.project ? $t('自动归组') : $t('不指定项目组') }}</small></span>
                  <span class="invitation-users">
                    <button v-if="invitation.acceptedUsers.length" type="button" :aria-label="$t('查看 {0} 名加入用户', [invitation.acceptedUsers.length])" @click="openInvitationUsers(invitation)">
                      <span class="avatar-stack" aria-hidden="true"><i v-for="user in invitation.acceptedUsers.slice(0, 3)" :key="user.id">{{ user.username.slice(0, 1).toUpperCase() }}</i></span>
                      <span><strong>{{ invitation.acceptedUsers.length }} {{ $t('人') }}</strong><small>{{ unattributedInvitationUses(invitation) ? $t('另有 {0} 次历史使用', [unattributedInvitationUses(invitation)]) : $t('查看加入明细') }}</small></span>
                    </button>
                    <span v-else><strong>{{ $t('暂无用户') }}</strong><small>{{ invitation.usedCount ? $t('{0} 次历史使用未关联', [invitation.usedCount]) : $t('链接尚未使用') }}</small></span>
                  </span>
                  <span><em class="invitation-status" :class="`is-${invitation.status}`">{{ invitationStatusLabel(invitation.status) }}</em></span>
                  <span><strong>{{ new Date(invitation.expiresAt).toLocaleString($locale()) }}</strong><small>{{ invitationTimeRemaining(invitation) }}</small></span>
                  <span><strong>{{ invitation.maxUses === null ? $t('{0} 人已加入', [invitation.usedCount]) : `${invitation.usedCount} / ${invitation.maxUses}` }}</strong><small>{{ invitation.remainingUses === null ? $t('剩余名额不限') : $t('剩余 {0} 个名额', [invitation.remainingUses]) }}</small></span>
                  <span class="row-actions invitation-actions">
                    <button class="action-icon" type="button" :class="{ 'is-success': copiedInvitationKey === invitation.id }" :disabled="invitation.status !== 'active' || !invitation.token" :aria-label="copiedInvitationKey === invitation.id ? $t('链接已复制') : $t('复制邀请链接')" :title="copiedInvitationKey === invitation.id ? $t('已复制') : $t('复制链接')" @click="copyInvitationLink(invitationLink(invitation) || undefined, invitation.id)"><Check v-if="copiedInvitationKey === invitation.id" :size="15" /><Copy v-else :size="15" /></button>
                    <button class="action-icon is-warning" type="button" :disabled="invitation.status !== 'active' || revokingInvitationId === invitation.id" :aria-label="$t('撤销邀请链接')" :title="$t('撤销链接')" @click="revokeInvitation(invitation)"><RefreshCw v-if="revokingInvitationId === invitation.id" class="is-spinning" :size="15" /><Ban v-else :size="15" /></button>
                    <button class="action-icon is-danger" type="button" :disabled="deletingInvitationId === invitation.id" :aria-label="$t('删除邀请记录')" :title="$t('删除记录')" @click="deleteInvitationRecord(invitation)"><RefreshCw v-if="deletingInvitationId === invitation.id" class="is-spinning" :size="15" /><Trash2 v-else :size="15" /></button>
                  </span>
                </div>
              </div>
              <div v-else class="panel-empty invitation-empty"><Link2 :size="28" /><strong>{{ $t('还没有邀请链接') }}</strong><span>{{ $t('生成一个链接，邀请成员加入组织或指定项目组') }}</span><el-button type="primary" @click="openInvitationDialog"><UserPlus :size="15" />{{ $t('生成邀请链接') }}</el-button></div>
            </article>
          </section>
</template>

<style scoped src="./organization-invitation.css"></style>
