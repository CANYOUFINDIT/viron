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

export function useMonitorInstall(ctx: MaintenanceContext, props: Readonly<MaintenancePanelProps>, emit: MaintenancePanelEmit) {
  const $payload = deferMaintenancePart(ctx, "payload");
  const $directory = deferMaintenancePart(ctx, "directory");
  const $scriptActions = deferMaintenancePart(ctx, "scriptActions");
  const $alertSettings = deferMaintenancePart(ctx, "alertSettings");
  const installingHosts = ref(new Set<string>());

  const clearingHosts = ref(new Set<string>());

  const restartingHosts = ref(new Set<string>());

  const uninstallingHosts = ref(new Set<string>());

  const installTask = ref<MonitorInstallTask | null>(null);

  const installTaskConnectionId = ref("");

  const installProgressDialog = ref(false);

  let installTaskTimer: number | undefined;

  const notifiedInstallTasks = new Set<string>();

  const selectedInstallTask = computed(() => installTaskConnectionId.value === $payload.selectedHost.value?.sshConnectionId ? installTask.value : null);

  const installTaskSteps = computed(() => [
      { phase: "preflight" as const, label: tr("目标预检"), description: tr("系统、架构、权限与目录") },
      { phase: "package_validation" as const, label: tr("校验安装包"), description: tr("版本、架构与 SHA-256") },
      { phase: "ssh_connect" as const, label: tr("建立 SSH 会话"), description: tr("使用已有连接及跳板链路") },
      { phase: "staging" as const, label: tr("准备临时目录"), description: tr("在目标主机创建安全暂存区") },
      { phase: "upload" as const, label: tr("上传安装文件"), description: tr("逐个传输并显示文件进度") },
      { phase: "remote_install" as const, label: tr("安装并启动服务"), description: tr("写入配置和 systemd 单元") },
      { phase: "reconnect" as const, label: tr("重新连接主机"), description: tr("刷新安装后的用户组权限") },
      { phase: "initial_collect" as const, label: tr("首次采集指标"), description: tr("扫描服务并拉取宿主机状态") },
      { phase: "persist" as const, label: tr("保存安装结果"), description: tr("写入 Viron 中心数据库") },
  ]);

  function isInstallTaskActive(task: MonitorInstallTask | null | undefined) {
      return task?.status === "pending" || task?.status === "running";
  }

  function stopInstallTaskPolling() {
      if (installTaskTimer === undefined)
          return;
      window.clearInterval(installTaskTimer);
      installTaskTimer = undefined;
  }

  function startInstallTaskPolling(connectionId: string) {
      if (installTaskTimer !== undefined)
          return;
      installTaskTimer = window.setInterval(() => {
          void refreshInstallTask(connectionId);
      }, 1000);
  }

  function switchInstallTaskHost(connectionId: string) {
      stopInstallTaskPolling();
      installTaskConnectionId.value = connectionId;
      installTask.value = null;
      void refreshInstallTask(connectionId, false);
  }

  async function refreshInstallTask(connectionId: string, notify = true) {
      if (!connectionId)
          return;
      const previous = installTaskConnectionId.value === connectionId ? installTask.value : null;
      try {
          const response = await api<{
              item: MonitorInstallTask | null;
          }>(`/api/v1/environments/${props.environmentId}/monitor-hosts/${connectionId}/install-task`);
          if (installTaskConnectionId.value !== connectionId)
              return;
          installTask.value = response.item;
          if (isInstallTaskActive(response.item)) {
              startInstallTaskPolling(connectionId);
              return;
          }
          stopInstallTaskPolling();
          if (!notify || !response.item || !isInstallTaskActive(previous) || notifiedInstallTasks.has(response.item.id))
              return;
          notifiedInstallTasks.add(response.item.id);
          await $payload.reload(true);
          if (response.item.status === "success") {
              const warning = response.item.result.monitorWarning;
              if (warning)
                  ElMessage.warning(tr("监控服务已安装，但首次采集失败：{{0}}", [localizeMessage(warning)]));
              else
                  ElMessage.success(tr("监控服务安装完成"));
          }
          else {
              ElMessage.error(tr("监控服务安装失败，请查看详细日志"));
          }
      }
      catch {
          if (isInstallTaskActive(previous))
              startInstallTaskPolling(connectionId);
      }
  }

  async function openInstallProgress(host: MonitorHost) {
      if (installTaskConnectionId.value !== host.sshConnectionId)
          switchInstallTaskHost(host.sshConnectionId);
      await refreshInstallTask(host.sshConnectionId, false);
      if (installTask.value)
          installProgressDialog.value = true;
  }

  function installTaskStepState(index: number) {
      const task = selectedInstallTask.value;
      if (!task)
          return "pending";
      if (task.status === "success" || task.phase === "complete")
          return "complete";
      const current = installTaskSteps.value.findIndex((step) => step.phase === task.phase);
      if (current < 0)
          return index === 0 && isInstallTaskActive(task) ? "active" : "pending";
      if (index < current)
          return "complete";
      if (index > current)
          return "pending";
      return task.status === "error" ? "error" : "active";
  }

  function installTaskStatusLabel(task: MonitorInstallTask) {
      if (task.status === "success")
          return tr("安装完成");
      if (task.status === "error")
          return tr("安装失败");
      if (task.status === "pending")
          return tr("等待执行");
      return tr("正在安装");
  }

  function formatInstallTaskElapsed(task: MonitorInstallTask) {
      const start = task.startedAt ?? task.createdAt;
      const end = task.completedAt ?? new Date().toISOString();
      const seconds = Math.max(0, Math.floor((Date.parse(end) - Date.parse(start)) / 1000));
      const minutes = Math.floor(seconds / 60);
      return minutes ? tr("{{0}} 分 {{1}} 秒", [minutes, seconds % 60]) : tr("{{0}} 秒", [seconds]);
  }

  function formatInstallLogTime(value: string) {
      return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function isMonitorInstalled(host: MonitorHost) {
      return host.monitorStatus === "ready" || Boolean(host.agentId);
  }

  function validMonitorInstallPath(value: string) {
      const path = value.trim().replace(/\/$/, "");
      const segments = path.slice(1).split("/");
      return /^\/opt\/[A-Za-z0-9._/-]+$/.test(path)
          && path !== "/opt"
          && segments.every((segment) => segment && segment !== "." && segment !== "..");
  }

  async function promptMonitorInstallPath(currentPath: string, message: string): Promise<string | null> {
      try {
          const result = await ElMessageBox.prompt(message, tr("修改监控安装目录"), {
              confirmButtonText: tr("重新预检"),
              cancelButtonText: tr("取消"),
              inputValue: currentPath === "/opt/viron/monitor" ? "/opt/viron/monitor-custom" : currentPath,
              inputPlaceholder: "/opt/viron/monitor-custom",
              inputValidator: (value) => validMonitorInstallPath(value) || tr("请输入 /opt 下不含空格和路径回退的绝对目录"),
          });
          return result.value.trim().replace(/\/$/, "");
      }
      catch {
          return null;
      }
  }

  function dangerConfirmOptions(confirmButtonText: string) {
      return {
          confirmButtonText,
          cancelButtonText: tr("取消"),
          type: "warning" as const,
          closeOnClickModal: false,
          closeOnPressEscape: true,
          distinguishCancelAndClose: true,
      };
  }

  async function installMonitorOnHost(host: MonitorHost, intent: "auto" | "reinstall" = "auto") {
      const next = new Set(installingHosts.value);
      next.add(host.sshConnectionId);
      installingHosts.value = next;
      let installPath = host.installPath || "/opt/viron/monitor";
      try {
          while (true) {
              const response = await api<{
                  item: MonitorInstallPreflight;
              }>(`/api/v1/environments/${props.environmentId}/monitor-hosts/${host.sshConnectionId}/install/preflight`, { method: "POST", body: JSON.stringify({ installPath }) });
              const preflight = response.item;
              if (preflight.pathState === "conflict") {
                  const conflict = preflight.issues.find((item) => item.code === "MONITOR_INSTALL_PATH_CONFLICT");
                  const replacement = await promptMonitorInstallPath(preflight.installPath, conflict?.message || tr("默认安装目录存在冲突，请修改安装目录"));
                  if (!replacement)
                      return;
                  installPath = replacement;
                  continue;
              }
              if (!preflight.canInstall) {
                  await ElMessageBox.alert(preflight.issues.map((item) => item.message).join("\n"), tr("无法一键安装"), {
                      confirmButtonText: tr("知道了"),
                      type: "warning",
                  });
                  return;
              }
              const reinstalling = intent === "reinstall";
              const upgrading = !reinstalling && preflight.pathState === "upgrade";
              const privilege = preflight.privilege === "root" ? "root" : tr("免密 sudo");
              if (!reinstalling) {
                  await ElMessageBox.confirm(tr("目标主机：{{0}}\n安装目录：{{1}}\n安装版本：{{2}} · {{3}}\n执行权限：{{4}}\n\n确认后将上传安装包、写入 systemd 单元并启动监控服务。", [
                      `${host.connectionName} (${host.host})`,
                      preflight.installPath,
                      preflight.packageVersion,
                      preflight.architecture ?? preflight.machineArchitecture,
                      privilege,
                  ]), upgrading ? tr("确认更新监控服务") : tr("确认安装监控服务"), dangerConfirmOptions(upgrading ? tr("更新并重启") : tr("安装并启动")));
              }
              const started = await api<{
                  item: MonitorInstallTask;
              }>(`/api/v1/environments/${props.environmentId}/monitor-hosts/${host.sshConnectionId}/install-tasks`, { method: "POST", body: JSON.stringify({ installPath: preflight.installPath }) });
              installTaskConnectionId.value = host.sshConnectionId;
              installTask.value = started.item;
              installProgressDialog.value = true;
              startInstallTaskPolling(host.sshConnectionId);
              return;
          }
      }
      catch (error) {
          if (error === "cancel" || error === "close")
              return;
          if (error instanceof ApiError && error.code === "MONITOR_INSTALL_RUNNING") {
              await openInstallProgress(host);
              return;
          }
          ElMessage.error(error instanceof ApiError || error instanceof Error ? error.message : tr("监控服务安装失败"));
      }
      finally {
          const updated = new Set(installingHosts.value);
          updated.delete(host.sshConnectionId);
          installingHosts.value = updated;
      }
  }

  async function reinstallMonitorOnHost(host: MonitorHost) {
      try {
          await ElMessageBox.confirm(tr("确定重装目标主机“{{0}}”上的 viron-monitor 吗？将重新上传安装包、覆盖 systemd 单元并重启。中心已入库的监控数据不会删除。", [host.connectionName || host.host]), tr("确认重装监控服务"), dangerConfirmOptions(tr("重装并重启")));
      }
      catch {
          return;
      }
      return installMonitorOnHost(host, "reinstall");
  }

  async function restartMonitorOnHost(host: MonitorHost) {
      try {
          await ElMessageBox.confirm(tr("确定重启目标主机“{{0}}”上的 viron-monitor 服务吗？正在进行的采集会被中断，随后可再次扫描并拉取。", [host.connectionName || host.host]), tr("确认重启监控服务"), dangerConfirmOptions(tr("重启")));
      }
      catch {
          return;
      }
      const next = new Set(restartingHosts.value);
      next.add(host.sshConnectionId);
      restartingHosts.value = next;
      try {
          const result = await api<{
              ok: boolean;
              monitorWarning?: string;
          }>(`/api/v1/environments/${props.environmentId}/monitor-hosts/${host.sshConnectionId}/restart`, { method: "POST" });
          await $payload.reload(true);
          if (result.monitorWarning)
              ElMessage.warning(tr("监控服务已重启，但立即扫描失败：{{0}}", [localizeMessage(result.monitorWarning)]));
          else
              ElMessage.success(tr("监控服务已重启"));
      }
      catch (error) {
          ElMessage.error(error instanceof ApiError || error instanceof Error ? error.message : tr("重启监控服务失败"));
      }
      finally {
          const updated = new Set(restartingHosts.value);
          updated.delete(host.sshConnectionId);
          restartingHosts.value = updated;
      }
  }

  async function clearMonitorData(host: MonitorHost) {
      try {
          await ElMessageBox.confirm(tr("仅清理目标主机“{{0}}”上 viron-monitor 的本地缓冲，Viron 服务端已经入库的监控数据不会删除。确定继续吗？", [host.connectionName || host.host]), tr("清理节点监控数据"), dangerConfirmOptions(tr("清理本地缓冲")));
      }
      catch {
          return;
      }
      const next = new Set(clearingHosts.value);
      next.add(host.sshConnectionId);
      clearingHosts.value = next;
      try {
          const result = await api<{
              cleared: {
                  samples: number;
                  gaps: number;
              };
          }>(`/api/v1/environments/${props.environmentId}/monitor-hosts/${host.sshConnectionId}/clear`, { method: "POST" });
          ElMessage.success(tr("已清理目标机本地缓冲：{{0}} 条样本，{{1}} 条缺口记录", [result.cleared.samples, result.cleared.gaps]));
      }
      finally {
          const updated = new Set(clearingHosts.value);
          updated.delete(host.sshConnectionId);
          clearingHosts.value = updated;
      }
  }

  async function uninstallMonitorOnHost(host: MonitorHost) {
      try {
          await ElMessageBox.confirm(
              tr("确定卸载目标主机“{{0}}”上的 viron-monitor 吗？将停止并删除目标机上的服务、程序、配置和本地缓冲；Viron 中心已入库的历史监控数据会保留。确定继续吗？", [host.connectionName || host.host]),
              tr("确认卸载监控探针"),
              dangerConfirmOptions(tr("卸载并删除本地数据")),
          );
      }
      catch {
          return;
      }
      const next = new Set(uninstallingHosts.value);
      next.add(host.sshConnectionId);
      uninstallingHosts.value = next;
      try {
          await api<{
              ok: boolean;
              localDataRemoved: boolean;
              preservedCentralHistory: boolean;
          }>(`/api/v1/environments/${props.environmentId}/monitor-hosts/${host.sshConnectionId}/uninstall`, { method: "DELETE" });
          await $payload.reload(true);
          ElMessage.success(tr("监控探针已卸载，中心历史数据已保留"));
      }
      catch (error) {
          ElMessage.error(error instanceof ApiError || error instanceof Error ? error.message : tr("监控探针卸载失败"));
      }
      finally {
          const updated = new Set(uninstallingHosts.value);
          updated.delete(host.sshConnectionId);
          uninstallingHosts.value = updated;
      }
  }

  return {
    installingHosts,
    clearingHosts,
    restartingHosts,
    uninstallingHosts,
    installTask,
    installTaskConnectionId,
    installProgressDialog,
    installTaskTimer,
    notifiedInstallTasks,
    selectedInstallTask,
    installTaskSteps,
    isInstallTaskActive,
    stopInstallTaskPolling,
    startInstallTaskPolling,
    switchInstallTaskHost,
    refreshInstallTask,
    openInstallProgress,
    installTaskStepState,
    installTaskStatusLabel,
    formatInstallTaskElapsed,
    formatInstallLogTime,
    isMonitorInstalled,
    validMonitorInstallPath,
    promptMonitorInstallPath,
    installMonitorOnHost,
    reinstallMonitorOnHost,
    restartMonitorOnHost,
    clearMonitorData,
    uninstallMonitorOnHost,
  };
}
