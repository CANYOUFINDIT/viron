import { describe, expect, it } from "vitest";
import { webSocketUrl } from "../src/client/service-url";

describe("webSocketUrl", () => {
  it("keeps the browser host and custom port for LAN access", () => {
    expect(webSocketUrl("/ws/ssh", { ticket: "a value" }, "http://192.168.1.20:5173/ssh")).toBe(
      "ws://192.168.1.20:5173/ws/ssh?ticket=a+value",
    );
  });

  it("uses secure WebSockets behind HTTPS origins", () => {
    expect(webSocketUrl("/ws/ssh", { ticket: "token" }, "https://viron.example.test/workbench")).toBe(
      "wss://viron.example.test/ws/ssh?ticket=token",
    );
  });
});
