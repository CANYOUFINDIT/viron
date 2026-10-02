const HOUR = 3_600_000;
const DAY = 86_400_000;
const MIN_BAR = 1.6;

export type GrantTimelineTone = "expired" | "soon" | "week" | "later" | "forever";

export interface GrantTimelineSource {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  expired?: boolean;
}

export interface GrantTimelineBar {
  id: string;
  label: string;
  tone: GrantTimelineTone;
  remainingMs: number;
  left: number;
  width: number;
  start: number;
  end: number | null;
}

export interface GrantTimelineModel {
  axisStart: number;
  axisEnd: number;
  now: number;
  nowLeft: number;
  bars: GrantTimelineBar[];
}

export const GRANT_TIMELINE_LEGEND: Array<{ tone: GrantTimelineTone; label: string }> = [
  { tone: "expired", label: "已过期" },
  { tone: "soon", label: "1 天内" },
  { tone: "week", label: "7 天内" },
  { tone: "later", label: "更久" },
  { tone: "forever", label: "永久" },
];

function parsed(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function grantTimelineTone(remainingMs: number): GrantTimelineTone {
  if (!Number.isFinite(remainingMs)) return "forever";
  if (remainingMs <= 0) return "expired";
  if (remainingMs <= DAY) return "soon";
  if (remainingMs <= 7 * DAY) return "week";
  return "later";
}

export function grantRemainingCopy(remainingMs: number): { key: string; values: number[] } {
  if (!Number.isFinite(remainingMs)) return { key: "永久", values: [] };
  if (remainingMs <= 0) return { key: "已过期", values: [] };
  if (remainingMs < HOUR) return { key: "不足 1 小时", values: [] };
  if (remainingMs < DAY) return { key: "剩余 {{0}} 小时", values: [Math.max(1, Math.ceil(remainingMs / HOUR))] };
  return { key: "剩余 {{0}} 天", values: [Math.max(1, Math.ceil(remainingMs / DAY))] };
}

export function buildGrantTimeline(grants: readonly GrantTimelineSource[], now = Date.now()): GrantTimelineModel {
  const starts = grants.map((grant) => parsed(grant.createdAt)).filter((value): value is number => value !== null);
  let axisStart = Math.min(now, ...(starts.length ? starts : [now]));
  const finiteEnds = grants.map((grant) => parsed(grant.expiresAt)).filter((value): value is number => value !== null);
  let axisEnd = Math.max(now, ...(finiteEnds.length ? finiteEnds : [now]));
  const span = Math.max(axisEnd - axisStart, DAY);
  axisStart -= span * 0.04;
  axisEnd += span * 0.08;
  // Keep a stretch of future on the axis. Otherwise permanent grants pin 现在 against the end date.
  axisEnd = Math.max(axisEnd, now + Math.max(now - axisStart, DAY) * 0.5);
  const axisSpan = Math.max(axisEnd - axisStart, 1);
  const place = (start: number, end: number) => {
    let width = ((end - start) / axisSpan) * 100;
    let left = ((start - axisStart) / axisSpan) * 100;
    width = Math.max(width, MIN_BAR);
    if (left + width > 100) left = 100 - width;
    left = Math.max(0, Math.min(left, 100 - width));
    return { left, width };
  };
  const bars = grants.map((grant) => {
    const start = parsed(grant.createdAt) ?? now;
    const end = parsed(grant.expiresAt);
    const openEnded = end === null;
    const remainingMs = openEnded ? (grant.expired ? 0 : Number.POSITIVE_INFINITY) : end - now;
    const tone = grantTimelineTone(grant.expired ? Math.min(remainingMs, 0) : remainingMs);
    const visualEnd = openEnded && !grant.expired ? axisEnd : Math.max(end ?? now, start);
    return {
      id: grant.id,
      label: grant.label,
      tone,
      remainingMs: grant.expired ? Math.min(remainingMs, 0) : remainingMs,
      ...place(start, visualEnd),
      start,
      end: openEnded ? null : end,
    };
  }).sort((left, right) => {
    if (left.remainingMs !== right.remainingMs) return left.remainingMs < right.remainingMs ? -1 : 1;
    return left.label.localeCompare(right.label, "zh-CN");
  });
  const nowLeft = Math.max(0, Math.min(100, ((now - axisStart) / axisSpan) * 100));
  return { axisStart, axisEnd, now, nowLeft, bars };
}
