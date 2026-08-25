export function sshErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (/authentication/i.test(value)) return "SSH 认证失败，请检查用户名和凭据";
  if (/timed out/i.test(value)) return "SSH 连接超时";
  if (/ECONNREFUSED/i.test(value)) return "SSH 端口拒绝连接";
  if (/ENOTFOUND|EAI_AGAIN/i.test(value)) return "无法解析 SSH 主机地址";
  if (/Host key/i.test(value)) return "SSH 主机指纹不匹配";
  return value;
}
