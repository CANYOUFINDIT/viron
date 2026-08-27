import { localizeMessage, translate as tr } from "../../i18n";
import { Activity, ArrowDown, ArrowUp, BellRing, Box, Check, ChevronRight, CircleAlert, Clock3, Database, Download, EllipsisVertical, FileText, GripVertical, Hammer, Package, Pencil, Play, Plus, Power, RefreshCw, Rocket, RotateCw, ScanSearch, Server, Settings2, ShieldCheck, Square, Terminal, Trash2, Wrench, Zap, } from "@lucide/vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, reactive, ref, watch, type Component } from "vue";
import { api, ApiError } from "../../api";
import { createLatestDataLoader } from "../../latest-data-loader";
import { candidateKey, providerLabel, type CandidateStatus, type MonitorCandidate, type Provider } from "../../service-candidate-tree";
import { normalizeMaintenanceScriptActions } from "../../service-maintenance-payload";
import { reorderIds, sameOrder } from "../../../shared/tab-order";
import { defaultMonitorAlertSettings, monitorDiskKey, type MonitorAlertSettings, } from "../../../shared/monitor-alerts";

import type { MaintenanceWorkspace, HostWorkspaceTab, MaintenanceDirectory, DirectoryMoveDirection, ScriptActionIcon, DirectoryDropTarget, ScriptAction, ScriptActionExecutionResult, ScriptActionExecution, HostSnapshot, KubernetesConfigDiscovery, MonitorHost, MonitorInstallPreflight, MonitorInstallTaskStatus, MonitorInstallTaskPhase, MonitorInstallTask, Deployment, ServiceItem, EnvironmentLog, MaintenancePayload, MaintenanceDeploymentResponse, MaintenanceServiceResponse, MaintenancePayloadResponse, MaintenanceCounts, MaintenancePanelProps, MaintenancePanelEmit } from "./types";
import { deferMaintenancePart, type MaintenanceContext } from "./context";

