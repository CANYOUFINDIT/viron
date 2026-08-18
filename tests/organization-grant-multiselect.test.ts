import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("organization resource grant selector", () => {
  const view = source("src/client/views/OrganizationView.vue");

  it("submits multiple resources from the selected resource type", () => {
    expect(view).toContain('const grantForm = reactive({ resourceType: "environment" as ResourceType, resourceIds: [] as string[] });');
    expect(view).toContain('v-model="grantForm.resourceIds" multiple filterable clearable collapse-tags collapse-tags-tooltip');
    expect(view).toContain('resourceType: grantForm.resourceType, resourceIds: grantForm.resourceIds');
    expect(view).toContain(':disabled="!grantForm.resourceIds.length"');
    expect(view).not.toContain("grantForm.resourceId =");
  });

  it("excludes resources already granted directly or through project inheritance", () => {
    expect(view).toContain("const selectedGrantResourceKeys = computed(() => new Set(");
    expect(view).toContain("selectedGrantRows.value.map(({ grant }) => `${grant.resourceType}:${grant.resourceId}`)");
    expect(view).toContain("&& !selectedGrantResourceKeys.value.has(`${item.type}:${item.id}`)");
  });
});
