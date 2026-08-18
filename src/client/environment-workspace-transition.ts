export interface EnvironmentWorkspaceTransitionOrigin {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PendingEnvironmentWorkspaceTransition {
  environmentId: string;
  origin: EnvironmentWorkspaceTransitionOrigin;
  requestedAt: number;
}

export const ENVIRONMENT_WORKSPACE_EXIT_MS = 110;
export const ENVIRONMENT_WORKSPACE_ENTER_MS = 280;
const ENVIRONMENT_WORKSPACE_TRANSITION_MAX_AGE_MS = 1_200;

let pendingTransition: PendingEnvironmentWorkspaceTransition | null = null;

export function rememberEnvironmentWorkspaceTransition(
  environmentId: string,
  origin: EnvironmentWorkspaceTransitionOrigin,
): void {
  if (!environmentId || ![origin.x, origin.y, origin.width, origin.height].every(Number.isFinite)) return;
  pendingTransition = {
    environmentId,
    origin: { ...origin },
    requestedAt: Date.now(),
  };
}

export function takeEnvironmentWorkspaceTransition(
  environmentId: string,
): EnvironmentWorkspaceTransitionOrigin | null {
  const transition = pendingTransition;
  pendingTransition = null;
  if (!transition || transition.environmentId !== environmentId) return null;
  if (Date.now() - transition.requestedAt > ENVIRONMENT_WORKSPACE_TRANSITION_MAX_AGE_MS) return null;
  return { ...transition.origin };
}

export function resetEnvironmentWorkspaceTransition(): void {
  pendingTransition = null;
}
