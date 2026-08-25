import { inject, provide, type InjectionKey } from "vue";
import type { useOrganizationController } from "./use-organization-controller";

export type OrganizationContext = ReturnType<typeof useOrganizationController>;

const organizationContextKey: InjectionKey<OrganizationContext> = Symbol("organization-context");

export function provideOrganizationContext(context: OrganizationContext): void {
  provide(organizationContextKey, context);
}

export function useOrganizationContext(): OrganizationContext {
  const context = inject(organizationContextKey);
  if (!context) throw new Error("Organization context is unavailable");
  return context;
}
