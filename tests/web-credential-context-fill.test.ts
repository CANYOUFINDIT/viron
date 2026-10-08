import { describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { captureWebCredentialTargetScript, fillWebCredentialTargetScript, installWebCredentialContextListenerScript } from "../src/shared/web-credential-context-fill.js";
import { desktopWebContextMenuGroups } from "../src/desktop/web-page-policy.js";

function fixture() {
  const window = new Window({ url: "https://console.example.test/login" });
  window.document.body.innerHTML = '<form><input id="user"><input id="password" type="password"><button>Login</button></form>';
  const user = window.document.querySelector<HTMLInputElement>("#user")!;
  const password = window.document.querySelector<HTMLInputElement>("#password")!;
  window.document.elementFromPoint = () => password;
  const origins = [window.location.origin];
  return { window, user, password, capture: (token = "selected") => window.eval(captureWebCredentialTargetScript(token, 20, 20, origins)), fill: (token = "selected") => window.eval(fillWebCredentialTargetScript(token, "fixture-secret", origins)) };
}

describe("normal page credential context menu", () => {
  it("offers credential commands only for an eligible editable input", () => {
    expect(desktopWebContextMenuGroups({ linkUrl: "", isEditable: true, hasSelection: false, credentialFillAvailable: true })[0]).toEqual(["fill-username", "fill-password"]);
    expect(desktopWebContextMenuGroups({ linkUrl: "", isEditable: false, hasSelection: false, credentialFillAvailable: true }).flat()).not.toContain("fill-password");
  });
  it("fills the captured node after focus moves, dispatches reactive events and leaves submission to the user", () => {
    const { window, user, password, capture, fill } = fixture();
    const input = vi.fn(), change = vi.fn(), submit = vi.fn();
    password.addEventListener("input", input); password.addEventListener("change", change);
    window.document.querySelector("form")!.addEventListener("submit", submit);
    expect(capture()).toBe(true); user.focus(); expect(fill()).toBe(true);
    expect(user.value).toBe(""); expect(password.value).toBe("fixture-secret");
    expect(input).toHaveBeenCalledOnce(); expect(change).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
    expect(password.readOnly).toBe(false); expect(password.style.visibility).toBe("");
    expect(fill()).toBe(false);
  });
  it("captures the real native context-menu target independently of zoomed or embedded coordinates", () => {
    const { window, password, fill } = fixture();
    window.eval(installWebCredentialContextListenerScript());
    window.document.elementFromPoint = () => null;
    password.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, composed: true }));
    expect(window.eval(captureWebCredentialTargetScript("selected", 500, 500, [window.location.origin], true))).toBe(true);
    expect(fill()).toBe(true); expect(password.value).toBe("fixture-secret");
  });
  it("rejects a replaced node and stale menus, including route and document changes", () => {
    for (const change of ["replacement", "route", "document", "token"]) {
      const { window, password, capture, fill } = fixture(); capture();
      if (change === "replacement") password.replaceWith(window.document.createElement("input"));
      if (change === "route") window.location.hash = "#/settings";
      if (change === "document") Object.defineProperty(window.performance, "timeOrigin", { value: 100 });
      expect(fill(change === "token" ? "stale" : undefined)).toBe(false);
      expect(password.value).toBe("");
    }
  });
  it("respects disabled and readonly fields and allows a website to unlock on focus", () => {
    const { password, capture, fill } = fixture();
    password.disabled = true; expect(capture()).toBe(false);
    password.disabled = false; password.readOnly = true; expect(capture()).toBe(true); expect(fill()).toBe(false);
    password.blur(); password.addEventListener("focus", () => { password.readOnly = false; });
    capture(); expect(fill()).toBe(true);
  });
  it("never captures a foreign page or writes after the origin changes", () => {
    const { window, password, capture, fill } = fixture(); capture();
    window.location.href = "https://foreign.example.test/login";
    expect(fill()).toBe(false); expect(capture()).toBe(false); expect(password.value).toBe("");
  });
});
