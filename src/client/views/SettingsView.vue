<script setup lang="ts">
import { ArchiveRestore } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import TipIcon from "../components/TipIcon.vue";
import AgentSettingsSection from "./settings/AgentSettingsSection.vue";
import ApiKeySettingsSection from "./settings/ApiKeySettingsSection.vue";
import AppearanceSettingsSection from "./settings/AppearanceSettingsSection.vue";
import ClientVersionSettingsSection from "./settings/ClientVersionSettingsSection.vue";
import ConnectionSettingsSection from "./settings/ConnectionSettingsSection.vue";
import McpSettingsSection from "./settings/McpSettingsSection.vue";
import MigrationSettingsSection from "./settings/MigrationSettingsSection.vue";
import ProfileSettingsSection from "./settings/ProfileSettingsSection.vue";
import RuntimeSettingsSection from "./settings/RuntimeSettingsSection.vue";
import ShortcutSettingsSection from "./settings/ShortcutSettingsSection.vue";
import { provideSettingsContext } from "./settings/context";
import { useSettingsController } from "./settings/use-settings-controller";

const context = useSettingsController();
provideSettingsContext(context);
const { activeSection, desktop, loading, restartRequired, sections, selectSection, session } = context;
</script>

<template>
  <div class="settings-view" v-loading="loading">
    <PageHeader :title="$t('设置')" />
    <div v-if="restartRequired" class="restart-banner"><ArchiveRestore :size="18" /><strong>{{ $t('跨实例迁移已暂存') }}</strong><TipIcon :content="$t('重启 Viron 服务后会应用迁移包；当前服务在重启前仍使用原数据。')" placement="right" /></div>

    <section class="settings-console">
      <nav class="settings-sections" :aria-label="$t('设置分类')">
        <button v-for="item in sections" :key="item.key" type="button" :class="{ 'is-active': activeSection === item.key }" @click="selectSection(item.key)">
          <span><component :is="item.icon" :size="17" /></span>
          <strong>{{ item.label }}</strong>
        </button>
      </nav>

      <div class="settings-detail">
        <ProfileSettingsSection v-if="activeSection === 'profile'" />
        <AppearanceSettingsSection v-else-if="activeSection === 'appearance'" />
        <ApiKeySettingsSection v-else-if="activeSection === 'api-keys'" />
        <McpSettingsSection v-else-if="activeSection === 'mcp'" @select-section="selectSection" />
        <ShortcutSettingsSection v-else-if="activeSection === 'shortcuts' && desktop" />
        <ConnectionSettingsSection v-else-if="activeSection === 'connection' && desktop" />
        <AgentSettingsSection v-else-if="activeSection === 'ai-agent' && desktop" />
        <ClientVersionSettingsSection v-else-if="activeSection === 'client-version' && desktop" />
        <RuntimeSettingsSection v-else-if="activeSection === 'runtime' && session.user?.isPlatformAdmin" />
        <MigrationSettingsSection v-else-if="activeSection === 'migration' && session.user?.isPlatformAdmin" />
      </div>
    </section>
  </div>
</template>

<style src="./settings/settings-base.css"></style>
