import { ref } from "vue";

export const CONNECTION_QUALITY_ENABLED_STORAGE_KEY = "viron-connection-quality-enabled";

function initialValue(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(CONNECTION_QUALITY_ENABLED_STORAGE_KEY) === "1";
}

export const connectionQualityEnabled = ref(initialValue());

export function setConnectionQualityEnabled(enabled: boolean): void {
  connectionQualityEnabled.value = enabled;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(CONNECTION_QUALITY_ENABLED_STORAGE_KEY, enabled ? "1" : "0");
  }
}
