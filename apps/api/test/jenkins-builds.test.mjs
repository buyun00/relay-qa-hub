import assert from "node:assert/strict";
import test from "node:test";
import { JenkinsBuildService, packageFiles } from "../dist/jenkins-builds.js";
import { createApiApp } from "../dist/app.js";
import { jenkinsConfig } from "./component-test-config.mjs";

const jobPath = `/job/${encodeURIComponent("01-【OZDQP】【Android】")}/`;
const definitions = [
  { name: "networkScope", choices: ["内网_自动判断", "外网_保留原参数"] },
  { name: "internalUseSdk", choices: ["不接入SDK", "接入SDK"] },
  { name: "buildMode", choices: ["Auto_自动判断", "App_资源和包体"] },
];
const job = {
  buildable: true,
  property: [{ parameterDefinitions: definitions }],
  builds: [
    {
      number: 10139,
      timestamp: 1788507462526,
      building: false,
      result: "SUCCESS",
      actions: [
        {
          parameters: Object.entries(jenkinsConfig.presets.external).map(([name, value]) => ({
            name,
            value,
          })),
        },
      ],
    },
  ],
};
const apk = {
  name: "baloot_2.1.136_1_extra_sdk.apk",
  type: "file",
  size: 226410758,
  mtime: 1788508278676,
};
const json = (body, options = {}) => new Response(JSON.stringify(body), options);

function fixture({ post, overrideJob, failJenkins = false } = {}) {
  const posts = [];
  let crumbs = 0;
  let reads = 0;
  const service = new JenkinsBuildService(async (value, init = {}) => {
    const url = new URL(value);
    const headers = new Headers(init.headers);
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal);
    if (url.port === "8000") {
      assert.equal(
        headers.has("authorization"),
        false,
        "never send Jenkins credentials to downloads",
      );
      assert.equal(headers.has("cookie"), false);
      if (url.pathname === "/apk/") return json({ files: [apk] });
      if (url.pathname === "/ipa/") return json({ files: [{ ...apk, name: "ios.ipa" }] });
      if (url.pathname === "/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip") {
        assert.equal(init.method, "HEAD");
        return new Response(null, {
          headers: {
            "content-length": "741036214",
            "last-modified": "Fri, 04 Sep 2026 07:51:44 GMT",
          },
        });
      }
    }
    assert.ok(headers.get("authorization")?.startsWith("Basic "));
    if (failJenkins) throw new Error("offline");
    if (url.pathname === `${jobPath}api/json`) {
      reads++;
      return json(overrideJob ?? job);
    }
    if (url.pathname === "/queue/api/json")
      return json({
        items: [
          { id: 10, why: "等待执行器", task: { url: `http://10.100.5.129:8080${jobPath}` } },
          { id: 11, why: "other job", task: { url: "http://10.100.5.129:8080/job/unrelated/" } },
        ],
      });
    if (url.pathname === "/crumbIssuer/api/json") {
      crumbs++;
      return json(
        { crumbRequestField: "Jenkins-Crumb", crumb: `crumb-${crumbs}` },
        { headers: { "set-cookie": `JSESSIONID=session-${crumbs}; Path=/; HttpOnly` } },
      );
    }
    if (url.pathname === `${jobPath}buildWithParameters`) {
      assert.equal(init.method, "POST");
      assert.equal(headers.get("jenkins-crumb"), `crumb-${crumbs}`);
      assert.equal(headers.get("cookie"), `JSESSIONID=session-${crumbs}`);
      posts.push(Object.fromEntries(new URLSearchParams(init.body)));
      return post
        ? post(posts.length)
        : new Response(null, {
            status: 201,
            headers: { location: "http://10.100.5.129:8080/queue/item/17/" },
          });
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  }, jenkinsConfig);
  return { service, posts, crumbs: () => crumbs, reads: () => reads };
}

test("the three presets match Jenkins UI and leave all unrelated defaults unset", async () => {
  const { service, posts } = fixture();
  for (const preset of ["internal-nosdk", "internal-sdk", "external"]) {
    assert.deepEqual(await service.trigger(preset, preset), { preset, queueId: 17 });
  }
  assert.deepEqual(posts, [
    { networkScope: "内网_自动判断", internalUseSdk: "不接入SDK", buildMode: "Auto_自动判断" },
    { networkScope: "内网_自动判断", internalUseSdk: "接入SDK", buildMode: "Auto_自动判断" },
    { networkScope: "外网_保留原参数", internalUseSdk: "不接入SDK", buildMode: "App_资源和包体" },
  ]);
  for (const parameters of posts) {
    assert.equal("BuildParam" in parameters, false);
    assert.equal("version" in parameters, false);
  }
});

test("expired crumb/session reauthenticates once, then submits with the new cookie", async () => {
  const f = fixture({
    post: (count) =>
      count === 1
        ? new Response(null, { status: 403 })
        : new Response(null, { status: 201, headers: { location: "/queue/item/18/" } }),
  });
  assert.equal((await f.service.trigger("internal-sdk", "retry")).queueId, 18);
  assert.equal(f.crumbs(), 2);
  assert.equal(f.posts.length, 2);
});

