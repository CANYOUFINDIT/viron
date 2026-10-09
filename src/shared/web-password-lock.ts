/** Runs in the executor's isolated world. This restricts page UI, not local process debugging. */
function installPasswordLocks() {
  const root = globalThis as typeof globalThis & { __vironWebPasswordLocks?: { has(node: HTMLInputElement): boolean; lock(node: HTMLInputElement, secret: string): void } };
  if (root.__vironWebPasswordLocks) return root.__vironWebPasswordLocks;
  const nodes = new Set<HTMLInputElement>();
  const secrets = new Set<string>();
  const enforce = (node: HTMLInputElement) => {
    if (node.type !== "password") node.type = "password";
    if (!node.readOnly) node.readOnly = true;
    for (const [name, value] of [["-webkit-text-security", "disc"], ["user-select", "none"], ["caret-color", "transparent"]]) {
      if (node.style.getPropertyValue(name) !== value || node.style.getPropertyPriority(name) !== "important") node.style.setProperty(name, value, "important");
    }
  };
  const redact = (value: string) => {
    for (const secret of secrets) if (secret) value = value.replaceAll(secret, "••••••••");
    return value;
  };
  const protectCopies = () => {
    for (const node of document.querySelectorAll<HTMLInputElement>("input")) {
      if ([...secrets].some((secret) => secret && node.value.includes(secret))) { nodes.add(node); enforce(node); }
    }
    if (!document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest("script,style")) continue;
      const text = node.nodeValue ?? "", masked = redact(text);
      if (text !== masked) node.nodeValue = masked;
    }
    for (const node of document.querySelectorAll<HTMLElement>("[title],[aria-label]")) {
      for (const attr of ["title", "aria-label"]) {
        const value = node.getAttribute(attr);
        if (value !== null && redact(value) !== value) node.setAttribute(attr, redact(value));
      }
    }
  };
  const observer = new MutationObserver((records) => {
    for (const node of nodes) { if (node.isConnected) enforce(node); else nodes.delete(node); }
    if (records.some((record) => record.type !== "attributes" || ["value", "title", "aria-label"].includes(record.attributeName ?? ""))) protectCopies();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  const blocked = (event: Event) => {
    if (!(event.target instanceof HTMLInputElement) || !nodes.has(event.target)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event instanceof ClipboardEvent) event.clipboardData?.clearData();
  };
  for (const type of ["copy", "cut", "paste", "dragstart", "beforeinput"]) document.addEventListener(type, blocked, true);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" && event.key !== "Enter" && event.key !== "Escape") blocked(event);
  }, true);
  root.__vironWebPasswordLocks = {
    has: (node) => nodes.has(node),
    lock: (node, secret) => {
      if (secret) secrets.add(secret);
      nodes.add(node); enforce(node); protectCopies();
      const shadow = node.getRootNode();
      if (shadow instanceof ShadowRoot) { observer.observe(shadow, { subtree: true, childList: true, attributes: true }); for (const type of ["copy", "cut", "paste", "beforeinput"]) shadow.addEventListener(type, blocked, true); }
    },
  };
  return root.__vironWebPasswordLocks;
}

export function webPasswordLockSource(): string { return installPasswordLocks.toString(); }
