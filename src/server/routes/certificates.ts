import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CertificateProbeTargetResult } from "../../shared/tls-certificates.js";
import { canAccessEnvironment, canManageWorkspace, workspaceParams } from "../access-control.js";
import { writeAudit } from "../audit.js";
import {
  TlsCertificateError,
  deleteWorkspaceCertificate,
  getWorkspaceCertificate,
  listWorkspaceCertificates,
  probeTlsEndpoint,
} from "../tls-certificates.js";
import { requireAdmin } from "./auth.js";

function requireManager(request: Parameters<typeof canManageWorkspace>[0], reply: { code: (status: number) => { send: (body: unknown) => unknown } }): boolean {
  if (canManageWorkspace(request)) return true;
  void reply.code(403).send({ error: "WORKSPACE_ADMIN_REQUIRED", message: "当前工作空间只有管理员可以管理证书" });
  return false;
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().max(200).optional(),
  status: z.string().trim().max(32).optional(),
  environmentId: z.string().uuid().optional(),
  sort: z.enum(["expiry", "name", "updated"]).optional(),
});

export async function registerCertificateRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/certificates", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CERTIFICATE_QUERY", message: "证书列表查询参数无效" });
    const [workspaceType, workspaceId] = workspaceParams(request);
    if (parsed.data.environmentId && !await canAccessEnvironment(app.db, request.admin!, parsed.data.environmentId)) {
      return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND", message: "环境不存在" });
    }
    return await listWorkspaceCertificates(app, { type: workspaceType, id: workspaceId }, parsed.data);
  });

  app.get<{ Params: { id: string } }>("/api/v1/certificates/:id", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const [workspaceType, workspaceId] = workspaceParams(request);
    const item = await getWorkspaceCertificate(app, { type: workspaceType, id: workspaceId }, request.params.id);
    if (!item) return reply.code(404).send({ error: "CERTIFICATE_NOT_FOUND", message: "证书不存在" });
    return { item };
  });

  app.delete<{ Params: { id: string }; Querystring: { cascade?: string } }>(
    "/api/v1/certificates/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      if (!requireManager(request, reply)) return;
      const [workspaceType, workspaceId] = workspaceParams(request);
      const cascade = request.query.cascade === "endpoints";
      try {
        const impact = await deleteWorkspaceCertificate(app, { type: workspaceType, id: workspaceId }, request.params.id, cascade);
        await writeAudit(app.db, {
          action: cascade ? "ssl_certificate.cascade_deleted" : "ssl_certificate.deleted",
          resourceType: "ssl_certificate",
          resourceId: request.params.id,
          summary: cascade ? `级联删除证书及其 ${impact.endpointCount} 个端点` : "删除证书资产",
          details: impact,
          request,
        });
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof TlsCertificateError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/v1/certificates/:id/probe", { preHandler: requireAdmin }, async (request, reply) => {
    if (!requireManager(request, reply)) return;
    const [workspaceType, workspaceId] = workspaceParams(request);
    const item = await getWorkspaceCertificate(app, { type: workspaceType, id: workspaceId }, request.params.id);
    if (!item) return reply.code(404).send({ error: "CERTIFICATE_NOT_FOUND", message: "证书不存在" });
    const results: CertificateProbeTargetResult[] = [];
    for (const endpoint of item.endpoints) {
      if (!endpoint.sshConnectionId || !endpoint.observeEnabled) continue;
      if (!await canAccessEnvironment(app.db, request.admin!, endpoint.environmentId)) continue;
      try {
        const probed = await probeTlsEndpoint(app, endpoint.id, { manual: true });
        if (probed.probeStatus === "ok") {
          results.push({ endpointId: endpoint.id, status: "succeeded", probeStatus: probed.probeStatus });
        } else {
          results.push({
            endpointId: endpoint.id,
            status: "failed",
            probeStatus: probed.probeStatus,
            error: probed.probeStatus,
            message: probed.probeError || "证书探测失败",
          });
        }
      } catch (error) {
        results.push({
          endpointId: endpoint.id,
          status: "failed",
          error: error instanceof TlsCertificateError ? error.code : "TLS_PROBE_FAILED",
          message: (error instanceof Error ? error.message : "证书探测失败").slice(0, 500),
        });
      }
    }
    const succeeded = results.filter((result) => result.status === "succeeded").length;
    const failed = results.length - succeeded;
    await writeAudit(app.db, {
      action: "ssl_certificate.probed",
      resourceType: "ssl_certificate",
      resourceId: request.params.id,
      summary: `重新探测证书 ${item.leafCn || item.fingerprintSha256.slice(0, 16)}：成功 ${succeeded}，失败 ${failed}`,
      details: {
        endpoints: results.length,
        succeeded,
        failed,
        errorCodes: [...new Set(results.flatMap((result) => result.error ? [result.error] : []))],
      },
      request,
    });
    return {
      item: await getWorkspaceCertificate(app, { type: workspaceType, id: workspaceId }, request.params.id),
      probed: results.length,
      succeeded,
      failed,
      results,
    };
  });
}
