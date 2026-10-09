import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { buildWebCredentialAutofillScript } from "../src/shared/web-credential-autofill.js";
import { captureWebCredentialTargetScript, fillWebCredentialTargetScript } from "../src/shared/web-credential-context-fill.js";

function fixture() {
  const window = new Window({ url: "https://console.example.test/login" });
  window.document.body.innerHTML = '<form><input name="username"><input id="secret" name="password" type="password"><input id="agree" type="checkbox"><button>Login</button></form>';
  for (const node of window.document.querySelectorAll("*")) node.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30, toJSON() {} });
  const secret = window.document.querySelector<HTMLInputElement>("#secret")!;
  const fill = (password = "fixture-secret") => window.eval(buildWebCredentialAutofillScript({ username: "fixture-user", password, previousSignature: "", autoSubmit: false, lockPassword: true,
    messages: { duplicate: "duplicate", filled: "filled", filledAndSubmitted: "submitted", ambiguousPasswords: "ambiguous", noReliableForm: "missing" } }));
  return { window, secret, fill };
}

describe("locked Web password filling", () => {
  it("retains reactive form values for manual submission and leaves agreements editable", async () => {
    const { window, secret, fill } = fixture();
    let controlled = "", submitted = "";
    secret.addEventListener("input", () => { controlled = secret.value; });
    window.document.querySelector("form")!.addEventListener("submit", (event) => { event.preventDefault(); submitted = new window.FormData(event.target as unknown as HTMLFormElement).get("password") as string; });
    expect(fill().status).toBe("filled");
    expect(secret.readOnly).toBe(true); expect(secret.type).toBe("password");
    expect(controlled).toBe("fixture-secret"); expect(submitted).toBe("");
    window.document.querySelector<HTMLInputElement>("#agree")!.click();
    expect(window.document.querySelector<HTMLInputElement>("#agree")!.checked).toBe(true);
    window.document.querySelector("form")!.requestSubmit();
    expect(submitted).toBe("fixture-secret");
    await window.happyDOM.close();
  });

  it("restores password masking and readonly after a page reveal and masks DOM echoes", async () => {
    const { window, secret, fill } = fixture(); fill();
    secret.type = "text"; secret.readOnly = false; secret.removeAttribute("style");
    window.document.body.insertAdjacentHTML("beforeend", '<span title="fixture-secret">Shown: fixture-secret</span><input id="echo" value="fixture-secret">');
    await window.happyDOM.whenAsyncComplete();
    expect(secret.type).toBe("password"); expect(secret.readOnly).toBe(true);
    expect(secret.style.getPropertyValue("-webkit-text-security")).toBe("disc");
    expect(secret.style.getPropertyPriority("-webkit-text-security")).toBe("important");
    expect(window.document.querySelector("span")!.textContent).toBe("Shown: ••••••••");
    expect(window.document.querySelector("span")!.title).toBe("••••••••");
    expect(window.document.querySelector<HTMLInputElement>("#echo")!.type).toBe("password");
    await window.happyDOM.close();
  });

  it("blocks copying and editing the locked field but permits Enter and other form inputs", async () => {
    const { window, secret, fill } = fixture(); fill();
    for (const type of ["copy", "cut", "paste", "dragstart", "beforeinput"]) {
      expect(secret.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }))).toBe(false);
    }
    expect(secret.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }))).toBe(false);
    expect(secret.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))).toBe(true);
    expect(window.document.querySelector("#agree")!.dispatchEvent(new window.Event("beforeinput", { bubbles: true, cancelable: true }))).toBe(true);
    await window.happyDOM.close();
  });

  it("lets explicit refills update only its own locks and locks a manually selected text input", async () => {
    const { window, secret, fill } = fixture(); fill();
    expect(fill("rotated-fixture-secret").status).toBe("filled"); expect(secret.value).toBe("rotated-fixture-secret");
    const origins = [window.location.origin]; window.document.elementFromPoint = () => secret;
    expect(window.eval(captureWebCredentialTargetScript("refill", 10, 10, origins))).toBe(true);
    expect(window.eval(fillWebCredentialTargetScript("refill", "manual-fixture-secret", origins, true))).toBe(true);
    expect(secret.value).toBe("manual-fixture-secret"); expect(secret.readOnly).toBe(true);
    const custom = window.document.createElement("input"); window.document.body.append(custom);
    window.document.elementFromPoint = () => custom;
    expect(window.eval(captureWebCredentialTargetScript("custom", 10, 10, origins))).toBe(true);
    expect(window.eval(fillWebCredentialTargetScript("custom", "custom-fixture-secret", origins, true))).toBe(true);
    expect(custom.type).toBe("password"); expect(custom.readOnly).toBe(true);
    const foreignReadonly = window.document.createElement("input"); foreignReadonly.readOnly = true; window.document.body.append(foreignReadonly);
    window.document.elementFromPoint = () => foreignReadonly;
    window.eval(captureWebCredentialTargetScript("readonly", 10, 10, origins));
    expect(window.eval(fillWebCredentialTargetScript("readonly", "fixture-secret", origins, true))).toBe(false);
    expect(foreignReadonly.value).toBe("");
    await window.happyDOM.close();
  });
});
