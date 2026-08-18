import { connect } from "node:net";
import type { ConnectionQualityTargetAddress } from "../shared/connection-quality.js";

export function probeDesktopTcpTarget(target: ConnectionQualityTargetAddress, timeoutMs = 5_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = connect({ host: target.host, port: target.port });
    const finish = (error?: Error) => {
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(Math.max(0, Math.round(performance.now() - started)));
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("目标连接探测超时")));
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}
