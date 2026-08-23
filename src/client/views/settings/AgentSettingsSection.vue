<script setup lang="ts">
import { useSettingsContext } from "./context";
import { Activity, AlertTriangle, Bot, Keyboard, MessageSquareText, Power, RefreshCw, RotateCcw, Save, Trash2 } from "@lucide/vue";
import TipIcon from "../../components/TipIcon.vue";
import AgentApprovalModeSelector from "../../components/AgentApprovalModeSelector.vue";

const { activeSection, agentAuditClearing, agentDeleting, agentDraft, agentEntryMode, agentEntrySwitching, agentModels, agentModelsError, agentModelsLoading, agentModelsMessage, agentSaving, agentSettings, agentShortcutDirty, agentStoredApiKeyAvailable, agentTestMessage, agentTesting, changeAgentEntryMode, clearAgentAudit, clearAgentSettings, defaultShortcutBindings, loadAgentModels, resetShortcut, saveAgentSettings, saveShortcuts, shortcutDisplay, shortcutDraft, shortcutError, shortcutPlatform, shortcutRecording, shortcutSaving, startShortcutRecording, testAgentSettings } = useSettingsContext();
</script>

<template>
<section class="settings-section-panel settings-section-panel--agent">
          <header><span><Bot :size="20" /></span><h3>{{ $t('Viron Agent') }}</h3><TipIcon :content="$t('Viron Agent 配置只保存在当前 App 本机；API Key 不上传远端 Viron 服务，也不会在保存后回显。')" placement="right" /></header>
          <aside class="agent-experimental-notice" role="note" aria-labelledby="agent-experimental-heading">
            <span><AlertTriangle :size="18" /></span>
            <div>
              <strong id="agent-experimental-heading">{{ $t('实验性功能 · 使用有风险') }}</strong>
              <p>{{ $t('Viron Agent 仍在开发中，生成内容和操作建议可能不准确或不可靠。请谨慎使用，并在执行命令、SQL 或其他操作前自行核验。') }}</p>
            </div>
          </aside>
          <div class="agent-status-card" :class="{ 'is-configured': agentSettings.configured }">
            <span><Bot :size="22" /></span>
            <div>
              <strong>{{ agentSettings.configured ? $t('已配置本机模型') : $t('尚未配置模型') }}</strong>
              <small>{{ agentSettings.configured ? `${agentSettings.model} · ${agentSettings.protocol === 'anthropic' ? 'Anthropic API' : 'OpenAI API'} · ${agentSettings.endpoint}` : $t('配置模型后即可使用所选 Viron Agent 入口') }}</small>
            </div>
            <em>{{ agentSettings.apiKeyStored ? $t('API Key 已加密保存') : $t('未保存 API Key') }}</em>
          </div>

          <section class="agent-entry-settings" aria-labelledby="agent-entry-heading">
            <div class="settings-field-heading"><strong id="agent-entry-heading">{{ $t('Viron Agent 入口') }}</strong><span>{{ $t('保存在当前设备') }}</span></div>
            <div class="agent-entry-options" role="radiogroup" :aria-label="$t('Viron Agent 入口')" :aria-busy="agentEntrySwitching">
              <button type="button" role="radio" :aria-checked="agentEntryMode === 'floating'" :class="{ 'is-active': agentEntryMode === 'floating' }" :disabled="agentEntrySwitching" @click="changeAgentEntryMode('floating')">
                <Bot :size="18" />
                <span><strong>{{ $t('悬浮按钮') }}</strong><small>{{ $t('保留当前可拖动按钮和完整 Chatbox') }}</small></span>
              </button>
              <button type="button" role="radio" :aria-checked="agentEntryMode === 'quick'" :class="{ 'is-active': agentEntryMode === 'quick' }" :disabled="agentEntrySwitching" @click="changeAgentEntryMode('quick')">
                <MessageSquareText :size="18" />
                <span><strong>{{ $t('快捷输入') }}</strong><small>{{ $t('快捷键唤起底部输入条，回复显示为右下角气泡') }}</small></span>
              </button>
              <button type="button" role="radio" :aria-checked="agentEntryMode === 'disabled'" :class="{ 'is-active': agentEntryMode === 'disabled' }" :disabled="agentEntrySwitching" @click="changeAgentEntryMode('disabled')">
                <Power :size="18" />
                <span><strong>{{ $t('关闭') }}</strong><small>{{ $t('隐藏所有 Viron Agent 入口，保留配置和当前会话') }}</small></span>
              </button>
            </div>
            <Transition name="settings-expand">
              <div v-if="agentEntryMode === 'quick'" class="agent-entry-shortcut">
                <span><strong>{{ $t('唤起快捷键') }}</strong><small>{{ shortcutPlatform === 'darwin' ? $t('默认 Option + Space') : $t('默认 Ctrl + Shift + A') }}</small></span>
                <button class="shortcut-recorder" type="button" :aria-pressed="shortcutRecording === 'app.agentQuickInput'" @click="startShortcutRecording('app.agentQuickInput')">
                  <Keyboard :size="14" /><kbd>{{ shortcutRecording === 'app.agentQuickInput' ? $t('请按下快捷键') : shortcutDisplay('app.agentQuickInput') }}</kbd>
                </button>
                <button class="shortcut-icon-action" type="button" :disabled="shortcutDraft['app.agentQuickInput'] === defaultShortcutBindings(shortcutPlatform)['app.agentQuickInput']" :aria-label="$t('恢复 Viron Agent 默认快捷键')" :title="$t('恢复默认')" @click="resetShortcut('app.agentQuickInput')"><RotateCcw :size="14" /></button>
                <el-button type="primary" :loading="shortcutSaving" :disabled="!agentShortcutDirty || Boolean(shortcutRecording)" @click="saveShortcuts"><Save :size="14" />{{ $t('保存快捷键') }}</el-button>
              </div>
            </Transition>
            <p v-if="activeSection === 'ai-agent' && shortcutError" class="shortcut-error" role="alert">{{ shortcutError }}</p>
          </section>

          <section class="agent-control-settings" aria-labelledby="agent-approval-heading">
            <div class="settings-field-heading"><strong id="agent-approval-heading">{{ $t('审批策略') }}</strong><span>{{ $t('统一控制所有 Agent 环境功能') }}</span></div>
            <AgentApprovalModeSelector v-model="agentDraft.approvalMode" :disabled="agentSaving" />
            <p>{{ $t('策略适用于 SSH、数据库、Redis、知识库和服务维护。它不会扩大当前用户权限，也不会放开尚未实现或未启用的工具。') }}</p>
          </section>

          <section class="agent-control-settings" aria-labelledby="agent-presentation-heading">
            <div class="settings-field-heading"><strong id="agent-presentation-heading">{{ $t('执行位置') }}</strong><span>{{ $t('审批策略与显示位置相互独立') }}</span></div>
            <div class="agent-presentation-options" role="radiogroup" :aria-label="$t('Viron Agent 执行位置')">
              <button type="button" role="radio" :aria-checked="agentDraft.executionPresentation === 'conversation'" :class="{ 'is-active': agentDraft.executionPresentation === 'conversation' }" @click="agentDraft.executionPresentation = 'conversation'">
                <MessageSquareText :size="18" /><span><strong>{{ $t('在对话中显示') }}</strong><small>{{ $t('通过 Viron 受控后台通道执行，结果显示在 Agent 卡片中') }}</small></span>
              </button>
              <button type="button" role="radio" :aria-checked="agentDraft.executionPresentation === 'workbench'" :class="{ 'is-active': agentDraft.executionPresentation === 'workbench' }" @click="agentDraft.executionPresentation = 'workbench'">
                <Activity :size="18" /><span><strong>{{ $t('直接操作工作台') }}</strong><small>{{ $t('命令、SQL 和结果在绑定的 SSH 终端或数据库工作台中可见') }}</small></span>
              </button>
            </div>
            <div class="agent-domain-status">
              <span><strong>SSH</strong><em>{{ $t('已支持') }}</em></span>
              <span><strong>{{ $t('数据库') }}</strong><em>{{ $t('已支持') }}</em></span>
              <span><strong>Redis</strong><em>{{ $t('待安全工具接入') }}</em></span>
              <span><strong>{{ $t('知识库') }}</strong><em>{{ $t('待安全工具接入') }}</em></span>
              <span><strong>{{ $t('服务维护') }}</strong><em>{{ $t('待安全工具接入') }}</em></span>
            </div>
          </section>

          <el-form label-position="top" class="settings-form agent-settings-form">
            <el-form-item :label="$t('协议类型')">
              <el-radio-group v-model="agentDraft.protocol">
                <el-radio-button value="openai">OpenAI API</el-radio-button>
                <el-radio-button value="anthropic">Anthropic API</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="Endpoint">
              <el-input v-model="agentDraft.endpoint" :placeholder="$t('例如 https://api.example.com/v1 或 http://localhost:11434/v1')" autocomplete="off" />
            </el-form-item>
            <el-form-item label="API Key">
              <el-input v-model="agentDraft.apiKey" type="password" show-password :placeholder="agentSettings.apiKeyStored ? $t('已保存 API Key，留空继续使用') : $t('请输入模型服务 API Key')" autocomplete="new-password" />
            </el-form-item>
            <el-form-item :label="$t('模型')" class="agent-model-field">
              <el-select v-model="agentDraft.model" filterable :loading="agentModelsLoading" :disabled="agentModelsLoading || !agentModels.length" :placeholder="$t('请从自动获取的模型列表中选择')">
                <el-option v-for="model in agentModels" :key="model" :label="model" :value="model" />
              </el-select>
              <el-button circle :loading="agentModelsLoading" :disabled="!agentDraft.endpoint.trim() || (!agentDraft.apiKey.trim() && !agentStoredApiKeyAvailable)" :aria-label="$t('重新获取模型列表')" @click="loadAgentModels"><RefreshCw v-if="!agentModelsLoading" :size="15" /></el-button>
            </el-form-item>
            <p class="agent-models-message" :class="{ 'is-error': agentModelsError }">{{ agentModelsMessage }}</p>
          </el-form>

          <p v-if="agentTestMessage" class="agent-test-message" :class="{ 'is-success': agentTestMessage.startsWith($t('连接成功')) }">{{ agentTestMessage }}</p>
          <footer>
            <el-button :loading="agentAuditClearing" @click="clearAgentAudit"><Trash2 :size="15" />{{ $t('清除操作记录') }}</el-button>
            <el-button :loading="agentDeleting" :disabled="!agentSettings.configured" @click="clearAgentSettings"><Trash2 :size="15" />{{ $t('清除配置') }}</el-button>
            <el-button :loading="agentTesting" :disabled="!agentSettings.configured || agentSaving" @click="testAgentSettings"><RefreshCw :size="15" />{{ $t('测试连接') }}</el-button>
            <el-button type="primary" :loading="agentSaving" :disabled="!agentDraft.model" @click="saveAgentSettings"><Save :size="15" />{{ $t('保存配置') }}</el-button>
          </footer>
        </section>
