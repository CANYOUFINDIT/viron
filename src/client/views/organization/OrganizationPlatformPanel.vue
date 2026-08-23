<script setup lang="ts">
import { useOrganizationContext } from "./context";
import { Plus } from "@lucide/vue";
import TipIcon from "../../components/TipIcon.vue";

const { createUser, detail, resetPassword, session, toggleUser, userForm, users } = useOrganizationContext();
</script>

<template>
<section class="console-panel platform-workspace">
            <article class="composer-card"><div class="composer-title"><h3>{{ $t('创建平台账号') }}</h3><TipIcon :content="$t('平台账号与组织成员身份彼此独立。')" placement="right" /></div><el-form label-position="top"><el-form-item :label="$t('用户名')"><el-input v-model="userForm.username" /></el-form-item><el-form-item :label="$t('初始密码')"><el-input v-model="userForm.password" type="password" show-password /></el-form-item><el-checkbox v-model="userForm.isPlatformAdmin">{{ $t('设为平台管理员') }}</el-checkbox><el-button type="primary" @click="createUser"><Plus :size="15" />{{ $t('创建账号') }}</el-button></el-form></article>
            <article class="directory-panel platform-directory"><header class="panel-heading"><div class="panel-heading__title"><h3>{{ $t('平台账号') }}</h3><TipIcon :content="detail ? $t('平台管理员身份不会自动获得组织资源。') : $t('平台账号不等于任何组织的成员。')" placement="right" /></div><em>{{ users.length }} {{ $t('人') }}</em></header><div class="data-list data-list--users"><div class="data-list__head"><span>{{ $t('账号') }}</span><span>{{ $t('平台角色') }}</span><span>{{ $t('组织数') }}</span><span>{{ $t('状态') }}</span><span>{{ $t('操作') }}</span></div><div v-for="user in users" :key="user.id" class="data-list__row"><span class="member-identity"><i>{{ user.username.slice(0, 1).toUpperCase() }}</i><strong>{{ user.username }}</strong></span><span>{{ user.isPlatformAdmin ? $t('平台管理员') : $t('普通用户') }}</span><span>{{ user.organizationCount }}</span><span><em class="status-pill" :class="`is-${user.status}`"><i></i>{{ user.status === 'active' ? $t('使用中') : $t('已停用') }}</em></span><span class="row-actions"><button type="button" @click="resetPassword(user)">{{ $t('重置密码') }}</button><button class="is-danger" type="button" :disabled="user.id === session.user?.id" @click="toggleUser(user)">{{ user.status === 'active' ? $t('停用') : $t('启用') }}</button></span></div></div></article>
          </section>
</template>

<style scoped src="./organization-platform.css"></style>
