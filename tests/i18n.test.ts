import { describe, expect, it } from "vitest";
import { enMessages } from "../src/shared/i18n-messages.js";
import {
  detectLanguage,
  localizeUnknownMessage,
  normalizeLanguage,
  translateMessage,
} from "../src/shared/i18n.js";
import { localizeJsonPayload } from "../src/server/i18n.js";

const placeholders = (value: string) => value.match(/\{\{\d+\}\}/g)?.sort() ?? [];

describe("Viron language selection", () => {
  it("uses Chinese for zh system locales and English for every other locale", () => {
    expect(detectLanguage(["zh-Hans-CN", "en-US"])).toBe("zh-CN");
    expect(detectLanguage("zh-TW")).toBe("zh-CN");
    expect(detectLanguage("en-US")).toBe("en");
    expect(detectLanguage("ja-JP")).toBe("en");
  });

  it("only accepts persisted product languages", () => {
    expect(normalizeLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("fr")).toBeNull();
  });
});

describe("Viron message catalog", () => {
  it("keeps every dynamic placeholder in the English message", () => {
    for (const [key, value] of Object.entries(enMessages)) expect(placeholders(value), key).toEqual(placeholders(key));
  });

  it("contains no Chinese characters in English values", () => {
    for (const [key, value] of Object.entries(enMessages)) expect(value, key).not.toMatch(/\p{Script=Han}/u);
  });

  it("formats static and dynamic messages", () => {
    expect(translateMessage("en", "设置")).toBe("Settings");
    expect(translateMessage("en", "请求失败（{{0}}）", [503])).toBe("Request failed (503)");
    expect(localizeUnknownMessage("en", "请求失败（502）")).toBe("Request failed (502)");
    expect(translateMessage("en", "元数据库不可用")).toBe("Metadata database unavailable");
    expect(translateMessage("zh-CN", "请求失败（{{0}}）", [503])).toBe("请求失败（503）");
  });
});

describe("API response localization", () => {
  it("localizes business errors for English requests without changing user data", () => {
    const payload = JSON.stringify({ message: "页面加载失败", item: { name: "设置", description: "用户数据" } });
    expect(JSON.parse(localizeJsonPayload("en-US", payload))).toEqual({
      message: "Failed to Load Page",
      item: { name: "设置", description: "用户数据" },
    });
    expect(localizeJsonPayload("zh-CN", payload)).toBe(payload);
  });
});
