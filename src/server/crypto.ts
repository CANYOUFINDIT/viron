import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

export interface SecretBox {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export function createSecretBox(masterKey: Buffer): SecretBox {
  return {
    encrypt(value: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv(ALGORITHM, masterKey, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
    },

    decrypt(value: string): string {
      const [version, ivValue, tagValue, encryptedValue] = value.split(":");
      if (version !== VERSION || !ivValue || !tagValue || encryptedValue === undefined) {
        throw new Error("Unsupported encrypted secret format.");
      }
      const decipher = createDecipheriv(ALGORITHM, masterKey, Buffer.from(ivValue, "base64"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, "base64")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
}
