<script setup lang="ts">
import { useSettingsContext } from "./context";
import { Database, Download, Upload } from "@lucide/vue";
import TipIcon from "../../components/TipIcon.vue";

const { exportPlatform, exporting, migration, restoreFile, restoreInput, restorePlatform, restoreProgress, selectRestoreFile, settings } = useSettingsContext();
</script>

<template>
<section class="settings-section-panel">
          <header><span><Database :size="20" /></span><h3>{{ $t('数据迁移') }}</h3><code class="settings-section-meta">{{ settings.databaseMode }} · {{ settings.dataDir }}</code></header>
          <div class="migration-groups">
            <article><Download :size="22" /><div><header><strong>{{ $t('导出迁移包') }}</strong><TipIcon :content="$t('迁移包包含平台快照、终端录像和数据库备份；来源主密钥仅以迁移密码加密后的形式写入。')" placement="right" /></header><el-input v-model="migration.exportPassword" type="password" show-password :placeholder="$t('设置迁移密码（至少 12 个字符）')" /><el-input v-model="migration.exportPasswordConfirm" type="password" show-password :placeholder="$t('再次输入迁移密码')" /><el-button :loading="exporting" @click="exportPlatform"><Download :size="15" />{{ $t('生成并下载') }}</el-button></div></article>
            <article><Upload :size="22" /><div><header><strong>{{ $t('导入迁移包') }}</strong><TipIcon :content="$t('凭据会使用当前实例主密钥重新加密；迁移密码和来源明文密钥不会落盘。')" placement="right" /></header><el-input v-model="migration.importPassword" type="password" show-password :placeholder="$t('输入迁移密码（旧版同密钥备份可留空）')" /><button class="restore-file" @click="restoreInput?.click()"><Upload :size="15" />{{ restoreFile?.name || $t('选择平台迁移 ZIP') }}</button><input ref="restoreInput" hidden type="file" accept=".zip" @change="selectRestoreFile" /><el-progress v-if="restoreProgress !== null" :percentage="restoreProgress" /><el-button type="danger" plain :disabled="!restoreFile" @click="restorePlatform">{{ $t('校验并暂存导入') }}</el-button></div></article>
          </div>
        </section>
</template>

<style scoped src="./settings-migration.css"></style>
