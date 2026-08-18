import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { probeDesktopTcpTarget } from "../src/desktop/connection-quality-probe.js";

describe("desktop connection quality probe", () => {
  it("measures a TCP connection from the current device", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      await expect(probeDesktopTcpTarget({ host: "127.0.0.1", port: address.port }, 1_000)).resolves.toEqual(expect.any(Number));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
