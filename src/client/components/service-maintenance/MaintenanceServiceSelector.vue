<script setup lang="ts">
import { ArrowDown, ArrowUp, Box, EllipsisVertical, GripVertical, RefreshCw, Server } from "@lucide/vue";

const { m } = defineProps<{ m: Record<string, any> }>();
const {
  payload,
  activeWorkspace,
  selectedService,
  selectedHost,
  savingServiceOrder,
  savingHostOrder,
  draggingDirectory,
  serviceDropTarget,
  hostDropTarget,
  canSortDirectory,
  summarizeService,
  hostPresence,
  hostLiveCpu,
  openWorkspaceTab,
  selectService,
  selectHost,
  dragDirectoryOver,
  leaveDirectoryDropTarget,
  dropDirectoryItem,
  startDirectoryDrag,
  endDirectoryDrag,
  handleDirectoryMove,
  canMoveDirectoryItem,
} = m;
</script>

<template>
  <aside class="maintenance-directory">
    <section v-show="activeWorkspace === 'service'" class="directory-group">
      <header><h3>{{ $t('服务清单') }}</h3><RefreshCw v-if="savingServiceOrder" :size="13" class="is-spinning" /><span>{{ payload.services.length }}</span></header>
      <div class="directory-list">
        <article
          v-for="service in payload.services"
          :key="service.id"
          class="service-index__row"
          :class="{
            'is-active': activeWorkspace === 'service' && selectedService?.id === service.id,
            'is-dragging': draggingDirectory?.kind === 'service' && draggingDirectory.id === service.id,
            'is-drop-before': serviceDropTarget?.id === service.id && !serviceDropTarget.after,
            'is-drop-after': serviceDropTarget?.id === service.id && serviceDropTarget.after,
          }"
          :data-directory-id="service.id"
          @dragover="dragDirectoryOver('service', service.id, $event)"
          @dragleave="leaveDirectoryDropTarget('service', $event)"
          @drop="dropDirectoryItem('service', service.id, $event)"
        >
          <span v-if="payload.canConfigure" class="directory-row__grip" :class="{ 'is-disabled': !canSortDirectory }" :draggable="canSortDirectory" :title="$t('拖动服务排序')" aria-hidden="true" @dragstart="startDirectoryDrag('service', service.id, $event)" @dragend="endDirectoryDrag"><GripVertical :size="14" /></span>
          <span v-else class="directory-row__spacer"></span>
          <button class="directory-row__main" type="button" :aria-pressed="activeWorkspace === 'service' && selectedService?.id === service.id" @click="selectService(service.id)">
            <span class="service-mark" :class="`is-${summarizeService(service).status}`"><Box :size="16" /></span>
            <span><strong>{{ service.name }}</strong><small>{{ summarizeService(service).label }}<template v-if="service.deployments.length"> · {{ service.deployments.length }} {{ $t('节点') }}</template></small></span>
          </button>
          <el-dropdown v-if="payload.canConfigure" class="directory-row__menu-target" trigger="click" placement="bottom-end" @command="handleDirectoryMove('service', service.id, $event)">
            <button class="directory-row__menu" type="button" :disabled="!canSortDirectory" :aria-label="$t('调整服务顺序')" :title="$t('调整服务顺序')"><EllipsisVertical :size="14" /></button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item command="up" :disabled="!canMoveDirectoryItem('service', service.id, 'up')"><ArrowUp :size="14" />{{ $t('上移') }}</el-dropdown-item><el-dropdown-item command="down" :disabled="!canMoveDirectoryItem('service', service.id, 'down')"><ArrowDown :size="14" />{{ $t('下移') }}</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </article>
        <div v-if="!payload.services.length" class="directory-empty"><Box :size="17" /><span>{{ $t('尚未录入服务') }}</span></div>
      </div>
    </section>

    <section v-show="activeWorkspace === 'host'" class="directory-group">
      <header><h3>{{ $t('SSH 宿主机') }}</h3><RefreshCw v-if="savingHostOrder" :size="13" class="is-spinning" /><span>{{ payload.hosts.length }}</span></header>
      <div class="directory-list">
        <article
          v-for="host in payload.hosts"
          :key="host.sshConnectionId"
          class="host-index__row"
          :class="{
            'is-active': activeWorkspace === 'host' && selectedHost?.sshConnectionId === host.sshConnectionId,
            'is-dragging': draggingDirectory?.kind === 'host' && draggingDirectory.id === host.sshConnectionId,
            'is-drop-before': hostDropTarget?.id === host.sshConnectionId && !hostDropTarget.after,
            'is-drop-after': hostDropTarget?.id === host.sshConnectionId && hostDropTarget.after,
          }"
          :data-directory-id="host.sshConnectionId"
          @dragover="dragDirectoryOver('host', host.sshConnectionId, $event)"
          @dragleave="leaveDirectoryDropTarget('host', $event)"
          @drop="dropDirectoryItem('host', host.sshConnectionId, $event)"
        >
          <span v-if="payload.canConfigure" class="directory-row__grip" :class="{ 'is-disabled': !canSortDirectory }" :draggable="canSortDirectory" :title="$t('拖动宿主机排序')" aria-hidden="true" @dragstart="startDirectoryDrag('host', host.sshConnectionId, $event)" @dragend="endDirectoryDrag"><GripVertical :size="14" /></span>
          <span v-else class="directory-row__spacer"></span>
          <button class="directory-row__main" type="button" :aria-pressed="activeWorkspace === 'host' && selectedHost?.sshConnectionId === host.sshConnectionId" @click="selectHost(host.sshConnectionId)"><Server :size="15" /><span><strong>{{ host.connectionName }}</strong><small>{{ hostPresence(host).label }}<template v-if="hostLiveCpu(host)"> · CPU {{ hostLiveCpu(host) }}</template></small></span><i :class="`is-${hostPresence(host).key}`"></i></button>
          <el-dropdown v-if="payload.canConfigure" class="directory-row__menu-target" trigger="click" placement="bottom-end" @command="handleDirectoryMove('host', host.sshConnectionId, $event)">
            <button class="directory-row__menu" type="button" :disabled="!canSortDirectory" :aria-label="$t('调整宿主机顺序')" :title="$t('调整宿主机顺序')"><EllipsisVertical :size="14" /></button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item command="up" :disabled="!canMoveDirectoryItem('host', host.sshConnectionId, 'up')"><ArrowUp :size="14" />{{ $t('上移') }}</el-dropdown-item><el-dropdown-item command="down" :disabled="!canMoveDirectoryItem('host', host.sshConnectionId, 'down')"><ArrowDown :size="14" />{{ $t('下移') }}</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </article>
        <div v-if="!payload.hosts.length" class="directory-empty"><Server :size="17" /><span>{{ $t('尚未关联 SSH 主机') }}</span></div>
      </div>
    </section>
  </aside>
</template>
