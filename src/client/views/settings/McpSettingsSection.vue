<script setup lang="ts">
import { useSettingsContext } from "./context";
import { AlertTriangle, Laptop, Power, RadioTower, Server, ShieldCheck } from "@lucide/vue";
import McpApprovalModeSelector from "../../components/McpApprovalModeSelector.vue";
import type { SettingsSection } from "./types";

const { changeLocalMcp, changeLocalMcpApprovalMode, codexLocalMcpApprovalMode, desktop, formatMcpTime, localMcp, mcpLoading, mcpSwitching, serverMcp, serverMcpUrl } = useSettingsContext();
const emit = defineEmits<{ "select-section": [key: SettingsSection] }>();
</script>

<template>
<section class="settings-section-panel settings-section-panel--mcp" v-loading="mcpLoading">
          <header><span><RadioTower :size="20" /></span><div><p>MODEL CONTEXT PROTOCOL</p><h3>{{ $t('MCP 服务') }}</h3><small>{{ $t('服务端 MCP 与桌面本机 MCP 相互独立；关闭其中一个不会影响另一个。') }}</small></div></header>

          <section class="mcp-service-card" :class="serverMcp?.enabled ? 'is-running' : 'is-stopped'">
            <header>
              <span><Server :size="20" /></span>
              <div><strong>{{ $t('服务端 MCP') }}</strong><small>{{ $t('由 Viron 服务配置统一控制') }}</small></div>
              <em><i></i>{{ serverMcp?.enabled ? $t('已启用') : $t('未启用') }}</em>
            </header>
            <template v-if="serverMcp?.enabled">
              <dl class="mcp-connection-grid">
                <div><dt>{{ $t('连接地址') }}</dt><dd><code>{{ serverMcpUrl }}</code></dd></div>
                <div><dt>{{ $t('传输协议') }}</dt><dd>Streamable HTTP</dd></div>
                <div><dt>{{ $t('认证方式') }}</dt><dd>{{ $t('个人 API Key') }}</dd></div>
                <div><dt>{{ $t('能力规模') }}</dt><dd>{{ serverMcp.toolCount }} {{ $t('个工具') }} · {{ serverMcp.businessOperationCount }} {{ $t('个业务操作') }}</dd></div>
              </dl>
              <div class="mcp-clients-heading"><strong>{{ $t('当前账号的客户端') }}</strong><span>{{ serverMcp.sessions.length }}</span></div>
              <div v-if="serverMcp.sessions.length" class="mcp-client-list">
                <article v-for="client in serverMcp.sessions" :key="client.id"><span><i></i></span><div><strong>{{ client.clientName }}</strong><small>{{ client.clientVersion || $t('版本未知') }}</small></div><time>{{ formatMcpTime(client.lastActivityAt) }}</time></article>
              </div>
              <p v-else class="mcp-empty">{{ $t('当前账号没有远程 MCP 客户端连接') }}</p>
              <div class="mcp-remote-policy-note"><ShieldCheck :size="15" /><span>{{ $t('远程 MCP 的 Viron 审批策略按个人 API Key 保存，可在“API Key”中为每个 Codex 连接独立设置。') }}</span><el-button text type="primary" @click="emit('select-section', 'api-keys')">{{ $t('管理 API Key') }}</el-button></div>
            </template>
            <p v-else class="mcp-disabled-note"><ShieldCheck :size="17" />{{ $t('管理员未在服务配置中启用 VIRON_MCP_ENABLED；远程 /mcp 不对外监听。') }}</p>
          </section>

          <section v-if="desktop && localMcp" class="mcp-service-card is-local" :class="localMcp.running ? 'is-running' : 'is-stopped'">
            <header>
              <span><Laptop :size="20" /></span>
              <div><strong>{{ $t('本机 MCP') }}</strong><small>{{ $t('只服务当前设备，并复用 App 的登录状态与执行模式') }}</small></div>
              <el-button :type="localMcp.enabled ? 'danger' : 'primary'" plain :loading="mcpSwitching" @click="changeLocalMcp(!localMcp.enabled)"><Power :size="14" />{{ localMcp.enabled ? $t('关闭') : $t('开启') }}</el-button>
            </header>
            <dl class="mcp-connection-grid">
              <div><dt>{{ $t('运行状态') }}</dt><dd><span class="mcp-state-dot" :class="{ 'is-on': localMcp.running }"></span>{{ localMcp.running ? $t('Broker 运行中') : $t('Broker 已停止') }}</dd></div>
              <div><dt>{{ $t('传输协议') }}</dt><dd>{{ localMcp.transport === 'unix' ? 'Unix Domain Socket' : 'Windows Named Pipe' }}</dd></div>
              <div class="is-wide"><dt>{{ $t('STDIO 启动器') }}</dt><dd><code>{{ localMcp.launcherPath }}</code></dd></div>
              <div v-if="localMcp.address" class="is-wide"><dt>{{ $t('Broker 地址') }}</dt><dd><code>{{ localMcp.address }}</code></dd></div>
            </dl>
            <div class="mcp-approval-block">
              <div class="mcp-approval-heading"><div><strong>{{ $t('本机 MCP 审批策略') }}</strong><small>{{ $t('只控制 Viron 是否要求二次确认；不会扩大当前用户、工作空间或连接权限。') }}</small></div><code>{{ localMcp.approvalMode }}</code></div>
              <McpApprovalModeSelector :model-value="localMcp.approvalMode" :disabled="mcpSwitching" @update:model-value="changeLocalMcpApprovalMode" />
              <p><span>{{ $t('Codex 客户端还有独立审批层。要与当前策略一致，请在该 MCP Server 配置中设置：') }}</span><code>default_tools_approval_mode = "{{ codexLocalMcpApprovalMode }}"</code></p>
            </div>
            <p v-if="localMcp.lastError" class="mcp-local-error"><AlertTriangle :size="16" />{{ localMcp.lastError }}</p>
            <div class="mcp-clients-heading"><strong>{{ $t('本机客户端') }}</strong><span>{{ localMcp.clients.length }}</span></div>
            <div v-if="localMcp.clients.length" class="mcp-client-list">
              <article v-for="client in localMcp.clients" :key="client.id"><span><i></i></span><div><strong>{{ client.clientName }}</strong><small>{{ client.clientVersion || $t('版本未知') }} · {{ $t('连接于') }} {{ formatMcpTime(client.connectedAt) }}</small></div><time>{{ formatMcpTime(client.lastActivityAt) }}</time></article>
            </div>
            <p v-else class="mcp-empty">{{ localMcp.running ? $t('等待本机 MCP 客户端连接') : $t('开启后，Codex 等客户端才能通过本机 STDIO 连接') }}</p>
          </section>
        </section>
</template>

<style scoped src="./settings-mcp.css"></style>
