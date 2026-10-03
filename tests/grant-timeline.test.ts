import { describe, expect, it } from "vitest";
import { GRANT_TIMELINE_SPANS, buildGrantTimeline, grantRemainingCopy, grantTimelineTone, grantTimelineWindow } from "../src/client/views/organization/grant-timeline";

const now = Date.parse("2026-10-02T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (offset: number) => new Date(now + offset).toISOString();

describe("grant timeline", () => {
  it("sorts bars by remaining time and assigns a color band", () => {
    const model = buildGrantTimeline([
      { id: "forever", label: "默认", createdAt: iso(-10 * DAY), expiresAt: null },
      { id: "later", label: "月度环境", createdAt: iso(-20 * DAY), expiresAt: iso(30 * DAY) },
      { id: "week", label: "本周发布", createdAt: iso(-15 * DAY), expiresAt: iso(3 * DAY) },
      { id: "soon", label: "今日到期", createdAt: iso(-10 * DAY), expiresAt: iso(5 * HOUR) },
      { id: "expired", label: "过期环境", createdAt: iso(-40 * DAY), expiresAt: iso(-2 * DAY), expired: true },
      { id: "local", label: "本地K8s", createdAt: iso(-60 * DAY), expiresAt: null },
    ], now, "all");

    expect(model.bars.map((bar) => bar.id)).toEqual(["expired", "soon", "week", "later", "local", "forever"]);
    expect(model.bars.map((bar) => bar.tone)).toEqual(["expired", "soon", "week", "later", "forever", "forever"]);

    const expired = model.bars[0];
    const later = model.bars[3];
    const forever = model.bars[5];
    expect(expired.left + expired.width).toBeLessThan(model.nowLeft);
    expect(forever.left).toBeLessThan(model.nowLeft);
    expect(forever.left + forever.width).toBeGreaterThan(model.nowLeft);
    expect(later.left + later.width).toBeLessThan(forever.left + forever.width);
    expect(forever.end).toBeNull();
    expect(forever.remainingMs).toBe(Number.POSITIVE_INFINITY);
  });

  it("leaves room after now when every grant is permanent", () => {
    const model = buildGrantTimeline([
      { id: "local", label: "本地K8s", createdAt: iso(-75 * DAY), expiresAt: null },
      { id: "default", label: "默认", createdAt: iso(-40 * DAY), expiresAt: null },
    ], now, "all");
    expect(model.nowLeft).toBeGreaterThan(55);
    expect(model.nowLeft).toBeLessThan(70);
    expect(model.bars.every((bar) => bar.left + bar.width > model.nowLeft)).toBe(true);
  });

  it("defaults to seven days even with old grants and distant expiry dates", () => {
    const model = buildGrantTimeline([
      { id: "old", label: "长期授权", createdAt: iso(-365 * DAY), expiresAt: null },
      { id: "distant", label: "年度授权", createdAt: iso(-60 * DAY), expiresAt: iso(365 * DAY) },
    ], now);

    expect(model.axisStart).toBe(now - 2 * DAY);
    expect(model.axisEnd).toBe(now + 5 * DAY);
    expect(model.nowVisible).toBe(true);
    for (const bar of model.bars) {
      expect(bar.left).toBe(0);
      expect(bar.width).toBe(100);
      expect(bar.outsideRange).toBeNull();
    }
    expect(model.bars.find((bar) => bar.id === "old")?.activeDays).toBe(365);
  });

  it.each(GRANT_TIMELINE_SPANS)("uses an exact %i day window containing now", (days) => {
    const model = buildGrantTimeline([], now, grantTimelineWindow(now, days));
    expect(model.axisEnd - model.axisStart).toBe(days * DAY);
    expect(model.nowLeft).toBeGreaterThan(0);
    expect(model.nowLeft).toBeLessThan(100);
  });

  it("clips intersecting grants and identifies grants outside a custom range without changing their status", () => {
    const model = buildGrantTimeline([
      { id: "spanning", label: "长期", createdAt: iso(-60 * DAY), expiresAt: iso(30 * DAY) },
      { id: "before", label: "早期", createdAt: iso(-20 * DAY), expiresAt: iso(-10 * DAY) },
      { id: "after", label: "未来", createdAt: iso(10 * DAY), expiresAt: iso(20 * DAY) },
      { id: "within", label: "当日", createdAt: iso(-6 * HOUR), expiresAt: iso(6 * HOUR) },
    ], now, { start: now - DAY, end: now + DAY });
    const bars = new Map(model.bars.map((bar) => [bar.id, bar]));

    expect(model.axisStart).toBe(now - DAY);
    expect(model.axisEnd).toBe(now + DAY);
    expect(bars.get("spanning")).toMatchObject({ left: 0, width: 100, outsideRange: null });
    expect(bars.get("within")).toMatchObject({ left: 37.5, width: 25, outsideRange: null, tone: "soon" });
    expect(bars.get("before")).toMatchObject({ outsideRange: "before", tone: "expired" });
    expect(bars.get("after")).toMatchObject({ outsideRange: "after", tone: "later" });
    expect(model.toneCounts).toMatchObject({ expired: 1, later: 2, soon: 1 });
    for (const bar of model.bars) {
      expect(bar.left).toBeGreaterThanOrEqual(0);
      expect(bar.left + bar.width).toBeLessThanOrEqual(100);
    }
  });

  it.each([-10, 10])("hides now for a custom window %i days away", (offset) => {
    const model = buildGrantTimeline([], now, { start: now + offset * DAY, end: now + (offset + 1) * DAY });
    expect(model.nowVisible).toBe(false);
    expect(model.ticks[0].label).toMatch(/\d+:\d+/);
  });

  it.each([
    { start: now, end: now },
    { start: now + DAY, end: now - DAY },
    { start: Number.NaN, end: now },
  ])("falls back to the short default for invalid ranges", (range) => {
    const model = buildGrantTimeline([], now, range);
    expect(model.axisEnd - model.axisStart).toBe(7 * DAY);
  });

  it("keeps an expired flag ahead of a later end time", () => {
    const model = buildGrantTimeline([
      { id: "flagged", label: "标记过期", createdAt: iso(-5 * DAY), expiresAt: iso(10 * DAY), expired: true },
    ], now);
    expect(model.bars[0].tone).toBe("expired");
    expect(model.bars[0].remainingMs).toBeLessThanOrEqual(0);
  });

  it("describes the remaining-time bands", () => {
    expect(grantTimelineTone(Number.POSITIVE_INFINITY)).toBe("forever");
    expect(grantTimelineTone(0)).toBe("expired");
    expect(grantTimelineTone(DAY)).toBe("soon");
    expect(grantTimelineTone(DAY + 1)).toBe("week");
    expect(grantTimelineTone(7 * DAY)).toBe("week");
    expect(grantTimelineTone(7 * DAY + 1)).toBe("later");
    expect(grantRemainingCopy(Number.POSITIVE_INFINITY)).toEqual({ key: "永久", values: [] });
    expect(grantRemainingCopy(-HOUR)).toEqual({ key: "已过期", values: [] });
    expect(grantRemainingCopy(20 * 60_000)).toEqual({ key: "不足 1 小时", values: [] });
    expect(grantRemainingCopy(2 * HOUR)).toEqual({ key: "剩余 {{0}} 小时", values: [2] });
    expect(grantRemainingCopy(3 * DAY)).toEqual({ key: "剩余 {{0}} 天", values: [3] });
  });

  it("calculates calibrated ticks and tone counts", () => {
    const model = buildGrantTimeline([
      { id: "forever", label: "默认", createdAt: iso(-10 * DAY), expiresAt: null },
      { id: "soon", label: "今日到期", createdAt: iso(-10 * DAY), expiresAt: iso(5 * HOUR) },
    ], now);

    expect(model.ticks.length).toBe(5);
    expect(model.ticks[0].left).toBe(0);
    expect(model.ticks[4].left).toBe(100);
    expect(model.toneCounts.forever).toBe(1);
    expect(model.toneCounts.soon).toBe(1);
    expect(model.toneCounts.expired).toBe(0);

    const foreverBar = model.bars.find((b) => b.id === "forever");
    expect(foreverBar?.openEnded).toBe(true);
    expect(foreverBar?.activeDays).toBeGreaterThanOrEqual(9);
  });
});
