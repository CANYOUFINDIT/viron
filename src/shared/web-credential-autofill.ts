export interface WebCredentialAutofillField {
  index: number;
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  label: string;
  formKey: string;
  formAction: string;
  formIdentity: string;
  submitText: string;
  valueState: "empty" | "filled";
}

export interface WebCredentialAutofillSelection {
  usernameIndex: number | null;
  passwordIndex: number | null;
  reason:
    "login" | "username-only" | "ambiguous-passwords" | "no-reliable-form";
}

export interface WebCredentialAutofillMessages {
  duplicate: string;
  ambiguousPasswords: string;
  noReliableForm: string;
  filled: string;
  filledAndSubmitted: string;
}

export interface WebCredentialAutofillScriptOptions {
  username: string;
  password: string;
  previousSignature: string;
  autoSubmit: boolean;
  messages: WebCredentialAutofillMessages;
}

export interface WebCredentialAutofillResult {
  status: "duplicate" | "filled" | "skipped";
  signature: string;
  message: string;
}

export const WEB_CREDENTIAL_AUTOFILL_DELAYS_MS = [
  250, 1_000, 2_500, 5_000, 10_000,
] as const;

/**
 * Chooses a single login credential target from serialized DOM metadata.
 * Keep this function self-contained: its runtime source is injected into an
 * isolated Chromium page by buildWebCredentialAutofillScript().
 */
