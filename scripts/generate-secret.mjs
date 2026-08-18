import { randomBytes } from "node:crypto";

process.stdout.write(`${randomBytes(32).toString("base64")}\n`);
