import { EventEmitter } from "node:events";
import type { Client, ConnectConfig } from "ssh2";
import { describe, expect, it, vi } from "vitest";
import { connectSshClient } from "../src/shared/ssh-client.js";

class FakeSshClient extends EventEmitter {
  readonly connect = vi.fn((_config: ConnectConfig) => this);
}

const config: ConnectConfig = {
  host: "127.0.0.1",
  port: 22,
  username: "operator",
  password: "secret",
};

describe("SSH client connection lifecycle", () => {
  it("rejects the connection attempt without exposing later client errors as uncaught exceptions", async () => {
    const client = new FakeSshClient();
    const connection = connectSshClient(client as unknown as Client, config);
    const socketError = new Error("read ECONNRESET");

    client.emit("error", socketError);
    await expect(connection).rejects.toBe(socketError);

    expect(client.listenerCount("error")).toBe(1);
    expect(() => client.emit("error", new Error("Connection lost before handshake"))).not.toThrow();
  });

  it("keeps a fallback error listener after the client becomes ready", async () => {
    const client = new FakeSshClient();
    const connection = connectSshClient(client as unknown as Client, config);

    client.emit("ready");
    await expect(connection).resolves.toBe(client);

    const runtimeError = vi.fn();
    client.once("error", runtimeError);
    const firstError = new Error("Keepalive timeout");
    client.emit("error", firstError);
    expect(runtimeError).toHaveBeenCalledWith(firstError);
    expect(() => client.emit("error", new Error("Connection lost"))).not.toThrow();
  });
});