export function useScriptActions(ctx: MaintenanceContext, props: Readonly<MaintenancePanelProps>, emit: MaintenancePanelEmit) {
  const $payload = deferMaintenancePart(ctx, "payload");
  const $directory = deferMaintenancePart(ctx, "directory");
  const $monitorInstall = deferMaintenancePart(ctx, "monitorInstall");
  const $alertSettings = deferMaintenancePart(ctx, "alertSettings");
  const scriptActionIconComponents: Record<ScriptActionIcon, Component> = {
      terminal: Terminal,
      rocket: Rocket,
      refresh: RefreshCw,
      database: Database,
      package: Package,
      shield: ShieldCheck,
      hammer: Hammer,
      zap: Zap,
  };

  const scriptActionIconOptions = Object.keys(scriptActionIconComponents) as ScriptActionIcon[];

  const runningScriptActionId = ref("");

  const scriptActionManagerDialog = ref(false);

  const scriptActionEditorOpen = ref(false);

  const scriptActionResultDialog = ref(false);

  const editingScriptActionId = ref("");

  const scriptActionExecution = ref<ScriptActionExecution | null>(null);

  const scriptActionScope = reactive({ serviceId: "", deploymentId: null as string | null, label: "" });

  const scriptActionForm = reactive({ name: "", icon: "terminal" as ScriptActionIcon, scriptBody: "" });

  const scopedScriptActions = computed(() => {
      const service = $payload.payload.value.services.find((item) => item.id === scriptActionScope.serviceId);
      if (!service)
          return [];
      if (!scriptActionScope.deploymentId)
          return service.scriptActions;
      return service.deployments.find((item) => item.id === scriptActionScope.deploymentId)?.scriptActions ?? [];
  });

  function resolveScriptActionIcon(icon: ScriptActionIcon) {
      return scriptActionIconComponents[icon] ?? Terminal;
  }

  function resetScriptActionForm() {
      editingScriptActionId.value = "";
      Object.assign(scriptActionForm, { name: "", icon: "terminal", scriptBody: "" });
  }

  function beginScriptActionCreate() {
      resetScriptActionForm();
      scriptActionEditorOpen.value = true;
  }

  async function beginScriptActionEdit(action: ScriptAction) {
      editingScriptActionId.value = action.id;
      Object.assign(scriptActionForm, {
          name: action.name,
          icon: action.icon,
          scriptBody: action.scriptBody ?? "",
      });
      scriptActionEditorOpen.value = true;
      try {
          const response = await api<{ item: ScriptAction }>(`/api/v1/service-script-actions/${action.id}`);
          if (editingScriptActionId.value === action.id) {
              Object.assign(scriptActionForm, {
                  name: response.item.name,
                  icon: response.item.icon,
                  scriptBody: response.item.scriptBody ?? "",
              });
          }
      } catch {
          /* keep metadata from the list DTO if the body cannot be loaded */
      }
  }

  function openScriptActionManager(deployment: Deployment | null = null) {
      const service = $payload.selectedService.value;
      if (!service)
          return;
      Object.assign(scriptActionScope, {
          serviceId: service.id,
          deploymentId: deployment?.id ?? null,
          label: deployment ? (deployment.displayName || deployment.externalId) : service.name,
      });
      resetScriptActionForm();
      scriptActionEditorOpen.value = deployment ? deployment.scriptActions.length === 0 : service.scriptActions.length === 0;
      scriptActionManagerDialog.value = true;
  }

  async function saveScriptAction() {
      if (!scriptActionForm.name.trim())
          return ElMessage.warning(tr("请输入按钮名称"));
      if (!scriptActionForm.scriptBody.trim())
          return ElMessage.warning(tr("请输入脚本正文"));
      $payload.saving.value = true;
      try {
          const body = JSON.stringify({
              deploymentId: scriptActionScope.deploymentId,
              name: scriptActionForm.name,
              icon: scriptActionForm.icon,
              scriptBody: scriptActionForm.scriptBody,
          });
          if (editingScriptActionId.value) {
              await api(`/api/v1/service-script-actions/${editingScriptActionId.value}`, { method: "PUT", body });
          }
          else {
              await api(`/api/v1/services/${scriptActionScope.serviceId}/script-actions`, { method: "POST", body });
          }
          await $payload.reload(true);
          resetScriptActionForm();
          scriptActionEditorOpen.value = false;
          ElMessage.success(tr("功能按钮已保存"));
      }
      finally {
          $payload.saving.value = false;
      }
  }

  async function removeScriptAction(action: ScriptAction) {
      await ElMessageBox.confirm(tr("删除功能按钮“{{0}}”？脚本正文也会一并删除。", [action.name]), tr("删除功能按钮"), { type: "warning" });
      await api(`/api/v1/service-script-actions/${action.id}`, { method: "DELETE" });
      await $payload.reload(true);
      if (editingScriptActionId.value === action.id) {
          resetScriptActionForm();
          scriptActionEditorOpen.value = false;
      }
      ElMessage.success(tr("功能按钮已删除"));
  }

  async function executeScriptAction(action: ScriptAction) {
      const service = $payload.payload.value.services.find((item) => item.id === action.serviceId);
      if (!service)
          return;
      const deployment = action.deploymentId ? service.deployments.find((item) => item.id === action.deploymentId) : null;
      const targetDescription = deployment
          ? tr("节点“{{0}}”", [deployment.displayName || deployment.externalId])
          : tr("服务“{{0}}”的 {{1}} 个部署节点", [service.name, service.deployments.length]);
      await ElMessageBox.confirm(tr("确定执行功能“{{0}}”吗？脚本将通过已有 SSH 连接在{{1}}上以对应 SSH 用户运行。", [action.name, targetDescription]), tr("确认执行脚本"), { type: "warning", confirmButtonText: tr("执行") });
      runningScriptActionId.value = action.id;
      try {
          const created = await api<{ item: { id: string } }>(`/api/v1/service-script-actions/${action.id}/execute`, {
              method: "POST",
              headers: { "Idempotency-Key": `${crypto.randomUUID()}${crypto.randomUUID()}`.slice(0, 48) },
              body: JSON.stringify({}),
          });
          let operation: { status: string; result?: { succeeded: number; failed: number; targets?: ScriptActionExecution["results"] } } | null = null;
          for (let attempt = 0; attempt < 120; attempt += 1) {
              const polled = await api<{ item: { status: string; result?: { succeeded: number; failed: number; targets?: ScriptActionExecution["results"] } } }>(`/api/v1/service-operations/${created.item.id}`);
              operation = polled.item;
              if (operation.status !== "queued" && operation.status !== "running")
                  break;
              await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          const failed = operation?.result?.failed ?? 0;
          scriptActionExecution.value = {
              ok: failed === 0 && operation?.status === "succeeded",
              action: { id: action.id, name: action.name, icon: action.icon, deploymentId: action.deploymentId },
              succeeded: operation?.result?.succeeded ?? 0,
              failed,
              results: operation?.result?.targets ?? [],
          };
          scriptActionResultDialog.value = true;
          if (scriptActionExecution.value.ok)
              ElMessage.success(tr("功能脚本执行成功"));
          else
              ElMessage.warning(tr("功能脚本执行完成，但有 {{0}} 个节点失败", [scriptActionExecution.value.failed]));
      }
      finally {
          runningScriptActionId.value = "";
      }
  }

  function formatScriptDuration(milliseconds: number) {
      if (milliseconds < 1000)
          return `${milliseconds} ms`;
      return `${(milliseconds / 1000).toFixed(1)} s`;
  }

  function scriptExecutionSummary(execution: ScriptActionExecution) {
      return tr("{{0}} 个成功 · {{1}} 个失败", [execution.succeeded, execution.failed]);
  }

  return {
    scriptActionIconComponents,
    scriptActionIconOptions,
    runningScriptActionId,
    scriptActionManagerDialog,
    scriptActionEditorOpen,
    scriptActionResultDialog,
    editingScriptActionId,
    scriptActionExecution,
    scriptActionScope,
    scriptActionForm,
    scopedScriptActions,
    resolveScriptActionIcon,
    resetScriptActionForm,
    beginScriptActionCreate,
    beginScriptActionEdit,
    openScriptActionManager,
    saveScriptAction,
    removeScriptAction,
    executeScriptAction,
    formatScriptDuration,
    scriptExecutionSummary,
  };
}