test("concurrent duplicate submissions reuse the receipt; conflicting reuse is rejected", async () => {
  const f = fixture();
  const receipts = await Promise.all([
    f.service.trigger("external", "same"),
    f.service.trigger("external", "same"),
  ]);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(f.posts.length, 1);
  await assert.rejects(f.service.trigger("internal-sdk", "same"), { code: "IDEMPOTENCY_CONFLICT" });
});

for (const outcome of ["timeout", "server-error", "redirect-login"]) {
  test(`ambiguous ${outcome} never automatically repeats a possibly accepted build`, async () => {
    const f = fixture({
      post: () => {
        if (outcome === "timeout") throw new Error("network interrupted after send");
        return new Response(null, {
          status: outcome === "server-error" ? 500 : 302,
          headers: { location: "/login" },
        });
      },
    });
    await assert.rejects(f.service.trigger("external", "unknown"), {
      code: "JENKINS_SUBMISSION_UNKNOWN",
    });
    await assert.rejects(f.service.trigger("external", "unknown"), {
      code: "JENKINS_SUBMISSION_UNKNOWN",
    });
    assert.equal(f.posts.length, 1);
  });
}

test("disabled or changed jobs cannot silently launch the wrong build", async () => {
  for (const [overrideJob, code] of [
    [{ ...job, buildable: false }, "JENKINS_JOB_DISABLED"],
    [{ ...job, property: [] }, "JENKINS_PARAMETERS_CHANGED"],
  ]) {
    const f = fixture({ overrideJob });
    await assert.rejects(f.service.trigger("external", "changed"), { code });
    assert.equal(f.posts.length, 0);
  }
});

test("status uses actual directories, scopes queue to this job and coalesces polling", async () => {
  const f = fixture();
  const [status, same] = await Promise.all([f.service.status(), f.service.status()]);
  assert.equal(status, same);
  assert.equal(f.reads(), 1);
  assert.equal(status.jenkins.builds[0].preset, "external");
  assert.deepEqual(
    status.jenkins.queue.map((q) => q.id),
    [10],
  );
  assert.equal(status.apks[0].url, `http://10.100.5.129:8000/apk/${apk.name}`);
  assert.equal(status.ipas[0].url, "http://10.100.5.129:8000/ipa/ios.ipa");
  assert.equal(status.zip.url, "http://10.100.5.129:8000/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip");
  assert.equal(JSON.stringify(status).includes("Basic "), false);
});

test("Jenkins outage does not hide available APK/IPA/ZIP files", async () => {
  const f = fixture({ failJenkins: true });
  const status = await f.service.status();
  assert.equal(status.jenkins, null);
  assert.equal(status.apks.length, 1);
  assert.equal(status.ipas.length, 1);
  assert.ok(status.zip);
});

test("download list rejects directories, traversal and empty files; classifies names independently", () => {
  const files = packageFiles(
    [
      apk,
      { ...apk, name: "internal_intra_sdk.apk", mtime: apk.mtime + 1 },
      { ...apk, name: "internal_intra_nosdk.apk", mtime: apk.mtime + 2 },
      { ...apk, name: "a.apk", type: "dir" },
      { ...apk, name: "../else.apk" },
      { ...apk, name: "a\\b.apk" },
      { ...apk, name: "empty.apk", size: 0 },
      { ...apk, name: "cleanup.log" },
    ],
    "apk",
  );
  assert.deepEqual(
    files.map((f) => f.preset),
    ["internal-nosdk", "internal-sdk", "external"],
  );
});

test("routes require QA Hub authentication, validate preset and reject additional settings", async (t) => {
  const f = fixture();
  const app = createApiApp({
    logger: false,
    debugBearerToken: "fixture-token",
    jenkinsBuildService: f.service,
  });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: "/api/v1/packaging" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/v1/packaging/progress" })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/packaging/builds",
        payload: { preset: "external" },
      })
    ).statusCode,
    401,
  );
  const headers = {
    authorization: "Bearer fixture-token",
    "idempotency-key": "test-request-key-12345",
  };
  for (const query of ["queues=0", "queues=1%2F2", "builds=-1", "queues=1,2,3,4,5,6,7,8,9,10,11"]) {
    assert.equal(
      (await app.inject({ url: `/api/v1/packaging/progress?${query}`, headers })).statusCode,
      400,
    );
  }
  for (const payload of [
    { preset: "wrong" },
    { preset: "external", version: "99" },
    { preset: "external", url: "http://other/" },
  ]) {
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/v1/packaging/builds", headers, payload }))
        .statusCode,
      400,
    );
  }
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/packaging/builds",
    headers,
    payload: { preset: "external" },
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { preset: "external", queueId: 17 });
  assert.equal(f.posts.length, 1);
});
