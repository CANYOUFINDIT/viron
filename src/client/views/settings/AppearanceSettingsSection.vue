<script setup lang="ts">
import { useSettingsContext } from "./context";
import { Activity, Languages, Palette } from "@lucide/vue";
import TipIcon from "../../components/TipIcon.vue";

const { changeConnectionQualityVisibility, chooseLanguage, chooseTheme, connectionQualityEnabled, language, languageOptions, theme, themeOptions } = useSettingsContext();
</script>

<template>
<section class="settings-section-panel">
          <header><span><Palette :size="20" /></span><h3>{{ $t('外观与语言') }}</h3><TipIcon :content="$t('外观与语言保存在当前客户端中，同一客户端上的不同登录账号共用选择。')" placement="right" /></header>
          <div class="settings-field-heading appearance-heading"><strong>{{ $t('界面语言') }}</strong><span>{{ $t('切换后自动刷新界面') }}</span></div>
          <div class="language-choice-grid" role="radiogroup" :aria-label="$t('界面语言')">
            <button v-for="option in languageOptions" :key="option.value" type="button" role="radio" :aria-checked="language === option.value" :class="['language-choice', { 'is-active': language === option.value }]" @click="chooseLanguage(option.value)">
              <Languages :size="18" />
              <span><strong>{{ option.label }}</strong><small>{{ option.description }}</small></span>
              <i>{{ language === option.value ? $t('当前使用') : $t('选择') }}</i>
            </button>
          </div>
          <div class="settings-field-heading appearance-heading theme-heading"><strong>{{ $t('主题样式') }}</strong></div>
          <div class="theme-choice-grid" role="radiogroup" :aria-label="$t('主题样式')">
            <button v-for="option in themeOptions" :key="option.value" type="button" role="radio" :aria-label="$t('切换到{0}主题', [option.label])" :aria-checked="theme === option.value" :class="['theme-choice', `is-${option.value}`, { 'is-active': theme === option.value }]" @click="chooseTheme(option.value)">
              <span class="theme-preview" aria-hidden="true"><i></i><b></b><em></em><small></small></span>
              <span class="theme-choice__copy"><strong>{{ option.label }}</strong></span>
              <i class="theme-choice__state">{{ theme === option.value ? $t('当前使用') : $t('选择') }}</i>
            </button>
          </div>
          <div class="settings-field-heading appearance-heading connection-quality-heading"><strong>{{ $t('连接质量悬浮面板') }}</strong><span>{{ $t('保存在当前设备') }}</span></div>
          <div class="connection-quality-preference">
            <span><Activity :size="19" /></span>
            <div><strong>{{ $t('显示连接质量') }}</strong><small>{{ $t('悬浮显示本机到 Viron、Viron 到活动目标的延迟与真实业务吞吐') }}</small></div>
            <el-switch :model-value="connectionQualityEnabled" :aria-label="$t('显示连接质量悬浮面板')" @change="changeConnectionQualityVisibility" />
          </div>
        </section>
</template>

<style scoped src="./settings-appearance.css"></style>
