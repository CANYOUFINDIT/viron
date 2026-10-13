export interface ApiErrorBody {
  message?: string;
  code?: string;
  details: Record<string, unknown>;
}

/** Keep the server JSON, including 409 groups. Callers decide retry separately. */
export function readApiErrorBody(rawBody: string): ApiErrorBody {
  let details: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
  } catch {
    details = {};
  }
  return {
    message: typeof details.message === "string" ? details.message : undefined,
    code: typeof details.error === "string" ? details.error : undefined,
    details,
  };
}
