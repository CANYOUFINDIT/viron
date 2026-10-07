import { selectWebCredentialAutofillFields, type WebCredentialAutofillField } from "./web-credential-autofill.js";
import type { WebLoginConfig } from "./protected-web-login.js";
import { containsPersistedWebLoginSecret } from "./web-login-storage.js";

// A fresh business document must be checked too: an HTTP redirect or an empty
// SPA render is not proof of authentication. No credentials enter this probe.
function businessPageStatus(successSelector = "") {
  const visible = (element: Element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 2 && rect.height > 2 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
  };
  if (!document.body || document.readyState !== "complete") return "waiting";
  const fields = [...document.querySelectorAll<HTMLInputElement>("input")].filter(visible);
  if (fields.some((node) => node.type === "password" || /username|current-password/.test(node.autocomplete)
    || /username|用户名|账号|帐号|password|密码/i.test([node.name, node.id, node.placeholder].join(" ")))) return "login";
  if (fields.some((node) => node.autocomplete === "one-time-code" || /otp|captcha|验证码/i.test([node.name, node.id, node.placeholder].join(" ")))) return "waiting";
  if (successSelector) return [...document.querySelectorAll(successSelector)].some(visible) ? "ready" : "waiting";
  if (/\/(?:log-?in|sign-?in|auth)(?:[/?#]|$)/i.test(location.pathname + location.hash)
    || /^(?:登录|登入|登陆|log ?in|sign ?in)(?:\s|$)/i.test(document.title.trim())) return "login";
  if (!document.body.innerText?.trim() && !document.title.trim()) return "waiting";
  if (document.querySelector("iframe,frame")) return "waiting";
  return "ready";
}

export function protectedLoginBusinessPageScript(successSelector = ""): string {
  return `(() => { const __name = (fn) => fn; return (${businessPageStatus.toString()})(${JSON.stringify(successSelector)}); })()`;
}

// This function runs only in an isolated world of a main-process-owned hidden window.
// Its results contain geometry/status, never input values or credential node handles.
function installLoginGuard(config: WebLoginConfig, username: string, password: string, selectFields: typeof selectWebCredentialAutofillFields, documentId: string, pageStatus: typeof businessPageStatus, persistedSecret: typeof containsPersistedWebLoginSecret) {
  const root = globalThis as typeof globalThis & { __vironLogin?: ReturnType<typeof createGuard> };
  function createGuard() {
    let revision = 0;
    const credentials = new Set<Element>();
    let filled = false;
    let submitted = false;
    let interactionDone = false;
    let interactionSelector = "";
    let passwordReleased = false;
    let assisted = false;
    const locks = new Map<HTMLElement, HTMLElement>();
    let lastRegion = "";
    let nodeSequence = 0;
    const identities = new WeakMap<Element, number>();
    const identity = (node: Element) => { if (!identities.has(node)) identities.set(node, ++nodeSequence); return identities.get(node); };
    const masks = new Map<HTMLElement, [string, string]>();
    const restoreMasks = () => { for (const [node, [value, priority]] of masks) { if (value) node.style.setProperty("visibility", value, priority); else node.style.removeProperty("visibility"); } masks.clear(); };
    const maskCredentials = () => {
      const echoed = password ? [...document.querySelectorAll<HTMLInputElement>("input")].filter((node) => node.value.includes(password)) : [];
      const sensitive = new Set([...credentials, ...echoed, ...(assisted ? [] : document.querySelectorAll('input[type="password"],input[autocomplete*="password"],input[autocomplete*="username"]'))]);
      for (const node of sensitive) if (node instanceof HTMLElement) {
        if (!masks.has(node)) masks.set(node, [node.style.getPropertyValue("visibility"), node.style.getPropertyPriority("visibility")]);
        if (node.style.getPropertyValue("visibility") !== "hidden" || node.style.getPropertyPriority("visibility") !== "important") node.style.setProperty("visibility", "hidden", "important");
      }
    };
    let agreementInteraction = false;
    let modalInteraction = false;
    const visible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 2 && rect.height > 2 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0;
    };
    const one = (selector: string) => {
      if (!selector) return null;
      const nodes = [...document.querySelectorAll(selector)].filter(visible);
      if (nodes.length > 1) throw new Error("ambiguous-selector");
      return nodes[0] ?? null;
    };
    const setValue = (element: Element, value: string, credential = false) => {
      if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly) throw new Error("invalid-input");
      if (credential || element.type === "password") credentials.add(element);
      if (value === password && password) passwordReleased = true;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const inputs = () => [...document.querySelectorAll<HTMLInputElement>("input")].filter(visible);
    const buttons = (target: Element | null) => [...(target?.closest("form") ?? document.body).querySelectorAll<HTMLElement>('button,input[type="submit"]')].filter(visible);
    const text = (node: HTMLElement) => node.innerText || node.getAttribute("value") || node.getAttribute("aria-label") || "";
    function detect() {
      const nodes = inputs();
      const fields: WebCredentialAutofillField[] = nodes.map((node, index) => ({
        index, type: node.type, autocomplete: node.autocomplete, name: node.name, id: node.id,
        placeholder: node.placeholder, ariaLabel: node.getAttribute("aria-label") || "",
        label: [...(node.labels ?? [])].map((label) => label.textContent ?? "").join(" "),
        formKey: node.form ? "form:" + [...document.forms].indexOf(node.form) : "none",
        formAction: node.form?.action ?? "", formIdentity: node.form ? [node.form.id, node.form.name, node.form.className].join(" ") : "",
        submitText: buttons(node).map(text).join(" "), valueState: node.value ? "filled" : "empty",
      }));
      const selection = selectFields(fields);
      return { username: selection.usernameIndex == null ? null : nodes[selection.usernameIndex], password: selection.passwordIndex == null ? null : nodes[selection.passwordIndex] };
    }
    function region() {
      const element = one(interactionSelector);
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      const rect = { x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.ceil(bounds.right) - Math.floor(bounds.x), height: Math.ceil(bounds.bottom) - Math.floor(bounds.y) };
      if (rect.x < 0 || rect.y < 0 || rect.width < 3 || rect.height < 3 || rect.x + rect.width > innerWidth || rect.y + rect.height > innerHeight) throw new Error("unsafe-region");
      const overlaps = (node: Element) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.left < rect.x + rect.width && box.right > rect.x && box.top < rect.y + rect.height && box.bottom > rect.y;
      };
      const sensitive = new Set([...credentials, ...document.querySelectorAll('input[type="password"],input[autocomplete*="password"],input[autocomplete*="username"]')]);
      for (const node of document.querySelectorAll<HTMLInputElement>("input")) if (password && node.value.includes(password)) sensitive.add(node);
      if ([...sensitive].some((node) => node === element || element.contains(node) || (visible(node) && overlaps(node)))) throw new Error("unsafe-region");
      if ([...document.querySelectorAll("iframe,frame,object,embed")].some((node) => element.contains(node) || overlaps(node))) throw new Error("unsafe-frame");
      if ([element, ...element.querySelectorAll("*")].some((node) => node.shadowRoot)) throw new Error("unsafe-shadow");
      if (password && (element.textContent ?? "").includes(password)) throw new Error("unsafe-region");
      // Overlays may sit outside the configured subtree while painting into it.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (password && node.textContent?.includes(password) && node.parentElement && overlaps(node.parentElement)) throw new Error("unsafe-region");
      }
      // Scope the frame identity to this region, its controls and geometry. Page
      // clocks, hover classes and unrelated reactive updates do not invalidate it.
      const signature = JSON.stringify([identity(element), rect, element.textContent,
        [...element.querySelectorAll("input,button,a,img,canvas,select,textarea")].map((node) => [identity(node), node.tagName, node.getAttribute("src"), node.getAttribute("href"), node.getAttribute("type")])]);
      if (signature !== lastRegion) { lastRegion = signature; revision++; }
      return { ...rect, revision: `${documentId}:${revision}` };
    }
    function maskSecretText() {
      if (!password || !document.body) return;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement?.closest("script,style")) continue;
        if (node.nodeValue?.includes(password)) node.nodeValue = node.nodeValue.replaceAll(password, "••••••");
      }
    }
    function freezeCredentials() {
      for (const [node, lock] of locks) if (!node.isConnected || !visible(node)) { lock.remove(); locks.delete(node); }
      for (const node of credentials) {
        if (!(node instanceof HTMLInputElement) || !visible(node)) continue;
        node.readOnly = true; node.tabIndex = -1;
        if (document.activeElement === node) node.blur();
        const box = node.getBoundingClientRect();
        let lock = locks.get(node);
        if (!lock) { lock = document.createElement("div"); lock.setAttribute("data-viron-credential-lock", ""); locks.set(node, lock); document.body.append(lock); }
        lock.textContent = node.type === "password" ? "密码已填入 · 已保护" : "用户名已填入 · 已保护";
        lock.style.cssText = `position:fixed;left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;box-sizing:border-box;display:flex;align-items:center;padding:0 12px;z-index:2147483647;background:#f4f8f6;color:#49665e;border:1px solid #cbdad4;border-radius:4px;font:13px sans-serif;`;
      }
      maskCredentials(); maskSecretText();
    }
    function pageRegion() {
      maskCredentials(); maskSecretText();
      const signature = JSON.stringify(["page", scrollX, scrollY, innerWidth, innerHeight,
        [...document.querySelectorAll("input,button,a,select,textarea,iframe")].map((node) => { const box = node.getBoundingClientRect(); return [identity(node), box.x, box.y, box.width, box.height]; })]);
      if (signature !== lastRegion) { lastRegion = signature; revision++; }
      return { x: 0, y: 0, width: innerWidth, height: innerHeight, revision: `${documentId}:${revision}` };
    }
    function assist() {
      assisted = true;
      restoreMasks();
      // Ignore broken recipes in the recovery flow. Conservative field detection
      // can fill ordinary forms; the user can choose an exact field otherwise.
      if (!filled) {
        const detected = detect();
        if (detected.username) setValue(detected.username, username, true);
        if (detected.password) setValue(detected.password, password, true);
        filled = Boolean(detected.username || detected.password);
      }
      const status = pageStatus();
      // Manual recovery only proves the page is safe to open. Do not report an
      // authentication success based on the user's navigation alone.
      const pendingFields = inputs().some((node) => ["text", "email", "tel", "password"].includes(node.type) && !node.disabled && !node.readOnly);
      if (status === "ready" && !pendingFields) return { status: "anonymous", released: passwordReleased };
      freezeCredentials();
      return { status: "interactive", kind: "page", region: pageRegion(), released: passwordReleased };
    }
    function fillAt(revisionValue: string, x: number, y: number, action: string) {
      if (!assisted || !Number.isFinite(x) || !Number.isFinite(y)) return false;
      const rect = pageRegion();
      if (rect.revision !== revisionValue || x < 0 || y < 0 || x >= rect.width || y >= rect.height) return false;
      const hit = document.elementFromPoint(x, y);
      const node = [...locks].find(([, lock]) => lock === hit || Boolean(hit && lock.contains(hit)))?.[0] ?? hit;
      if (!(node instanceof HTMLInputElement) || node.disabled || (node.readOnly && !credentials.has(node)) || !["text", "email", "tel", "password", "search"].includes(node.type)) return false;
      if (action !== "fill-username" && action !== "fill-password") return false;
      node.readOnly = false;
      if (action === "fill-password") node.type = "password";
      setValue(node, action === "fill-password" ? password : username, true);
      filled = true;
      restoreMasks(); freezeCredentials();
      return true;
    }
    function submit(target: Element | null) {
      const form = target?.closest("form");
      let button = config.submitSelector ? one(config.submitSelector) : null;
      if (!config.submitSelector) {
        const candidates = buttons(target);
        const primary = candidates.filter((node) => /login|log in|sign in|next|登录|登入|登陆|下一步/i.test(text(node)) || node.getAttribute("type") === "submit");
        // Component forms often prevent native submission and bind login to a
        // type="button" labelled Submit. Only accept a unique button inside the
        // detected credential form; never guess among page-wide neutral actions.
        const credentialForm = form && ([...credentials].some((node) => node instanceof HTMLInputElement && node.type === "password" && node.form === form)
          || /login|sign.?in|auth|登录/i.test([form.id, form.className].join(" ")));
        const neutral = credentialForm ? candidates.filter((node) => /^(?:submit|提交|确认)\s*$/i.test(text(node).trim())) : [];
        const matches = primary.length ? primary : neutral;
        if (matches.length > 1) throw new Error("ambiguous-selector");
        button = matches[0] ?? null;
      }
      if (button instanceof HTMLButtonElement && button.disabled) return false;
      if (button) button.click();
      else if (form) form.requestSubmit();
      else throw new Error("missing-submit");
      submitted = true;
      // Keep a still-visible challenge available for correction after submission.
      if (config.interactionSelector) interactionDone = false;
      return true;
    }
    function tick(stepIndex: number, previouslySubmitted: boolean, submittedUrl: string, passwordSubmitted = false, submittedDocument = "") {
      restoreMasks();
      if (!document.body) return { status: "waiting" };
      // A terms checkbox may open a teleported dialog outside its label. Prefer
      // that safe dialog, rather than continuing to expose an occluded checkbox.
      const dialog = [...document.querySelectorAll<HTMLElement>('dialog[open],[role="dialog"],[aria-modal="true"],.el-dialog,.el-message-box')].filter(visible).reverse().find((node) =>
        agreementInteraction || /agree|terms|privacy|同意|协议|隐私|条款/i.test(node.textContent ?? ""));
      if (dialog) {
        if ([dialog, ...dialog.querySelectorAll("*")].some((node) => getComputedStyle(node).visibility === "visible" && Number(getComputedStyle(node).opacity || 1) < 1)) return { status: "waiting" };
        // Native form values remain intact. Hide credential pixels while a modal
        // overlaps the login form; no full login screenshot ever leaves the host.
        maskCredentials();
        const dialogId = `${documentId}-${identity(dialog)}`;
        dialog.setAttribute("data-viron-dialog", dialogId);
        interactionSelector = `[data-viron-dialog="${dialogId}"]`;
        modalInteraction = true;
        return { status: "interactive", kind: "agreement", region: region(), released: passwordReleased };
      }
      modalInteraction = false;
      if (config.steps.length) {
        const success = config.steps.find((step) => step.action === "success")!;
        const credentialForm = config.steps.some((step) => step.action === "type" && ["{USERNAME}", "{SECRET}"].includes(step.value ?? "") && one(step.selector));
        if (!credentialForm && (!success.origin || success.origin === location.origin) && one(success.selector) && pageStatus(success.selector) === "ready") return { status: "success", released: passwordReleased };
        const step = config.steps[stepIndex];
        if (!step) throw new Error("invalid-step");
        if (step.origin && step.origin !== location.origin) return { status: "waiting" };
        const target = one(step.selector);
        if (!target) return { status: "waiting" };
        if (step.action === "success") return { status: pageStatus(step.selector) === "ready" ? "success" : "waiting", released: passwordReleased };
        if (step.action === "interactive") {
          interactionSelector = step.selector;
          return { status: "interactive", region: region() };
        }
        if (step.action === "type") {
          const secret = step.value === "{SECRET}";
          setValue(target, secret ? password : step.value === "{USERNAME}" ? username : step.value ?? "", secret || step.value === "{USERNAME}");
        } else target.click();
        return { status: "next", released: passwordReleased };
      }
      const detected = detect();
      const user = config.usernameSelector ? one(config.usernameSelector) : detected.username;
      const pass = config.passwordSelector ? one(config.passwordSelector) : detected.password;
      const visiblePasswords = inputs().filter((node) => node.type === "password" || credentials.has(node));
      const pendingVerification = inputs().some((node) => node.autocomplete === "one-time-code" || /otp|captcha|verification|验证码|动态口令/i.test([node.id, node.name, node.placeholder].join(" ")));
      if (previouslySubmitted && !visiblePasswords.length && pageStatus(config.successSelector) === "ready" && (config.successSelector || location.href !== submittedUrl || String(performance.timeOrigin) !== submittedDocument) && !pendingVerification && !(config.interactionSelector && one(config.interactionSelector))) return { status: "success" };
      if (passwordSubmitted && !filled && visiblePasswords.length) return { status: "rejected" };
      if (!filled && (pass || user)) {
        if (user) setValue(user, username, true);
        if (pass) setValue(pass, password, true);
        filled = true;
      }
      if (config.interactionSelector && one(config.interactionSelector) && !interactionDone) {
        interactionSelector = config.interactionSelector;
        return { status: "interactive", region: region(), released: passwordReleased };
      }
      // Do not consent to terms on the user's behalf. Expose only the separate
      // agreement label/checkbox; the same crop checks exclude credential fields.
      const agreement = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((node) => !node.checked
        && (node.required || /agree|terms|privacy|同意|协议|隐私|条款/i.test([node.name, node.id, node.getAttribute("aria-label") ?? "", ...(node.labels ?? [])].map((item) => typeof item === "string" ? item : item.textContent).join(" ")))
        && visible(node.closest("label") ?? [...(node.labels ?? [])][0] ?? node));
      if (agreement && filled) {
        agreementInteraction = true;
        const area = agreement.closest("label") ?? [...(agreement.labels ?? [])][0] ?? agreement;
        const areaId = `${documentId}-${identity(area)}`;
        if (area.getAttribute("data-viron-agreement") !== areaId) area.setAttribute("data-viron-agreement", areaId);
        interactionSelector = `[data-viron-agreement="${areaId}"]`;
        return { status: "interactive", kind: "agreement", region: region(), released: passwordReleased };
      }
      if (!config.interactionSelector && (submitted || previouslySubmitted) && [...document.querySelectorAll<HTMLElement>('[role="alert"],.el-form-item__error,.auth-form__error-message')].some((node) => visible(node) && /.+/.test(node.textContent?.trim() ?? ""))) return { status: "rejected" };
      if (filled && !submitted) {
        if (!submit(pass ?? user)) return { status: "waiting", released: passwordReleased };
        return { status: "submitted", released: passwordReleased };
      }
      if (submitted || previouslySubmitted) return { status: "waiting", released: passwordReleased };
      // An anonymous entry can be opened without releasing credentials. A configured
      // success marker still takes precedence over this convenience path.
      if (pageStatus() === "ready" && !config.usernameSelector && !config.passwordSelector && !config.successSelector) return { status: "anonymous" };
      if (config.successSelector && pageStatus(config.successSelector) === "ready" && !visiblePasswords.length) return { status: "success" };
      return { status: "waiting" };
    }
    function authorize(revisionValue: string, x?: number, y?: number, keyboard = false) {
      const rect = assisted ? pageRegion() : region();
      if (!rect || rect.revision !== revisionValue) return null;
      const element = assisted ? document.documentElement : one(interactionSelector)!;
      if (keyboard) {
        const focused = document.activeElement;
        if (!focused || !element.contains(focused) || credentials.has(focused)) return null;
        if (!(focused instanceof HTMLInputElement && ["text", "tel", "number", "email", "search"].includes(focused.type))
          && !(assisted && (focused instanceof HTMLTextAreaElement || focused instanceof HTMLIFrameElement || focused instanceof HTMLElement && focused.isContentEditable || focused === document.body))) return null;
      } else if (typeof x === "number" && typeof y === "number") {
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;
        const target = document.elementFromPoint(rect.x + x, rect.y + y);
        if (!target || !(target === element || element.contains(target)) || credentials.has(target)) return null;
      }
      return rect;
    }
    function continueInteraction(revisionValue: string) {
      if (modalInteraction || !authorize(revisionValue)) return false;
      interactionDone = true;
      // A challenge may have appeared after the first submit.
      submitted = false;
      return true;
    }
    async function finish() {
      // sessionStorage belongs to this document; other storage stays in the isolated
      // Session. Refuse to hand over a document that persists the password itself.
      for (const storage of [localStorage, sessionStorage]) for (let i = 0; i < storage.length; i++) {
        const value = storage.getItem(storage.key(i)!);
        if (persistedSecret(value, password, username, storage.key(i)!)) throw new Error("secret-in-storage");
      }
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue;
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(info.name!);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(new Error("storage-read-failed"));
        });
        try {
          for (const storeName of database.objectStoreNames) {
            const records = await new Promise<Array<{ key: IDBValidKey; value: unknown }>>((resolve, reject) => {
              const transaction = database.transaction(storeName, "readonly");
              const request = transaction.objectStore(storeName).openCursor();
              const values: Array<{ key: IDBValidKey; value: unknown }> = [];
              transaction.onerror = () => reject(new Error("storage-read-failed"));
              request.onerror = () => reject(new Error("storage-read-failed"));
              request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return resolve(values);
                if (values.length > 10000) return reject(new Error("storage-too-large"));
                values.push({ key: cursor.key, value: cursor.value });
                cursor.continue();
              };
            });
            for (const record of records) {
              const value = record.value instanceof Blob ? await record.value.text() : record.value;
              if (persistedSecret(record.key, password, username) || persistedSecret(value, password, username)) throw new Error("secret-in-storage");
            }
          }
        } finally { database.close(); }
      }
      return Object.fromEntries(Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]));
    }
    // Native events are checked again at delivery, after asynchronous host calls.
    // A modal moving between authorization and dispatch must not reach a password.
    const protectPointer = (event: Event) => {
      if ((!interactionSelector && !assisted) || !event.isTrusted) return;
      const element = assisted ? document.documentElement : one(interactionSelector);
      const target = event.target;
      if (!element || !(target instanceof Element) || !(target === element || element.contains(target)) || [...credentials].some((node) => node === target || node.contains(target))) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "touchstart", "touchend"]) window.addEventListener(type, protectPointer, true);
    for (const type of ["copy", "cut", "dragstart"]) window.addEventListener(type, (event) => { if (assisted) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
    new MutationObserver(() => { if (assisted) { maskCredentials(); maskSecretText(); } }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style", "type"] });
    return { tick, region, pageRegion, assist, fillAt, authorize, continueInteraction, finish, secretReleased: () => passwordReleased };
  }
  root.__vironLogin ??= createGuard();
}

export function protectedLoginInstallScript(config: WebLoginConfig, username: string, password: string, documentId: string): string {
  // Generate the nonce in the trusted main process. Browser crypto.randomUUID()
  // is unavailable on ordinary HTTP origins, including private network websites.
  return `(() => { const __name = (fn) => fn; (${installLoginGuard.toString()})(${JSON.stringify(config)}, ${JSON.stringify(username)}, ${JSON.stringify(password)}, ${selectWebCredentialAutofillFields.toString()}, ${JSON.stringify(documentId)}, ${businessPageStatus.toString()}, ${containsPersistedWebLoginSecret.toString()}); })()`;
}
