import { ElMessage, ElMessageBox } from "element-plus";
import { ref, type ComputedRef } from "vue";
import { api } from "../../api";
import { translate as tr } from "../../i18n";
import type { Deployment, ServiceItem } from "./types";

type MaintenanceAction = "start" | "stop" | "restart";

interface OperationTarget {
  deploymentId?: string;
  targetName?: string;
  ok: boolean;
  message: string;
  durationMs?: number;
}

interface OperationItem {
  id: string;
  status: string;
  result?: {
    succeeded: number;
    failed: number;
    targets?: OperationTarget[];
  };
}

export function useMaintenanceActions(
  selectedService: ComputedRef<ServiceItem | null>,
  reload: () => Promise<void>,
) {
  const runningAction = ref("");
  const selectedDeploymentIds = ref<string[]>([]);
  const batchDialog = ref(false);
  const batchOperation = ref<{
    id: string;
    action: MaintenanceAction;
    status: string;
    succeeded: number;
    failed: number;
    targets: Array<{ deploymentId: string; targetName: string; ok: boolean; message: string; durationMs: number }>;
  } | null>(null);

  async function pollOperation(operationId: string) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await api<{ item: OperationItem }>(`/api/v1/service-operations/${operationId}`);
      if (response.item.status !== "queued" && response.item.status !== "running") return response.item;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(tr("操作超时"));
  }

  async function runMaintenanceAction(deployment: Deployment, action: MaintenanceAction) {
    const actionLabel = ({ start: tr("启动"), stop: tr("停止"), restart: tr("重启") })[action];
    await ElMessageBox.confirm(tr("确定要{{0}}“{{1}}”吗？命令将在 {{2}} 上执行。", [actionLabel, deployment.displayName || deployment.externalId, deployment.sshConnectionName]), tr("确认维护动作"), { type: action === "stop" ? "warning" : "info" });
    runningAction.value = `${deployment.id}:${action}`;
    try {
      const created = await api<{ item: { id: string } }>(`/api/v1/service-deployments/${deployment.id}/actions`, {
        method: "POST",
        headers: { "Idempotency-Key": `${crypto.randomUUID()}${crypto.randomUUID()}`.slice(0, 48) },
        body: JSON.stringify({ action }),
      });
      const item = await pollOperation(created.item.id);
      await reload();
      if (item.status === "succeeded") ElMessage.success(tr("{{0}}动作已完成", [actionLabel]));
      else ElMessage.warning(item.result?.targets?.find((target) => !target.ok)?.message || tr("{{0}}动作未完全成功", [actionLabel]));
    } finally {
      runningAction.value = "";
    }
  }

  function toggleDeploymentSelection(id: string) {
    selectedDeploymentIds.value = selectedDeploymentIds.value.includes(id)
      ? selectedDeploymentIds.value.filter((item) => item !== id)
      : [...selectedDeploymentIds.value, id];
  }

  function selectAllVisibleDeployments() {
    const ids = selectedService.value?.deployments.map((item) => item.id) ?? [];
    const allSelected = ids.length > 0 && ids.every((id) => selectedDeploymentIds.value.includes(id));
    selectedDeploymentIds.value = allSelected
      ? selectedDeploymentIds.value.filter((id) => !ids.includes(id))
      : [...new Set([...selectedDeploymentIds.value, ...ids])];
  }

  function clearDeploymentSelection() {
    selectedDeploymentIds.value = [];
  }

  async function runBatchMaintenanceAction(action: MaintenanceAction, deploymentIds = selectedDeploymentIds.value) {
    const actionLabel = ({ start: tr("启动"), stop: tr("停止"), restart: tr("重启") })[action];
    const ids = [...new Set(deploymentIds)].slice(0, 50);
    if (!ids.length) return;
    await ElMessageBox.confirm(tr("确定要批量{{0}} {{1}} 个部署节点吗？命令将通过已有 SSH 连接执行。", [actionLabel, ids.length]), tr("确认批量维护动作"), { type: action === "stop" ? "warning" : "info" });
    runningAction.value = `batch:${action}`;
    batchDialog.value = true;
    batchOperation.value = { id: "", action, status: "queued", succeeded: 0, failed: 0, targets: [] };
    try {
      const created = await api<{ item: { id: string } }>("/api/v1/service-deployments/actions", {
        method: "POST",
        headers: { "Idempotency-Key": `${crypto.randomUUID()}${crypto.randomUUID()}`.slice(0, 48) },
        body: JSON.stringify({ action, deploymentIds: ids }),
      });
      const item = await pollOperation(created.item.id);
      batchOperation.value = {
        id: created.item.id,
        action,
        status: item.status,
        succeeded: item.result?.succeeded ?? 0,
        failed: item.result?.failed ?? 0,
        targets: (item.result?.targets ?? []).map((target) => ({
          deploymentId: String(target.deploymentId ?? ""),
          targetName: String(target.targetName ?? ""),
          ok: Boolean(target.ok),
          message: String(target.message ?? ""),
          durationMs: Number(target.durationMs ?? 0),
        })),
      };
      await reload();
      if (item.status === "succeeded") ElMessage.success(tr("批量{{0}}已完成", [actionLabel]));
      else ElMessage.warning(tr("批量{{0}}未完全成功", [actionLabel]));
    } finally {
      runningAction.value = "";
    }
  }

  async function retryFailedBatchTargets() {
    const failedIds = (batchOperation.value?.targets ?? []).filter((item) => !item.ok && item.deploymentId).map((item) => item.deploymentId);
    if (!failedIds.length || !batchOperation.value) return;
    await runBatchMaintenanceAction(batchOperation.value.action, failedIds);
  }

  return {
    runningAction,
    selectedDeploymentIds,
    batchDialog,
    batchOperation,
    runMaintenanceAction,
    toggleDeploymentSelection,
    selectAllVisibleDeployments,
    clearDeploymentSelection,
    runBatchMaintenanceAction,
    retryFailedBatchTargets,
  };
}
