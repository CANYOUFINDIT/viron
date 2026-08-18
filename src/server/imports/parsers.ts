import { createDecipheriv, createHash } from "node:crypto";
import { basename, extname, posix } from "node:path";
import { hash as bcryptHash } from "bcrypt-pbkdf";
import { XMLParser } from "fast-xml-parser";
import yauzl from "yauzl";

export interface ImportedSshPayload {
  type: "ssh";
  importKey: string;
  sourcePath: string;
  groupPath: string[];
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey" | "keyboardInteractive";
  credential: { password?: string; privateKey?: string; passphrase?: string };
  options: Record<string, unknown>;
  warnings: string[];
}

export interface ImportedDatabasePayload {
  type: "database";
  importKey: string;
  sourcePath: string;
  groupPath: string[];
  name: string;
  engine: "mysql" | "mariadb";
  host: string;
  port: number;
  username: string;
  credential: { password?: string; httpTunnelUsername?: string; httpTunnelPassword?: string };
  defaultDatabase: string;
  connectionMode: "tcp" | "sshTunnel" | "httpTunnel";
  sshImportKey?: string;
  options: Record<string, unknown>;
  warnings: string[];
}

export type ImportedPayload = ImportedSshPayload | ImportedDatabasePayload;

export interface ImportFile {
  path: string;
  content: Buffer;
  /** Original source path when `path` is normalized for classification. */
  sourcePath?: string;
}

const MAX_ARCHIVE_FILES = 5_000;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 200;

function decryptAesCbc(ciphertext: Buffer, key: Buffer, iv: Buffer, autoPadding: boolean): Buffer {
  const decipher = createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  decipher.setAutoPadding(autoPadding);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function bcryptPbkdf(password: Buffer, salt: Buffer, keyLength: number, rounds: number): Buffer {
  const blockSize = 32;
  const output = Buffer.alloc(keyLength);
  const passwordHash = createHash("sha512").update(password).digest();
  const stride = Math.ceil(keyLength / blockSize);
  const amount = Math.ceil(keyLength / stride);
  let remaining = keyLength;
  for (let count = 1; remaining > 0; count += 1) {
    const countSalt = Buffer.alloc(salt.length + 4);
    salt.copy(countSalt);
    countSalt.writeUInt32BE(count, salt.length);
    let saltHash = createHash("sha512").update(countSalt).digest();
    let temporary = Buffer.alloc(blockSize);
    bcryptHash(passwordHash, saltHash, temporary);
    const block = Buffer.from(temporary);
    for (let round = 1; round < rounds; round += 1) {
      saltHash = createHash("sha512").update(temporary).digest();
      temporary = Buffer.alloc(blockSize);
      bcryptHash(passwordHash, saltHash, temporary);
      for (let index = 0; index < blockSize; index += 1) block[index] ^= temporary[index];
    }
    const use = Math.min(amount, remaining);
    for (let index = 0; index < use; index += 1) {
      const destination = index * stride + (count - 1);
      if (destination >= keyLength) break;
      output[destination] = block[index];
    }
    remaining -= use;
  }
  return output;
}

export function decryptSecureCrtPassword(value: string, passphrase = ""): string {
  const match = value.trim().match(/^(02|03):([0-9a-fA-F]+)$/);
  if (!match) throw new Error("不支持的 SecureCRT Password V2 格式");
  const prefix = match[1];
  let ciphertext = Buffer.from(match[2], "hex");
  let key: Buffer;
  let iv: Buffer;
  if (prefix === "02") {
    key = createHash("sha256").update(passphrase, "utf8").digest();
    iv = Buffer.alloc(16);
  } else {
    if (ciphertext.length < 32) throw new Error("SecureCRT Password V2 密文长度不正确");
    const salt = ciphertext.subarray(0, 16);
    ciphertext = ciphertext.subarray(16);
    const passwordBytes = Buffer.from(passphrase, "utf8");
    const derived = bcryptPbkdf(passwordBytes, salt, 48, 16);
    key = derived.subarray(0, 32);
    iv = derived.subarray(32, 48);
  }
  if (!ciphertext.length || ciphertext.length % 16 !== 0) throw new Error("SecureCRT 密文块长度不正确");
  const padded = decryptAesCbc(ciphertext, key, iv, false);
  if (padded.length < 36) throw new Error("SecureCRT 解密结果长度不正确");
  const length = padded.readUInt32LE(0);
  if (length > padded.length - 36) throw new Error("SecureCRT 解密校验失败");
  const plaintext = padded.subarray(4, 4 + length);
  const checksum = padded.subarray(4 + length, 36 + length);
  if (!createHash("sha256").update(plaintext).digest().equals(checksum)) throw new Error("SecureCRT 密码校验失败");
  return plaintext.toString("utf8");
}

export function decryptNavicatV2Password(value: string): string {
  const ciphertext = Buffer.from(value.trim(), "hex");
  if (!ciphertext.length || ciphertext.length % 16 !== 0) throw new Error("Navicat 密文不是 V2 AES 格式");
  return decryptAesCbc(ciphertext, Buffer.from("libcckeylibcckey", "ascii"), Buffer.from("libcciv libcciv ", "ascii"), true).toString("utf8");
}

function iniValue(lines: Map<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = lines.get(name.toLowerCase());
    if (value !== undefined) return value;
  }
  return "";
}

