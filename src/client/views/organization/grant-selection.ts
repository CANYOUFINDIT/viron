import { ref } from "vue";
import type { ResourceRef } from "../../../shared/organization-rbac";

/** Resource chosen from the overview before opening a grant or request form. */
export const pendingResourceGrant = ref<ResourceRef | null>(null);
