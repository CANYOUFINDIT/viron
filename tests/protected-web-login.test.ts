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
  it("clicks a component form's unique Submit button instead of bypassing its login handler", () => {
    const { window, guard } = fixture("");
    const form = window.document.querySelector("form")!;
    form.className = "next-form login-form";
    window.document.querySelector("#challenge")!.remove();
    const button = form.querySelector("button")!;
    button.type = "button"; button.textContent = "提交";
    let clicks = 0, nativeSubmits = 0;
    form.addEventListener("submit", (event) => { event.preventDefault(); nativeSubmits++; });
    button.addEventListener("click", () => { clicks++; });
    expect(guard.tick(0, false, "").status).toBe("submitted");
    expect(clicks).toBe(1); expect(nativeSubmits).toBe(0);
    expect(guard.tick(0, true, window.location.href).status).toBe("waiting");
    expect(clicks).toBe(1);
  });
  it("refuses to guess between multiple neutral Submit buttons", () => {
    const { window, guard } = fixture("");
    window.document.querySelector("#challenge")!.remove();
    const button = window.document.querySelector("button")!;
    button.type = "button"; button.textContent = "提交";
    const other = button.cloneNode(true) as typeof button;
    other.getBoundingClientRect = button.getBoundingClientRect;
    button.after(other);
    expect(() => guard.tick(0, false, "")).toThrow("ambiguous-selector");
  });
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
    window.document.querySelector("#challenge")!.append(window.document.createElement("button"));
    expect(guard.authorize(result.region.revision, undefined, undefined, true)).toBeNull();
  });
  it("keeps the frame valid through unrelated DOM changes and focus styling", () => {
    const { window, guard } = fixture();
    const result = guard.tick(0, false, "");
    window.document.title = "Login clock updated";
    window.document.querySelector("#otp")!.classList.add("focused");
    window.document.body.append(window.document.createElement("aside"));
    expect(guard.region().revision).toBe(result.region.revision);
  });
  it("switches from an agreement checkbox to a separate dialog without exposing credentials", () => {
    const { window, guard } = fixture("");
    const label = window.document.createElement("label");
    label.innerHTML = '<input type="checkbox" required> I agree to terms';
    label.getBoundingClientRect = window.document.querySelector("#challenge")!.getBoundingClientRect;
    window.document.querySelector("form")!.append(label);
    const first = guard.tick(0, false, "");
    const dialog = window.document.createElement("section");
    dialog.setAttribute("role", "dialog"); dialog.innerHTML = '<p>Privacy terms</p><button>Agree</button>';
    // It overlaps the old form, as a centered Element Plus dialog does.
    dialog.getBoundingClientRect = window.document.querySelector("#password")!.getBoundingClientRect;
    window.document.body.append(dialog);
    const second = guard.tick(0, false, "");
    expect(second.status).toBe("interactive");
    expect(second.kind).toBe("agreement");
    expect(second.region.revision).not.toBe(first.region.revision);
    expect(window.getComputedStyle(window.document.querySelector("#password")!).visibility).toBe("hidden");
    expect(guard.authorize(first.region.revision)).toBeNull();
    expect(guard.continueInteraction(second.region.revision)).toBe(false);
    dialog.remove(); label.querySelector<HTMLInputElement>("input")!.checked = true;
    expect(guard.tick(0, false, "").status).toBe("submitted");
    expect(window.getComputedStyle(window.document.querySelector("#password")!).visibility).not.toBe("hidden");
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
