<script setup lang="ts">
import { Plus } from "@lucide/vue";
import MaintenanceDeploymentCard from "./MaintenanceDeploymentCard.vue";

const { m } = defineProps<{ m: Record<string, any> }>();
const emit = defineEmits<{ "open-log": [id: string]; "open-ssh": [id: string] }>();
const {
  payload,
  selectedService,
  selectedDeploymentIds,
  selectAllVisibleDeployments,
  openDeploymentCreate,
} = m;
</script>

<template>
  <section class="deployment-board">
    <div v-if="payload.canOperate && selectedService.deployments.length" class="deployment-select-all">
      <label><input type="checkbox" :checked="selectedService.deployments.every((item: { id: string }) => selectedDeploymentIds.includes(item.id))" @change="selectAllVisibleDeployments">{{ $t('全选节点') }}</label>
    </div>
    <div class="deployment-grid">
      <MaintenanceDeploymentCard
        v-for="deployment in selectedService.deployments"
        :key="deployment.id"
        :m="m"
        :deployment="deployment"
        @open-log="emit('open-log', $event)"
        @open-ssh="emit('open-ssh', $event)"
      />
      <button v-if="payload.canConfigure && !selectedService.deployments.length" class="deployment-empty-action" type="button" @click="openDeploymentCreate()"><Plus :size="18" /><strong>{{ $t('添加部署节点') }}</strong></button>
    </div>
  </section>
</template>
