<script setup lang="ts">
import { useSettingsContext } from "./context";
import { Laptop, PackageCheck, RefreshCw } from "@lucide/vue";
import TipIcon from "../../components/TipIcon.vue";

const { checkForUpdates, desktopAppState, updateChecking } = useSettingsContext();
</script>

<template>
<section class="settings-section-panel">
          <header><span><PackageCheck :size="20" /></span><h3>{{ $t('客户端版本') }}</h3><TipIcon :content="$t('通过当前 Endpoint 检测适用于本机的软件更新。')" placement="right" /></header>
          <div class="client-version-card" :aria-busy="updateChecking">
            <span class="client-version-card__icon"><Laptop :size="26" /></span>
            <div class="client-version-card__copy"><strong>Viron <em>{{ desktopAppState?.appVersion || '—' }}</em></strong><p>{{ $t('更新来源：') }}{{ desktopAppState?.endpoint || $t('尚未选择 Endpoint') }}</p></div>
            <el-button type="primary" :loading="updateChecking" @click="checkForUpdates"><RefreshCw v-if="!updateChecking" :size="15" />{{ updateChecking ? $t('正在检测…') : $t('检测更新') }}</el-button>
            <span v-if="updateChecking" class="client-version-card__progress" aria-hidden="true"><i></i></span>
          </div>
        </section>
</template>

<style scoped src="./settings-client-version.css"></style>
