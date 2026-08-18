import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { ClientInstallerArchitecture, ClientInstallerPlatform } from "../../shared/client-installer.js";
import type { DesktopInstallerInformation, ProductVersionInformation } from "../../shared/desktop-release.js";
import { findPublishedClientInstaller, listPublishedClientInstallers, type PublishedClientInstaller } from "../client-installers.js";
import { API_PROTOCOL, PRODUCT_ID, PRODUCT_VERSION } from "../product-info.js";

type DesktopArchitecture = Exclude<ClientInstallerArchitecture, "universal">;

const targets: Record<string, { platform: ClientInstallerPlatform; architecture: DesktopArchitecture }> = {
  "macos-arm64": { platform: "macos", architecture: "arm64" },
  "macos-x64": { platform: "macos", architecture: "x64" },
  "windows-x86": { platform: "windows", architecture: "x86" },
  "windows-x64": { platform: "windows", architecture: "x64" },
  "windows-arm64": { platform: "windows", architecture: "arm64" },
};

function installer(
  installers: PublishedClientInstaller[],
  platform: ClientInstallerPlatform,
  architecture: DesktopArchitecture,
): DesktopInstallerInformation {
  const published = findPublishedClientInstaller(installers, platform, architecture);
  if (!published) return { available: false, version: null, downloadUrl: null, fileName: null, size: null };
  return {
    available: true,
    version: published.information.version,
    downloadUrl: `/api/v1/desktop-installers/${platform}/${architecture}`,
    fileName: published.information.fileName,
    size: published.information.size,
  };
}

function target(platform: string, architecture: string) {
  return targets[`${platform}-${architecture}`] ?? null;
}

export async function registerVersionRoutes(app: FastifyInstance) {
  app.get("/version", async (_request, reply): Promise<ProductVersionInformation> => {
    reply.header("cache-control", "no-store");
    const installers = await listPublishedClientInstallers(app.config.dataDir);
    return {
      product: PRODUCT_ID,
      serverVersion: PRODUCT_VERSION,
      apiVersion: API_PROTOCOL.max,
      apiProtocol: API_PROTOCOL,
      clients: {
        macos: {
          latestVersion: PRODUCT_VERSION,
          installers: {
            arm64: installer(installers, "macos", "arm64"),
            x64: installer(installers, "macos", "x64"),
          },
        },
        windows: {
          latestVersion: PRODUCT_VERSION,
          installers: {
            x86: installer(installers, "windows", "x86"),
            x64: installer(installers, "windows", "x64"),
            arm64: installer(installers, "windows", "arm64"),
          },
        },
      },
    };
  });

  app.get<{ Params: { platform: string; architecture: string } }>(
    "/desktop-installers/:platform/:architecture",
    async (request, reply) => {
      const requested = target(request.params.platform, request.params.architecture);
      const published = requested && findPublishedClientInstaller(
        await listPublishedClientInstallers(app.config.dataDir),
        requested.platform,
        requested.architecture,
      );
      if (!requested || !published) {
        return reply.code(404).send({
          error: "DESKTOP_INSTALLER_NOT_AVAILABLE",
          message: "当前平台的桌面安装包尚未配置",
        });
      }
      reply
        .header("cache-control", "no-store")
        .header("content-type", published.contentType)
        .header("content-length", String(published.information.size))
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(published.information.fileName)}`);
      return reply.send(createReadStream(published.filePath));
    },
  );
}
