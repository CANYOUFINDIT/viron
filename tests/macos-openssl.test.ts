import { describe, expect, it } from "vitest";
import { pkcs12ExportArgs, resolveOpenSslCommand, supportsPkcs12Legacy } from "../scripts/macos-openssl.mjs";

describe("macOS OpenSSL packaging helpers", () => {
  it("selects the first available OpenSSL candidate", () => {
    expect(resolveOpenSslCommand(["/missing/openssl", "/available/openssl"], (command) => command === "/available/openssl"))
      .toBe("/available/openssl");
  });

  it("detects whether pkcs12 supports the legacy option", () => {
    expect(supportsPkcs12Legacy("openssl", () => ({ stdout: "", stderr: "  -legacy  Use legacy encryption" })))
      .toBe(true);
    expect(supportsPkcs12Legacy("openssl", () => ({ stdout: "", stderr: "pkcs12 usage" })))
      .toBe(false);
  });

  it("only adds the legacy option when the selected OpenSSL supports it", () => {
    const input = { output: "identity.p12", key: "key.pem", certificate: "certificate.pem", password: "secret" };
    expect(pkcs12ExportArgs({ ...input, legacy: true })).toContain("-legacy");
    expect(pkcs12ExportArgs({ ...input, legacy: false })).not.toContain("-legacy");
  });
});
