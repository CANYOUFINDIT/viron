export type ClipboardCopyMethod = "clipboard-api" | "exec-command";

export interface ClipboardCopyOptions {
  secureContext?: boolean;
  clipboard?: Pick<Clipboard, "writeText"> | null;
  document?: Document | null;
}

function copyWithExecCommand(documentRef: Document, value: string): boolean {
  if (!documentRef.body) return false;
  const previousFocus = documentRef.activeElement as (Element & { focus?: (options?: FocusOptions) => void }) | null;
  const textarea = documentRef.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none";
  documentRef.body.appendChild(textarea);

  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return documentRef.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    try {
      previousFocus?.focus?.({ preventScroll: true });
    } catch {
      // The previously focused element may have been removed during the interaction.
    }
  }
}

export async function copyTextToClipboard(value: string, options: ClipboardCopyOptions = {}): Promise<ClipboardCopyMethod> {
  const secureContext = options.secureContext ?? (typeof window !== "undefined" && window.isSecureContext);
  const clipboard = options.clipboard === undefined
    ? (typeof navigator !== "undefined" ? navigator.clipboard : undefined)
    : options.clipboard ?? undefined;
  const documentRef = options.document === undefined
    ? (typeof document !== "undefined" ? document : undefined)
    : options.document ?? undefined;

  let clipboardError: unknown;
  if (secureContext && clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return "clipboard-api";
    } catch (error) {
      clipboardError = error;
    }
  }

  if (documentRef && copyWithExecCommand(documentRef, value)) return "exec-command";
  if (clipboardError) throw clipboardError;
  throw new Error("Clipboard API unavailable");
}
