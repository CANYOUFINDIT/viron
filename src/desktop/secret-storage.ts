import { safeStorage } from "electron";
import {
  decryptLocalSecret,
  encryptLocalSecret,
  isLocalSecretCiphertext,
} from "./local-secret-storage.js";

export class DesktopSecretStorage {
  constructor(
    private readonly userDataPath: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  supports(ciphertext: string | undefined): ciphertext is string {
    return this.platform === "darwin" ? isLocalSecretCiphertext(ciphertext) : Boolean(ciphertext);
  }

  encrypt(plaintext: string, context: string): string {
    if (this.platform === "darwin") return encryptLocalSecret(this.userDataPath, plaintext, context);
    if (!safeStorage.isEncryptionAvailable()) throw new Error("操作系统安全存储不可用");
    return safeStorage.encryptString(plaintext).toString("base64");
  }

  decrypt(ciphertext: string, context: string): string {
    if (this.platform === "darwin") return decryptLocalSecret(this.userDataPath, ciphertext, context);
    if (!safeStorage.isEncryptionAvailable()) throw new Error("操作系统安全存储不可用");
    return safeStorage.decryptString(Buffer.from(ciphertext, "base64"));
  }
}