function parseSecureCrtFile(file: ImportFile, passphrase: string): ImportedSshPayload | null {
  const content = file.content.toString("utf8").replace(/^\uFEFF/, "");
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^[SD]:"([^"]+)"=(.*)$/);
    if (!match) continue;
    const [, name, raw] = match;
    if (line.startsWith("D:")) {
      const parsed = Number.parseInt(raw, 16);
      values.set(name.toLowerCase(), Number.isFinite(parsed) ? String(parsed) : raw);
    } else {
      values.set(name.toLowerCase(), raw);
    }
  }
  const host = iniValue(values, "Hostname").trim();
  const protocol = iniValue(values, "Protocol Name", "Protocol").toLowerCase();
  if (!host || (protocol && !protocol.includes("ssh"))) return null;
  const warnings: string[] = [];
  const encryptedPassword = iniValue(values, "Password V2");
  let password = "";
  if (encryptedPassword) {
    try {
      password = decryptSecureCrtPassword(encryptedPassword, passphrase);
    } catch {
      warnings.push("Password V2 无法使用当前配置口令解密，需要补录密码");
    }
  }
  const identity = iniValue(values, "Identity Filename V2", "Identity Filename").trim();
  const usePrivateKey = !password && Boolean(identity);
  if (usePrivateKey) warnings.push(`检测到私钥引用 ${basename(identity)}，导入后需要上传私钥内容`);
  const classificationPath = file.path.replace(/\\/g, "/");
  const sourcePath = (file.sourcePath ?? file.path).replace(/\\/g, "/");
  const groupPath = classificationPath.split("/").slice(0, -1).filter(Boolean);
  return {
    type: "ssh",
    importKey: classificationPath,
    sourcePath,
    groupPath,
    name: basename(classificationPath, extname(classificationPath)),
    host,
    port: Number.parseInt(iniValue(values, "[SSH2] Port", "Port"), 10) || 22,
    username: iniValue(values, "Username").trim(),
    authType: usePrivateKey ? "privateKey" : "password",
    credential: usePrivateKey ? { privateKey: "", passphrase: "" } : { password },
    options: {
      terminalType: iniValue(values, "Terminal Type") || "xterm-256color",
      keepAliveSeconds: 30,
      encoding: "utf-8",
      hostKeySha256: "",
      secureCrtIdentityPath: identity,
      secureCrtFirewall: iniValue(values, "Firewall Name", "Firewall"),
    },
    warnings,
  };
}

function secureCrtSessionKey(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const marker = "/sessions/";
  const index = lower.lastIndexOf(marker);
  return index >= 0 ? normalized.slice(index + marker.length) : normalized.replace(/^\/+/, "");
}

