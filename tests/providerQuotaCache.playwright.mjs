import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ headless: true });
const quota = { id: "ark", name: "Ark", status: "ready", periods: [{ label: "session", usedPercent: 32, resetsAt: null }], updatedAt: new Date().toISOString(), stale: false, message: null };
const errors = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", e => { errors.push(e.message); console.error(e.message); });
  await page.route("**/quota-cache-fixture", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="UTF-8"><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
    window.__vite_plugin_react_preamble_installed__ = true;
  </script><script type="module">
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import {useProviderQuotas,providerRemaining} from '/src/providerQuota.tsx';
    function App(){ const items=useProviderQuotas('cache-test'); const item=items[0]; return React.createElement('div',null,item ? providerRemaining(item)+' '+(item.stale?'缓存':'实时')+' '+(item.message??'') : 'empty'); }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
  </script>` }));
  let mode = "ready", requests = 0, release;
  await page.route("**/api/codex/provider-quotas", async route => {
    requests++;
    if (mode === "delay") await new Promise(resolve => { release = resolve; });
    if (mode === "fail") return route.fulfill({ status: 503, json: {} });
    return route.fulfill({ json: { data: { loading: mode === "loading", items: [mode === "loading" ? { ...quota, status: "loading", periods: [], updatedAt: null } : quota] } } });
  });
  await page.goto("http://127.0.0.1:5216/quota-cache-fixture");
  await page.getByText("68% 实时", { exact: true }).waitFor();
  mode = "delay";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("68% 缓存", { exact: true }).waitFor();
  await page.waitForFunction(() => document.body.textContent.includes("68%"));
  for (let n = 0; !release && n < 100; n++) await page.waitForTimeout(20);
  assert.ok(release, `background refresh not started; requests=${requests}; errors=${JSON.stringify(errors)}`);
  mode = "loading"; release();
  await page.getByText("68% 缓存 正在后台更新额度…", { exact: true }).waitFor();
  mode = "fail";
  await page.getByText("68% 缓存 额度更新暂不可用，保留上次成功值。", { exact: true }).waitFor();
  const before = requests;
  mode = "ready";
  await page.getByText("68% 实时", { exact: true }).waitFor({ timeout: 20000 });
  assert.ok(requests > before, "failed refresh must retry without reopening");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ reloadShowsCacheBeforeNetwork: true, emptyLoadingPreservesQuota: true, failurePreservesQuota: true, automaticRecovery: true, errors }));
} finally { await browser.close(); }
