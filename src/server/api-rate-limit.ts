import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";

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
  await app.register(rateLimit, {
    global: false,
    hook: "preHandler",
    keyGenerator: principalKey,
    errorResponseBuilder: (_request, context) => rateLimitResponse(context.ttl),
  });

  // Bound unauthenticated traffic before credentials are checked. This limiter
  // uses createRateLimit so it does not suppress the per-route/user limiter.
  const ipRateLimit = app.createRateLimit({ max: 6000, timeWindow: "1 minute", keyGenerator: (request) => request.ip });
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    const result = await ipRateLimit(request);
    if (result.isAllowed || !result.isExceeded) return;
    await reply.code(429).headers({
      "x-ratelimit-limit": result.max,
      "x-ratelimit-remaining": 0,
      "x-ratelimit-reset": result.ttlInSeconds,
      "retry-after": result.ttlInSeconds,
    }).send(rateLimitResponse(result.ttl));
  });

  const apiRateLimit = app.rateLimit({
    max: (request) => request.admin || request.apiKey ? 1200 : 300,
    timeWindow: "1 minute",
    groupId: "api",
  });
  const sessionRateLimit = app.rateLimit({ max: 120, timeWindow: "1 minute", groupId: "session" });
  const sessionRoutes = new Set(["/api/v1/auth/me", "/api/v1/auth/workspace", "/api/v1/auth/logout"]);

  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/") || route.config?.rateLimit !== undefined) return;
    const handlers = !route.preHandler ? [] : Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler];
    // Route authentication runs first, so only verified identities receive a
    // user budget; arbitrary cookies and headers cannot create new buckets.
    route.preHandler = [...handlers, sessionRoutes.has(route.url) ? sessionRateLimit : apiRateLimit];
  });
}
