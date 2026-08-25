<script setup lang="ts">
import { useSettingsContext } from "./context";
import { CalendarDays, ChevronDown, Fingerprint, KeyRound, LogOut, ShieldCheck, UserRound } from "@lucide/vue";
import TipIcon from "../../components/TipIcon.vue";

const { changePassword, closePasswordPanel, formatAccountCreatedAt, password, passwordPanelOpen, saving, session, signOut, signingOut } = useSettingsContext();
</script>

<template>
<section class="settings-section-panel settings-section-panel--profile">
          <header><span><UserRound :size="20" /></span><h3>{{ $t('个人信息') }}</h3></header>
          <div class="profile-summary">
            <span class="profile-avatar">{{ session.user?.username.slice(0, 1).toUpperCase() }}</span>
            <div class="profile-identity"><strong>{{ session.user?.username }}</strong><em>{{ session.user?.isPlatformAdmin ? $t('平台管理员') : $t('普通用户') }}</em></div>
            <dl>
              <div><dt><UserRound :size="14" />{{ $t('用户名') }}</dt><dd>{{ session.user?.username }}</dd></div>
              <div><dt><ShieldCheck :size="14" />{{ $t('平台角色') }}</dt><dd>{{ session.user?.isPlatformAdmin ? $t('平台管理员') : $t('普通用户') }}</dd></div>
              <div><dt><Fingerprint :size="14" />{{ $t('账号 ID') }}</dt><dd :title="session.user?.id"><code>{{ session.user?.id }}</code></dd></div>
              <div><dt><CalendarDays :size="14" />{{ $t('注册时间') }}</dt><dd>{{ formatAccountCreatedAt(session.user?.createdAt) }}</dd></div>
            </dl>
          </div>
          <div class="profile-action-bar">
            <div class="profile-password-trigger">
              <el-button :class="{ 'is-expanded': passwordPanelOpen }" @click="passwordPanelOpen = !passwordPanelOpen"><KeyRound :size="16" />{{ $t('修改密码') }}<ChevronDown :size="15" /></el-button>
              <TipIcon :content="$t('密码修改成功后，其他登录会话会立即失效。')" placement="right" />
            </div>
            <el-button type="danger" plain :loading="signingOut" @click="signOut"><LogOut :size="15" />{{ $t('退出登录') }}</el-button>
          </div>
          <Transition name="settings-expand">
            <section v-if="passwordPanelOpen" class="profile-password-panel">
              <el-form label-position="top" class="settings-form profile-password-form">
                <el-form-item :label="$t('当前密码')"><el-input v-model="password.currentPassword" type="password" autocomplete="current-password" show-password /></el-form-item>
                <el-form-item :label="$t('新密码')"><el-input v-model="password.newPassword" type="password" autocomplete="new-password" show-password /></el-form-item>
                <el-form-item :label="$t('确认新密码')"><el-input v-model="password.confirmPassword" type="password" autocomplete="new-password" show-password /></el-form-item>
              </el-form>
              <footer><el-button @click="closePasswordPanel">{{ $t('取消') }}</el-button><el-button type="primary" :loading="saving" @click="changePassword"><ShieldCheck :size="15" />{{ $t('保存密码') }}</el-button></footer>
            </section>
          </Transition>
        </section>
</template>

<style scoped src="./settings-profile.css"></style>
