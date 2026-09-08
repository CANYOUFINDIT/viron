import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildSshConnectConfig, type SshConnectInput } from "../src/shared/ssh-connect.js";
import { openSshProxySocket } from "../src/shared/ssh-proxy.js";

const servers: Server[] = [];
const sockets: Socket[] = [];

function connection(overrides: Partial<SshConnectInput> = {}): SshConnectInput {
  return {
    host: "target.example.test",
    port: 22,
    username: "deploy",
    authType: "password",
    credential: { password: "secret" },
    options: {},
    ...overrides,
  };
}

async function listen(handler: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    sockets.push(socket);
    handler(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy fixture did not start");
  return address.port;
}

afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("SSH connection options", () => {
  it("configures SSH Agent authentication, forwarding, timeout, IP family, compression, and modern algorithms", () => {
    const config = buildSshConnectConfig(connection({
      authType: "sshAgent",
      credential: {},
      options: {
        agentSocket: "/tmp/test-agent.sock",
        agentForwarding: true,
        connectTimeoutSeconds: 42,
        ipVersion: "ipv6",
        compression: true,
        algorithmPreset: "modern",
      },
    }), undefined);

    expect(config).toMatchObject({
      agent: "/tmp/test-agent.sock",
      authHandler: ["agent"],
      agentForward: true,
      readyTimeout: 42_000,
      forceIPv4: false,
      forceIPv6: true,
    });
    expect(config.algorithms?.compress).toEqual(["zlib@openssh.com", "zlib", "none"]);
    expect(config.algorithms?.serverHostKey).toMatchObject({ remove: ["ssh-dss", "ssh-rsa"] });
  });

  it("adds selected legacy algorithms only in compatibility mode", () => {
    const config = buildSshConnectConfig(connection({ options: { algorithmPreset: "compatible" } }), undefined);
    expect(config.algorithms?.kex).toMatchObject({ append: expect.arrayContaining(["diffie-hellman-group14-sha1"]) });
    expect(config.algorithms?.cipher).toMatchObject({ append: expect.arrayContaining(["aes128-cbc"]) });
  });
});

describe("SSH outbound proxies", () => {
  it("opens an authenticated HTTP CONNECT tunnel without exposing credentials in options", async () => {
    let request = "";
    const port = await listen((socket) => {
      socket.once("data", (chunk) => {
        request = chunk.toString("latin1");
        socket.write("HTTP/1.1 200 Connection established\r\n\r\nREADY");
      });
    });
    const socket = await openSshProxySocket(connection({
      credential: { password: "secret", proxyPassword: "proxy-secret" },
      options: { proxyType: "http", proxyHost: "127.0.0.1", proxyPort: port, proxyUsername: "proxy-user" },
    }));
    expect(socket).toBeTruthy();
    const [ready] = await once(socket!, "data") as [Buffer];
    expect(ready.toString()).toBe("READY");
    expect(request).toContain("CONNECT target.example.test:22 HTTP/1.1");
    expect(request).toContain(`Proxy-Authorization: Basic ${Buffer.from("proxy-user:proxy-secret").toString("base64")}`);
    expect(connection().options).not.toHaveProperty("proxyPassword");
  });

  it("negotiates SOCKS5 username/password and remote DNS", async () => {
    const observed: { username?: string; password?: string; host?: string; port?: number } = {};
    const port = await listen((socket) => {
      void (async () => {
        const [greeting] = await once(socket, "data") as [Buffer];
        expect([...greeting]).toEqual([5, 2, 0, 2]);
        socket.write(Buffer.from([5, 2]));

        const [auth] = await once(socket, "data") as [Buffer];
        const usernameLength = auth[1];
        const passwordLength = auth[2 + usernameLength];
        observed.username = auth.subarray(2, 2 + usernameLength).toString();
        observed.password = auth.subarray(3 + usernameLength, 3 + usernameLength + passwordLength).toString();
        socket.write(Buffer.from([1, 0]));

        const [request] = await once(socket, "data") as [Buffer];
        expect([...request.subarray(0, 4)]).toEqual([5, 1, 0, 3]);
        const hostLength = request[4];
        observed.host = request.subarray(5, 5 + hostLength).toString();
        observed.port = request.readUInt16BE(5 + hostLength);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 22]));
      })();
    });
    const socket = await openSshProxySocket(connection({
      credential: { password: "secret", proxyPassword: "proxy-secret" },
      options: { proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: port, proxyUsername: "proxy-user" },
    }));
    expect(socket).toBeTruthy();
    expect(observed).toEqual({ username: "proxy-user", password: "proxy-secret", host: "target.example.test", port: 22 });
  });
  it.each(["2001:db8::42", "::ffff:192.0.2.1"])("encodes IPv6 target %s and preserves coalesced SSH data", async (host) => {
    let request: Buffer | undefined;
    const port = await listen((socket) => {
      socket.once("data", () => {
        socket.write(Buffer.from([5, 0]));
        socket.once("data", (chunk) => {
          request = chunk;
          socket.write(Buffer.concat([Buffer.from([5, 0, 0, 4]), Buffer.alloc(18), Buffer.from("SSH-2.0-fixture\r\n")]));
        });
      });
    });
    const socket = await openSshProxySocket(connection({ host, options: { proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: port } }));
    const [banner] = await once(socket!, "data") as [Buffer];
    expect(banner.toString()).toBe("SSH-2.0-fixture\r\n");
    expect(request?.subarray(0, 4)).toEqual(Buffer.from([5, 1, 0, 4]));
    expect(request?.subarray(4, 20).toString("hex")).toBe(host.startsWith("2001") ? "20010db8000000000000000000000042" : "00000000000000000000ffffc0000201");
    expect(request?.readUInt16BE(20)).toBe(22);
  });

  it.each(["HTTP/1.1 407 Proxy Authentication Required\r\n\r\n", "X".repeat(33 * 1024)])("closes rejected and oversized HTTP handshakes", async (response) => {
    let closed!: Promise<unknown>;
    const port = await listen((socket) => {
      closed = once(socket, "close");
      socket.once("data", () => socket.write(response));
    });
    await expect(openSshProxySocket(connection({ options: { proxyType: "http", proxyHost: "127.0.0.1", proxyPort: port } }))).rejects.toThrow();
    await closed;
  });

  it("bounds a stalled proxy handshake and closes its socket", async () => {
    let closed!: Promise<unknown>;
    const port = await listen((socket) => {
      socket.resume();
      closed = once(socket, "close");
    });
    await expect(openSshProxySocket(connection({ options: { proxyType: "http", proxyHost: "127.0.0.1", proxyPort: port, connectTimeoutSeconds: 1 } }))).rejects.toThrow("超时");
    await closed;
  });

  it("rejects premature closure during SOCKS5 negotiation", async () => {
    const port = await listen((socket) => socket.once("data", () => socket.end(Buffer.from([5]))));
    await expect(openSshProxySocket(connection({ options: { proxyType: "socks5", proxyHost: "127.0.0.1", proxyPort: port } }))).rejects.toThrow("提前关闭");
  });

  it("rejects HTTP target header injection before opening a proxy socket", async () => {
    await expect(openSshProxySocket(connection({ host: "host\r\nInjected: value", options: { proxyType: "http", proxyHost: "127.0.0.1", proxyPort: 8080 } }))).rejects.toThrow("地址无效");
  });

});
