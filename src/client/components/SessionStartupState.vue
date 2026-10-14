<script setup lang="ts">
import { computed } from "vue";
import { AlertTriangle, LoaderCircle, LogOut, RefreshCw } from "@lucide/vue";
import { sessionInitialization } from "../session";
import { translate as tr } from "../i18n";

defineProps<{ allowLogout: boolean; signingOut: boolean }>();
defineEmits<{ reload: []; logout: [] }>();

const slow = computed(() => sessionInitialization.elapsedSeconds >= 3);
const title = computed(() => sessionInitialization.error ? tr("无法完成登录初始化") : slow.value ? tr("连接耗时较长") : tr("正在启动 Viron"));
const phase = computed(() => ({
  endpoint: tr("正在读取本机 Endpoint 配置"),
  validation: tr("正在验证 Endpoint 和服务能力"),
  session: tr("正在读取登录状态与工作空间"),
})[sessionInitialization.phase]);
const explanation = computed(() => sessionInitialization.error || (slow.value
  ? sessionInitialization.phase === "session"
    ? tr("Endpoint 已通过验证，正在等待登录状态接口响应。超过 15 秒将显示超时提示。")
    : tr("正在等待 Endpoint 验证完成。超过 15 秒将显示超时提示。")
  : tr("连接完成后将自动进入工作空间。")));
</script>

<template>
  <main class="session-startup" :aria-busy="sessionInitialization.pending">
    <section class="session-startup__content" :role="sessionInitialization.error ? 'alert' : 'status'" aria-live="polite">
      <span class="session-startup__icon" :class="{ 'is-warning': slow || sessionInitialization.error }">
        <AlertTriangle v-if="sessionInitialization.error" :size="26" />
        <LoaderCircle v-else class="session-startup__spinner" :size="26" />
      </span>
      <h1>{{ title }}</h1>
      <p class="session-startup__explanation">{{ explanation }}</p>
      <dl class="session-startup__details">
        <template v-if="sessionInitialization.endpoint">
          <dt>Endpoint</dt><dd>{{ sessionInitialization.endpoint }}</dd>
        </template>
        <dt>{{ $t('当前步骤') }}</dt><dd>{{ phase }}</dd>
        <dt>{{ $t('已等待') }}</dt><dd>{{ $t('{0} 秒', [sessionInitialization.elapsedSeconds]) }}</dd>
      </dl>
      <div class="session-startup__actions">
        <el-button v-if="sessionInitialization.error || slow" type="primary" :disabled="signingOut" @click="$emit('reload')"><RefreshCw :size="15" />{{ $t('重新连接') }}</el-button>
        <el-button v-if="allowLogout" :loading="signingOut" @click="$emit('logout')"><LogOut :size="15" />{{ $t('退出登录') }}</el-button>
      </div>
      <p v-if="allowLogout" class="session-startup__hint">{{ $t('退出登录后可重新选择 Endpoint。') }}</p>
    </section>
  </main>
</template>

<style scoped>
.session-startup {
  min-height: 100dvh;
  padding: 64px 24px 32px;
  display: grid;
  place-items: center;
  background: var(--color-paper);
  -webkit-app-region: drag;
}
.session-startup__content {
  width: min(100%, 520px);
  display: grid;
  justify-items: center;
  gap: 16px;
  text-align: center;
  -webkit-app-region: no-drag;
}
.session-startup__icon {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: var(--radius-control);
  background: var(--color-paper-raised);
  color: var(--color-accent);
  border: 1px solid var(--color-rule);
}
.session-startup__icon.is-warning { color: var(--amber-600); }
.session-startup__spinner { animation: startup-spin 1.2s linear infinite; }
.session-startup h1 { margin: 0; color: var(--color-ink); font-size: var(--text-xl); }
.session-startup p { margin: 0; color: var(--color-muted); font-size: var(--text-sm); line-height: 1.7; }
.session-startup__details {
  width: 100%;
  margin: 4px 0;
  padding: 18px 20px;
  border-block: 1px solid var(--color-rule);
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px 24px;
  font-size: var(--text-sm);
  text-align: left;
}
.session-startup dt { color: var(--color-muted); }
.session-startup dd { margin: 0; color: var(--color-ink); overflow-wrap: anywhere; }
.session-startup__actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
.session-startup__actions :deep(.el-button + .el-button) { margin-left: 0; }
.session-startup .session-startup__hint { font-size: var(--text-xs); }
@keyframes startup-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .session-startup__spinner { animation: none; } }
</style>