export const selectWebCredentialAutofillFields = (
  fields: WebCredentialAutofillField[],
): WebCredentialAutofillSelection => {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[\s_-]+/g, " ")
      .trim();
  const hasAutocomplete = (field: WebCredentialAutofillField, token: string) =>
    field.autocomplete.trim().toLowerCase().split(/\s+/).includes(token);
  const fieldText = (field: WebCredentialAutofillField) =>
    normalize(
      [
        field.name,
        field.id,
        field.placeholder,
        field.ariaLabel,
        field.label,
      ].join(" "),
    );
  const passwordPattern = /(pass(word|code|phrase)?|passwd|pwd|密码|口令)/i;
  const currentPasswordPattern =
    /(current|old|existing|原|旧|当前).{0,12}(pass(word|code|phrase)?|passwd|pwd|密码|口令)|(pass(word|code|phrase)?|passwd|pwd|密码|口令).{0,12}(current|old|existing|原|旧|当前)/i;
  const newPasswordPattern =
    /(new|confirm|repeat|create|set|registration|register|signup|sign up|reset|change|新|确认|重复|注册|创建|重置|修改|更改).{0,12}(pass(word|code|phrase)?|passwd|pwd|密码|口令)|(pass(word|code|phrase)?|passwd|pwd|密码|口令).{0,12}(new|confirm|repeat|create|set|registration|register|signup|sign up|reset|change|新|确认|重复|注册|创建|重置|修改|更改)/i;
  const otpPattern =
    /(one.?time|verification|verify|auth(entication)?|security).{0,10}(code|pin)|2fa|mfa|totp|otp|captcha|验证码|校验码|动态码|一次性|双因素|两步验证/i;
  const usernamePattern =
    /(user(name|id)?|account|login|email|e mail|mail|mobile|phone|用户名|用户|账号|帐号|邮箱|邮件|手机|手机号)/i;
  const searchPattern =
    /(search|query|keyword|filter|find|搜索|查询|关键字|筛选)/i;
  const newIdentityPattern =
    /(new|confirm|repeat|register|signup|sign up|create).{0,10}(user|account|email|mail)|(新|确认|重复|注册|创建).{0,10}(用户|账号|帐号|邮箱|邮件)/i;
  const strongLoginPattern =
    /(^|[^a-z])(sign ?in|log ?in|login|logon)([^a-z]|$)|登录|登入|登陆/i;
  const weakLoginPattern = /(^|[^a-z])(continue|next)([^a-z]|$)|下一步|继续/i;
  const nonLoginPattern =
    /(register|registration|sign ?up|create account|forgot|reset|change|update|save).{0,16}(password|account)?|new password|confirm password|注册|创建账号|忘记密码|找回密码|重置密码|新密码|确认密码|修改密码|更改密码|保存密码/i;

  const contextScores = (field: WebCredentialAutofillField) => {
    const actionAndIdentity = normalize(
      `${field.formAction} ${field.formIdentity}`,
    );
    const submit = normalize(field.submitText);
    let score = 0;
    let strongLogin = 0;
    if (strongLoginPattern.test(actionAndIdentity)) {
      score += 45;
      strongLogin += 45;
    }
    if (strongLoginPattern.test(submit)) {
      score += 55;
      strongLogin += 55;
    } else if (weakLoginPattern.test(submit)) score += 15;
    if (nonLoginPattern.test(actionAndIdentity)) score -= 90;
    if (nonLoginPattern.test(submit)) score -= 90;
    return { score, strongLogin };
  };

  const passwordCandidates = fields.filter((field) => {
    const text = fieldText(field);
    if (hasAutocomplete(field, "one-time-code") || otpPattern.test(text))
      return false;
    return (
      field.type === "password" ||
      (field.type === "text" &&
        (hasAutocomplete(field, "current-password") ||
          hasAutocomplete(field, "new-password") ||
          passwordPattern.test(text)))
    );
  });

  const usernameScore = (
    field: WebCredentialAutofillField,
    passwordField?: WebCredentialAutofillField,
  ) => {
    if (!["text", "email", "tel", "number"].includes(field.type)) return -1_000;
    const text = fieldText(field);
    if (
      passwordPattern.test(text) ||
      otpPattern.test(text) ||
      searchPattern.test(text)
    )
      return -1_000;
    let score = 0;
    if (hasAutocomplete(field, "username")) score += 80;
    if (field.type === "email") score += 30;
    else if (field.type === "tel") score += 18;
    if (usernamePattern.test(text)) score += 45;
    if (newIdentityPattern.test(text)) score -= 70;
    score += contextScores(field).score;
    if (passwordField) {
      if (field.formKey === passwordField.formKey) score += 35;
      else if (field.formKey !== "none" || passwordField.formKey !== "none")
        score -= 100;
      if (field.index < passwordField.index)
        score += Math.max(
          5,
          22 - Math.min(17, passwordField.index - field.index),
        );
      else score -= 20;
    }
    return score;
  };

  const usernameFor = (passwordField?: WebCredentialAutofillField) =>
    fields
      .map((field) => ({ field, score: usernameScore(field, passwordField) }))
      .filter((candidate) => candidate.score >= 45)
      .sort(
        (left, right) =>
          right.score - left.score || left.field.index - right.field.index,
      );

  if (!passwordCandidates.length) {
    const usernames = usernameFor();
    if (
      !usernames.length ||
      (usernames[1] && usernames[0].score - usernames[1].score < 15)
    ) {
      return {
        usernameIndex: null,
        passwordIndex: null,
        reason: "no-reliable-form",
      };
    }
    return {
      usernameIndex: usernames[0].field.index,
      passwordIndex: null,
      reason: "username-only",
    };
  }

  const groupPasswordCounts = new Map<string, number>();
  const groupHasNewPassword = new Map<string, boolean>();
  for (const field of passwordCandidates) {
    groupPasswordCounts.set(
      field.formKey,
      (groupPasswordCounts.get(field.formKey) ?? 0) + 1,
    );
    const text = fieldText(field);
    if (hasAutocomplete(field, "new-password") || newPasswordPattern.test(text))
      groupHasNewPassword.set(field.formKey, true);
  }

  const rankedPasswords = passwordCandidates
    .map((field) => {
      const text = fieldText(field);
      const context = contextScores(field);
      const groupCount = groupPasswordCounts.get(field.formKey) ?? 1;
      let score = field.type === "password" ? 30 : 10;
      if (hasAutocomplete(field, "current-password")) score += 100;
      if (hasAutocomplete(field, "new-password")) score -= 75;
      if (passwordPattern.test(text)) score += 20;
      if (currentPasswordPattern.test(text)) score += 35;
      if (newPasswordPattern.test(text)) score -= 85;
      score += context.score;
      if (groupCount === 1) score += 20;
      else score -= 15;
      if (
        groupHasNewPassword.get(field.formKey) &&
        groupCount > 1 &&
        !hasAutocomplete(field, "current-password")
      )
        score -= 45;
      const usernames = usernameFor(field);
      if (usernames.length) score += 25;
      const mislabeledLogin =
        hasAutocomplete(field, "new-password") &&
        groupCount === 1 &&
        context.strongLogin >= 45 &&
        usernames.length > 0;
      if (hasAutocomplete(field, "new-password") && !mislabeledLogin)
        score = Math.min(score, 20);
      return { field, score, usernames };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.field.index - right.field.index,
    );

  const best = rankedPasswords[0];
  const second = rankedPasswords[1];
  if (!best || best.score < 55)
    return {
      usernameIndex: null,
      passwordIndex: null,
      reason: "no-reliable-form",
    };
  if (
    second &&
    best.field.formKey !== second.field.formKey &&
    best.score - second.score < 25
  ) {
    return {
      usernameIndex: null,
      passwordIndex: null,
      reason: "ambiguous-passwords",
    };
  }
  const username = best.usernames[0];
  if (
    username &&
    best.usernames[1] &&
    username.score - best.usernames[1].score < 15
  ) {
    return {
      usernameIndex: null,
      passwordIndex: null,
      reason: "no-reliable-form",
    };
  }
  return {
    usernameIndex: username?.field.index ?? null,
    passwordIndex: best.field.index,
    reason: "login",
  };
};

