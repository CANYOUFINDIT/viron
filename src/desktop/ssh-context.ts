export interface DesktopSshContext {
  endpoint: string;
  userId: string;
  workspaceType: "personal" | "organization";
  workspaceId: string;
}

export function contextKey(context: DesktopSshContext): string {
  return `${context.endpoint}\0${context.userId}\0${context.workspaceType}\0${context.workspaceId}`;
}
