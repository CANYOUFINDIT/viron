import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, dialog, session, type Session } from "electron";
import {
  createDeviceIdentity,
  validateDeviceIdentity,
  type DeviceIdentity,
} from "./device-identity.js";
import { translate as tr } from "./i18n.js";
import { DesktopSecretStorage } from "./secret-storage.js";
import {
  SYSTEM_KEY_ACCESS_CONSENT_VERSION,
  systemKeyAccessConsentRequired,
} from "./system-key-access.js";
import { readState, writeState } from "./app-state.js";
import { mainWindow } from "./window-host.js";

interface StoredDeviceIdentity {
  deviceId: string;
  keyId: string;
  publicKey: string;
  encryptedPrivateKey: string;
}

interface DesktopDeviceFile {
  identities?: Record<string, StoredDeviceIdentity>;
}

let systemKeyAccessConsentPrompt: Promise<void> | null = null;
let systemKeyAccessConfirmedThisLaunch = false;

export function devicePath(): string {
  return join(app.getPath("userData"), "desktop-devices.json");
}

export function readDeviceFile(): DesktopDeviceFile {
  try {
    return JSON.parse(readFileSync(devicePath(), "utf8")) as DesktopDeviceFile;
  } catch {
    return {};
  }
}

export function writeDeviceFile(state: DesktopDeviceFile): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(devicePath(), `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function identityKey(endpoint: string, userId: string): string {
  return createHash("sha256").update(`${endpoint}\0${userId}`).digest("hex");
}

export function rememberSystemKeyAccessConsent(): void {
  if (process.platform === "darwin") return;
  const state = readState();
  if (state.systemKeyAccessConsentVersion === SYSTEM_KEY_ACCESS_CONSENT_VERSION) return;
  writeState({ ...state, systemKeyAccessConsentVersion: SYSTEM_KEY_ACCESS_CONSENT_VERSION });
}

export function forgetSystemKeyAccessConsent(): void {
  if (process.platform !== "darwin") {
    const state = readState();
    if (state.systemKeyAccessConsentVersion !== undefined) {
      delete state.systemKeyAccessConsentVersion;
      writeState(state);
    }
  }
  systemKeyAccessConfirmedThisLaunch = false;
}

export function hasStoredDeviceIdentity(endpoint: string, userId: string): boolean {
  return Boolean(readDeviceFile().identities?.[identityKey(endpoint, userId)]);
}

export function systemKeyAccessCopy(): { message: string; detail: string } {
  if (process.platform === "win32") {
    return {
      message: tr("允许 Viron 使用 Windows 安全存储保护设备密钥？"),
      detail: [
        tr("为了从当前电脑安全连接 Web 账号、SSH/SFTP 主机、环境日志和数据库，Viron 会为当前 Endpoint 和用户生成独立设备私钥，并使用当前 Windows 用户的数据保护能力加密保存。"),
        tr("设备私钥只供 Viron 主进程使用，不会打包进安装程序，也不会上传到 Endpoint。"),
      ].join("\n\n"),
    };
  }
  return {
    message: tr("允许 Viron 使用操作系统安全存储保护设备密钥？"),
    detail: tr("设备私钥只供 Viron 主进程使用，不会打包进 App，也不会上传到 Endpoint。"),
  };
}

export function deviceIdentity(endpoint: string, userId: string): DeviceIdentity {
  const state = readDeviceFile();
  const key = identityKey(endpoint, userId);
  const stored = state.identities?.[key];
  const secretStorage = new DesktopSecretStorage(app.getPath("userData"));
  if (stored && secretStorage.supports(stored.encryptedPrivateKey)) {
    let privateKey: string;
    try {
      privateKey = secretStorage.decrypt(stored.encryptedPrivateKey, `device-private-key:${key}`);
    } catch {
      throw new Error(tr("未能读取本机保存的 Viron 设备私钥，请重新登录后重试"));
    }
    const identity = {
      deviceId: stored.deviceId,
      keyId: stored.keyId,
      publicKey: stored.publicKey,
      privateKey,
    };
    if (validateDeviceIdentity(identity)) return identity;
  }
  const created = createDeviceIdentity();
  let encryptedPrivateKey: string;
  try {
    encryptedPrivateKey = secretStorage.encrypt(created.privateKey, `device-private-key:${key}`);
  } catch {
    throw new Error(tr("未能在本机保存 Viron 设备私钥，请检查当前用户的数据目录权限"));
  }
  const next: StoredDeviceIdentity = {
    deviceId: created.deviceId,
    keyId: created.keyId,
    publicKey: created.publicKey,
    encryptedPrivateKey,
  };
  writeDeviceFile({ identities: { ...state.identities, [key]: next } });
  return created;
}

export async function confirmSystemKeyAccess(endpoint: string, userId: string): Promise<void> {
  if (process.platform === "darwin") return;
  if (systemKeyAccessConfirmedThisLaunch) return;
  if (systemKeyAccessConsentPrompt) return await systemKeyAccessConsentPrompt;
  if (!systemKeyAccessConsentRequired(
    readState().systemKeyAccessConsentVersion,
    hasStoredDeviceIdentity(endpoint, userId),
  )) {
    systemKeyAccessConfirmedThisLaunch = true;
    return;
  }
  systemKeyAccessConsentPrompt = (async () => {
    if (!mainWindow) throw new Error(tr("主窗口不可用"));
    const copy = systemKeyAccessCopy();
    const result = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: tr("Viron 系统安全存储授权"),
      message: copy.message,
      detail: copy.detail,
      buttons: [tr("同意并继续"), tr("暂不允许")],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response !== 0) throw new Error(tr("已取消系统安全存储授权，Viron 未访问操作系统安全存储"));
    systemKeyAccessConfirmedThisLaunch = true;
  })();
  try {
    await systemKeyAccessConsentPrompt;
  } finally {
    systemKeyAccessConsentPrompt = null;
  }
}

export function endpointSession(endpoint: string): Session {
  const key = createHash("sha256").update(endpoint).digest("hex").slice(0, 32);
  const endpointPartition = session.fromPartition(`persist:viron-endpoint-${key}`);
  endpointPartition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  return endpointPartition;
}
