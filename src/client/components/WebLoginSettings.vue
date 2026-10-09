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
const modes = [
  { value: "protected", label: "自动登录（默认）", description: "后台尝试自动登录；需要手动操作时打开正常网页，可右键输入框填入用户名或密码，再自行点击登录。" },
  { value: "locked", label: "填充并锁定密码", description: "直接填入登录信息并锁住密码框，限制页面明文显示、修改和复制。此模式禁用浏览器扩展和开发者工具，由使用者完成协议、验证码并提交登录。" },
  { value: "direct", label: "直接填充（允许查看密码）", description: "在可操作的登录页填入用户名和密码，由使用者完成协议、验证码并提交登录。密码可以通过页面、开发者工具或浏览器插件查看，请仅用于允许共享密码的入口。" },
] as const;
</script>

<template>
  <details class="login-settings">
    <summary>{{ $t('高级配置') }}</summary>
    <fieldset class="login-settings__modes">
      <legend>{{ $t('登录方式') }}</legend>
      <label v-for="mode in modes" :key="mode.value" class="login-settings__mode" :class="{ 'is-selected': modelValue.mode === mode.value }">
        <input v-model="modelValue.mode" type="radio" name="web-login-mode" :value="mode.value" />
        <span><strong>{{ $t(mode.label) }}</strong><small>{{ $t(mode.description) }}</small></span>
      </label>
    </fieldset>
    <p>{{ $t('配置对该 Web 入口下的所有账号生效。用户名和密码选择器留空时自动识别。') }}</p>
    <el-form-item v-for="[key, label, placeholder] in fields.filter(([key]) => modelValue.mode === 'protected' || key === 'usernameSelector' || key === 'passwordSelector')" :key="key" :label="$t(label)">
      <el-input v-model="modelValue[key]" :placeholder="placeholder" />
    </el-form-item>
    <p v-if="modelValue.mode === 'protected'" class="login-settings__hint">建议配置成功标记，确认登录后再打开业务页面。需要协议确认或验证码时，将打开正常网页供手动操作。</p>
    <el-form-item label="允许登录域名（每行一个 Origin）">
      <el-input :model-value="originsText" type="textarea" :rows="2" placeholder="https://login.example.com" @update:model-value="emit('update:originsText', $event)" />
    </el-form-item>
    <el-form-item v-if="modelValue.mode === 'protected'" label="多步登录脚本（可选，JSON）">
      <el-input :model-value="stepsText" type="textarea" :rows="6" spellcheck="false" placeholder='[{"action":"type","selector":"#username","value":"{USERNAME}"},{"action":"type","selector":"#password","value":"{SECRET}"},{"action":"click","selector":"#login"},{"action":"success","selector":"#user-menu"}]' @update:model-value="emit('update:stepsText', $event)" />
    </el-form-item>
    <p v-if="modelValue.mode === 'protected'" class="login-settings__hint">操作支持 type、click、interactive、success。密码使用 {SECRET}，用户名使用 {USERNAME}；修改账号密码后无需重写脚本。最后一步必须为 success。</p>
  </details>
</template>

<style scoped>
.login-settings { border-top: 1px solid var(--ink-100); padding-top: 14px; margin-top: 6px; }
.login-settings summary { cursor: pointer; font-weight: 600; color: var(--ink-800); }
.login-settings p { color: var(--ink-500); font-size: 12px; line-height: 1.7; margin: 12px 0; }
.login-settings .login-settings__hint { margin-top: -8px; }
.login-settings__modes { border: 0; padding: 0; margin: 18px 0 0; min-width: 0; }
.login-settings__modes legend { padding: 0; margin-bottom: 10px; color: var(--ink-800); font-size: 14px; font-weight: 600; }
.login-settings__mode { display: flex; align-items: flex-start; gap: 10px; border: 1px solid var(--ink-100); border-radius: 8px; padding: 12px; cursor: pointer; }
.login-settings__mode + .login-settings__mode { margin-top: 8px; }
.login-settings__mode.is-selected { border-color: var(--teal-600); }
.login-settings__mode input { margin: 3px 0 0; flex: none; accent-color: var(--teal-600); }
.login-settings__mode strong { display: block; color: var(--ink-800); font-size: 13px; font-weight: 600; line-height: 1.5; }
.login-settings__mode small { display: block; margin-top: 4px; color: var(--ink-500); font-size: 12px; line-height: 1.7; }
</style>
