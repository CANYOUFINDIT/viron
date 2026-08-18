const invitationTokenPattern = /^[A-Za-z0-9_-]{16,256}$/;

function tokenFromJoinPath(path: string): string | null {
  const pathOnly = path.split(/[?#]/, 1)[0];
  const match = /^\/join\/([^/]+)\/?$/.exec(pathOnly);
  const token = match?.[1] ?? "";
  return invitationTokenPattern.test(token) ? token : null;
}

export function parseOrganizationInvitationToken(value: string): string | null {
  const input = value.trim();
  if (!input || input.length > 2_048) return null;

  try {
    const url = new URL(input);
    const hashPath = url.hash.startsWith("#/") ? url.hash.slice(1) : "";
    return tokenFromJoinPath(hashPath) ?? tokenFromJoinPath(url.pathname);
  } catch {
    return null;
  }
}
