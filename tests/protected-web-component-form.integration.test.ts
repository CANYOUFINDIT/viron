import { createServer } from "node:http";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { createServerProtectedLogin, verifyServerBusinessPage } from "../src/server/web-browser/protected-login.js";
import { defaultWebLoginConfig } from "../src/shared/protected-web-login.js";
import type { ProtectedLoginController, ProtectedLoginResult } from "../src/shared/protected-web-login-controller.js";

describe.skipIf(process.env.VIRON_WEB_BROWSER_TEST !== "1")("component login forms in the server browser", () => {
  it("uses component input state and a Submit click, retains a structured identity token, and verifies a fresh hash-route document", async () => {
    let posts = 0, nativeSubmits = 0;
    const target = createServer((request, response) => {
      if (request.url === "/unexpected-submit") { nativeSubmits++; response.end(); return; }
      if (request.method === "POST") {
        let body = ""; request.on("data", (chunk) => body += chunk); request.on("end", () => {
          const values = new URLSearchParams(body);
          expect(values.get("username")).toBe("fixture-identity"); expect(values.get("password")).toBe("fixture-identity");
          posts++; response.setHeader("Content-Type", "application/json"); response.end('{"accessToken":"opaque-fixture-token"}');
        }); return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>Component console</title><form class="next-form login-form"><input id="username" autocomplete="off" placeholder="请输入用户名"><input id="password" type="password" autocomplete="off" placeholder="请输入密码"><button id="login" type="button">提交</button></form><script>
        const state={};for(const input of document.querySelectorAll('input'))input.addEventListener('input',event=>state[input.id]=event.target.value);
        document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();fetch('/unexpected-submit')});
        const home=()=>{document.querySelector('form').remove();document.body.insertAdjacentHTML('beforeend','<main>Authenticated console</main>');location.hash='/home'};
        login.addEventListener('click',async()=>{const result=await fetch('/login',{method:'POST',body:new URLSearchParams(state)});const token=await result.json();localStorage.setItem('token',JSON.stringify({...token,username:state.username}));sessionStorage.setItem('fixture-tab','kept');home()});
        if(localStorage.getItem('token'))home();
      </script>`);
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--disable-extensions"] });
    const context = await browser.newContext();
    let login: ProtectedLoginController | undefined;
    const snapshots: string[] = [];
    let complete!: (value: ProtectedLoginResult) => void;
    const result = new Promise<ProtectedLoginResult>((resolve) => { complete = resolve; });
    try {
      login = await createServerProtectedLogin({ context, url: `http://127.0.0.1:${(target.address() as { port: number }).port}/#/login`, username: "fixture-identity", password: "fixture-identity", config: defaultWebLoginConfig(), changed: () => { if (login) snapshots.push(JSON.stringify(login.state)); }, completed: async (value) => { complete(value); } });
      const auth = context.pages()[0];
      const finished = await Promise.race([result, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("Component login timed out")), 12_000); timer.unref(); })]);
      expect(finished.url.endsWith("#/home")).toBe(true); expect(auth.isClosed()).toBe(true);
      expect(posts).toBe(1); expect(nativeSubmits).toBe(0);
      expect(snapshots.some((value) => { const state=JSON.parse(value); return state.phase === "authenticating" && state.pageLoading === false; })).toBe(true);
      expect(snapshots.every((value) => !value.includes("fixture-identity"))).toBe(true);
      const business = await context.newPage();
      await business.goto(finished.url); const cdp = await context.newCDPSession(business);
      await verifyServerBusinessPage(business, cdp, "", () => true);
      expect(await business.locator("input[type=password]").count()).toBe(0);
      expect(await business.locator("main").textContent()).toBe("Authenticated console");
      expect(posts).toBe(1);
    } finally {
      login?.dispose(); await login?.settled(); await browser.close(); target.closeAllConnections(); await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  }, 20_000);
});
