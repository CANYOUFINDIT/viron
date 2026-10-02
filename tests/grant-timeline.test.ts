import { describe, expect, it } from "vitest";
import { buildGrantTimeline, grantRemainingCopy, grantTimelineTone } from "../src/client/views/organization/grant-timeline";

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
    ], now);

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
    ], now);
    expect(model.nowLeft).toBeGreaterThan(55);
    expect(model.nowLeft).toBeLessThan(70);
    expect(model.bars.every((bar) => bar.left + bar.width > model.nowLeft)).toBe(true);
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
});
