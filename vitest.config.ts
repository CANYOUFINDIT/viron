import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig((env) => mergeConfig(viteConfig(env), {
  test: { exclude: [...configDefaults.exclude, "private/**", "release/**"] },
}));
