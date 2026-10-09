/** Declarative login recipes contain selectors and placeholders, never account secrets. */
export interface WebLoginStep {
  action: "type" | "click" | "interactive" | "success";
  selector: string;
  origin?: string;
  value?: string;
}
export type WebLoginMode = "protected" | "locked" | "direct";
export interface WebLoginConfig {
  mode: WebLoginMode;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  successSelector: string;
  interactionSelector: string;
  allowedOrigins: string[];
  steps: WebLoginStep[];
}
export interface ProtectedLoginState {
  phase: "loading" | "authenticating" | "interactive" | "failed";
  /** Actual document loading, distinct from credential submission/verification. */
  pageLoading?: boolean;
  message: string;
  kind?: "agreement" | "challenge" | "page";
  image: string;
  revision: string;
  width: number;
  height: number;
  /** Opaque input identities and geometry, never website DOM or field values. */
  targets?: ProtectedLoginTarget[];
}
export interface ProtectedLoginTarget { token: string; x: number; y: number; width: number; height: number }
export interface ProtectedLoginInput {
  revision: string;
  type: "mouseDown" | "mouseUp" | "mouseMove" | "click" | "text" | "key" | "continue" | "fill-username" | "fill-password" | "scroll";
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  deltaY?: number;
  targetToken?: string;
}
export function defaultWebLoginConfig(): WebLoginConfig {
  return { mode: "protected", usernameSelector: "", passwordSelector: "", submitSelector: "", successSelector: "", interactionSelector: "", allowedOrigins: [], steps: [] };
}
export function parseWebLoginConfig(value: unknown): WebLoginConfig {
  if (value == null) return defaultWebLoginConfig();
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("登录配置必须是对象");
  const input = value as Record<string, unknown>;
  const result = defaultWebLoginConfig();
  if (input.mode !== undefined) {
    if (input.mode !== "protected" && input.mode !== "locked" && input.mode !== "direct") throw new Error("登录方式无效");
    result.mode = input.mode;
  }
  for (const name of ["usernameSelector", "passwordSelector", "submitSelector", "successSelector", "interactionSelector"] as const) {
    if (input[name] === undefined) continue;
    if (typeof input[name] !== "string" || input[name].length > 1000) throw new Error("登录选择器无效");
    result[name] = input[name].trim();
  }
  if (input.allowedOrigins !== undefined) {
    if (!Array.isArray(input.allowedOrigins) || input.allowedOrigins.length > 10) throw new Error("登录域名无效");
    result.allowedOrigins = input.allowedOrigins.map((origin: unknown) => {
      if (typeof origin !== "string") throw new Error("登录域名无效");
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error("请填写完整 Origin，例如 https://login.example.com");
      return origin;
    });
  }
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps) || input.steps.length > 40) throw new Error("登录步骤最多 40 项");
    result.steps = input.steps.map((item: unknown) => {
      if (!item || typeof item !== "object") throw new Error("登录步骤无效");
      const step = item as WebLoginStep;
      if (!["type", "click", "interactive", "success"].includes(step.action) || typeof step.selector !== "string" || !step.selector.trim() || step.selector.length > 1000) throw new Error("登录步骤需要操作和 CSS 选择器");
      if (step.origin && !result.allowedOrigins.includes(step.origin)) throw new Error("步骤的 Origin 必须列在允许登录域名中");
      if (step.action === "type" && (typeof step.value !== "string" || step.value.length > 4096)) throw new Error("输入步骤需要 value；账号密码请使用 {USERNAME} 和 {SECRET}");
      return { action: step.action, selector: step.selector.trim(), ...(step.origin ? { origin: step.origin } : {}), ...(step.action === "type" ? { value: step.value } : {}) };
    });
    if (result.steps.length && (result.steps.at(-1)?.action !== "success" || result.steps.slice(0, -1).some((step) => step.action === "success"))) throw new Error("脚本必须以唯一的 success 步骤结束");
  }
  return result;
}
