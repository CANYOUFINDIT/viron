import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { ClientInstallerCatalog } from "../../shared/client-installer.js";
import { listPublishedClientInstallers } from "../client-installers.js";
import { requireAdmin } from "./auth.js";

export async function registerClientInstallerRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/client-installers",
    { preHandler: requireAdmin },
    async (_request, reply): Promise<ClientInstallerCatalog> => {
      reply.header("cache-control", "no-store");
      return { items: (await listPublishedClientInstallers(app.config.dataDir)).map((installer) => installer.information) };
    },
  );

  app.get<{ Params: { fileName: string } }>(
    "/api/v1/client-installers/:fileName/download",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const installer = (await listPublishedClientInstallers(app.config.dataDir))
        .find((item) => item.information.fileName === request.params.fileName);
      if (!installer) {
        return reply.code(404).send({
          error: "CLIENT_INSTALLER_NOT_FOUND",
          message: "客户端安装包不存在或不可用",
        });
      }
      reply
        .header("cache-control", "no-store")
        .header("content-type", installer.contentType)
        .header("content-length", String(installer.information.size))
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(installer.information.fileName)}`);
      return reply.send(createReadStream(installer.filePath));
    },
  );
}
