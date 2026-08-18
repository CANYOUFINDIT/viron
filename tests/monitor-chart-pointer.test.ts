import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { monitorChartPointerPosition } from "../src/client/monitor-chart-pointer.js";

describe("monitor chart pointer", () => {
  it("maps the pointer against the plot area instead of the full SVG width", () => {
    const boundsLeft = 100;
    const boundsWidth = 360;
    const chartWidth = 720;
    const plotLeft = 54;
    const plotWidth = 648;
    const plotClientLeft = boundsLeft + plotLeft / chartWidth * boundsWidth;
    const plotClientWidth = plotWidth / chartWidth * boundsWidth;

    expect(monitorChartPointerPosition(plotClientLeft, boundsLeft, boundsWidth, chartWidth, plotLeft, plotWidth))
      .toEqual({ x: plotLeft, ratio: 0 });
    expect(monitorChartPointerPosition(plotClientLeft + plotClientWidth / 2, boundsLeft, boundsWidth, chartWidth, plotLeft, plotWidth))
      .toEqual({ x: plotLeft + plotWidth / 2, ratio: 0.5 });
    expect(monitorChartPointerPosition(plotClientLeft + plotClientWidth, boundsLeft, boundsWidth, chartWidth, plotLeft, plotWidth))
      .toEqual({ x: plotLeft + plotWidth, ratio: 1 });
  });

  it("clamps the hover axis to the drawable plot bounds", () => {
    expect(monitorChartPointerPosition(0, 100, 360, 720, 54, 648)).toEqual({ x: 54, ratio: 0 });
    expect(monitorChartPointerPosition(1_000, 100, 360, 720, 54, 648)).toEqual({ x: 702, ratio: 1 });
  });

  it("renders the hover axis at the continuous pointer coordinate", () => {
    const component = readFileSync(new URL("../src/client/components/MonitorTimeSeriesChart.vue", import.meta.url), "utf8");

    expect(component).toContain('<line :x1="hoveredX" :x2="hoveredX"');
    expect(component).toContain("const targetTime = startTime.value + pointer.ratio * timeSpan.value;");
    expect(component).toContain(":cy=\"hoverY(entry.seriesIndex, hoveredIndex)\"");
    expect(component).not.toContain("series.filter((entry)");
    expect(component).not.toContain("(event.clientX - bounds.left) / bounds.width");
  });
});
