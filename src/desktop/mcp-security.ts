export interface DesktopMcpWorkspaceContext {
  workspace: {
    type: "personal" | "organization";
    id: string;
  };
}

export function desktopMcpWorkspaceKey(context: DesktopMcpWorkspaceContext): string {
  return context.workspace.type === "personal" ? "personal" : `organization:${context.workspace.id}`;
}

export function desktopMcpOperationUrlAllowed(endpoint: string, candidate: string, allowFormActions = false): boolean {
  try {
    const endpointOrigin = new URL(endpoint).origin;
    const target = new URL(candidate);
    const suffix = allowFormActions ? "(?:/(?:submit|cancel))?" : "";
    return target.origin === endpointOrigin
      && new RegExp(`^/mcp/operations/[0-9a-f-]+${suffix}$`, "i").test(target.pathname)
      && !target.search
      && !target.hash;
  } catch {
    return false;
  }
}