export function parseSecureCrtFiles(files: ImportFile[], passphrase = ""): ImportedSshPayload[] {
  const groups = new Map<string, ImportFile[]>();
  for (const file of files.filter((item) => [".ini", ".session"].includes(extname(item.path).toLowerCase()))) {
    const key = secureCrtSessionKey(file.path);
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }
  const result: ImportedSshPayload[] = [];
  for (const [key, group] of groups) {
    group.sort((left, right) => {
      const leftPersonal = (left.sourcePath ?? left.path).toLowerCase().includes("personal") ? 1 : 0;
      const rightPersonal = (right.sourcePath ?? right.path).toLowerCase().includes("personal") ? 1 : 0;
      return leftPersonal - rightPersonal;
    });
    const primary = group.find((file) => /(^|\n)S:"Hostname"=.+/m.test(file.content.toString("utf8"))) ?? group[0];
    const merged: ImportFile = {
      path: key || primary.path,
      sourcePath: primary.sourcePath,
      content: Buffer.concat(group.map((file) => Buffer.concat([file.content, Buffer.from("\n")]))),
    };
    const parsed = parseSecureCrtFile(merged, passphrase);
    if (parsed) result.push(parsed);
  }
  return result;
}

function objectValue(object: Record<string, unknown>, ...names: string[]): string {
  const entries = Object.entries(object);
  for (const name of names) {
    const match = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (match?.[1] !== undefined && match[1] !== null) return String(match[1]);
  }
  return "";
}

interface NavicatConnectionObject {
  object: Record<string, unknown>;
  groupPath: string[];
}

function findConnectionObjects(value: unknown, groupPath: string[] = [], result: NavicatConnectionObject[] = [], nodeName = ""): NavicatConnectionObject[] {
  if (Array.isArray(value)) {
    for (const item of value) findConnectionObjects(item, groupPath, result, nodeName);
  } else if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (objectValue(object, "ConnType") && objectValue(object, "ConnectionName")) {
      const directGroup = objectValue(object, "Group", "GroupName", "Folder", "FolderName");
      result.push({ object, groupPath: directGroup ? directGroup.split(/[\\/]+/).filter(Boolean) : groupPath });
    } else {
      const isGroupNode = /^(group|folder|category)$/i.test(nodeName);
      const nodeGroup = isGroupNode ? objectValue(object, "Name", "GroupName", "FolderName") : "";
      const nextPath = nodeGroup ? [...groupPath, nodeGroup] : groupPath;
      for (const [childName, child] of Object.entries(object)) findConnectionObjects(child, nextPath, result, childName);
    }
  }
  return result;
}

function truthy(value: string): boolean {
  return ["true", "1", "yes"].includes(value.trim().toLowerCase());
}

