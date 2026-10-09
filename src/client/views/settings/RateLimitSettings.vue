<script setup lang="ts">
import { RotateCcw, ShieldCheck } from "@lucide/vue";
import { API_RATE_LIMIT_BOUNDS, defaultApiRateLimitSettings, type ApiRateLimitSettings } from "../../../shared/api-rate-limit-settings";
import TipIcon from "../../components/TipIcon.vue";

const model = defineModel<ApiRateLimitSettings>({ required: true });
defineProps<{ saving: boolean }>();

const fields = [
  { key: "userRequestsPerMinute", label: "单用户业务请求", description: "同一用户的多个窗口和登录会话共用额度，不同用户独立计数。" },
  { key: "anonymousRequestsPerMinute", label: "匿名 IP 请求", description: "未登录的通用接口请求，按来源 IP 计数。" },
  { key: "sessionRequestsPerMinute", label: "登录状态与会话请求", description: "登录状态检查、工作空间切换和退出登录使用独立额度。" },
  { key: "loginAttemptsPerMinute", label: "同一 IP 登录尝试", description: "同一来源 IP 的登录尝试共用额度，包括成功和失败的尝试。" },
  { key: "ipRequestsPerMinute", label: "同一 IP 总请求", description: "同一来源 IP 的请求总量上限；共用出口 IP 的用户会共同计入。" },
] as const;
</script>

<template>
  <section class="rate-limit-settings" :aria-label="$t('请求限流')">
    <header>
      <h4><ShieldCheck :size="17" />{{ $t('请求限流') }}</h4>
      <el-button :disabled="saving" text @click="model = defaultApiRateLimitSettings()"><RotateCcw :size="14" />{{ $t('恢复默认') }}</el-button>
    </header>
    <p>{{ $t('保存后立即生效，重启后保留。恢复默认只修改当前表单，保存后应用。') }}</p>
    <el-form label-position="top" class="settings-form rate-limit-form">
      <el-form-item :label="$t('启用通用请求限流')" class="rate-limit-toggle">
        <el-switch v-model="model.enabled" :disabled="saving" :aria-label="$t('启用通用请求限流')" />
        <em>{{ $t('注册和敏感操作的专项额度独立生效。') }}</em>
      </el-form-item>
      <div class="rate-limit-grid">
        <el-form-item v-for="field in fields" :key="field.key">
          <template #label><span class="rate-limit-label">{{ $t(field.label) }}<TipIcon :content="$t(field.description)" /></span></template>
          <el-input-number v-model="model[field.key]" :disabled="saving || !model.enabled" :min="API_RATE_LIMIT_BOUNDS[field.key].min" :max="API_RATE_LIMIT_BOUNDS[field.key].max" :precision="0" controls-position="right" :aria-label="$t(field.label)" />
          <em>{{ $t('次 / 分钟') }}</em>
        </el-form-item>
      </div>
    </el-form>
    <p class="rate-limit-management-note">{{ $t('平台设置使用独立管理额度，调低限流后仍可进入此处调整。') }}</p>
  </section>
</template>

<style scoped>
.rate-limit-settings { margin-top: var(--space-lg); padding-top: var(--space-md); border-top: 1px solid var(--color-rule); }
.rate-limit-settings > header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-sm); }
.rate-limit-settings h4 { display: flex; align-items: center; gap: var(--space-xs); margin: 0; color: var(--color-ink); font-size: var(--text-sm); }
.rate-limit-settings h4 svg { color: var(--color-accent-strong); }
.rate-limit-settings > p { margin: var(--space-xs) 0 0; color: var(--color-muted); font-size: var(--text-xs); line-height: 1.6; }
.settings-form.rate-limit-form { width: 100%; margin-top: var(--space-md); }
.rate-limit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 var(--space-lg); }
.rate-limit-label { display: flex; align-items: center; gap: var(--space-2xs); }
.rate-limit-label :deep(.tip-icon) { width: 20px; height: 20px; flex-basis: 20px; }
.rate-limit-grid :deep(.el-input-number) { width: 160px; }
.rate-limit-settings > .rate-limit-management-note { margin-top: 0; }
@media (max-width: 42.5rem) { .rate-limit-grid { grid-template-columns: 1fr; } }
</style>
