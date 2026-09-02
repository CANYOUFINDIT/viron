import { Cron } from "croner";

export const CONNECTION_SOURCE_SCHEDULE_PRESETS = [
  { id: "every-15m", expression: "*/15 * * * *", label: "每 15 分钟" },
  { id: "every-30m", expression: "*/30 * * * *", label: "每 30 分钟" },
  { id: "hourly", expression: "0 * * * *", label: "每小时" },
  { id: "every-6h", expression: "0 */6 * * *", label: "每 6 小时" },
  { id: "every-12h", expression: "0 */12 * * *", label: "每 12 小时" },
  { id: "daily-2am", expression: "0 2 * * *", label: "每天 02:00" },
] as const;

export type ConnectionSourceSchedulePresetId = (typeof CONNECTION_SOURCE_SCHEDULE_PRESETS)[number]["id"] | "custom";

export const DEFAULT_CONNECTION_SOURCE_SCHEDULE_EXPRESSION = "0 */6 * * *";

export function matchConnectionSourceSchedulePreset(expression: string | null | undefined): ConnectionSourceSchedulePresetId {
  const trimmed = expression?.trim() ?? "";
  return CONNECTION_SOURCE_SCHEDULE_PRESETS.find((item) => item.expression === trimmed)?.id ?? (trimmed ? "custom" : "every-6h");
}

export function connectionSourceScheduleExpressionForPreset(preset: ConnectionSourceSchedulePresetId, customExpression = ""): string {
  if (preset === "custom") return customExpression.trim();
  return CONNECTION_SOURCE_SCHEDULE_PRESETS.find((item) => item.id === preset)?.expression ?? DEFAULT_CONNECTION_SOURCE_SCHEDULE_EXPRESSION;
}

export function cronExpressionError(expression: string): string | null {
  if (!expression.trim()) return "启用定时同步时必须填写 Cron 表达式";
  try {
    const probe = new Cron(expression, { paused: true });
    if (!probe.nextRun()) return "Cron 表达式没有可执行的下次时间";
    probe.stop();
    return null;
  } catch {
    return "Cron 表达式无效";
  }
}

export function nextCronRun(expression: string, from?: Date): Date | null {
  if (cronExpressionError(expression)) return null;
  const probe = new Cron(expression, { paused: true });
  const next = from ? probe.nextRun(from) : probe.nextRun();
  probe.stop();
  return next;
}

export function isConnectionSourceScheduleOverdue(expression: string, lastSyncedAt: string | null, now = new Date()): boolean {
  if (!lastSyncedAt || cronExpressionError(expression)) return false;
  const last = new Date(lastSyncedAt);
  if (Number.isNaN(last.getTime())) return false;
  const nextAfterLast = nextCronRun(expression, last);
  return Boolean(nextAfterLast && nextAfterLast.getTime() <= now.getTime());
}