</template>


<style scoped>
.agent-entry-settings { width: 100%; margin-top: 20px; }
.agent-control-settings { width: 100%; margin-top: 20px; }
.settings-form.agent-settings-form { width: 100%; }
.agent-entry-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
.agent-experimental-notice { margin-top: 20px; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--amber-600) 30%, var(--ink-100)); border-radius: 10px; background: color-mix(in srgb, var(--amber-100) 58%, var(--surface)); color: var(--amber-600); display: flex; align-items: flex-start; gap: 10px; }
.agent-experimental-notice > span { width: 30px; height: 30px; flex: 0 0 30px; border-radius: 8px; background: color-mix(in srgb, var(--amber-600) 12%, transparent); display: grid; place-items: center; }
.agent-experimental-notice > div { min-width: 0; }
.agent-experimental-notice strong { display: block; color: color-mix(in srgb, var(--amber-600) 78%, var(--ink-800)); font-size: 12px; }
.agent-experimental-notice p { margin: 4px 0 0; color: var(--ink-500); font-size: 11px; line-height: 1.55; }
.agent-status-card { margin-top: 12px; padding: 16px; border: 1px solid var(--ink-100); border-radius: 12px; background: var(--ink-50); display: grid; grid-template-columns: 42px minmax(0, 1fr) auto; align-items: center; gap: 13px; }
.agent-status-card > span { width: 42px; height: 42px; border-radius: 10px; background: var(--surface); color: var(--ink-500); display: grid; place-items: center; }
.agent-status-card.is-configured > span { background: var(--teal-50); color: var(--teal-700); }
.agent-status-card strong, .agent-status-card small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-status-card strong { color: var(--ink-800); font-size: 13px; }
.agent-status-card small { margin-top: 3px; color: var(--ink-400); font-size: 11px; }
.agent-status-card em { color: var(--ink-400); font-size: 11px; font-style: normal; text-align: right; }
.agent-status-card.is-configured em { color: var(--teal-700); }
.agent-control-settings > p { margin: 9px 0 0; color: var(--ink-400); font-size: 10px; line-height: 1.55; }
.agent-presentation-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.agent-presentation-options > button { min-height: 66px; padding: 11px 12px; border: 1px solid var(--ink-100); border-radius: 8px; background: var(--surface); color: var(--ink-500); display: grid; grid-template-columns: 34px minmax(0, 1fr); align-items: center; gap: 10px; text-align: left; cursor: pointer; }
.agent-presentation-options > button:hover { border-color: var(--ink-200); background: var(--ink-50); }
.agent-presentation-options > button.is-active { border-color: color-mix(in srgb, var(--teal-500) 48%, var(--ink-100)); background: var(--teal-50); color: var(--teal-700); box-shadow: 0 0 0 3px color-mix(in srgb, var(--teal-500) 8%, transparent); }
.agent-presentation-options span, .agent-presentation-options strong, .agent-presentation-options small { min-width: 0; display: block; }
.agent-presentation-options strong { color: var(--ink-700); font-size: 12px; }
.agent-presentation-options small { margin-top: 3px; color: var(--ink-400); font-size: 10px; line-height: 1.45; }
.agent-domain-status { margin-top: 9px; display: flex; flex-wrap: wrap; gap: 6px; }
.agent-domain-status > span { min-height: 25px; padding: 0 8px; border: 1px solid var(--ink-100); border-radius: 6px; background: var(--ink-50); display: inline-flex; align-items: center; gap: 6px; }
.agent-domain-status strong { color: var(--ink-600); font-size: 10px; }
.agent-domain-status em { color: var(--ink-400); font-size: 9px; font-style: normal; }
.agent-entry-options > button {
  min-width: 0;
  min-height: 66px;
  padding: 10px 12px;
  border: 1px solid var(--ink-100);
  border-radius: 7px;
  background: var(--ink-50);
  color: var(--ink-500);
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  text-align: left;
  cursor: pointer;
  transition: border-color .16s ease, background-color .16s ease, color .16s ease, transform .16s ease;
}
.agent-entry-options > button:hover:not(:disabled) { border-color: var(--ink-200); color: var(--ink-700); transform: translateY(-1px); }
.agent-entry-options > button:active:not(:disabled) { transform: translateY(0); }
.agent-entry-options > button.is-active { border-color: color-mix(in srgb, var(--teal-500) 38%, var(--ink-100)); background: var(--surface); color: var(--teal-700); box-shadow: inset 3px 0 var(--teal-500); }
.agent-entry-options > button:disabled { opacity: .56; cursor: wait; }
.agent-entry-options > button > svg { justify-self: center; }
.agent-entry-options > button span, .agent-entry-options > button strong, .agent-entry-options > button small { min-width: 0; display: block; }
.agent-entry-options > button strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.agent-entry-options > button small { margin-top: 3px; color: var(--ink-400); font-size: 10px; line-height: 1.4; }
.agent-entry-shortcut {
  min-height: 48px;
  margin-top: 10px;
  padding: 8px 9px 8px 12px;
  border: 1px solid var(--ink-100);
  border-radius: 7px;
  background: var(--surface);
  display: grid;
  grid-template-columns: minmax(140px, 1fr) minmax(150px, 210px) 32px auto;
  align-items: center;
  gap: 8px;
}
.agent-entry-shortcut > span { min-width: 0; }
.agent-entry-shortcut > span strong, .agent-entry-shortcut > span small { display: block; }
.agent-entry-shortcut > span strong { color: var(--ink-600); font-size: 11px; }
.agent-entry-shortcut > span small { margin-top: 2px; color: var(--ink-400); font-size: 10px; }
.agent-settings-form :deep(.el-select) { flex: 1; min-width: 0; }
.agent-model-field :deep(.el-select) { flex: 1; min-width: 0; width: auto; }
.agent-model-field :deep(.el-button) { flex: none; }
.agent-models-message { margin: -8px 0 16px; color: var(--ink-400); font-size: 12px; }
.agent-models-message.is-error { color: var(--red-600); }
.agent-test-message { margin: 2px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--red-100); color: var(--red-600); font-size: 12px; line-height: 1.5; }
.agent-test-message.is-success { background: var(--teal-50); color: var(--teal-700); }
.settings-section-panel--agent > footer { gap: 8px; }
@media (max-width: 900px) {
  .agent-entry-options { grid-template-columns: 1fr; }
  .agent-presentation-options { grid-template-columns: 1fr; }
  .agent-entry-shortcut { grid-template-columns: minmax(0, 1fr) 32px auto; }
  .agent-entry-shortcut > span { grid-column: 1 / -1; }
}
@media (max-width: 42.5rem) {
  .agent-entry-shortcut { grid-template-columns: minmax(0, 1fr) 32px; }
  .agent-entry-shortcut :deep(.el-button) { grid-column: 1 / -1; width: 100%; }
}
</style>
