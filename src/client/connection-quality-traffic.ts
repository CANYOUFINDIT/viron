interface TrafficTotals {
  uploaded: number;
  downloaded: number;
}

let totals: TrafficTotals = { uploaded: 0, downloaded: 0 };
let previous = { ...totals, at: Date.now() };

export function connectionQualityByteLength(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return 0; }
}

export function recordConnectionQualityTraffic(direction: "upload" | "download", bytes: number): void {
  const normalized = Math.max(0, Math.round(bytes));
  if (direction === "upload") totals.uploaded += normalized;
  else totals.downloaded += normalized;
}

export function sampleConnectionQualityTraffic(now = Date.now()): {
  uploadBytesPerSecond: number;
  downloadBytesPerSecond: number;
} {
  const elapsedSeconds = Math.max(0.25, (now - previous.at) / 1000);
  const sample = {
    uploadBytesPerSecond: Math.round((totals.uploaded - previous.uploaded) / elapsedSeconds),
    downloadBytesPerSecond: Math.round((totals.downloaded - previous.downloaded) / elapsedSeconds),
  };
  previous = { ...totals, at: now };
  return sample;
}
