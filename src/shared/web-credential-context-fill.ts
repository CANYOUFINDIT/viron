import { webPasswordLockSource } from "./web-password-lock.js";

/** Remember the actual input, not its coordinates or whichever field is focused later. */
function captureTarget(token: string, x: number, y: number, allowedOrigins: string[], useContextEvent: boolean): boolean {
  const state = globalThis as typeof globalThis & { __vironCredentialTarget?: { token: string; input: HTMLInputElement; href: string; documentTime: number; capturedAt: number }; __vironCredentialContextEvent?: { input: Element | null; capturedAt: number } };
  delete state.__vironCredentialTarget;
  const contextEvent = state.__vironCredentialContextEvent;
  delete state.__vironCredentialContextEvent;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !allowedOrigins.includes(location.origin) || !["http:", "https:"].includes(location.protocol) || new URL(location.href).username || new URL(location.href).password) return false;
  let element = useContextEvent ? contextEvent && Date.now() - contextEvent.capturedAt < 1000 ? contextEvent.input : null : document.elementFromPoint(x, y);
  while (!useContextEvent && element?.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (!(element instanceof HTMLInputElement) || element.disabled || !["text", "email", "password", "search", "tel", "url"].includes(element.type)) return false;
  state.__vironCredentialTarget = { token, input: element, href: location.href, documentTime: performance.timeOrigin, capturedAt: Date.now() };
  return true;
}

function fillTarget(token: string, value: string, allowedOrigins: string[], lockPassword: boolean): boolean {
  const state = globalThis as typeof globalThis & { __vironCredentialTarget?: { token: string; input: HTMLInputElement; href: string; documentTime: number; capturedAt: number }; __vironWebPasswordLocks?: { has(node: HTMLInputElement): boolean; lock(node: HTMLInputElement, value: string): void } };
  const target = state.__vironCredentialTarget;
  delete state.__vironCredentialTarget;
  if (!target || target.token !== token || target.href !== location.href || target.documentTime !== performance.timeOrigin || Date.now() - target.capturedAt > 60_000 || !allowedOrigins.includes(location.origin)) return false;
  const input = target.input;
  if (!input.isConnected || input.ownerDocument !== document || input.disabled || !["text", "email", "password", "search", "tel", "url"].includes(input.type)) return false;
  input.focus();
  // Some sites unlock their fields on focus. Never override a permanent readonly field.
  if ((input.readOnly && !(lockPassword && state.__vironWebPasswordLocks?.has(input))) || input.disabled || !input.isConnected || !["text", "email", "password", "search", "tel", "url"].includes(input.type) || target.href !== location.href || target.documentTime !== performance.timeOrigin) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return false;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  if (lockPassword) state.__vironWebPasswordLocks?.lock(input, value);
  return true;
}

export function installWebCredentialContextListenerScript(): string {
  return `(() => {
    if (globalThis.__vironCredentialContextListener) return;
    globalThis.__vironCredentialContextListener = true;
    document.addEventListener("contextmenu", event => {
      globalThis.__vironCredentialContextEvent = {
        input: event.composedPath().find(node => node instanceof HTMLInputElement) ?? null,
        capturedAt: Date.now()
      };
    }, true);
  })()`;
}

export function captureWebCredentialTargetScript(token: string, x: number, y: number, allowedOrigins: string[], useContextEvent = false): string {
  return `(${captureTarget.toString()})(${JSON.stringify(token)}, ${JSON.stringify(x)}, ${JSON.stringify(y)}, ${JSON.stringify(allowedOrigins)}, ${JSON.stringify(useContextEvent)})`;
}

export function fillWebCredentialTargetScript(token: string, value: string, allowedOrigins: string[], lockPassword = false): string {
  return `(() => { const __name = (target) => target; ${lockPassword ? `(${webPasswordLockSource()})();` : ""} return (${fillTarget.toString()})(${JSON.stringify(token)}, ${JSON.stringify(value)}, ${JSON.stringify(allowedOrigins)}, ${JSON.stringify(lockPassword)}); })()`;
}
