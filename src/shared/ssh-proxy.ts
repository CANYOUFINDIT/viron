import { connect, isIP, type Socket } from "node:net";
import type { SshConnectInput } from "./ssh-connect.js";

const MAX_PROXY_RESPONSE_BYTES = 32 * 1024;

function proxyError(message: string, translate: (key: string) => string): Error {
  return new Error(translate(message));
}

function connectSocket(socket: Socket): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

function finishProxyHandshake(socket: Socket): void {
  socket.setTimeout(0);
  socket.setNoDelay(true);
  socket.removeAllListeners("timeout");
  setImmediate(() => { if (!socket.destroyed) socket.resume(); });
}

function readBytes(socket: Socket, length: number, translate: (key: string) => string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = () => {
      if (buffered.length < length) return;
      socket.pause();
      cleanup();
      const result = buffered.subarray(0, length);
      const remaining = buffered.subarray(length);
      if (remaining.length) socket.unshift(remaining);
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      finish();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(proxyError("代理服务器提前关闭连接", translate));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

function readHttpHeaders(socket: Socket, translate: (key: string) => string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if ((end < 0 ? buffered.length : end + 4) > MAX_PROXY_RESPONSE_BYTES) {
        cleanup();
        reject(proxyError("代理服务器响应过大", translate));
        return;
      }
      if (end < 0) return;
      socket.pause();
      cleanup();
      const remaining = buffered.subarray(end + 4);
      if (remaining.length) socket.unshift(remaining);
      resolve(buffered.subarray(0, end).toString("latin1"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(proxyError("代理服务器提前关闭连接", translate));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.resume();
  });
}

async function openHttpProxy(socket: Socket, connection: SshConnectInput, translate: (key: string) => string): Promise<Socket> {
  const options = connection.options;
  const authority = isIP(connection.host) === 6 ? `[${connection.host}]:${connection.port}` : `${connection.host}:${connection.port}`;
  const authorization = options.proxyUsername
    ? `Proxy-Authorization: Basic ${Buffer.from(`${options.proxyUsername}:${connection.credential.proxyPassword ?? ""}`).toString("base64")}\r\n`
    : "";
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: Keep-Alive\r\n${authorization}\r\n`);
  const headers = await readHttpHeaders(socket, translate);
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i.exec(headers);
  if (!match || Number(match[1]) < 200 || Number(match[1]) >= 300) {
    socket.destroy();
    throw proxyError("HTTP 代理拒绝了 SSH 隧道", translate);
  }
  finishProxyHandshake(socket);
  return socket;
}

async function openSocks5Proxy(socket: Socket, connection: SshConnectInput, translate: (key: string) => string): Promise<Socket> {
  const options = connection.options;
  const hasCredentials = Boolean(options.proxyUsername);
  socket.write(Buffer.from(hasCredentials ? [5, 2, 0, 2] : [5, 1, 0]));
  const greeting = await readBytes(socket, 2, translate);
  if (greeting[0] !== 5 || greeting[1] === 0xff) {
    socket.destroy();
    throw proxyError("SOCKS5 代理没有可用的认证方式", translate);
  }
  if (greeting[1] === 2) {
    const username = Buffer.from(options.proxyUsername ?? "", "utf8");
    const password = Buffer.from(connection.credential.proxyPassword ?? "", "utf8");
    if (!username.length || username.length > 255 || password.length > 255) {
      socket.destroy();
      throw proxyError("SOCKS5 代理用户名或密码长度无效", translate);
    }
    socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
    const auth = await readBytes(socket, 2, translate);
    if (auth[0] !== 1 || auth[1] !== 0) {
      socket.destroy();
      throw proxyError("SOCKS5 代理认证失败", translate);
    }
  } else if (greeting[1] !== 0) {
    socket.destroy();
    throw proxyError("SOCKS5 代理返回了不支持的认证方式", translate);
  }

  let address: Buffer;
  if (isIP(connection.host) === 4) {
    address = Buffer.from([1, ...connection.host.split(".").map(Number)]);
  } else if (isIP(connection.host) === 6) {
    // URL canonicalizes embedded IPv4 literals into hexadecimal groups.
    const normalized = new URL(`http://[${connection.host}]/`).hostname.slice(1, -1);
    const [left, right] = normalized.split("::");
    const leading = left ? left.split(":") : [];
    const trailing = right ? right.split(":") : [];
    const groups = [...leading, ...Array(8 - leading.length - trailing.length).fill("0"), ...trailing];
    address = Buffer.alloc(17);
    address[0] = 4;
    groups.forEach((group, index) => address.writeUInt16BE(parseInt(group, 16), 1 + index * 2));
  } else {
    const hostname = Buffer.from(connection.host, "utf8");
    if (!hostname.length || hostname.length > 255) {
      socket.destroy();
      throw proxyError("SOCKS5 目标主机名长度无效", translate);
    }
    address = Buffer.concat([Buffer.from([3, hostname.length]), hostname]);
  }
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([connection.port >> 8, connection.port & 0xff])]));
  const response = await readBytes(socket, 4, translate);
  if (response[0] !== 5 || response[1] !== 0 || response[2] !== 0) {
    socket.destroy();
    throw proxyError("SOCKS5 代理无法连接 SSH 主机", translate);
  }
  const addressLength = response[3] === 1 ? 4 : response[3] === 4 ? 16 : response[3] === 3 ? (await readBytes(socket, 1, translate))[0] : -1;
  if (addressLength < 0) {
    socket.destroy();
    throw proxyError("SOCKS5 代理响应格式无效", translate);
  }
  await readBytes(socket, addressLength + 2, translate);
  finishProxyHandshake(socket);
  return socket;
}

export async function openSshProxySocket(
  connection: SshConnectInput,
  translate: (key: string) => string = (key) => key,
): Promise<Socket | undefined> {
  const proxyType = connection.options.proxyType ?? "none";
  if (proxyType === "none") return undefined;
  if (!connection.options.proxyHost || !connection.options.proxyPort) throw proxyError("代理服务器地址不完整", translate);
  if (/[\s\x00-\x1f\x7f]/.test(connection.host)) throw proxyError("代理目标主机地址无效", translate);
  const socket = connect({
    host: connection.options.proxyHost,
    port: connection.options.proxyPort,
    family: connection.options.ipVersion === "ipv4" ? 4 : connection.options.ipVersion === "ipv6" ? 6 : undefined,
  });
  // Keep a listener between handshake reads, and bound the entire negotiation,
  // including a proxy that sends partial responses indefinitely.
  const onError = () => {};
  socket.on("error", onError);
  const deadline = setTimeout(() => socket.destroy(proxyError("连接代理服务器超时", translate)),
    Math.max(1, Number(connection.options.connectTimeoutSeconds ?? 15)) * 1000);
  try {
    await connectSocket(socket);
    return await (proxyType === "http" ? openHttpProxy(socket, connection, translate) : openSocks5Proxy(socket, connection, translate));
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(deadline);
    socket.off("error", onError);
  }
}
