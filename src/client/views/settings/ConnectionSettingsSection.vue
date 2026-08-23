<script setup lang="ts">
import { useSettingsContext } from "./context";
import { Cable, Laptop, Server } from "@lucide/vue";
import TipIcon from "../../components/TipIcon.vue";

const { changeExecutionMode, desktopAppState, executionMode, modeSwitching, targetLabel, targetRows } = useSettingsContext();
</script>

<template>
<section class="settings-section-panel">
          <header><span><Cable :size="20" /></span><h3>{{ $t('连接与执行') }}</h3><TipIcon :content="$t('设置按当前设备与 Endpoint 保存；切换模式会安全释放当前 App 的活动连接。')" placement="right" /></header>
          <div class="execution-mode-block">
            <div class="settings-field-heading"><strong>{{ $t('连接模式') }}</strong></div>
            <div class="execution-mode-switch" role="radiogroup" :aria-label="$t('连接模式')" :aria-busy="modeSwitching">
              <button type="button" role="radio" :aria-checked="executionMode === 'local'" :class="{ 'is-active': executionMode === 'local' }" :disabled="modeSwitching" @click="changeExecutionMode('local')"><Laptop :size="18" /><strong>{{ $t('本机直连') }}</strong></button>
              <button type="button" role="radio" :aria-checked="executionMode === 'server'" :class="{ 'is-active': executionMode === 'server' }" :disabled="modeSwitching" @click="changeExecutionMode('server')"><Server :size="18" /><strong>{{ $t('服务端转发') }}</strong></button>
            </div>
          </div>
          <div class="execution-targets">
            <div class="settings-field-heading"><strong>{{ $t('实际执行位置') }}</strong><span>{{ desktopAppState?.endpoint || $t('尚未选择 Endpoint') }}</span></div>
            <div class="execution-target-list">
              <article v-for="row in targetRows" :key="row.label" :class="[`is-${row.target}`, { 'is-planned': row.planned }]"><span><i></i><strong>{{ row.label }}</strong></span><em>{{ targetLabel(row.target, row.fallback, row.planned) }}</em></article>
            </div>
          </div>
        </section>
</template>

<style scoped src="./settings-connection.css"></style>
