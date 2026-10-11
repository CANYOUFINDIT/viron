export interface WebPluginView {
  environmentId: string;
  allowExtensions: boolean;
  locked: boolean;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  closePopup(): void;
}

export function webExtensionShortcutEnabled(allowExtensions: boolean, locked: boolean): boolean {
  return allowExtensions && !locked;
}

export async function applyDesktopWebPluginPolicy(
  view: WebPluginView,
  policy: { inject: boolean },
): Promise<"suspended" | "resumed" | "unchanged"> {
  const next = policy.inject === true && !view.locked;
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
  readPolicy: (environmentId: string) => Promise<{ inject: boolean }>,
): Promise<void> {
  const seen = new Map<string, { inject: boolean }>();
  for (const view of views) {
    if (!view.environmentId) continue;
    let policy = seen.get(view.environmentId);
    if (!policy) {
      try {
        policy = await readPolicy(view.environmentId);
      } catch {
        policy = { inject: false };
      }
      seen.set(view.environmentId, policy);
    }
    await applyDesktopWebPluginPolicy(view, policy);
  }
}
