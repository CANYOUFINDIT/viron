import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { protectedLoginInstallScript } from "../src/shared/protected-web-login-dom.js";
import { defaultWebLoginConfig, type WebLoginConfig } from "../src/shared/protected-web-login.js";

function fixture(overrides: Partial<WebLoginConfig> = {}) {
  const window = new Window({ url: "https://console.example.test/login" });
  Object.defineProperty(window.document, "readyState", { get: () => "complete" });
  window.document.body.innerHTML = '<form class="login-form"><input id="username" autocomplete="username"><input id="password" type="password"><button type="button">Login</button></form>';
  const geometry = () => ({ x: 10, y: 10, top: 10, left: 10, bottom: 50, right: 210, width: 200, height: 40, toJSON() {} });
  for (const node of window.document.querySelectorAll("*")) node.getBoundingClientRect = geometry;
  const form = window.document.querySelector("form")!;
  const button = window.document.querySelector("button")!;
  const password = window.document.querySelector<HTMLInputElement>("#password")!;
  let now = 1000;
  window.Date.now = () => now;
  window.eval(protectedLoginInstallScript({ ...defaultWebLoginConfig(), ...overrides }, "fixture-user", "fixture-password", "fixture-document"));
  return { window, form, button, password, geometry, guard: window.eval("globalThis.__vironLogin"), advance: (ms: number) => { now += ms; } };
}

describe("protected automatic form submission", () => {
  it("prefers the password form's native submitter over another provider's login button", () => {
    const f = fixture();
    f.button.type = "submit";
    const google = f.window.document.createElement("button");
    google.type = "button"; google.textContent = "Sign in with Google"; google.getBoundingClientRect = f.geometry; f.form.append(google);
    let submissions = 0, providerClicks = 0;
    f.form.addEventListener("submit", (event) => { event.preventDefault(); submissions++; });
    google.addEventListener("click", () => { providerClicks++; });
    f.guard.tick(0, false, "");
    expect(f.guard.tick(0, false, "").status).toBe("submitted");
    expect(submissions).toBe(1); expect(providerClicks).toBe(0);
  });
  it("waits for component state to commit before clicking once", async () => {
    const f = fixture();
    const state: Record<string, string> = {}, requests: Record<string, string>[] = [];
    for (const input of f.form.querySelectorAll("input")) input.addEventListener("input", () => {
      const value = input.value;
      queueMicrotask(() => { state[input.id] = value; });
    });
    f.button.addEventListener("click", () => requests.push({ ...state }));
    expect(f.guard.tick(0, false, "").status).toBe("filled");
    expect(requests).toHaveLength(0);
    await Promise.resolve();
    expect(f.guard.tick(0, false, "").status).toBe("submitted");
    expect(f.guard.tick(0, true, f.window.location.href).status).toBe("waiting");
    expect(requests).toEqual([{ username: "fixture-user", password: "fixture-password" }]);
  });

  it("refills a password input replaced during reactive rendering before submission", async () => {
    const f = fixture();
    const requests: string[] = [];
    f.form.querySelector("#username")!.addEventListener("input", () => {
      const replacement = f.password.cloneNode() as typeof f.password;
      replacement.value = ""; replacement.getBoundingClientRect = f.geometry;
      f.password.replaceWith(replacement);
    }, { once: true });
    f.button.addEventListener("click", () => {
      requests.push(f.form.querySelector<HTMLInputElement>("#password")!.value);
    });
    for (let i = 0; i < 5; i++) { f.guard.tick(0, requests.length > 0, f.window.location.href); await Promise.resolve(); }
    expect(requests).toEqual(["fixture-password"]);
  });

  it("waits for configured fields and submit controls instead of bypassing the site's handler", () => {
    const f = fixture({ passwordSelector: "#later-password", submitSelector: "#later-submit" });
    let nativeSubmits = 0, clicks = 0;
    f.form.addEventListener("submit", (event) => { event.preventDefault(); nativeSubmits++; });
    f.button.addEventListener("click", () => { clicks++; });
    expect(f.guard.tick(0, false, "").status).toBe("waiting");
    expect(f.form.querySelector<HTMLInputElement>("#username")!.value).toBe("");
    f.password.id = "later-password";
    f.guard.tick(0, false, ""); f.guard.tick(0, false, "");
    expect(nativeSubmits).toBe(0); expect(clicks).toBe(0);
    f.button.id = "later-submit";
    expect(f.guard.tick(0, false, "").status).toBe("submitted");
    expect(clicks).toBe(1); expect(nativeSubmits).toBe(0);
  });

  it("keeps waiting through a loading alert and transient validation error", () => {
    const f = fixture();
    const error = f.window.document.createElement("div");
    error.className = "el-form-item__error"; error.textContent = "Password is required"; error.getBoundingClientRect = f.geometry;
    f.form.append(error);
    f.guard.tick(0, false, ""); f.guard.tick(0, false, "");
    expect(f.guard.tick(0, true, f.window.location.href).status).toBe("waiting");
    error.remove();
    const alert = error.cloneNode() as typeof error;
    alert.className = ""; alert.setAttribute("role", "alert"); alert.textContent = "Signing in…"; alert.getBoundingClientRect = f.geometry;
    f.form.append(alert); f.button.disabled = true;
    expect(f.guard.tick(0, true, f.window.location.href).status).toBe("pending");
    f.advance(35_000);
    expect(f.guard.tick(0, true, f.window.location.href).status).toBe("pending");
  });

  it("ignores unrelated alerts but stops on a stable authentication failure", () => {
    const f = fixture();
    f.guard.tick(0, false, ""); f.guard.tick(0, false, "");
    const alert = f.window.document.createElement("div");
    alert.setAttribute("role", "alert"); alert.textContent = "A background request failed"; alert.getBoundingClientRect = f.geometry;
    f.window.document.body.append(alert);
    expect(f.guard.tick(0, true, f.window.location.href).status).toBe("waiting");
    alert.textContent = "Password accepted, login successful"; f.form.append(alert);
    f.advance(1000);
    expect(f.guard.tick(0, true, f.window.location.href).status).toBe("waiting");
    f.form.append(alert); alert.textContent = "Incorrect username or password";
    expect(f.guard.tick(0, true, f.window.location.href).status).toBe("waiting");
    f.advance(1000);
    expect(f.guard.tick(0, true, f.window.location.href).status).toBe("rejected");
    expect(f.password.value).toBe("fixture-password");
  });
});
