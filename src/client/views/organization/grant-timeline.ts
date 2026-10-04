const HOUR = 3_600_000;
const DAY = 86_400_000;
const MIN_BAR = 1.6;

export const GRANT_TIMELINE_SPANS = [7, 14, 30, 90] as const;
export type GrantTimelineSpan = (typeof GRANT_TIMELINE_SPANS)[number];

export interface GrantTimelineRange {
  start: number;
  end: number;
}

export type GrantTimelineTone = "expired" | "soon" | "week" | "later" | "forever";

export interface GrantTimelineSource {
  id: string;
  label: string;
  createdAt: string;
  startsAt?: string | null;
  expiresAt: string | null;
  expired?: boolean;
}

export interface GrantTimelineTick {
  time: number;
  left: number;
  label: string;
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
  openEnded: boolean;
  startLeft: number;
  endLeft: number | null;
  activeDays: number;
  outsideRange: "before" | "after" | null;
}

export interface GrantTimelineModel {
  axisStart: number;
  axisEnd: number;
  now: number;
  nowLeft: number;
  nowVisible: boolean;
  bars: GrantTimelineBar[];
  ticks: GrantTimelineTick[];
  toneCounts: Record<GrantTimelineTone, number>;
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

function formatTickDate(time: number, axisStart: number, axisEnd: number): string {
  const span = axisEnd - axisStart;
  const d = new Date(time);
  if (span < 2 * DAY) {
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const sameYear = new Date(axisStart).getFullYear() === new Date(axisEnd).getFullYear();
  if (sameYear) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function grantTimelineWindow(now: number, days: GrantTimelineSpan = 7): GrantTimelineRange {
  const pastDays = Math.floor(days / 3);
  return { start: now - pastDays * DAY, end: now + (days - pastDays) * DAY };
}

function grantStart(grant: GrantTimelineSource): number | null {
  return parsed(grant.startsAt) ?? parsed(grant.createdAt);
}

function fullTimelineRange(grants: readonly GrantTimelineSource[], now: number): GrantTimelineRange {
  const starts = grants.map((grant) => grantStart(grant)).filter((value): value is number => value !== null);
  let axisStart = Math.min(now, ...(starts.length ? starts : [now]));
  const finiteEnds = grants.map((grant) => parsed(grant.expiresAt)).filter((value): value is number => value !== null);
  let axisEnd = Math.max(now, ...(finiteEnds.length ? finiteEnds : [now]));
  const span = Math.max(axisEnd - axisStart, DAY);
  axisStart -= span * 0.04;
  axisEnd += span * 0.08;
  // Keep a stretch of future on the axis. Otherwise permanent grants pin 现在 against the end date.
  axisEnd = Math.max(axisEnd, now + Math.max(now - axisStart, DAY) * 0.5);
  return { start: axisStart, end: axisEnd };
}

export function buildGrantTimeline(
  grants: readonly GrantTimelineSource[],
  now = Date.now(),
  range: GrantTimelineRange | "all" = grantTimelineWindow(now),
): GrantTimelineModel {
  const requested = range === "all" ? fullTimelineRange(grants, now) : range;
  const validRange = Number.isFinite(requested.start) && Number.isFinite(requested.end) && requested.end > requested.start;
  const { start: axisStart, end: axisEnd } = validRange ? requested : grantTimelineWindow(now);
  const axisSpan = Math.max(axisEnd - axisStart, 1);
  const place = (start: number, end: number) => {
    const visibleStart = Math.max(axisStart, Math.min(axisEnd, start));
    const visibleEnd = Math.max(visibleStart, Math.min(axisEnd, end));
    const width = Math.min(100, Math.max(((visibleEnd - visibleStart) / axisSpan) * 100, MIN_BAR));
    let left = ((visibleStart - axisStart) / axisSpan) * 100;
    if (left + width > 100) left = 100 - width;
    left = Math.max(0, Math.min(left, 100 - width));
    return { left, width };
  };
  const bars: GrantTimelineBar[] = grants.map((grant) => {
    const start = grantStart(grant) ?? now;
    const end = parsed(grant.expiresAt);
    const openEnded = end === null;
    const remainingMs = openEnded ? (grant.expired ? 0 : Number.POSITIVE_INFINITY) : end - now;
    const tone = grantTimelineTone(grant.expired ? Math.min(remainingMs, 0) : remainingMs);
    const visualEnd = openEnded && !grant.expired ? axisEnd : Math.max(end ?? now, start);
    const startLeft = Math.max(0, Math.min(100, ((start - axisStart) / axisSpan) * 100));
    const endLeft = openEnded ? null : Math.max(0, Math.min(100, (((end ?? now) - axisStart) / axisSpan) * 100));
    const activeDays = Math.max(0, Math.floor((now - start) / DAY));
    const outsideRange: GrantTimelineBar["outsideRange"] = start > axisEnd ? "after" : visualEnd < axisStart ? "before" : null;
    return {
      id: grant.id,
      label: grant.label,
      tone,
      remainingMs: grant.expired ? Math.min(remainingMs, 0) : remainingMs,
      ...place(start, visualEnd),
      start,
      end: openEnded ? null : end,
      openEnded,
      startLeft,
      endLeft,
      activeDays,
      outsideRange,
    };
  }).sort((left, right) => {
    const leftExpired = left.tone === "expired";
    const rightExpired = right.tone === "expired";
    if (leftExpired !== rightExpired) return leftExpired ? 1 : -1;
    if (leftExpired && rightExpired) {
      const ended = (right.end ?? right.start) - (left.end ?? left.start);
      if (ended) return ended;
    }
    if (left.remainingMs !== right.remainingMs) return left.remainingMs < right.remainingMs ? -1 : 1;
    return left.label.localeCompare(right.label, "zh-CN");
  });
  const nowLeft = Math.max(0, Math.min(100, ((now - axisStart) / axisSpan) * 100));

  const tickCount = 5;
  const tickStep = (axisEnd - axisStart) / (tickCount - 1);
  const ticks: GrantTimelineTick[] = [];
  for (let i = 0; i < tickCount; i++) {
    const time = axisStart + i * tickStep;
    const left = (i / (tickCount - 1)) * 100;
    ticks.push({
      time,
      left,
      label: formatTickDate(time, axisStart, axisEnd),
    });
  }

  const toneCounts: Record<GrantTimelineTone, number> = {
    expired: 0,
    soon: 0,
    week: 0,
    later: 0,
    forever: 0,
  };
  for (const bar of bars) {
    toneCounts[bar.tone] = (toneCounts[bar.tone] || 0) + 1;
  }

  const nowVisible = now >= axisStart && now <= axisEnd;
  return { axisStart, axisEnd, now, nowLeft, nowVisible, bars, ticks, toneCounts };
}
