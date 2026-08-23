import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("knowledge base workspace availability", () => {
  it("exposes the knowledge base in regular and immersive environment navigation", () => {
    const environment = source("../src/client/views/EnvironmentDetailView.vue");
    const immersive = source("../src/client/components/EnvironmentImmersiveNavigation.vue");
    const shell = source("../src/client/components/AppShell.vue");
    const router = source("../src/client/router.ts");
    const workspaceView = source("../src/client/views/KnowledgeBaseView.vue");
    expect(environment).toContain("KnowledgeBasePanel");
    expect(environment).toContain("activeTab === 'knowledge'");
    expect(environment).toContain("environment?.knowledgeDocumentCount || 0");
    expect(immersive).toContain("selectTab('knowledge')");
    expect(immersive).toContain("counts.knowledge");
    expect(shell).toContain('routeName: "knowledge"');
    expect(router).toContain('path: "/knowledge"');
    expect(workspaceView).toContain("<KnowledgeBasePanel />");
  });

  it("keeps editor, preview, automatic save, image, import/export, and grant controls in the shared panel", () => {
    const panel = source("../src/client/components/KnowledgeBasePanel.vue");
    expect(panel).toContain("scheduleAutoSave");
    expect(panel).toContain("1_000");
    expect(panel).toContain("MarkdownEditor");
    expect(panel).toContain("renderKnowledgeMarkdown");
    expect(panel).toContain("image/png,image/jpeg,image/gif,image/webp");
    expect(panel).toContain(".md,.zip");
    expect(panel).toContain("openGrantDialog");
    expect(panel).toContain("openAssociationDialog");
    expect(panel).toContain("saveEnvironmentTags");
    expect(panel).toContain('@click="selectRoot"');
    expect(panel).not.toContain("@click.self=\"selectRoot\"");
    expect(panel).toContain("知识库根目录");
    expect(panel).toContain("environmentRootId");
    expect(panel).toContain("storageParentId");
    expect(panel).toContain("Object.assign(treeNode, response.item, { parentId: visibleParentId })");
    expect(panel).toContain("knowledge-tree-row__branches");
    expect(panel).toContain("continuationDepths");
    expect(panel).toContain("<el-dropdown class=\"knowledge-export-menu\"");
    expect(panel.match(/<Download /g)).toHaveLength(1);
  });

  it("shows the Markdown suffix in the new document name input", () => {
    const panel = source("../src/client/components/KnowledgeBasePanel.vue");
    expect(panel).toContain('<template #suffix><span class="knowledge-document-name-suffix">.md</span></template>');
    expect(panel).not.toContain("<template #append>");
    expect(panel).not.toContain("输入文档名称，.md 后缀可省略");
  });

  it("keeps the editor in the flexible workspace row when the save alert is absent", () => {
    const panel = source("../src/client/components/KnowledgeBasePanel.vue");
    expect(panel).toContain(".knowledge-toolbar { grid-row: 1;");
    expect(panel).toContain(".knowledge-save-alert { grid-row: 2;");
    expect(panel).toContain(".knowledge-editor-stage { grid-row: 3;");
    expect(panel).toContain(".knowledge-statusbar { grid-row: 4;");
  });

  it("defines workspace ownership and environment associations for SQLite and MySQL", () => {
    const sqlite = source("../src/server/sqlite-schema.ts");
    const mysql = source("../src/server/mysql-schema.ts");
    for (const schema of [sqlite, mysql]) {
      expect(schema).toContain("workspace_type");
      expect(schema).toContain("workspace_id");
      expect(schema).toContain("knowledge_node_environments");
      expect(schema).toContain("ON DELETE SET NULL");
    }
    expect(mysql).toContain("knowledge_nodes_sibling_name_idx (workspace_type, workspace_id, parent_key, name)");
  });
});
