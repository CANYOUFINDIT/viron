import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";

const defaultCandidates = [
  process.env.OPENSSL_BIN,
  "/opt/homebrew/bin/openssl",
  "/opt/homebrew/opt/openssl@3/bin/openssl",
  "/usr/local/opt/openssl@3/bin/openssl",
  "/usr/local/bin/openssl",
  "/usr/bin/openssl",
  "openssl",
].filter(Boolean);

function commandAvailable(command) {
  if (command.includes("/")) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return spawnSync(command, ["version"], { stdio: "ignore" }).status === 0;
}

export function resolveOpenSslCommand(candidates = defaultCandidates, available = commandAvailable) {
  const command = candidates.find((candidate) => available(candidate));
  if (!command) throw new Error("没有找到可用的 OpenSSL 命令");
  return command;
}

export function supportsPkcs12Legacy(command, runner = spawnSync) {
  const result = runner(command, ["pkcs12", "-help"], { encoding: "utf8" });
  return `${result.stdout || ""}\n${result.stderr || ""}`.includes("-legacy");
}

export function pkcs12ExportArgs({ output, key, certificate, password, legacy }) {
  return [
    "pkcs12",
    "-export",
    ...(legacy ? ["-legacy"] : []),
    "-out", output,
    "-inkey", key,
    "-in", certificate,
    "-passout", `pass:${password}`,
  ];
}
