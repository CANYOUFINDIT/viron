export type EnvironmentOverviewNavigationTarget =
  | { name: "overview" }
  | { name: "environment"; params: { id: string } };

export function updateRememberedEnvironmentId(
  rememberedEnvironmentId: string | null,
  routeName: string,
  environmentId: string | null,
  previousRouteName: string,
): string | null {
  if (routeName === "overview") return null;
  if (routeName === "environment" && environmentId && (previousRouteName === "overview" || rememberedEnvironmentId)) return environmentId;
  return rememberedEnvironmentId;
}

export function environmentOverviewNavigationTarget(
  routeName: string,
  rememberedEnvironmentId: string | null,
): EnvironmentOverviewNavigationTarget {
  if (routeName !== "environment" && rememberedEnvironmentId) {
    return { name: "environment", params: { id: rememberedEnvironmentId } };
  }
  return { name: "overview" };
}
