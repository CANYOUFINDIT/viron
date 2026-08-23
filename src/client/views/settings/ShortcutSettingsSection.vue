<script setup lang="ts">
import { useSettingsContext } from "./context";
import { Keyboard, RotateCcw, Save, X } from "@lucide/vue";
import TipIcon from "../../components/TipIcon.vue";

const { clearShortcut, resetAllShortcuts, resetShortcut, saveShortcuts, shortcutDefaultBinding, shortcutDirty, shortcutDisplay, shortcutDraft, shortcutError, shortcutGroups, shortcutPlatform, shortcutRecording, shortcutSaving, startShortcutRecording, undoShortcutChanges } = useSettingsContext();
</script>

<template>
<section class="settings-section-panel settings-section-panel--shortcuts">
          <header><span><Keyboard :size="20" /></span><h3>{{ $t('快捷键') }}</h3><TipIcon :content="$t('快捷键保存在当前设备。Command+Shift+W 固定用于关闭窗口；系统与文本编辑保留组合不能覆盖。')" placement="right" /></header>
          <div class="shortcut-settings-toolbar">
            <span :class="{ 'is-dirty': shortcutDirty }">{{ shortcutDirty ? $t('未保存') : $t('已保存') }}</span>
            <el-button :disabled="shortcutRecording !== ''" @click="resetAllShortcuts"><RotateCcw :size="14" />{{ $t('恢复全部默认') }}</el-button>
          </div>
          <div class="shortcut-groups">
            <section v-for="group in shortcutGroups" :key="group.key" class="shortcut-group">
              <header><strong>{{ group.label }}</strong></header>
              <div v-for="definition in group.items" :key="definition.id" class="shortcut-row" :class="{ 'is-recording': shortcutRecording === definition.id }">
                <span class="shortcut-row__label"><strong>{{ $t(definition.label) }}</strong></span>
                <button class="shortcut-recorder" type="button" :aria-pressed="shortcutRecording === definition.id" @click="startShortcutRecording(definition.id)">
                  <Keyboard :size="14" /><kbd>{{ shortcutRecording === definition.id ? $t('请按下快捷键') : shortcutDisplay(definition.id) }}</kbd>
                </button>
                <button class="shortcut-icon-action" type="button" :disabled="shortcutDraft[definition.id] === shortcutDefaultBinding(definition, shortcutPlatform)" :aria-label="$t('恢复{0}默认快捷键', [$t(definition.label)])" :title="$t('恢复默认')" @click="resetShortcut(definition.id)"><RotateCcw :size="14" /></button>
                <button class="shortcut-icon-action" type="button" :disabled="!shortcutDraft[definition.id]" :aria-label="$t('清除{0}快捷键', [$t(definition.label)])" :title="$t('清除快捷键')" @click="clearShortcut(definition.id)"><X :size="14" /></button>
              </div>
            </section>
          </div>
          <p v-if="shortcutError" class="shortcut-error" role="alert">{{ shortcutError }}</p>
          <footer><el-button :disabled="!shortcutDirty" @click="undoShortcutChanges">{{ $t('撤销更改') }}</el-button><el-button type="primary" :loading="shortcutSaving" :disabled="!shortcutDirty || Boolean(shortcutRecording)" @click="saveShortcuts"><Save :size="15" />{{ $t('保存快捷键') }}</el-button></footer>
        </section>
</template>

<style scoped src="./settings-shortcut.css"></style>
