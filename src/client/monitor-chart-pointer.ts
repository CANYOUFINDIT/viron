export interface MonitorChartPointerPosition {
  x: number;
  ratio: number;
}

export function monitorChartPointerPosition(
  clientX: number,
  boundsLeft: number,
  boundsWidth: number,
  chartWidth: number,
  plotLeft: number,
  plotWidth: number,
): MonitorChartPointerPosition {
  const chartX = boundsWidth > 0 ? (clientX - boundsLeft) / boundsWidth * chartWidth : plotLeft;
  const x = Math.max(plotLeft, Math.min(plotLeft + plotWidth, chartX));
  return {
    x,
    ratio: plotWidth > 0 ? (x - plotLeft) / plotWidth : 0,
  };
}
