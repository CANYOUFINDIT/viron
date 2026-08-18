import { describe, expect, it } from "vitest";
import {
  SYSTEM_KEY_ACCESS_CONSENT_VERSION,
  systemKeyAccessConsentRequired,
} from "../src/desktop/system-key-access.js";

describe("desktop system key access consent", () => {
  it("prompts a fresh installation before its first system storage access", () => {
    expect(systemKeyAccessConsentRequired(undefined, false)).toBe(true);
  });

  it("does not repeat the explanation after the consent version is stored", () => {
    expect(systemKeyAccessConsentRequired(SYSTEM_KEY_ACCESS_CONSENT_VERSION, false)).toBe(false);
  });

  it("migrates an existing encrypted device identity without prompting again", () => {
    expect(systemKeyAccessConsentRequired(undefined, true)).toBe(false);
  });

  it("prompts again when the consent copy version changes and no identity exists", () => {
    expect(systemKeyAccessConsentRequired(SYSTEM_KEY_ACCESS_CONSENT_VERSION - 1, false)).toBe(true);
  });
});
