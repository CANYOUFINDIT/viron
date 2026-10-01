import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("organization resource grant selector", () => {
  const view = source("src/client/views/OrganizationView.vue");
  const dialog = source("src/client/views/organization/OrganizationGrantDialog.vue");
  const controller = source("src/client/views/organization/use-organization-controller.ts");

  it("submits the selected environments or connections with one duration", () => {
    expect(view).toContain("<OrganizationGrantDialog />");
    expect(dialog).toContain('class="grant-kind-switch"');
    expect(dialog).toContain('class="grant-picker-row"');
    expect(dialog).not.toContain("<el-select");
    expect(dialog).toContain("wholeGroup");
    expect(dialog).toContain("expiresAt: expiryValue()");
    expect(dialog).toContain("scopeKind,");
    expect(controller).toContain("const body = JSON.stringify({ granteeType, granteeId, ...draft });");
    expect(controller).toContain("editingGrant");
    expect(controller).not.toContain("grantForm");
  });

  it("allows another grant on a resource that already has one", () => {
    expect(controller).not.toContain("selectedGrantResourceKeys");
  });
});
