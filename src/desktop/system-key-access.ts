export const SYSTEM_KEY_ACCESS_CONSENT_VERSION = 1;

export function systemKeyAccessConsentRequired(
  storedVersion: number | undefined,
  hasStoredIdentity: boolean,
): boolean {
  return storedVersion !== SYSTEM_KEY_ACCESS_CONSENT_VERSION && !hasStoredIdentity;
}
