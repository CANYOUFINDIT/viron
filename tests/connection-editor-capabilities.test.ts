import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("professional connection editor capabilities", () => {
  const pool = source("src/client/views/ConnectionPoolView.vue");
  const editor = source("src/client/components/ConnectionEditDialog.vue");
  const methodPicker = source("src/client/components/ConnectionMethodPicker.vue");
  const tlsSettings = source("src/client/components/DatabaseTlsSettings.vue");

  it.each([
    ["resource pool", pool],
    ["workbench editor", editor],
  ])("keeps SSH and database connection methods consistent in the %s", (_name, contents) => {
    expect(contents).toContain("<ConnectionMethodPicker");
    expect(contents).toContain('value: "password"');
    expect(contents).toContain('value: "privateKey"');
    expect(contents).toContain('value: "keyboardInteractive"');
    expect(contents).toContain('value: "tcp"');
    expect(contents).toContain('value: "sshTunnel"');
    expect(contents).toContain('value: "httpTunnel"');
    expect(contents).toContain("跳板机 / ProxyJump");
    expect(contents).toContain("hostKeySha256: form.hostKeySha256.trim()");
    expect(contents).toContain("keepAliveSeconds: form.keepAliveSeconds");
    expect(contents).toContain("charset: form.charset");
    expect(contents).toContain("timezone: form.timezone");
    expect(contents).toContain("connectTimeoutMs: form.connectTimeoutMs");
  });

  it.each([
    ["resource pool", pool],
    ["workbench editor", editor],
  ])("submits encrypted TLS client credentials from the %s", (_name, contents) => {
    expect(contents).toContain("tlsCa: form.tlsCa");
    expect(contents).toContain("tlsCertificate: form.tlsCertificate");
    expect(contents).toContain("tlsPrivateKey: form.tlsPrivateKey");
    expect(contents).toContain("tlsPassphrase: form.tlsPassphrase");
    expect(contents).toContain("双向 TLS 必须同时配置客户端证书和客户端私钥");
    expect(contents).toContain("<DatabaseTlsSettings");
  });

  it("uses accessible radio semantics for method cards", () => {
    expect(methodPicker).toContain('role="radiogroup"');
    expect(methodPicker).toContain('role="radio"');
    expect(methodPicker).toContain(':aria-checked="modelValue === choice.value"');
  });

  it("offers explicit TLS policy levels and private CA / mTLS fields", () => {
    expect(tlsSettings).toContain('value: "disabled"');
    expect(tlsSettings).toContain('value: "required"');
    expect(tlsSettings).toContain('value: "verify"');
    expect(tlsSettings).toContain("v-model=\"ca\"");
    expect(tlsSettings).toContain("v-model=\"certificate\"");
    expect(tlsSettings).toContain("v-model=\"privateKey\"");
    expect(tlsSettings).toContain("v-model=\"passphrase\"");
  });
});
