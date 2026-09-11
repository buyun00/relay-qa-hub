import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

// Uses the actual React page with controlled HTTP responses. No build or upload writes.
// Set QA_HUB_PLAYWRIGHT_PACKAGE to a Playwright package.json if not installed locally.
const require = createRequire(process.env.QA_HUB_PLAYWRIGHT_PACKAGE || import.meta.url);
const { chromium } = require("playwright");
const repo = fileURLToPath(new URL("..", import.meta.url));
const root = path.join(repo, "work", "compatibility-navigation-tests");
await fs.mkdir(path.join(root, "harness"), { recursive: true });
await fs.writeFile(
  path.join(root, "harness/index.html"),
  '<div id="root"></div><script type="module" src="/main.tsx"></script>',
);
await fs.writeFile(
  path.join(root, "harness/main.tsx"),
  `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import PackagingPage from '../../../apps/web/src/PackagingPage';
import '../../../apps/web/src/app.css';import '../../../apps/web/src/icon-theme.css';
function Harness(){const [active,setActive]=useState(true);const [revision,setRevision]=useState(0);return <><button id="enter" onClick={()=>setActive(true)}>进入</button><button id="leave" onClick={()=>setActive(false)}>离开</button><button id="refresh-data" onClick={()=>setRevision(v=>v+1)}>刷新页面数据</button><PackagingPage active={active} refreshRevision={revision} userId="navigation-test"/></>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness/></React.StrictMode>);
`,
);
const server = await createServer({
  root: path.join(root, "harness"),
  configFile: false,
  logLevel: "error",
  cacheDir: path.join(root, "vite-cache"),
  plugins: [react()],
  server: { host: "127.0.0.1", port: 4665, strictPort: true, fs: { allow: [repo] } },
});
await server.listen();
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [],
  submissions = [];
let gets = 0,
  unsafe = 0,
  hold = false,
  batch;
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/api/**", async (route) => {
  const request = route.request(),
    u = new URL(request.url());
  let body;
  if (u.pathname === "/api/v1/packaging/compatibility") {
    if (request.method() === "POST") {
      submissions.push({ at: Date.now(), id: request.headers()["idempotency-key"] });
      assert.match(submissions.at(-1).id, /^[a-f0-9-]{36}$/);
      batch = {
        id: submissions.at(-1).id,
        requestedAt: new Date().toISOString(),
        checks: ["Android/Debug", "Android/Release", "iOS/Debug", "iOS/Release"].map((s) => {
          const [platform, configuration] = s.split("/");
          return {
            target: { id: s.toLowerCase().replace("/", "-"), platform, configuration },
            state: "queued",
            queueId: 42,
            buildNumber: null,
            report: null,
            reportUrl: null,
            checkedAt: null,
            errorCode: null,
          };
        }),
      };
      body = batch;
    } else {
      gets++;
      body = hold
        ? batch
        : {
            ...batch,
            checks: batch.checks.map((c) => ({
              ...c,
              state: "complete",
              buildNumber: 1,
              checkedAt: new Date().toISOString(),
              report: {
                result: "HOT_UPDATE_ALLOWED",
                selectedVersion: `${c.target.platform}/${c.target.configuration}/2.5.1/1`,
                playerVersion: `${c.target.platform}/${c.target.configuration}/2.5.1/1`,
                targetRevision: "b".repeat(40),
                baseRevision: "a".repeat(40),
                commitCount: 1,
                changeCount: 1,
                changeCounts: { hot_update: 1 },
              },
            })),
          };
    }
  } else if (request.method() !== "GET") {
    unsafe++;
    return route.abort();
  } else if (u.pathname === "/api/v1/packaging")
    body = {
      checkedAt: new Date().toISOString(),
      jenkins: { buildable: true, builds: [], queue: [] },
      artifacts: [],
      apks: [],
      ipas: [],
      zip: null,
    };
  else if (u.pathname.endsWith("/progress"))
    body = { checkedAt: new Date().toISOString(), builds: [], queues: [] };
  else if (u.pathname.endsWith("/build-chains")) body = [];
  else if (u.pathname === "/api/v1/increment-upload")
    body = { configured: true, available: true, jobs: [], toolVersion: "0.5.1" };
  else throw Error("Unexpected fixture route " + u.pathname);
  await route.fulfill({ json: body });
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const completed = () => page.getByRole("button", { name: "重新检测", exact: true }).waitFor();
try {
  await page.goto("http://127.0.0.1:4665");
  await page.getByRole("button", { name: "开始检测", exact: true }).waitFor();
  await wait(2300);
  assert.equal(submissions.length, 0, "mount does not submit");
  await page.locator("#refresh-data").click();
  await wait(2100);
  assert.equal(submissions.length, 0, "data refresh does not submit");
  assert.equal(await page.getByText("尚未检测，点击开始检测", { exact: true }).count(), 4);
  await page.locator("#leave").click();
  await page.locator("#enter").click();
  await wait(500);
  await page.locator("#leave").click();
  await wait(1700);
  assert.equal(submissions.length, 0, "brief visit cancels auto detection");
  const entry = Date.now();
  await page.locator("#enter").click();
  await wait(1300);
  assert.equal(submissions.length, 0, "entry does not submit before two seconds");
  await completed();
  assert.equal(submissions.length, 1);
  assert.ok(submissions[0].at - entry >= 1950);
  await page.locator("#refresh-data").click();
  await wait(2300);
  assert.equal(submissions.length, 1, "completed result and data refresh do not retrigger");
  await page.locator("#leave").click();
  await page.locator("#enter").click();
  await page.getByRole("button", { name: "重新检测", exact: true }).click();
  await completed();
  await wait(400);
  assert.equal(submissions.length, 2, "manual action cancels pending entry timer");
  hold = true;
  await page.getByRole("button", { name: "重新检测", exact: true }).evaluate((b) => {
    b.click();
    b.click();
  });
  await page.getByRole("button", { name: "正在检测四组…", exact: true }).waitFor();
  await page.locator("#refresh-data").click();
  await page.locator("#leave").click();
  await page.locator("#enter").click();
  await wait(2400);
  assert.equal(submissions.length, 3, "double click, refresh, and re-entry share the active batch");
  hold = false;
  await completed();
  assert.equal(submissions.length, 3);
  await page.screenshot({ path: path.join(root, "page.png"), fullPage: true });
  assert.deepEqual(errors, []);
  assert.equal(unsafe, 0);
  const result = {
    at: new Date().toISOString(),
    fixtureOnly: true,
    mountAndDataRefreshSubmitZero: true,
    shortVisitCancelled: true,
    navigationDelayMs: submissions[0].at - entry,
    manualCancelsPendingTimer: true,
    busyRequestsCoalesced: true,
    submissions,
    gets,
    unsafe,
    errors,
  };
  await fs.writeFile(path.join(root, "verification.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await server.close();
}
