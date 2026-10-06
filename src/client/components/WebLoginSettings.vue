<script setup lang="ts">
import type { WebLoginConfig } from "../../shared/protected-web-login";
defineProps<{ modelValue: WebLoginConfig; stepsText: string; originsText: string }>();
const emit = defineEmits<{ "update:stepsText": [value: string]; "update:originsText": [value: string] }>();
const fields = [
  ["usernameSelector", "用户名选择器", 'input[name="username"]'],
  ["passwordSelector", "密码选择器", 'input[type="password"]'],
  ["submitSelector", "登录按钮选择器", 'button[type="submit"]'],
  ["successSelector", "登录成功标记", '[data-testid="user-menu"]'],
  ["interactionSelector", "验证区域选择器", '#verification'],
] as const;
</script>

<template>
  <details class="login-settings">
    <summary>后台登录配置</summary>
    <p>账号密码仅在后台页面中填写。普通表单可留空自动识别；验证码、滑块或多步登录请配置下方选项。</p>
    <el-form-item v-for="[key, label, placeholder] in fields" :key="key" :label="label">
      <el-input v-model="modelValue[key]" :placeholder="placeholder" />
    </el-form-item>
    <p class="login-settings__hint">验证区域必须只包含验证控件，不能包含账号、密码或 iframe。建议配置成功标记，确认登录后再打开业务页面。</p>
    <el-form-item label="允许登录域名（每行一个 Origin）">
      <el-input :model-value="originsText" type="textarea" :rows="2" placeholder="https://login.example.com" @update:model-value="emit('update:originsText', $event)" />
    </el-form-item>
    <el-form-item label="多步登录脚本（可选，JSON）">
      <el-input :model-value="stepsText" type="textarea" :rows="6" spellcheck="false" placeholder='[{"action":"type","selector":"#username","value":"{USERNAME}"},{"action":"type","selector":"#password","value":"{SECRET}"},{"action":"click","selector":"#login"},{"action":"success","selector":"#user-menu"}]' @update:model-value="emit('update:stepsText', $event)" />
    </el-form-item>
    <p class="login-settings__hint">操作支持 type、click、interactive、success。密码使用 {SECRET}，用户名使用 {USERNAME}；修改账号密码后无需重写脚本。最后一步必须为 success。</p>
  </details>
</template>

<style scoped>
.login-settings { border-top: 1px solid var(--ink-100); padding-top: 14px; margin-top: 6px; }
.login-settings summary { cursor: pointer; font-weight: 600; color: var(--ink-800); }
.login-settings p { color: var(--ink-500); font-size: 12px; line-height: 1.7; margin: 12px 0; }
.login-settings .login-settings__hint { margin-top: -8px; }
</style>
