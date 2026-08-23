<script setup lang="ts">
import { useSettingsContext } from "./context";
import { Save, Settings2 } from "@lucide/vue";
import TipIcon from "../../components/TipIcon.vue";

const { saveSettings, saving, settings } = useSettingsContext();
</script>

<template>
<section class="settings-section-panel">
          <header><span><Settings2 :size="20" /></span><h3>{{ $t('运行策略') }}</h3><TipIcon :content="$t('连接超时与单用户额度由服务环境变量控制；监控采集频率保存后无需重启即可生效。')" placement="right" /></header>
          <el-form label-position="top" class="settings-form settings-form--compact">
            <el-form-item :label="$t('连接空闲断开')"><el-input-number :model-value="settings.connectionIdleMinutes" disabled /><em>{{ $t('分钟 · CONNECTION_IDLE_MINUTES') }}</em></el-form-item>
            <el-form-item :label="$t('单用户最大连接数')"><el-input-number :model-value="settings.userConnectionLimit" disabled /><em>{{ $t('个 · USER_CONNECTION_LIMIT') }}</em></el-form-item>
            <el-form-item :label="$t('宿主机监控采集频率')"><el-input-number v-model="settings.monitorPullIntervalSeconds" :min="10" :max="3600" :step="10" /><em>{{ $t('秒 · 10–3600') }}</em></el-form-item>
            <el-form-item :label="$t('操作审计、终端录像与 SQL 历史保留')"><el-input-number v-model="settings.auditRetentionDays" :min="1" :max="3650" /><em>{{ $t('天') }}</em></el-form-item>
          </el-form>
          <footer><el-button type="primary" :loading="saving" @click="saveSettings"><Save :size="15" />{{ $t('保存策略') }}</el-button></footer>
        </section>
</template>
