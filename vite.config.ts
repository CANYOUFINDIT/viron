import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const configuredPort = Number(env.PORT);
  const apiPort = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 8080;
  const apiTarget = `http://127.0.0.1:${apiPort}`;

  return {
    base: mode === "desktop" ? "./" : "/",
    plugins: [vue()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src/client", import.meta.url)),
      },
    },
    build: {
      outDir: mode === "desktop" ? "dist/desktop-renderer" : "dist/client",
      emptyOutDir: true,
      ...(mode === "desktop" ? {
        rollupOptions: {
          input: {
            main: fileURLToPath(new URL("./index.html", import.meta.url)),
            "desktop-agent-launcher": fileURLToPath(new URL("./desktop-agent-launcher.html", import.meta.url)),
            "desktop-agent-chat": fileURLToPath(new URL("./desktop-agent-chat.html", import.meta.url)),
            "desktop-connection-quality": fileURLToPath(new URL("./desktop-connection-quality.html", import.meta.url)),
            "desktop-active-environment-dock": fileURLToPath(new URL("./desktop-active-environment-dock.html", import.meta.url)),
          },
        },
      } : {}),
    },
    server: {
      host: env.HOST || "127.0.0.1",
      port: 5173,
      proxy: {
        "/api": apiTarget,
        "/healthz": apiTarget,
        "/readyz": apiTarget,
        "/mcp": apiTarget,
        "/ws": {
          target: apiTarget,
          ws: true,
        },
      },
    },
  };
});
