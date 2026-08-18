import { describe, expect, it } from "vitest";
import { renderKnowledgeMarkdown } from "../src/client/knowledge-markdown.js";

describe("knowledge Markdown rendering", () => {
  it("renders tables, task markers, fenced code, and stored images", () => {
    const output = renderKnowledgeMarkdown([
      "# Runbook",
      "",
      "- [ ] check",
      "- [x] done",
      "",
      "| Key | Value |",
      "| --- | --- |",
      "| env | prod |",
      "",
      "```sh",
      "echo ready",
      "```",
      "",
      "![map](knowledge-asset://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)",
    ].join("\n"), { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": "data:image/png;base64,AAAA" });
    expect(output).toContain("☐ check");
    expect(output).toContain("☑ done");
    expect(output).toContain("<table>");
    expect(output).toContain('<code class="language-sh">');
    expect(output).toContain('src="data:image/png;base64,AAAA"');
  });

  it("escapes raw HTML and rejects unsafe links", () => {
    const output = renderKnowledgeMarkdown('<img src=x onerror="alert(1)">\n\n[bad](javascript:alert(1))');
    expect(output).toContain("&lt;img");
    expect(output).not.toContain("<img");
    expect(output).not.toContain("href=");
  });
});
