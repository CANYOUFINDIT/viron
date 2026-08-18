import { describe, expect, it } from "vitest";
import {
  DESKTOP_WEB_PAGE_LIMIT,
  cacheableDesktopWebUrl,
  desktopWebContextMenuGroups,
  desktopWebLastUrlKey,
  desktopWebPartitionName,
  pageAfterClose,
  restorableDesktopWebUrl,
  shouldAttemptDesktopWebAutofill,
  supportedDesktopPopupUrl,
  supportedDesktopWebUrl,
} from "../src/desktop/web-page-policy.js";

describe("desktop Web pages", () => {
  it("allows only HTTP(S) top-level navigation", () => {
    expect(supportedDesktopWebUrl("https://example.com/login")).toBe(true);
    expect(supportedDesktopWebUrl("http://127.0.0.1:3000/")).toBe(true);
    expect(supportedDesktopWebUrl("file:///tmp/secret")).toBe(false);
    expect(supportedDesktopWebUrl("javascript:alert(1)")).toBe(false);
  });

  it("allows an empty popup document without widening regular navigation", () => {
    expect(supportedDesktopPopupUrl("about:blank")).toBe(true);
    expect(supportedDesktopWebUrl("about:blank")).toBe(false);
    expect(supportedDesktopPopupUrl("data:text/html,test")).toBe(false);
  });

  it("selects the adjacent page when the active page closes", () => {
    expect(pageAfterClose(["a", "b", "c"], "b", "b")).toBe("c");
    expect(pageAfterClose(["a", "b", "c"], "c", "c")).toBe("b");
    expect(pageAfterClose(["a", "b", "c"], "a", "b")).toBe("a");
    expect(pageAfterClose(["a"], "a", "a")).toBeNull();
    expect(DESKTOP_WEB_PAGE_LIMIT).toBe(8);
  });

  it("builds contextual desktop Web menu groups", () => {
    expect(desktopWebContextMenuGroups({
      linkUrl: "https://example.com/docs",
      isEditable: false,
      hasSelection: true,
    })).toEqual([
      ["open-link-new-page", "copy-link"],
      ["copy"],
      ["back", "forward", "reload"],
      ["inspect"],
    ]);
    expect(desktopWebContextMenuGroups({
      linkUrl: "mailto:ops@example.com",
      isEditable: true,
      hasSelection: false,
    })).toEqual([
      ["copy-link"],
      ["undo", "redo"],
      ["cut", "copy", "paste"],
      ["select-all"],
      ["back", "forward", "reload"],
      ["inspect"],
    ]);
  });

  it("isolates persistent profiles by Endpoint, user, and credential", () => {
    const base = desktopWebPartitionName("https://viron.example.com", "user-a", "credential-a");
    expect(base).toMatch(/^persist:viron-web-[0-9a-f]{40}$/);
    expect(desktopWebPartitionName("https://other.example.com", "user-a", "credential-a")).not.toBe(base);
    expect(desktopWebPartitionName("https://viron.example.com", "user-b", "credential-a")).not.toBe(base);
    expect(desktopWebPartitionName("https://viron.example.com", "user-a", "credential-b")).not.toBe(base);
  });

  it("isolates the last URL cache by Endpoint, user, and credential", () => {
    const base = desktopWebLastUrlKey("https://viron.example.com", "user-a", "credential-a");
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(desktopWebLastUrlKey("https://other.example.com", "user-a", "credential-a")).not.toBe(base);
    expect(desktopWebLastUrlKey("https://viron.example.com", "user-b", "credential-a")).not.toBe(base);
    expect(desktopWebLastUrlKey("https://viron.example.com", "user-a", "credential-b")).not.toBe(base);
  });

  it("restores only a same-origin HTTP(S) URL with its full path", () => {
    const entryUrl = "https://example.com/login";
    const storedUrl = "https://example.com/projects/42?tab=logs#latest";
    expect(cacheableDesktopWebUrl(entryUrl, storedUrl)).toBe(storedUrl);
    expect(restorableDesktopWebUrl(entryUrl, storedUrl)).toBe(storedUrl);
    expect(cacheableDesktopWebUrl(entryUrl, "https://other.example.com/projects/42")).toBeNull();
    expect(cacheableDesktopWebUrl(entryUrl, "file:///tmp/secret")).toBeNull();
    expect(restorableDesktopWebUrl(entryUrl, "https://other.example.com/projects/42")).toBe(entryUrl);
    expect(restorableDesktopWebUrl("https://new.example.com/login", storedUrl)).toBe("https://new.example.com/login");
  });

  it("keeps automatic filling on approved pages while allowing an explicit refill on the active page", () => {
    expect(shouldAttemptDesktopWebAutofill(true, false)).toBe(true);
    expect(shouldAttemptDesktopWebAutofill(false, false)).toBe(false);
    expect(shouldAttemptDesktopWebAutofill(false, true)).toBe(true);
  });
});
