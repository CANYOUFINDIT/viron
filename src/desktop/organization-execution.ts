import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { endpointJson } from "./http-proxy.js";
import { signedDesktopOperation } from "./execution-router.js";
import {
  DESKTOP_EXECUTION_AUTHORIZATION_KIND,
  type DesktopExecutionAuthorizationResult,
  type DesktopExecutionChannel,
  type DesktopExecutionCheck,
  type DesktopExecutionRequestIdentity,
} from "../shared/desktop-execution-authorization.js";

/** Trusted execution channel. MCP is the default. Agent sets agent around its own call. */
export const organizationExecutionChannel = new AsyncLocalStorage<DesktopExecutionChannel>();

export function runWithOrganizationExecutionChannel<T>(channel: DesktopExecutionChannel, run: () => Promise<T>): Promise<T> {
  return organizationExecutionChannel.run(channel, run);
}

export async function authorizeOrganizationExecution(
  requestIdentity: DesktopExecutionRequestIdentity,
  checks: DesktopExecutionCheck[],
): Promise<DesktopExecutionAuthorizationResult> {
  const channel = organizationExecutionChannel.getStore() ?? "mcp";
  const operationId = randomUUID();
  const signed = await signedDesktopOperation({
    operationId,
    kind: DESKTOP_EXECUTION_AUTHORIZATION_KIND,
    channel,
    checks,
    requestIdentity,
  });
  return endpointJson<DesktopExecutionAuthorizationResult>("/api/v1/desktop/organization-execution/authorize", {
    method: "POST",
    body: signed,
  });
}
