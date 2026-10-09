import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { defaultApiRateLimitSettings } from "../shared/api-rate-limit-settings.js";

function principalKey(request: FastifyRequest): string {
  if (request.admin) return `user:${request.admin.id}`;
  if (request.apiKey) return `api-key:${request.apiKey.id}`;
  return `ip:${request.ip}`;
}

function rateLimitResponse(ttl: number) {
  const retryAfter = Math.max(1, Math.ceil(ttl / 1000));
  return {
    statusCode: 429,
    error: "API_RATE_LIMIT",
    message: `请求过于频繁，请在 ${retryAfter} 秒后重试`,
    retryAfter,
  };
}

export async function registerApiRateLimit(app: FastifyInstance): Promise<void> {
  app.config.apiRateLimit ??= defaultApiRateLimitSettings();
  const policy = () => app.config.apiRateLimit!;
  await app.register(rateLimit, {
    global: false,
    hook: "preHandler",
    keyGenerator: principalKey,
    errorResponseBuilder: (_request, context) => rateLimitResponse(context.ttl),
  });

  // Bound unauthenticated traffic before credentials are checked. This limiter
  // uses createRateLimit so it does not suppress the per-route/user limiter.
  const ipRateLimit = app.createRateLimit({
    max: () => policy().ipRequestsPerMinute,
    allowList: () => !policy().enabled,
    timeWindow: "1 minute",
    keyGenerator: (request) => request.ip,
  });
  // Management has a fixed, independent budget so an overly low policy can
  // always be corrected without disabling authentication or abuse protection.
  const managementIpRateLimit = app.createRateLimit({ max: 600, timeWindow: "1 minute", keyGenerator: (request) => request.ip });
  const managementRequest = (request: FastifyRequest) => request.routeOptions.url === "/api/v1/settings"
    && ["GET", "PUT"].includes(request.method);
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const result = await (managementRequest(request) ? managementIpRateLimit : ipRateLimit)(request);
    if (result.isAllowed || !result.isExceeded) return;
    await reply.code(429).headers({
      "x-ratelimit-limit": result.max,
      "x-ratelimit-remaining": 0,
      "x-ratelimit-reset": result.ttlInSeconds,
      "retry-after": result.ttlInSeconds,
    }).send(rateLimitResponse(result.ttl));
  });

  const apiRateLimit = app.rateLimit({
    max: (request) => request.admin || request.apiKey ? policy().userRequestsPerMinute : policy().anonymousRequestsPerMinute,
    allowList: () => !policy().enabled,
    timeWindow: "1 minute",
    groupId: "api",
  });
  const sessionRateLimit = app.rateLimit({ max: () => policy().sessionRequestsPerMinute, allowList: () => !policy().enabled, timeWindow: "1 minute", groupId: "session" });
  const loginRateLimit = app.rateLimit({ max: () => policy().loginAttemptsPerMinute, allowList: () => !policy().enabled, timeWindow: "1 minute", groupId: "login" });
  const managementRateLimit = app.rateLimit({ max: 60, timeWindow: "1 minute", groupId: "management" });
  const sessionRoutes = new Set(["/api/v1/auth/me", "/api/v1/auth/workspace", "/api/v1/auth/logout"]);

  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/") || route.config?.rateLimit !== undefined) return;
    const handlers = !route.preHandler ? [] : Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler];
    // Route authentication runs first, so only verified identities receive a
    // user budget; arbitrary cookies and headers cannot create new buckets.
    const limiter = route.url === "/api/v1/settings" ? managementRateLimit
      : route.url === "/api/v1/auth/login" ? loginRateLimit
      : sessionRoutes.has(route.url) ? sessionRateLimit : apiRateLimit;
    route.preHandler = [...handlers, limiter];
  });
}