export function buildWebCredentialAutofillScript(
  options: WebCredentialAutofillScriptOptions,
): string {
  const payload = Buffer.from(JSON.stringify(options), "utf8").toString(
    "base64",
  );
  const selectorSource = selectWebCredentialAutofillFields.toString();
  return `(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(payload)}), (character) => character.charCodeAt(0));
    const { username, password, previousSignature, autoSubmit, messages } = JSON.parse(new TextDecoder().decode(bytes));
    const __name = (target) => target;
    const selectFields = ${selectorSource};
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return !element.disabled && !element.readOnly && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0.05 && rect.width > 2 && rect.height > 2;
    };
    const allInputs = [...document.querySelectorAll("input")];
    const inputs = allInputs.filter(visible);
    const formKey = (input) => input.form ? "form:" + [...document.forms].indexOf(input.form) : "none";
    const containerFor = (input) => input.form ?? input.closest('[role="form"], [class*="login" i], [id*="login" i]') ?? document.body;
    const submitButtons = (input) => [...containerFor(input).querySelectorAll('button, input[type="submit"]')].filter(visible);
    const textOf = (element) => (element.innerText || element.value || element.getAttribute("aria-label") || "").trim();
    const labelOf = (input) => {
      const explicit = [...(input.labels || [])].map((label) => label.innerText || label.textContent || "");
      const wrapping = input.closest("label");
      if (wrapping) explicit.push(wrapping.innerText || wrapping.textContent || "");
      const describedBy = (input.getAttribute("aria-describedby") || "").split(/\\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "");
      return [...explicit, ...describedBy].join(" ").trim();
    };
    const describe = () => inputs.map((input, index) => ({
      index,
      type: input.type.toLowerCase(),
      autocomplete: input.getAttribute("autocomplete") || "",
      name: input.name || "",
      id: input.id || "",
      placeholder: input.placeholder || "",
      ariaLabel: input.getAttribute("aria-label") || "",
      label: labelOf(input),
      formKey: formKey(input),
      formAction: input.form?.action || "",
      formIdentity: input.form ? [input.form.id, input.form.name, input.form.className].join(" ") : "",
      submitText: submitButtons(input).map(textOf).join(" "),
      valueState: input.value ? "filled" : "empty",
    }));
    const signatureOf = (fields) => location.href + "|" + fields.map((field) => [
      field.type,
      field.name,
      field.id,
      field.autocomplete,
      field.formKey,
      field.formAction,
      field.submitText,
      field.placeholder,
      field.ariaLabel,
      field.label,
      field.valueState,
    ].join(":")).join("|");
    const fields = describe();
    const initialSignature = signatureOf(fields);
    if (initialSignature === previousSignature) return { status: "duplicate", signature: initialSignature, message: messages.duplicate };
    const selection = selectFields(fields);
    if (selection.usernameIndex === null && selection.passwordIndex === null) {
      return {
        status: "skipped",
        signature: initialSignature,
        message: selection.reason === "ambiguous-passwords" ? messages.ambiguousPasswords : messages.noReliableForm,
      };
    }
    const setValue = (input, value) => {
      const prototype = input.ownerDocument.defaultView?.HTMLInputElement?.prototype ?? HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(input, value); else input.value = value;
      let inputEvent;
      try { inputEvent = new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: value }); }
      catch { inputEvent = new Event("input", { bubbles: true }); }
      input.dispatchEvent(inputEvent);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const usernameInput = selection.usernameIndex === null ? null : inputs[selection.usernameIndex];
    const passwordInput = selection.passwordIndex === null ? null : inputs[selection.passwordIndex];
    if (usernameInput) setValue(usernameInput, username);
    if (passwordInput) setValue(passwordInput, password);
    const finalSignature = signatureOf(describe());
    const target = passwordInput ?? usernameInput;
    const form = target?.form ?? null;
    const buttons = target ? submitButtons(target) : [];
    const submit = buttons.find((button) => /login|log in|sign in|登录|登入|登陆/i.test(textOf(button)))
      ?? buttons.find((button) => button.type === "submit");
    if (autoSubmit && (submit || form)) {
      window.setTimeout(() => {
        if (submit && submit.type !== "submit") submit.click();
        else if (form?.requestSubmit) form.requestSubmit(submit instanceof HTMLElement ? submit : undefined);
        else submit?.click();
      }, 120);
    }
    return {
      status: "filled",
      signature: finalSignature,
      message: autoSubmit && (submit || form) ? messages.filledAndSubmitted : messages.filled,
    };
  })()`;
}
