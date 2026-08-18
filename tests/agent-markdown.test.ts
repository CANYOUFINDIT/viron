import { describe, expect, it } from "vitest";
import { renderAgentMarkdown } from "../src/client/agent-markdown.js";

describe("Agent Markdown rendering", () => {
  it("renders common assistant formatting", () => {
    const output = renderAgentMarkdown("请先**显式加入现场**。\n\n- SSH\n- 数据库\n\n使用 `SELECT 1`。");
    expect(output).toContain("<strong>显式加入现场</strong>");
    expect(output).toContain("<ul>");
    expect(output).toContain("<code>SELECT 1</code>");
  });

  it("escapes raw HTML from model output", () => {
    const output = renderAgentMarkdown('<img src=x onerror="alert(1)">');
    expect(output).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(output).not.toContain("<img");
  });

  it("rejects unsafe links and hardens normal links", () => {
    expect(renderAgentMarkdown("[危险链接](javascript:alert(1))")).not.toContain("href=");
    const output = renderAgentMarkdown("[Viron](https://example.com)");
    expect(output).toContain('target="_blank"');
    expect(output).toContain('rel="noopener noreferrer"');
  });
});
