import type { DesktopMcpWebAction } from "./web-view-runtime.js";

export interface DesktopWebSemanticSnapshot {
  text: string;
  interactive: Array<{
    index: number;
    tag: string;
    role: string;
    name: string;
    href: string;
    disabled: boolean;
  }>;
}

export const desktopWebSnapshotScript = `(() => {
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
  };
  const nameFor = (element) => (element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500);
  return {
    text: (document.body?.innerText || "").replace(/\\u0000/g, ""),
    interactive: [...document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=link],[tabindex]")]
      .filter(visible)
      .slice(0, 200)
      .map((element, index) => ({
        index,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        name: nameFor(element),
        href: element instanceof HTMLAnchorElement ? element.href : "",
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      })),
  };
})()`;

export function desktopWebActionScript(input: DesktopMcpWebAction): string {
  const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
  return `(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(payload)}), (character) => character.charCodeAt(0));
    const input = JSON.parse(new TextDecoder().decode(bytes));
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
    };
    const nameFor = (element) => (element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder") || element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500);
    const elements = [...document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=link],[tabindex]")].filter(visible).slice(0, 200);
    const element = elements[input.elementIndex];
    if (!element) throw new Error("交互元素序号已失效，请重新读取页面快照");
    const name = nameFor(element);
    if (input.expectedName && name !== input.expectedName) throw new Error("交互元素名称已变化，请重新读取页面快照");
    if (element.disabled || element.getAttribute("aria-disabled") === "true") throw new Error("交互元素当前不可用");
    const setValue = (target, value) => {
      const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(target, value); else target.value = value;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    };
    if (input.action === "fill") {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error("目标元素不支持文本填写");
      if (element instanceof HTMLInputElement && ["password", "file", "hidden"].includes(element.type.toLowerCase())) throw new Error("MCP 不允许填写密码、文件或隐藏输入框");
      setValue(element, input.value || "");
    } else if (input.action === "select") {
      if (!(element instanceof HTMLSelectElement)) throw new Error("目标元素不是下拉选择框");
      if (![...element.options].some((option) => option.value === input.value)) throw new Error("下拉选项不存在");
      element.value = input.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (input.action === "submit") {
      const form = element.closest("form");
      if (form?.requestSubmit) form.requestSubmit(element instanceof HTMLButtonElement || (element instanceof HTMLInputElement && ["submit", "image"].includes(element.type)) ? element : undefined);
      else element.click();
    } else {
      element.click();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { index: input.elementIndex, tag: element.tagName.toLowerCase(), name };
  })()`;
}
