import { describe, expect, it } from "vitest";
import {
  buildWebCredentialAutofillScript,
  selectWebCredentialAutofillFields,
  WEB_CREDENTIAL_AUTOFILL_DELAYS_MS,
  type WebCredentialAutofillField,
} from "../src/shared/web-credential-autofill.js";

function field(
  index: number,
  input: Partial<WebCredentialAutofillField>,
): WebCredentialAutofillField {
  return {
    index,
    type: "text",
    autocomplete: "",
    name: "",
    id: "",
    placeholder: "",
    ariaLabel: "",
    label: "",
    formKey: "form:0",
    formAction: "",
    formIdentity: "",
    submitText: "",
    valueState: "empty",
    ...input,
  };
}

describe("Web credential autofill field selection", () => {
  it("recognizes a login form even though its autocomplete metadata is wrong", () => {
    const selection = selectWebCredentialAutofillFields([
      field(0, {
        id: "el-id-6995-6",
        placeholder: "用户名或邮箱",
        autocomplete: "off",
        formAction: "https://console.example.com/user/login",
        submitText: "登录",
      }),
      field(1, {
        type: "password",
        id: "el-id-6995-7",
        placeholder: "密码",
        autocomplete: "new-password",
        formAction: "https://console.example.com/user/login",
        submitText: "登录",
      }),
      field(2, { type: "checkbox", label: "我已阅读并同意服务条款" }),
    ]);

    expect(selection).toEqual({
      usernameIndex: 0,
      passwordIndex: 1,
      reason: "login",
    });
  });

  it("selects current-password without filling new or confirmation fields", () => {
    const selection = selectWebCredentialAutofillFields([
      field(0, {
        autocomplete: "section-login username",
        id: "field-a",
        formAction: "/login",
        submitText: "Sign in",
      }),
      field(1, {
        type: "password",
        autocomplete: "section-login current-password",
        id: "field-b",
        formAction: "/login",
        submitText: "Sign in",
      }),
      field(2, {
        type: "password",
        autocomplete: "section-register new-password",
        id: "field-c",
        formAction: "/login",
        submitText: "Sign in",
      }),
      field(3, {
        type: "password",
        autocomplete: "section-register new-password",
        id: "field-d",
        formAction: "/login",
        submitText: "Sign in",
      }),
    ]);

    expect(selection).toEqual({
      usernameIndex: 0,
      passwordIndex: 1,
      reason: "login",
    });
  });

  it("rejects registration and password-change forms", () => {
    const registration = selectWebCredentialAutofillFields([
      field(0, {
        type: "email",
        autocomplete: "username",
        name: "email",
        formAction: "/register",
        submitText: "Create account",
      }),
      field(1, {
        type: "password",
        autocomplete: "new-password",
        name: "newPassword",
        formAction: "/register",
        submitText: "Create account",
      }),
      field(2, {
        type: "password",
        autocomplete: "new-password",
        name: "confirmPassword",
        formAction: "/register",
        submitText: "Create account",
      }),
    ]);
    const passwordChange = selectWebCredentialAutofillFields([
      field(0, {
        type: "password",
        autocomplete: "current-password",
        name: "currentPassword",
        formAction: "/change-password",
        submitText: "Save password",
      }),
      field(1, {
        type: "password",
        autocomplete: "new-password",
        name: "newPassword",
        formAction: "/change-password",
        submitText: "Save password",
      }),
      field(2, {
        type: "password",
        autocomplete: "new-password",
        name: "confirmPassword",
        formAction: "/change-password",
        submitText: "Save password",
      }),
    ]);

    expect(registration).toEqual({
      usernameIndex: null,
      passwordIndex: null,
      reason: "no-reliable-form",
    });
    expect(passwordChange).toEqual({
      usernameIndex: null,
      passwordIndex: null,
      reason: "no-reliable-form",
    });
  });

  it("never treats OTP or captcha inputs as the stored password", () => {
    const selection = selectWebCredentialAutofillFields([
      field(0, {
        autocomplete: "username",
        name: "account",
        formAction: "/login",
        submitText: "登录",
      }),
      field(1, {
        type: "password",
        autocomplete: "one-time-code",
        name: "otpCode",
        placeholder: "验证码",
        formAction: "/login",
        submitText: "登录",
      }),
    ]);

    expect(selection).toEqual({
      usernameIndex: 0,
      passwordIndex: null,
      reason: "username-only",
    });
  });

  it("rejects equally plausible password fields from separate login forms", () => {
    const selection = selectWebCredentialAutofillFields([
      field(0, {
        autocomplete: "username",
        name: "username",
        formKey: "form:0",
        formAction: "/login",
        submitText: "Login",
      }),
      field(1, {
        type: "password",
        name: "password",
        formKey: "form:0",
        formAction: "/login",
        submitText: "Login",
      }),
      field(2, {
        autocomplete: "username",
        name: "username",
        formKey: "form:1",
        formAction: "/login",
        submitText: "Login",
      }),
      field(3, {
        type: "password",
        name: "password",
        formKey: "form:1",
        formAction: "/login",
        submitText: "Login",
      }),
    ]);

    expect(selection).toEqual({
      usernameIndex: null,
      passwordIndex: null,
      reason: "ambiguous-passwords",
    });
  });

  it("supports username-first login flows but ignores search fields", () => {
    expect(
      selectWebCredentialAutofillFields([
        field(0, {
          type: "email",
          autocomplete: "section-login username",
          name: "email",
          formAction: "/login",
          submitText: "Continue",
        }),
      ]),
    ).toEqual({
      usernameIndex: 0,
      passwordIndex: null,
      reason: "username-only",
    });

    expect(
      selectWebCredentialAutofillFields([
        field(0, { name: "search", placeholder: "搜索", formKey: "none" }),
      ]),
    ).toEqual({
      usernameIndex: null,
      passwordIndex: null,
      reason: "no-reliable-form",
    });
  });
});

describe("Web credential autofill script", () => {
  it("keeps credentials encoded and observes empty/filled state for SPA retries", () => {
    const script = buildWebCredentialAutofillScript({
      username: "测试用户",
      password: "密碼-🔐",
      previousSignature: "",
      autoSubmit: false,
      messages: {
        duplicate: "duplicate",
        ambiguousPasswords: "ambiguous",
        noReliableForm: "missing",
        filled: "filled",
        filledAndSubmitted: "submitted",
      },
    });

    expect(script).not.toContain("测试用户");
    expect(script).not.toContain("密碼-🔐");
    expect(script).toContain("new TextDecoder()");
    expect(script).toContain('valueState: input.value ? "filled" : "empty"');
    expect(() => new Function(script)).not.toThrow();
    expect(WEB_CREDENTIAL_AUTOFILL_DELAYS_MS).toEqual([
      250, 1_000, 2_500, 5_000, 10_000,
    ]);
  });
});