function parseNavicatFile(file: ImportFile): ImportedPayload[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseAttributeValue: false,
    isArray: (tagName) => tagName === "Connection",
  });
  const document = parser.parse(file.content.toString("utf8")) as unknown;
  const result: ImportedPayload[] = [];
  const sourceBase = file.path.replace(/\\/g, "/");
  for (const [index, entry] of findConnectionObjects(document).entries()) {
    const { object, groupPath } = entry;
    const type = objectValue(object, "ConnType").toUpperCase();
    if (!["MYSQL", "MARIADB"].includes(type)) continue;
    const name = objectValue(object, "ConnectionName") || `Navicat ${index + 1}`;
    const sourcePath = [sourceBase, ...groupPath, name].filter(Boolean).join("/");
    const warnings: string[] = [];
    let password = "";
    const encryptedPassword = objectValue(object, "Password");
    if (encryptedPassword) {
      try {
        password = decryptNavicatV2Password(encryptedPassword);
      } catch {
        warnings.push("Navicat 密码不是可识别的 V2 格式，需要补录密码");
      }
    }

    const sshEnabled = truthy(objectValue(object, "SSH", "UseSSH"));
    const sshImportKey = `${sourcePath}#ssh`;
    if (sshEnabled) {
      let sshPassword = "";
      const encryptedSshPassword = objectValue(object, "SSH_Password");
      if (encryptedSshPassword) {
        try {
          sshPassword = decryptNavicatV2Password(encryptedSshPassword);
        } catch {
          warnings.push("Navicat SSH Tunnel 密码无法解密，需要补录");
        }
      }
      result.push({
        type: "ssh",
        importKey: sshImportKey,
        sourcePath: `${sourcePath}/SSH Tunnel`,
        groupPath,
        name: `${name} · SSH Tunnel`,
        host: objectValue(object, "SSH_Host"),
        port: Number.parseInt(objectValue(object, "SSH_Port"), 10) || 22,
        username: objectValue(object, "SSH_UserName"),
        authType: truthy(objectValue(object, "SSH_AuthMethod")) ? "privateKey" : "password",
        credential: { password: sshPassword },
        options: { terminalType: "xterm-256color", keepAliveSeconds: 30, encoding: "utf-8", hostKeySha256: "" },
        warnings: sshPassword || !encryptedSshPassword ? [] : ["SSH Tunnel 凭据需要补录"],
      });
    }

    const httpEnabled = truthy(objectValue(object, "HTTP", "UseHTTP", "HTTPTunnel"));
    const httpTunnelUsername = objectValue(object, "HTTP_UserName", "HTTPUsername", "HTTP_User");
    let httpTunnelPassword = "";
    const encryptedHttpPassword = objectValue(object, "HTTP_Password", "HTTPPassword");
    if (encryptedHttpPassword) {
      try {
        httpTunnelPassword = decryptNavicatV2Password(encryptedHttpPassword);
      } catch {
        warnings.push("Navicat HTTP Tunnel 认证密码无法解密，需要补录");
      }
    }
    const sslEnabled = truthy(objectValue(object, "SSL", "UseSSL"));
    result.push({
      type: "database",
      importKey: sourcePath,
      sourcePath,
      groupPath,
      name,
      engine: type === "MARIADB" ? "mariadb" : "mysql",
      host: objectValue(object, "Host"),
      port: Number.parseInt(objectValue(object, "Port"), 10) || 3306,
      username: objectValue(object, "UserName", "Username"),
      credential: { password, httpTunnelUsername, httpTunnelPassword },
      defaultDatabase: objectValue(object, "Database", "InitialDatabase"),
      connectionMode: sshEnabled ? "sshTunnel" : httpEnabled ? "httpTunnel" : "tcp",
      sshImportKey: sshEnabled ? sshImportKey : undefined,
      options: {
        charset: objectValue(object, "CharacterSet", "Charset") || "utf8mb4",
        timezone: "local",
        connectTimeoutMs: 10_000,
        ssl: {
          enabled: sslEnabled,
          rejectUnauthorized: true,
          ca: objectValue(object, "SSL_CA"),
          certificate: objectValue(object, "SSL_CERT"),
          privateKey: objectValue(object, "SSL_KEY"),
          passphrase: "",
        },
        httpTunnelUrl: objectValue(object, "HTTP_URL", "HTTPHost", "HTTPTunnelURL"),
        httpTunnelRejectUnauthorized: true,
      },
      warnings,
    });
  }
  return result;
}

function unzip(buffer: Buffer): Promise<ImportFile[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error("无法打开 ZIP 文件"));
      const files: ImportFile[] = [];
      let totalBytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on("entry", (entry) => {
        if (settled) return;
        const path = entry.fileName.replace(/\\/g, "/");
        if (path.startsWith("/") || path.split("/").includes("..")) return fail(new Error("ZIP 中包含不安全路径"));
        if (/\/$/.test(path)) return zip.readEntry();
        if (files.length >= MAX_ARCHIVE_FILES) return fail(new Error(`ZIP 文件数量超过 ${MAX_ARCHIVE_FILES}`));
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_ARCHIVE_BYTES) return fail(new Error("ZIP 解压后大小超过 100MB"));
        if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > MAX_EXPANSION_RATIO) return fail(new Error("ZIP 文件压缩比异常"));
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError ?? new Error("无法读取 ZIP 条目"));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.once("error", fail);
          stream.once("end", () => {
            files.push({ path: posix.normalize(path), content: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.once("error", fail);
      zip.once("end", () => {
        if (!settled) {
          settled = true;
          resolve(files);
        }
      });
      zip.readEntry();
    });
  });
}

export async function parseConnectionImport(type: "securecrt" | "navicat", filename: string, buffer: Buffer, passphrase = ""): Promise<ImportedPayload[]> {
  const files = extname(filename).toLowerCase() === ".zip" ? await unzip(buffer) : [{ path: filename, content: buffer }];
  if (type === "securecrt") {
    return parseSecureCrtFiles(files, passphrase);
  }
  return files
    .filter((file) => [".ncx", ".xml"].includes(extname(file.path).toLowerCase()))
    .flatMap(parseNavicatFile);
}
