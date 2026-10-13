export interface WebPluginPolicy {
  inject: boolean;
  label?: string | null;
  reason?: string;
  entryId?: string;
  environmentId?: string;
  entryUrl?: string;
}

export interface WebPluginView {
  environmentId: string;
  entryId: string;
  currentUrl: string;
  allowExtensions: boolean;
  locked: boolean;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  closePopup(): void;
  note?(policy: WebPluginPolicy): void;
}

export function webExtensionShortcutEnabled(allowExtensions: boolean, locked: boolean): boolean {
  return allowExtensions && !locked;
}

export async function applyDesktopWebPluginPolicy(
  view: WebPluginView,
  policy: WebPluginPolicy,
): Promise<"suspended" | "resumed" | "unchanged"> {
  const next = policy.inject === true && !view.locked;
  view.note?.(policy);
  if (view.allowExtensions === next) return "unchanged";
  view.allowExtensions = next;
  view.closePopup();
  if (!next) {
    await view.suspend();
    return "suspended";
  }
  await view.resume();
  return "resumed";
}

export async function refreshOrganizationWebPlugins(
  views: WebPluginView[],
  readPolicy: (target: { environmentId: string; entryId: string; currentUrl: string }) => Promise<WebPluginPolicy>,
): Promise<void> {
  const seen = new Map<string, WebPluginPolicy>();
  for (const view of views) {
    if (!view.environmentId) continue;
    const key = `${view.environmentId}\0${view.entryId}\0${view.currentUrl}`;
    let policy = seen.get(key);
    if (!policy) {
      try {
        policy = await readPolicy({ environmentId: view.environmentId, entryId: view.entryId, currentUrl: view.currentUrl });
      } catch {
        policy = { inject: false, label: "环境未授权 · 已禁用", reason: "策略不可用" };
      }
      seen.set(key, policy);
    }
    await applyDesktopWebPluginPolicy(view, policy);
  }
}
