export function activeApiKeys<T extends { status: "active" | "revoked" }>(items: T[]): T[] {
  return items.filter((item) => item.status === "active");
}
