<script setup lang="ts">import { translate as tr } from "../i18n";

import { AlertCircle, ArrowRight, Building2, Check, Clock3, FolderKanban, UserPlus } from "@lucide/vue";
import { ElMessage } from "element-plus";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api";
import TipIcon from "../components/TipIcon.vue";
import { loadSession, session, switchWorkspace } from "../session";
import vironLogoUrl from "../../../design/logo/viron-logo.svg?url";

interface Invitation {
  organization: { id: string; name: string; description: string };
  inviter: { username: string };
  project: { id: string; name: string } | null;
  expiresAt: string;
  maxUses: number | null;
  usedCount: number;
  remainingUses: number | null;
  alreadyMember: boolean;
  alreadyProjectMember: boolean;
}

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const accepting = ref(false);
const invitation = ref<Invitation | null>(null);
const error = ref<{ code?: string; message: string } | null>(null);
const token = computed(() => String(route.params.token ?? ""));
const needsAcceptance = computed(() => Boolean(invitation.value && (!invitation.value.alreadyMember || (invitation.value.project && !invitation.value.alreadyProjectMember))));

async function loadInvitation() {
  loading.value = true;
  error.value = null;
  try {
    invitation.value = await api<Invitation>(`/api/v1/organization-invitations/${encodeURIComponent(token.value)}`);
  } catch (cause) {
    invitation.value = null;
    error.value = cause instanceof ApiError
      ? { code: cause.code, message: cause.message }
      : { message: tr("暂时无法读取邀请信息") };
  } finally {
    loading.value = false;
  }
}

async function enterOrganization() {
  if (!invitation.value) return;
  await loadSession();
  const workspace = session.workspaces.find((item) => item.type === "organization" && item.id === invitation.value!.organization.id);
  if (!workspace) {
    ElMessage.error(tr("组织工作空间尚未同步，请刷新后重试"));
    return;
  }
  await switchWorkspace(workspace);
  await router.replace({ name: "organization" });
}

async function acceptInvitation() {
  if (!invitation.value || !needsAcceptance.value) return enterOrganization();
  accepting.value = true;
  try {
    await api(`/api/v1/organization-invitations/${encodeURIComponent(token.value)}/accept`, { method: "POST" });
    ElMessage.success(invitation.value.project ? tr("已加入项目组 {0}", [invitation.value.project.name]) : tr("已加入 {0}", [invitation.value.organization.name]));
    await enterOrganization();
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === "MEMBER_EXISTS") {
      invitation.value.alreadyMember = true;
      invitation.value.alreadyProjectMember = Boolean(invitation.value.project);
      await enterOrganization();
      return;
    }
    error.value = cause instanceof ApiError
      ? { code: cause.code, message: cause.message }
      : { message: tr("接受邀请失败，请稍后重试") };
  } finally {
    accepting.value = false;
  }
}

onMounted(loadInvitation);
</script>

