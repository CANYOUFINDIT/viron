import { translate as tr } from "./i18n";
import type { MonitorAlertItem, MonitorAlertNotificationPhase } from "../shared/monitor-alerts";

function number(details: Record<string, unknown>, key: string): number | null {
  const value = Number(details[key]);
  return Number.isFinite(value) ? value : null;
}

function percent(value: number | null): string {
  return value == null ? tr("未知") : `${value.toFixed(1)}%`;
}

function temperature(value: number | null): string {
  return value == null ? tr("未知") : `${value.toFixed(1)}°C`;
}

function diskLabel(alert: MonitorAlertItem): string {
  const device = String(alert.details.device ?? "").trim();
  const path = String(alert.details.path ?? "").trim();
  if (device && path) return `${device} · ${path}`;
  return path || device || alert.ruleKey;
}

export function monitorAlertTitle(alert: MonitorAlertItem, phase: MonitorAlertNotificationPhase): string {
  const location = `${tr(alert.workspaceName)} / ${alert.environmentName}`;
  if (alert.ruleType === "disk_added") return tr("监控事件 · {0}", [location]);
  if (phase === "escalated") return tr("监控升级 · {0}", [location]);
  return phase === "active"
    ? tr("监控告警 · {0}", [location])
    : tr("监控已恢复 · {0}", [location]);
}

export function monitorAlertBody(alert: MonitorAlertItem, phase: MonitorAlertNotificationPhase): string {
  const target = alert.targetName || alert.connectionName;
  const recovered = phase === "recovered";
  if (alert.ruleType === "host_offline") {
    return recovered
      ? tr("{0} 的监控采集已恢复", [target])
      : tr("{0} 连续两次无法取得有效监控数据", [target]);
  }
  if (alert.ruleType === "cpu") {
    return recovered
      ? tr("{0} 的 CPU 使用率已恢复到阈值以内", [target])
      : tr("{0} 的 CPU 使用率达到 {1}，阈值为 {2}", [target, percent(number(alert.details, "value")), percent(number(alert.details, "threshold"))]);
  }
  if (alert.ruleType === "memory") {
    return recovered
      ? tr("{0} 的内存使用率已恢复到阈值以内", [target])
      : tr("{0} 的内存使用率达到 {1}，阈值为 {2}", [target, percent(number(alert.details, "value")), percent(number(alert.details, "threshold"))]);
  }
  if (alert.ruleType === "disk_usage") {
    return recovered
      ? tr("{0} 的磁盘 {1} 使用率已恢复到阈值以内", [target, diskLabel(alert)])
      : tr("{0} 的磁盘 {1} 使用率达到 {2}，阈值为 {3}", [target, diskLabel(alert), percent(number(alert.details, "value")), percent(number(alert.details, "threshold"))]);
  }
  if (alert.ruleType === "temperature") {
    return recovered
      ? tr("{0} 的温度已恢复到阈值以内", [target])
      : tr("{0} 的温度达到 {1}，阈值为 {2}", [target, temperature(number(alert.details, "value")), temperature(number(alert.details, "threshold"))]);
  }
  if (alert.ruleType === "disk_added") {
    return tr("{0} 检测到新增磁盘挂载 {1}", [target, diskLabel(alert)]);
  }
  if (alert.ruleType === "disk_missing") {
    return recovered
      ? tr("{0} 的磁盘 {1} 已重新出现", [target, diskLabel(alert)])
      : tr("{0} 的磁盘 {1} 连续两次采集未出现，可能已经掉盘", [target, diskLabel(alert)]);
  }
  if (alert.ruleType === "tls_expired") {
    return recovered
      ? tr("{0} 的证书已更新到有效期内", [target])
      : tr("{0} 的证书已经过期", [target]);
  }
  if (alert.ruleType === "tls_expiring") {
    const days = number(alert.details, "daysRemaining");
    return recovered
      ? tr("{0} 的证书有效期已回到告警阈值以上", [target])
      : tr("{0} 的证书将在 {1} 天后过期", [target, days == null ? tr("不久") : String(days)]);
  }
  if (alert.ruleType === "tls_hostname_mismatch") {
    return recovered
      ? tr("{0} 的证书主机名已匹配", [target])
      : tr("{0} 的证书主机名与 SNI 不匹配", [target]);
  }
  const status = String(alert.details.status ?? tr("异常"));
  return recovered
    ? tr("服务 {0} 的部署节点 {1} 已恢复运行", [alert.serviceName, target])
    : tr("服务 {0} 的部署节点 {1} 状态异常：{2}", [alert.serviceName, target, status]);
}

export function monitorAlertRuleLabel(alert: Pick<MonitorAlertItem, "ruleType">): string {
  return ({
    host_offline: tr("宿主机离线"),
    cpu: "CPU",
    memory: tr("内存"),
    disk_usage: tr("磁盘使用率"),
    temperature: tr("温度"),
    disk_added: tr("新增磁盘"),
    disk_missing: tr("掉盘"),
    deployment_status: tr("部署状态"),
    tls_expiring: tr("证书即将过期"),
    tls_expired: tr("证书已过期"),
    tls_hostname_mismatch: tr("证书主机名不匹配"),
  })[alert.ruleType];
}
