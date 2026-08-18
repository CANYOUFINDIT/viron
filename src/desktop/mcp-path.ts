import { homedir } from "node:os";
import { join } from "node:path";

export function defaultVironMcpDescriptorPath(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (environment.VIRON_MCP_DESCRIPTOR) return environment.VIRON_MCP_DESCRIPTOR;
  if (platform === "darwin") return join(home, "Library", "Application Support", "Viron", "viron-mcp.json");
  if (platform === "win32") return join(environment.APPDATA || join(home, "AppData", "Roaming"), "Viron", "viron-mcp.json");
  return join(environment.XDG_CONFIG_HOME || join(home, ".config"), "Viron", "viron-mcp.json");
}
