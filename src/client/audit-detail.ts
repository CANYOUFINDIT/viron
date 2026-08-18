import { translate as tr } from "./i18n";
interface DetailDefinition {
  key: string;
  label: string;
  unit?: string;
}

const detailDefinitions: DetailDefinition[] = [
  { key: "status", label: tr("状态") },
  { key: "durationMs", label: tr("耗时"), unit: "ms" },
  { key: "latencyMs", label: tr("延迟"), unit: "ms" },
  { key: "rowCount", label: tr("行数") },
  { key: "changed", label: tr("变更") },
  { key: "operations", label: tr("操作数") },
  { key: "count", label: tr("数量") },
  { key: "imported", label: tr("导入") },
  { key: "reused", label: tr("复用") },
  { key: "skipped", label: tr("跳过") },
  { key: "completedFiles", label: tr("完成文件") },
  { key: "skippedFiles", label: tr("跳过文件") },
  { key: "transferredBytes", label: tr("传输字节") },
  { key: "byteLength", label: tr("响应字节") },
  { key: "database", label: tr("数据库") },
  { key: "format", label: tr("格式") },
  { key: "mode", label: tr("模式") },
  { key: "host", label: tr("主机") },
  { key: "port", label: tr("端口") },
  { key: "path", label: tr("路径") },
  { key: "newPath", label: tr("新路径") },
  { key: "destination", label: tr("目标路径") },
  { key: "filename", label: tr("文件") },
  { key: "command", label: tr("命令") },
  { key: "argumentCount", label: tr("参数数") },
  { key: "access", label: tr("访问") },
  { key: "reason", label: tr("原因") },
  { key: "stage", label: tr("阶段") },
  { key: "role", label: tr("角色") },
  { key: "type", label: tr("类型") },
  { key: "itemType", label: tr("对象") },
  { key: "executionMode", label: tr("执行方式") },
  { key: "version", label: tr("版本") },
  { key: "includeData", label: tr("包含数据") },
  { key: "complete", label: tr("扫描完成") },
  { key: "updated", label: tr("更新") },
  { key: "deleted", label: tr("删除") },
];

const valueLabels: Record<string, string> = {
  success: tr("成功"),
  error: tr("失败"),
  cancelled: tr("已取消"),
  completed: tr("已完成"),
  interrupted: tr("已中断"),
  read: tr("只读"),
  write: tr("写入"),
  "desktop-local": tr("本机 App"),
};

function displayValue(value: unknown): string | null {
  if (typeof value === "boolean") return value ? tr("是") : tr("否");
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 80 || /[\r\n]/.test(normalized)) return null;
  return valueLabels[normalized] ?? normalized;
}

export function auditDetailSummary(details: Record<string, unknown> | null | undefined): string[] {
  if (!details) return [];
  const summary: string[] = [];
  for (const definition of detailDefinitions) {
    const value = displayValue(details[definition.key]);
    if (value === null) continue;
    summary.push(`${definition.label} ${value}${definition.unit ? ` ${definition.unit}` : ""}`);
    if (summary.length === 3) break;
  }
  return summary;
}
