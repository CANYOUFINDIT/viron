import packageJson from "../../package.json" with { type: "json" };

export const PRODUCT_ID = "viron";
export const PRODUCT_VERSION = packageJson.version;
export const API_PROTOCOL = { min: 1, max: 2 } as const;

export const DESKTOP_LOCAL_CAPABILITIES = {
  web: true,
  ssh: true,
  sftp: true,
  logs: true,
  database: true,
  redis: true,
  inspection: true,
} as const;

export function productCapabilities(webClientEnabled = true, mcpEnabled = false) {
  return {
    product: PRODUCT_ID,
    productVersion: PRODUCT_VERSION,
    apiProtocol: API_PROTOCOL,
    clientAccess: {
      desktop: true,
      web: webClientEnabled,
    },
    desktopLocal: DESKTOP_LOCAL_CAPABILITIES,
    mcp: {
      server: {
        enabled: mcpEnabled,
        path: "/mcp",
        transport: "streamable-http",
        authentication: "personal-api-key",
      },
    },
    serverForwarding: {
      enabled: true,
      web: webClientEnabled,
      ssh: true,
      sftp: true,
      logs: true,
      database: true,
      redis: true,
    },
  };
}
