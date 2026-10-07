import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { defaultWebLoginConfig, parseWebLoginConfig } from "../src/shared/protected-web-login.js";
import { protectedLoginBusinessPageScript, protectedLoginInstallScript } from "../src/shared/protected-web-login-dom.js";

function fixture(interactionSelector = "#challenge", uuidAvailable = true) {
  const window = new Window({ url: "https://console.example.com/login" });
  Object.defineProperty(window.document, "readyState", { get: () => "complete" });
  if (!uuidAvailable) Object.defineProperty(window.crypto, "randomUUID", { value: undefined });
  window.document.body.innerHTML = `<form><input id="username" autocomplete="username"><input id="password" type="password"><div id="challenge"><input id="otp" autocomplete="one-time-code"><button type="button">Refresh</button></div><button type="submit">Login</button></form>`;
  for (const element of window.document.querySelectorAll("*")) {
    const y = element.id === "password" ? 70 : element.id === "username" ? 10 : 140;
    element.getBoundingClientRect = () => ({ x: 10, y, top: y, left: 10, bottom: y + 40, right: 210, width: 200, height: 40, toJSON() {} });
  }
  const config = { ...defaultWebLoginConfig(), interactionSelector };
  window.eval(protectedLoginInstallScript(config, "fixture-user", "fixture-password", "fixture-document"));
  return { window, guard: window.eval("globalThis.__vironLogin") };
}