<template>
  <div class="invitation-route">
    <div class="invitation-route__mesh" aria-hidden="true"></div>
    <section class="invitation-dialog" role="dialog" aria-modal="true" aria-labelledby="invitation-title">
      <header>
        <span class="dialog-brand"><img :src="vironLogoUrl" alt="" /></span>
        <span>VIRON / ORGANIZATION INVITE</span>
        <em>{{ $t('登录身份：') }}{{ session.user?.username }}</em>
      </header>

      <div v-if="loading" class="invitation-loading">
        <span></span><strong>{{ $t('正在验证邀请链接') }}</strong><small>{{ $t('确认有效期与组织状态…') }}</small>
      </div>

      <div v-else-if="error" class="invitation-error">
        <span><AlertCircle :size="30" /></span>
        <small>{{ error.code === 'INVITATION_EXPIRED' ? 'INVITATION EXPIRED' : error.code === 'INVITATION_REVOKED' ? 'INVITATION REVOKED' : ['INVITATION_EXHAUSTED', 'INVITATION_USED'].includes(error.code || '') ? 'INVITATION EXHAUSTED' : 'INVALID INVITATION' }}</small>
        <h1 id="invitation-title">{{ error.message }}</h1>
        <p>{{ error.code === 'INVITATION_EXPIRED' ? $t('请联系组织管理员重新生成一个仍在有效期内的邀请链接。') : error.code === 'INVITATION_REVOKED' ? $t('该链接已被组织管理员撤销。') : ['INVITATION_EXHAUSTED', 'INVITATION_USED'].includes(error.code || '') ? $t('该链接的可加入名额已经全部使用。') : $t('请检查链接是否完整，或联系邀请人重新获取。') }}</p>
        <button class="secondary-action" type="button" @click="router.replace({ name: 'overview' })">{{ $t('返回环境总览') }}</button>
      </div>

      <template v-else-if="invitation">
        <div class="invitation-identity">
          <span class="inviter-avatar">{{ invitation.inviter.username.slice(0, 1).toUpperCase() }}</span>
          <span class="invitation-line"></span>
          <span class="organization-avatar"><Building2 :size="24" /></span>
        </div>
        <div class="invitation-copy">
          <small>{{ !needsAcceptance ? 'MEMBERSHIP CONFIRMED' : invitation.alreadyMember ? 'PROJECT INVITATION' : 'YOU ARE INVITED' }}</small>
          <h1 id="invitation-title">
            <template v-if="!needsAcceptance">{{ $t('你已经加入') }} <strong>{{ invitation.organization.name }}</strong><template v-if="invitation.project"> / <strong>{{ invitation.project.name }}</strong></template></template>
            <template v-else-if="invitation.alreadyMember && invitation.project"><strong>{{ invitation.inviter.username }}</strong> {{ $t('邀请你加入') }} <strong>{{ invitation.project.name }}</strong> {{ $t('项目组') }}</template>
            <template v-else><strong>{{ invitation.inviter.username }}</strong> {{ $t('邀请你加入') }} <strong>{{ invitation.organization.name }}</strong> {{ $t('组织') }}</template>
          </h1>
          <p v-if="invitation.organization.description">{{ invitation.organization.description }}</p>
        </div>
        <div class="invitation-facts">
          <span><FolderKanban v-if="invitation.project" :size="15" /><Check v-else :size="15" /><span class="heading-with-tip"><strong>{{ invitation.project?.name || $t('组织直属成员') }}</strong><TipIcon :content="invitation.project ? $t('接受后会自动加入该项目组，并继承项目组及其上级项目组的资源授权。') : $t('本邀请不指定项目组；加入后业务资源仍由管理员另行分配。')" placement="right" /></span></span>
          <span><Clock3 :size="15" /><span><strong>{{ new Date(invitation.expiresAt).toLocaleString($locale()) }}</strong><small>{{ $t('邀请链接有效期') }}</small></span></span>
          <span><UserPlus :size="15" /><span><strong>{{ invitation.remainingUses === null ? $t('剩余名额不限') : $t('剩余 {0} 个名额', [invitation.remainingUses]) }}</strong><small>{{ invitation.maxUses === null ? $t('已有 {0} 人加入', [invitation.usedCount]) : $t('已使用 {0} / {1}', [invitation.usedCount, invitation.maxUses]) }}</small></span></span>
        </div>
        <footer>
          <button class="secondary-action" type="button" @click="router.replace('/')">{{ $t('暂不加入') }}</button>
          <button class="primary-action" type="button" :disabled="accepting" @click="acceptInvitation">
            <template v-if="accepting">{{ $t('正在加入…') }}</template>
            <template v-else-if="!needsAcceptance">{{ $t('进入组织') }}<ArrowRight :size="16" /></template>
            <template v-else-if="invitation.alreadyMember && invitation.project"><UserPlus :size="16" />{{ $t('加入项目组') }}</template>
            <template v-else><UserPlus :size="16" />{{ $t('同意并加入') }}{{ invitation.project ? $t('组织与项目组') : $t('组织') }}</template>
          </button>
        </footer>
      </template>
    </section>
  </div>
</template>

