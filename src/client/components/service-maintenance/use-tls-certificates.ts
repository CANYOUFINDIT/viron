import { translate as tr } from "../../i18n";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, reactive, ref } from "vue";
import { api } from "../../api";
import {
  formatFingerprint,
  groupTlsEndpoints,
  tlsEndpointAttention,
  type TlsCertificateGroup,
  type TlsEndpoint,
} from "../../../shared/tls-certificates";
import type { MaintenancePanelEmit, MaintenancePanelProps } from "./types";
import { deferMaintenancePart, type MaintenanceContext } from "./context";

export function useTlsCertificates(ctx: MaintenanceContext, props: Readonly<MaintenancePanelProps>, _emit: MaintenancePanelEmit) {
  const $payload = deferMaintenancePart(ctx, "payload");
  const certificateDialog = ref(false);
  const editingEndpointId = ref("");
  const probingEndpointIds = ref(new Set<string>());
  const selectedCertificateKey = ref("");
  const certificateForm = reactive({
    host: "",
    port: 443,
    sni: "",
    sshConnectionId: "" as string | null,
    observeEnabled: true,
  });

  const certificateGroups = computed(() => groupTlsEndpoints($payload.payload.value.tlsEndpoints ?? []));

  const selectedCertificate = computed(() =>
    certificateGroups.value.find((item) => item.key === selectedCertificateKey.value) ?? certificateGroups.value[0] ?? null,
  );

  const expiringCertificates = computed(() => certificateGroups.value.filter((item) => item.daysRemaining != null && item.daysRemaining >= 0 && item.daysRemaining <= $payload.payload.value.alertSettings.tlsWarnDays).length);
  const expiredCertificates = computed(() => certificateGroups.value.filter((item) => item.daysRemaining != null && item.daysRemaining < 0).length);
  const unboundCertificates = computed(() => ($payload.payload.value.tlsEndpoints ?? []).filter((item) => !item.sshConnectionId).length);

  function selectCertificate(key: string) {
    selectedCertificateKey.value = key;
    $payload.activeWorkspace.value = "certificate";
  }

  function certificateTone(group: TlsCertificateGroup) {
    if (group.daysRemaining != null && group.daysRemaining < 0) return "expired";
    if (group.daysRemaining != null && group.daysRemaining <= $payload.payload.value.alertSettings.tlsWarnDays) return "expiring";
    if (group.hostnameMatch === false) return "mismatch";
    if (group.endpoints.some((item) => !item.sshConnectionId)) return "unbound";
    if (group.endpoints.some((item) => item.probeStatus !== "ok" && item.probeStatus !== "never" && item.probeStatus !== "skipped")) return "failed";
    return "ok";
  }

  function certificateSummary(group: TlsCertificateGroup) {
    const tone = certificateTone(group);
    if (tone === "expired") return tr("已过期");
    if (tone === "expiring") return tr("{{0}} 天后到期", [group.daysRemaining ?? 0]);
    if (tone === "mismatch") return tr("主机名不匹配");
    if (tone === "unbound") return tr("待关联主机");
    if (tone === "failed") return tr("探测失败");
    if (group.daysRemaining != null) return tr("剩余 {{0}} 天", [group.daysRemaining]);
    return tr("尚未探测");
  }

  function endpointStatusLabel(endpoint: TlsEndpoint) {
    const attention = tlsEndpointAttention(endpoint, $payload.payload.value.alertSettings.tlsWarnDays);
    if (attention === "unbound") return tr("待关联主机");
    if (attention === "expired") return tr("已过期");
    if (attention === "expiring") return tr("即将过期");
    if (attention === "mismatch") return tr("主机名不匹配");
    if (attention === "failed") {
      if (endpoint.probeStatus === "probe_unavailable") return tr("目标机缺少 OpenSSL");
      return tr("探测失败");
    }
    if (endpoint.probeStatus === "never") return tr("尚未探测");
    return tr("正常");
  }

  function fingerprintLabel(value: string) {
    return value ? formatFingerprint(value) : tr("尚未取得指纹");
  }

  function openCertificateCreate() {
    editingEndpointId.value = "";
    const host = $payload.selectedHost.value;
    Object.assign(certificateForm, {
      host: host?.host ?? "",
      port: 443,
      sni: "",
      sshConnectionId: host?.sshConnectionId ?? null,
      observeEnabled: true,
    });
    certificateDialog.value = true;
  }

  function openCertificateEdit(endpoint: TlsEndpoint) {
    editingEndpointId.value = endpoint.id;
    Object.assign(certificateForm, {
      host: endpoint.host,
      port: endpoint.port,
      sni: endpoint.sni,
      sshConnectionId: endpoint.sshConnectionId,
      observeEnabled: endpoint.observeEnabled,
    });
    certificateDialog.value = true;
  }

  async function saveCertificate() {
    if (!certificateForm.host.trim()) return ElMessage.warning(tr("请填写探测主机"));
    $payload.saving.value = true;
    try {
      const body = JSON.stringify({
        host: certificateForm.host.trim(),
        port: certificateForm.port,
        sni: certificateForm.sni.trim(),
        sshConnectionId: certificateForm.sshConnectionId || null,
        observeEnabled: certificateForm.observeEnabled,
      });
      if (editingEndpointId.value) {
        await api(`/api/v1/tls-endpoints/${editingEndpointId.value}`, { method: "PUT", body });
      } else {
        const created = await api<{ id: string }>(`/api/v1/environments/${props.environmentId}/tls-endpoints`, { method: "POST", body });
        selectedCertificateKey.value = `pending:${created.id}`;
        $payload.activeWorkspace.value = "certificate";
      }
      certificateDialog.value = false;
      await $payload.reload();
      ElMessage.success(tr("证书端点已保存"));
    } finally {
      $payload.saving.value = false;
    }
  }

  async function removeCertificate(endpoint: TlsEndpoint) {
    try {
      await ElMessageBox.confirm(tr("删除后将停止观察 {{0}}:{{1}}，已产生的证书告警会恢复。", [endpoint.host, endpoint.port]), tr("删除证书端点"), { type: "warning" });
    } catch {
      return;
    }
    await api(`/api/v1/tls-endpoints/${endpoint.id}`, { method: "DELETE" });
    await $payload.reload();
    ElMessage.success(tr("证书端点已删除"));
  }

  async function probeCertificate(endpoint: TlsEndpoint) {
    probingEndpointIds.value = new Set(probingEndpointIds.value).add(endpoint.id);
    try {
      await api(`/api/v1/tls-endpoints/${endpoint.id}/probe`, { method: "POST" });
      await $payload.reload();
      ElMessage.success(tr("已完成重新探测"));
    } finally {
      const next = new Set(probingEndpointIds.value);
      next.delete(endpoint.id);
      probingEndpointIds.value = next;
    }
  }

  function applyCertificateFocus() {
    if (!props.focusEndpointId) return false;
    const endpoint = ($payload.payload.value.tlsEndpoints ?? []).find((item) => item.id === props.focusEndpointId);
    if (!endpoint) return false;
    selectCertificate(endpoint.fingerprintSha256 || `pending:${endpoint.id}`);
    return true;
  }

  return {
    certificateDialog,
    editingEndpointId,
    probingEndpointIds,
    selectedCertificateKey,
    certificateForm,
    certificateGroups,
    selectedCertificate,
    expiringCertificates,
    expiredCertificates,
    unboundCertificates,
    selectCertificate,
    certificateTone,
    certificateSummary,
    endpointStatusLabel,
    fingerprintLabel,
    openCertificateCreate,
    openCertificateEdit,
    saveCertificate,
    removeCertificate,
    probeCertificate,
    applyCertificateFocus,
  };
}
