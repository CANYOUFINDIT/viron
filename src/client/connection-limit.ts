export function dispatchConnectionLimit(message: string): void {
  window.dispatchEvent(new CustomEvent("viron:connection-limit", { detail: { message } }));
}
