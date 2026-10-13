import { createHash, randomUUID } from "node:crypto";
import { databaseSqlPermissions } from "../shared/access-permissions.js";
import {
  DESKTOP_EXECUTION_RESULT_KIND,
  type DesktopExecutionAuthorizationBasis,
  type DesktopExecutionCheck,
  type DesktopExecutionCheckResult,
} from "../shared/desktop-execution-authorization.js";
import { translate as tr } from "./i18n.js";
import { DesktopApiError, endpointJson } from "./http-proxy.js";
import { signedDesktopOperation } from "./execution-router.js";
import { authorizeOrganizationExecution, runWithOrganizationExecutionChannel } from "./organization-execution.js";
import type { DesktopSshContext } from "./ssh-context.js";

export interface DesktopAgentGrant {
  checks: DesktopExecutionCheck[];
  decisions: DesktopExecutionCheckResult[];
}

const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECK_BATCH = 16;

function resourceCheck(type: "ssh_connection" | "database_connection", id: string, code: string): DesktopExecutionCheck | null {
  if (!RESOURCE_ID.test(id)) return null;
  return { target: { type, id: id.toLowerCase() }, code };
}

/** Organization Agent calls the same signed authorization as MCP, on the agent channel. Personal workspaces keep the existing path. */
const EMPTY_GRANT: DesktopAgentGrant = { checks: [], decisions: [] };

export async function authorizeDesktopAgentChecks(
  context: DesktopSshContext,
  path: string,
  body: string,
  checks: DesktopExecutionCheck[],
): Promise<DesktopAgentGrant> {
  if (context.workspaceType !== "organization") return EMPTY_GRANT;
  if (!checks.length) throw new DesktopApiError(403, "ACTION_FORBIDDEN", tr("组织 Agent 不能执行未受控的操作"));
  const requestIdentity = {
    method: "POST",
    path,
    bodyDigest: createHash("sha256").update(body).digest("hex"),
  };
  const decisions: DesktopExecutionCheckResult[] = [];
  await runWithOrganizationExecutionChannel("agent", async () => {
    for (let index = 0; index < checks.length; index += CHECK_BATCH) {
      const result = await authorizeOrganizationExecution(requestIdentity, checks.slice(index, index + CHECK_BATCH));
      if (!result.allowed) throw new DesktopApiError(403, result.error ?? "FEATURE_FORBIDDEN", result.message || tr("组织执行授权未通过"));
      decisions.push(...result.checks);
    }
  });
  return { checks, decisions };
}

/** Writes the tool outcome. This is not the authorization check record. */
export async function reportDesktopAgentExecution(
  context: DesktopSshContext,
  grant: DesktopAgentGrant,
  status: "success" | "failed",
): Promise<void> {
  if (context.workspaceType !== "organization" || !grant.decisions.length) return;
  for (const decision of grant.decisions) {
    const basis: DesktopExecutionAuthorizationBasis = decision.basis;
    await endpointJson("/api/v1/desktop/organization-execution/result", {
      method: "POST",
      body: await signedDesktopOperation({
        operationId: randomUUID(),
        kind: DESKTOP_EXECUTION_RESULT_KIND,
        channel: "agent" as const,
        target: decision.target,
        code: decision.code,
        status,
        basis,
      }, context),
    });
  }
}

export async function authorizeDesktopAgentDatabase(context: DesktopSshContext, connectionId: string, sql: string): Promise<DesktopAgentGrant> {
  const checks = databaseSqlPermissions(sql)
    .map((code) => resourceCheck("database_connection", connectionId, code))
    .filter((item): item is DesktopExecutionCheck => item !== null);
  return authorizeDesktopAgentChecks(
    context,
    `/api/v1/database-connections/${connectionId}/queries`,
    JSON.stringify({ sql }),
    checks,
  );
}

export async function authorizeDesktopAgentDatabaseRead(context: DesktopSshContext, connectionId: string): Promise<DesktopAgentGrant> {
  const check = resourceCheck("database_connection", connectionId, "database.read");
  return authorizeDesktopAgentChecks(
    context,
    `/api/v1/database-connections/${connectionId}/agent-context`,
    JSON.stringify({ connectionId }),
    check ? [check] : [],
  );
}

/** Agent SSH uses the same ssh.use check the accepted MCP purpose signature carries. It does not require mcp. */
export async function authorizeDesktopAgentSsh(
  context: DesktopSshContext,
  connectionId: string,
  command: string,
): Promise<DesktopAgentGrant> {
  const check = resourceCheck("ssh_connection", connectionId, "ssh.use");
  return authorizeDesktopAgentChecks(
    context,
    `/api/v1/ssh-connections/${connectionId}/commands`,
    JSON.stringify({ command }),
    check ? [check] : [],
  );
}
