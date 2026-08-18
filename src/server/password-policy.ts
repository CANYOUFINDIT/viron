export const STRONG_PASSWORD_MIN_LENGTH = 10;

export function passwordPolicyError(password: string, allowWeakPasswords = false): string | null {
  if (!password) return "密码不能为空";
  if (allowWeakPasswords) return null;

  const categories = [/[a-z]/.test(password), /[A-Z]/.test(password), /\d/.test(password), /[^A-Za-z0-9]/.test(password)]
    .filter(Boolean).length;
  if (password.length < STRONG_PASSWORD_MIN_LENGTH || categories < 3) {
    return `密码至少需要 ${STRONG_PASSWORD_MIN_LENGTH} 个字符，并包含大写字母、小写字母、数字、特殊字符中的至少 3 类`;
  }
  return null;
}
