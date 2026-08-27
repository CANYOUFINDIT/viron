import { randomUUID } from "node:crypto";

export function operationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "idempotency-key": `${randomUUID()}${randomUUID()}`.slice(0, 48), ...extra };
}

export async function waitForOperation(
  app: { inject: (opts: object) => Promise<{ statusCode: number; json: () => { item: { id: string; status: string; result?: { succeeded: number; failed: number; targets?: Array<Record<string, unknown>> } } } }> },
  cookies: unknown,
  operationId: string,
): Promise<{ id: string; status: string; result?: { succeeded: number; failed: number; targets?: Array<Record<string, unknown>> } }> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/v1/service-operations/${operationId}`, cookies });
    if (response.statusCode === 200 && !["queued", "running"].includes(response.json().item.status)) {
      return response.json().item;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`operation ${operationId} did not finish`);
}