describe("protected Web login", () => {
  it("initializes without the secure-context-only browser UUID API", () => {
    const { window, guard } = fixture("#challenge", false);
    expect(window.crypto.randomUUID).toBeUndefined();
    const result = guard.tick(0, false, "");
    expect(result.status).toBe("interactive");
    expect(result.region.revision).toMatch(/^fixture-document:/);
    expect(JSON.stringify(result)).not.toContain("fixture-password");
  });
  it("uses defaults for existing entries and rejects unsafe recipes", () => {
    expect(parseWebLoginConfig(undefined)).toEqual(defaultWebLoginConfig());
    expect(() => parseWebLoginConfig({ allowedOrigins: ["https://login.example.com/path"] })).toThrow();
    expect(() => parseWebLoginConfig({ steps: [{ action: "eval", selector: "body" }] })).toThrow();
    expect(() => parseWebLoginConfig({ steps: [{ action: "click", selector: "#login" }] })).toThrow();
    expect(() => parseWebLoginConfig({ steps: [{ action: "success", selector: "#home", origin: "https://other.example.com" }] })).toThrow();
  });
  it("holds credentials privately while exposing only safe verification geometry", () => {
    const { window, guard } = fixture();
    const result = guard.tick(0, false, "");
    expect(result.status).toBe("interactive");
    expect(JSON.stringify(result)).not.toContain("fixture-password");
    expect(window.document.querySelector<HTMLInputElement>("#password")!.value).toBe("fixture-password");
    expect(result.region).toMatchObject({ x: 10, y: 140, width: 200, height: 40 });
  });
  it("rejects credential containers and credentials whose type was changed to text", () => {
    const { guard } = fixture("form");
    expect(() => guard.tick(0, false, "")).toThrow("unsafe-region");
    const next = fixture();
    next.guard.tick(0, false, "");
    const password = next.window.document.querySelector<HTMLInputElement>("#password")!;
    password.type = "text";
    next.window.document.querySelector("#challenge")!.append(password);
    expect(() => next.guard.region()).toThrow("unsafe-region");
  });
  it("rejects a verification iframe and overlapping credential fields", () => {
    const { window, guard } = fixture();
    guard.tick(0, false, "");
    const password = window.document.querySelector("#password")!;
    password.getBoundingClientRect = window.document.querySelector("#challenge")!.getBoundingClientRect;
    expect(() => guard.region()).toThrow("unsafe-region");
    const next = fixture();
    next.guard.tick(0, false, "");
    next.window.document.querySelector("#challenge")!.append(next.window.document.createElement("iframe"));
    expect(() => next.guard.region()).toThrow("unsafe-frame");
  });
  it("forwards keyboard input only to a verification input, and refuses stale frames", () => {
    const { window, guard } = fixture();
    const result = guard.tick(0, false, "");
    window.document.querySelector<HTMLElement>("#password")!.focus();
    expect(guard.authorize(result.region.revision, undefined, undefined, true)).toBeNull();
    window.document.querySelector<HTMLElement>("#otp")!.focus();
    expect(guard.authorize(result.region.revision, undefined, undefined, true)).not.toBeNull();
    window.document.querySelector("#otp")!.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(guard.authorize(result.region.revision, undefined, undefined, true)).toBeNull();
  });
  it("refuses to release a session that persisted the plaintext password", async () => {
    const { window, guard } = fixture();
    window.localStorage.setItem("unsafe", "fixture-password");
    await expect(guard.finish()).rejects.toThrow("secret-in-storage");
  });
  it("does not accept a login route or a blank SPA render as anonymous success", () => {
    const { window, guard } = fixture("");
    window.document.body.replaceChildren();
    expect(guard.tick(0, false, "").status).toBe("waiting");
    window.location.href = "https://console.example.com/home";
    expect(guard.tick(0, true, "https://console.example.com/login", true, "old-document").status).toBe("waiting");
    expect(window.eval(protectedLoginBusinessPageScript())).toBe("waiting");
  });
  it("does not let a success marker override a visible credential form", () => {
    const { window } = fixture();
    const marker = window.document.createElement("main");
    marker.id = "success";
    marker.getBoundingClientRect = window.document.querySelector("#challenge")!.getBoundingClientRect;
    window.document.body.append(marker);
    expect(window.eval(protectedLoginBusinessPageScript("#success"))).toBe("login");
  });
  it("recognizes a cached session before replaying a multi-step login recipe", () => {
    const { window } = fixture("");
    window.location.href = "https://console.example.com/home";
    window.document.body.innerHTML = '<main id="home">Already signed in</main>';
    window.document.querySelector("#home")!.getBoundingClientRect = () => ({ x: 10, y: 10, top: 10, left: 10, bottom: 110, right: 210, width: 200, height: 100, toJSON() {} });
    window.eval("delete globalThis.__vironLogin");
    window.eval(protectedLoginInstallScript({ ...defaultWebLoginConfig(), steps: [
      { action: "type", selector: "#username", value: "{USERNAME}" },
      { action: "type", selector: "#password", value: "{SECRET}" },
      { action: "click", selector: "#login" },
      { action: "success", selector: "#home" },
    ] }, "fixture-user", "fixture-password", "cached-document"));
    const guard = window.eval("globalThis.__vironLogin");
    expect(guard.tick(0, false, "").status).toBe("success");
    expect(guard.secretReleased()).toBe(false);
  });
  it("asks for agreement confirmation in a crop that excludes the password", () => {
    const { window, guard } = fixture("");
    const label = window.document.createElement("label");
    label.innerHTML = '<input type="checkbox" required> I agree to the terms';
    label.getBoundingClientRect = window.document.querySelector("#challenge")!.getBoundingClientRect;
    const checkbox = label.querySelector<HTMLInputElement>("input")!;
    checkbox.getBoundingClientRect = label.getBoundingClientRect;
    checkbox.style.opacity = "0"; // Component libraries paint the visible label instead.
    window.document.querySelector("form")!.append(label);
    const result = guard.tick(0, false, "");
    expect(result.status).toBe("interactive");
    expect(result.kind).toBe("agreement");
    expect(result.region).toMatchObject({ y: 140 });
    expect(JSON.stringify(result)).not.toContain("fixture-password");
    checkbox.checked = true;
    expect(guard.continueInteraction(result.region.revision)).toBe(true);
    expect(guard.tick(0, false, "").status).toBe("submitted");
  });
});
