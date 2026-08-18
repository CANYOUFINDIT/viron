import type { FastifyRequest } from "fastify";

export const EXECUTION_SCOPE_HEADER = "x-viron-execution-scope";

export function executionScope(request: FastifyRequest): string | null {
  const value = request.headers[EXECUTION_SCOPE_HEADER];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(normalized) ? normalized : null;
}
