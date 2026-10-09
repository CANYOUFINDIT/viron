import { z } from "zod";
import { API_RATE_LIMIT_BOUNDS } from "../shared/api-rate-limit-settings.js";

function requestBudget(key: keyof typeof API_RATE_LIMIT_BOUNDS) {
  const bounds = API_RATE_LIMIT_BOUNDS[key];
  return z.number().int().min(bounds.min).max(bounds.max);
}

export const apiRateLimitSettingsSchema = z.object({
  enabled: z.boolean(),
  userRequestsPerMinute: requestBudget("userRequestsPerMinute"),
  anonymousRequestsPerMinute: requestBudget("anonymousRequestsPerMinute"),
  sessionRequestsPerMinute: requestBudget("sessionRequestsPerMinute"),
  loginAttemptsPerMinute: requestBudget("loginAttemptsPerMinute"),
  ipRequestsPerMinute: requestBudget("ipRequestsPerMinute"),
}).strict();
