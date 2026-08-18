import { describe, expect, it } from "vitest";
import { classifyLogSeverity, renderHighlightedLogHtml } from "../src/client/log-highlighting";

describe("log highlighting", () => {
  it("maps common log levels to the same severity families used by mainstream log viewers", () => {
    expect(classifyLogSeverity("service,FATAL,unrecoverable")).toBe("critical");
    expect(classifyLogSeverity("service,ERROR,request failed")).toBe("error");
    expect(classifyLogSeverity("[WARN] retrying")).toBe("warning");
    expect(classifyLogSeverity("level=INFO ready")).toBe("info");
    expect(classifyLogSeverity("DEBUG cache hit")).toBe("debug");
    expect(classifyLogSeverity("TRACE entering handler")).toBe("trace");
  });

  it("highlights timestamps, identifiers, durations, IPs and HTTP status fields", () => {
    const html = renderHighlightedLogHtml("2026-07-20T15:26:10.336,ERROR,id:191703238,senderIp:192.168.5.146,useTime:13ms,status=503");
    expect(html).toContain("log-line--error");
    expect(html).toContain("log-token--timestamp");
    expect(html).toContain("log-token--identifier");
    expect(html).toContain("log-token--ip");
    expect(html).toContain("log-token--duration");
    expect(html).toContain("log-token--status-error");
  });

  it("keeps stack traces visually attached to an error and escapes remote log HTML", () => {
    const html = renderHighlightedLogHtml("ERROR failed\n  at app.run (<script>alert('xss')</script>:1)");
    expect(html.match(/log-line--error/g)).toHaveLength(2);
    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("highlights fixed keywords without disabling HTML escaping", () => {
    const html = renderHighlightedLogHtml("<script>ERROR</script>\nerror", { semantic: false, keyword: "error", keywordCaseSensitive: false });
    expect(html.match(/log-token--keyword/g)).toHaveLength(2);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(renderHighlightedLogHtml("ERROR\nerror", { semantic: false, keyword: "error", keywordCaseSensitive: true }).match(/log-token--keyword/g)).toHaveLength(1);
  });
});
