import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { describe, expect, it } from "vitest";
import { createServerProtectedLogin } from "../src/server/web-browser/protected-login.js";
import { defaultWebLoginConfig } from "../src/shared/protected-web-login.js";
import type { ProtectedLoginController, ProtectedLoginResult } from "../src/shared/protected-web-login-controller.js";
import { PublicWebAssetCache } from "../src/shared/public-web-asset-cache.js";
import { configureServerWebRequests } from "../src/server/web-browser/public-web-assets.js";

describe.skipIf(process.env.VIRON_WEB_BROWSER_TEST !== "1")("protected login loading and cache", () => {
  it("shares public scripts between isolated accounts without sharing cookies or menu responses", async () => {
    const scriptCookies: string[] = [];
    const target = createServer((request, response) => {
      if (request.url === "/assets/app-AbCd1234.js") {
        scriptCookies.push(request.headers.cookie ?? "");
        response.setHeader("Content-Type", "text/javascript"); response.setHeader("Cache-Control", "public, max-age=3600");
        response.end("document.querySelector('main').dataset.loaded='yes';"); return;
      }
      response.setHeader("Content-Type", "text/html"); response.setHeader("Cache-Control", "private, no-store");
      response.end(`<!doctype html><main>${request.headers.cookie ?? "anonymous"}</main><script src="/assets/app-AbCd1234.js"></script>`);
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
    mkdirSync("private/browser-tests", { recursive: true });
    const directory = mkdtempSync(join(process.cwd(), "private/browser-tests/account-assets-"));
    const browser = await chromium.launch({ headless: true });
    try {
      for (const account of ["first-account", "second-account"]) {
        const context = await browser.newContext();
        await context.addCookies([{ name: "account", value: account, url: origin }]);
        const page = await context.newPage();
        await configureServerWebRequests(await context.newCDPSession(page), { assets: new PublicWebAssetCache(directory) });
        await page.goto(origin); expect(await page.locator("main").textContent()).toBe(`account=${account}`);
        expect(await page.locator("main").getAttribute("data-loaded")).toBe("yes");
        await context.close();
      }
      expect(scriptCookies).toEqual([""]);
    } finally {
      await browser.close(); target.closeAllConnections(); await new Promise<void>((resolve) => target.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10_000);
  it("authenticates a ready form while an unrelated image is still downloading", async () => {
    let posts = 0;
    const target = createServer((request, response) => {
      if (request.url === "/slow-image") return;
      if (request.method === "POST") { posts++; response.end("ok"); return; }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Login</title>
        <form><input name="username" autocomplete="username"><input name="password" type="password"><button>Login</button></form>
        <img src="/slow-image"><script>document.querySelector('form').onsubmit=async event=>{
          event.preventDefault();await fetch('/authenticate',{method:'POST',body:new URLSearchParams(new FormData(event.target))});
          event.target.remove();document.body.insertAdjacentHTML('beforeend','<main id="home">Signed in</main>');location.hash='/home';
        }</script>`);
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    let login: ProtectedLoginController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = new Promise<ProtectedLoginResult>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Ready form was blocked by an image download")), 5000);
        void createServerProtectedLogin({ context, url: `http://127.0.0.1:${(target.address() as { port: number }).port}/login`,
          username: "fixture-user", password: "fixture-password", config: { ...defaultWebLoginConfig(), successSelector: "#home" },
          changed: () => {}, completed: async (value) => { resolve(value); },
        }).then((value) => { login = value; }, reject);
      });
      expect((await result).authenticated).toBe(true);
      expect(posts).toBe(1);
    } finally {
      clearTimeout(timer); login?.dispose(); await login?.settled(); await browser.close();
      target.closeAllConnections(); await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  }, 10_000);

  it("reuses cached scripts after restarting the persistent authentication browser", async () => {
    let scriptRequests = 0;
    const target = createServer((request, response) => {
      if (request.url === "/app.js") {
        scriptRequests++; response.setHeader("Cache-Control", "public, max-age=31536000");
        response.setHeader("Content-Type", "text/javascript"); response.end("document.querySelector('main').textContent='Signed in';"); return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end('<!doctype html><title>Console</title><main id="home">Loading</main><script src="/app.js"></script>');
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    mkdirSync("private/browser-tests", { recursive: true });
    const directory = mkdtempSync(join(process.cwd(), "private/browser-tests/login-cache-"));
    let context: BrowserContext | undefined, login: ProtectedLoginController | undefined;
    try {
      for (let restart = 0; restart < 2; restart++) {
        context = await chromium.launchPersistentContext(directory, { headless: true });
        const result = new Promise<ProtectedLoginResult>((resolve, reject) => {
          void createServerProtectedLogin({ context: context!, url: `http://127.0.0.1:${(target.address() as { port: number }).port}/login`,
            username: "fixture-user", password: "fixture-password", config: { ...defaultWebLoginConfig(), successSelector: "#home" },
            changed: () => {}, completed: async (value) => { resolve(value); },
          }).then((value) => { login = value; }, reject);
        });
        expect((await result).authenticated).toBe(true);
        await context.close(); context = undefined;
      }
      expect(scriptRequests).toBe(1);
    } finally {
      login?.dispose(); await login?.settled(); await context?.close();
      target.closeAllConnections(); await new Promise<void>((resolve) => target.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
