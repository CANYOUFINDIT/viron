import { describe, expect, it } from "vitest";
import { normalizeWebAddress } from "../src/shared/web-address.js";

describe("Web browser address input", () => {
  it("adds HTTPS when the user enters a host without a protocol", () => {
    expect(normalizeWebAddress("www.baidu.com")).toBe("https://www.baidu.com/");
    expect(normalizeWebAddress(" example.com/path?q=1 ")).toBe("https://example.com/path?q=1");
    expect(normalizeWebAddress("localhost:8080/healthz")).toBe("http://localhost:8080/healthz");
    expect(normalizeWebAddress("envman:8080/healthz")).toBe("http://envman:8080/healthz");
    expect(normalizeWebAddress("192.168.1.20:8080")).toBe("http://192.168.1.20:8080/");
  });

  it("preserves explicit HTTP(S) addresses", () => {
    expect(normalizeWebAddress("http://127.0.0.1:8080/healthz")).toBe("http://127.0.0.1:8080/healthz");
    expect(normalizeWebAddress("HTTPS://Example.com/Login")).toBe("https://example.com/Login");
  });

  it("rejects empty, malformed, and unsupported addresses", () => {
    expect(normalizeWebAddress(" ")).toBeNull();
    expect(normalizeWebAddress("not a host")).toBeNull();
    expect(normalizeWebAddress("file:///tmp/secret")).toBeNull();
    expect(normalizeWebAddress("javascript:alert(1)")).toBeNull();
  });
});
