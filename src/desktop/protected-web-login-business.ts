import type { WebContents } from "electron";
import { protectedLoginBusinessPageScript } from "../shared/protected-web-login-dom.js";

/** Check the newly loaded business document, independently of the destroyed login document. */
export async function verifyProtectedBusinessPage(contents: WebContents, selector: string, current: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000;
  let since = 0, candidate = "";
  while (current() && !contents.isDestroyed() && Date.now() < deadline) {
    if (!contents.isLoadingMainFrame()) {
      try {
        const result = await contents.executeJavaScriptInIsolatedWorld(997, [{ code: protectedLoginBusinessPageScript(selector) }], true);
        const key = `${contents.getURL()}:${result}`;
        if (candidate !== key) { candidate = key; since = Date.now(); }
        if (result === "login" && Date.now() - since >= 3000) throw new Error("business-login");
        if (result === "ready" && Date.now() - since >= (selector ? 300 : 1500)) return;
      } catch (error) {
        if (error instanceof Error && error.message === "business-login") throw error;
        // Navigation can invalidate the isolated world between the loading check
        // and the probe. Only a complete, stable document can be accepted.
        since = 0; candidate = "";
      }
    } else { since = 0; candidate = ""; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("business-unconfirmed");
}