<style scoped>
.invitation-route { min-height: calc(100vh - 60px); padding: 40px 20px; display: grid; place-items: center; position: relative; overflow: hidden; }
.invitation-route__mesh { position: absolute; inset: 0; pointer-events: none; background: radial-gradient(ellipse 70% 56% at 50% 49%, color-mix(in srgb, var(--teal-100) 72%, transparent), transparent 72%), radial-gradient(circle at 74% 72%, color-mix(in srgb, var(--ink-100) 62%, transparent), transparent 31%); }
.invitation-route__mesh::before, .invitation-route__mesh::after { content: ""; position: absolute; border: 1px solid color-mix(in srgb, var(--teal-500) 14%, transparent); border-radius: 50%; }
.invitation-route__mesh::before { width: 430px; height: 430px; left: -240px; bottom: -180px; box-shadow: 0 0 0 55px color-mix(in srgb, var(--teal-500) 2%, transparent); }
.invitation-route__mesh::after { width: 280px; height: 280px; right: -130px; top: -110px; box-shadow: 0 0 0 38px color-mix(in srgb, var(--teal-500) 2%, transparent); }
.invitation-dialog { width: min(1100px, 100%); border: 1px solid var(--ink-100); border-radius: 22px; background: var(--surface); box-shadow: 0 32px 96px rgba(8, 22, 25, .17); position: relative; overflow: hidden; animation: dialog-in .5s cubic-bezier(.22, 1, .36, 1) both; }
.invitation-dialog::before { content: ""; position: absolute; inset: 0 0 auto; height: 3px; background: var(--teal-500); }
.invitation-dialog > header { min-height: 72px; padding: 0 28px; border-bottom: 1px solid var(--ink-100); display: grid; grid-template-columns: 34px 1fr auto; align-items: center; gap: 11px; color: var(--ink-500); font-family: var(--font-mono); font-size: 10px; font-weight: 800; letter-spacing: .11em; }
.dialog-brand { width: 34px; height: 34px; border: 1px solid var(--ink-100); border-radius: 9px; background: white; display: grid; place-items: center; }
.dialog-brand img { width: 28px; height: auto; display: block; }
.invitation-dialog > header em { color: var(--ink-400); font-family: var(--font-ui); font-size: 10px; font-style: normal; font-weight: 500; letter-spacing: 0; }
.invitation-identity { padding-top: 50px; display: grid; grid-template-columns: 64px 86px 64px; justify-content: center; align-items: center; }
.inviter-avatar, .organization-avatar { width: 64px; height: 64px; border-radius: 17px; display: grid; place-items: center; }
.inviter-avatar { border: 1px solid var(--ink-100); background: var(--ink-50); color: var(--ink-700); font-family: var(--font-display); font-size: 24px; font-weight: 900; }
.organization-avatar { background: var(--ink-950); color: #65d2ae; box-shadow: 0 0 0 8px var(--teal-50); }
.invitation-line { height: 1px; background: repeating-linear-gradient(90deg, var(--ink-200) 0 5px, transparent 5px 9px); position: relative; }
.invitation-line::after { content: ">"; position: absolute; right: -2px; top: 50%; color: var(--ink-300); font-size: 10px; transform: translateY(-54%); }
.invitation-copy { padding: 29px 54px 32px; text-align: center; }
.invitation-copy > small, .invitation-error > small { color: var(--teal-600); font-family: var(--font-mono); font-size: 10px; font-weight: 900; letter-spacing: .17em; }
.invitation-copy h1, .invitation-error h1 { max-width: 820px; margin: 11px auto 12px; color: var(--ink-800); font-family: var(--font-display); font-size: clamp(27px, 3.4vw, 36px); line-height: 1.3; letter-spacing: -.025em; }
.invitation-copy h1 strong { color: var(--teal-700); }
.invitation-copy p, .invitation-error p { max-width: 520px; margin: 0 auto; color: var(--ink-400); font-size: 13px; line-height: 1.7; }
.invitation-facts { width: min(880px, calc(100% - 72px)); margin: 0 auto; border: 1px solid var(--ink-100); border-radius: 13px; background: var(--ink-50); display: grid; grid-template-columns: repeat(3, 1fr); }
.invitation-facts > span { min-height: 80px; padding: 16px 20px; display: flex; align-items: center; gap: 12px; color: var(--teal-600); }
.invitation-facts > span + span { border-left: 1px solid var(--ink-100); }
.invitation-facts strong, .invitation-facts small { display: block; }
.invitation-facts strong { color: var(--ink-700); font-size: 12px; }
.invitation-facts small { margin-top: 5px; color: var(--ink-400); font-size: 11px; }
.invitation-dialog > footer { width: min(880px, calc(100% - 72px)); margin: 0 auto; padding: 26px 0 34px; display: flex; justify-content: flex-end; gap: 10px; }
.secondary-action, .primary-action { height: 42px; padding: 0 18px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; cursor: pointer; font-size: 12px; font-weight: 700; }
.secondary-action { border: 1px solid var(--ink-200); background: var(--surface); color: var(--ink-600); }
.primary-action { min-width: 168px; border: 1px solid var(--teal-600); background: var(--teal-600); color: white; box-shadow: 0 8px 20px rgba(24, 128, 109, .16); }
.primary-action:hover { background: var(--teal-700); }
.primary-action:disabled { opacity: .6; cursor: wait; }
.invitation-loading, .invitation-error { min-height: 380px; padding: 50px; display: grid; place-items: center; align-content: center; text-align: center; }
.invitation-loading > span { width: 34px; height: 34px; margin-bottom: 17px; border: 2px solid var(--ink-100); border-top-color: var(--teal-500); border-radius: 50%; animation: spin .8s linear infinite; }
.invitation-loading strong { color: var(--ink-700); font-size: 13px; }
.invitation-loading small { margin-top: 5px; color: var(--ink-400); font-size: 10px; }
.invitation-error > span { width: 58px; height: 58px; margin-bottom: 18px; border-radius: 16px; background: var(--red-100); color: var(--red-600); display: grid; place-items: center; }
.invitation-error .secondary-action { margin-top: 24px; }
@keyframes dialog-in { from { opacity: 0; transform: translateY(14px) scale(.985); } }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 620px) {
  .invitation-route { padding: 18px 8px; }
  .invitation-dialog { border-radius: 15px; }
  .invitation-dialog > header { grid-template-columns: 30px 1fr; }
  .invitation-dialog > header em { display: none; }
  .invitation-identity { padding-top: 36px; grid-template-columns: 56px 70px 56px; }
  .inviter-avatar, .organization-avatar { width: 56px; height: 56px; border-radius: 15px; }
  .invitation-copy { padding: 25px 24px 28px; }
  .invitation-copy h1, .invitation-error h1 { font-size: 28px; }
  .invitation-facts { width: auto; grid-template-columns: 1fr; margin-inline: 18px; }
  .invitation-facts > span + span { border-top: 1px solid var(--ink-100); border-left: 0; }
  .invitation-dialog > footer { width: auto; margin: 0; padding-inline: 18px; flex-direction: column-reverse; }
  .secondary-action, .primary-action { width: 100%; }
}
@media (prefers-reduced-motion: reduce) { .invitation-dialog { animation: none; } }
</style>
