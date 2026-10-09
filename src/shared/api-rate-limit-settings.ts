export interface ApiRateLimitSettings {
  enabled: boolean;
  userRequestsPerMinute: number;
  anonymousRequestsPerMinute: number;
  sessionRequestsPerMinute: number;
  loginAttemptsPerMinute: number;
  ipRequestsPerMinute: number;
}

export const API_RATE_LIMIT_BOUNDS = {
  userRequestsPerMinute: { min: 1, max: 100_000 },
  anonymousRequestsPerMinute: { min: 1, max: 100_000 },
  sessionRequestsPerMinute: { min: 1, max: 10_000 },
  loginAttemptsPerMinute: { min: 1, max: 1000 },
  ipRequestsPerMinute: { min: 1, max: 1_000_000 },
} as const;

export function defaultApiRateLimitSettings(): ApiRateLimitSettings {
  return {
    enabled: true,
    userRequestsPerMinute: 1200,
    anonymousRequestsPerMinute: 300,
    sessionRequestsPerMinute: 120,
    loginAttemptsPerMinute: 20,
    ipRequestsPerMinute: 6000,
  };
}
