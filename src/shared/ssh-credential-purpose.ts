import { z } from "zod";

/** Signed with the device key for one credential fetch. ssh.view is intentionally absent. */
export const SSH_CREDENTIAL_PURPOSE_CODES = ["ssh.use", "ssh.browse", "ssh.download", "ssh.upload", "ssh.delete", "logs.view"] as const;

export const sshCredentialPurposePayloadSchema = z.object({
  operationId: z.string().uuid(),
  connectionId: z.string().uuid(),
  channel: z.enum(["mcp", "agent"]),
  code: z.enum(SSH_CREDENTIAL_PURPOSE_CODES),
  targetType: z.enum(["ssh_connection", "environment_log"]),
  targetId: z.string().uuid(),
}).strict();

export type SshCredentialPurposePayload = z.infer<typeof sshCredentialPurposePayloadSchema>;
