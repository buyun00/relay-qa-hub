import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import test from "node:test";

import { createApiApp } from "../dist/index.js";
import { parseAndroidUpdateChannel } from "../dist/android-updates.js";

const apkName = "Relay-QA-Hub-Android-23-0.2.0-preview.9.apk";
// Transport fixture bytes, deliberately not represented as an installable/signed APK.
const apkBytes = Buffer.from("isolated-preview-download\u0000\u0001\u0002", "utf8");
const sha256 = createHash("sha256").update(apkBytes).digest("hex");
const previewManifest = {
  schemaVersion: 1,
  channel: "preview",
  versionCode: 23,
  versionName: "0.2.0-preview.9",
  packageName: "com.relayqahub.android.preview.debug",
  fileName: apkName,
  size: apkBytes.length,
  sha256,
};

async function fixture(t, channel) {
  const directory = await mkdtemp(join(tmpdir(), "qa-android-channel-"));
  const root = join(directory, "feed");
  await mkdir(root);
  await writeFile(join(root, apkName), apkBytes);
  await writeFile(join(directory, "outside.apk"), "outside-private-fixture");
  await writeFile(join(root, "unpublished.apk"), "unpublished-private-fixture");
  const app = createApiApp({
    logger: false,
    isolateLegacyComponents: true,
    androidUpdateRoot: root,
    ...(channel === undefined ? {} : { androidUpdateChannel: channel }),
  });
  t.after(async () => {
    await app.close();
    const suffix = relative(tmpdir(), directory);
    assert(!isAbsolute(suffix) && !suffix.startsWith(".."));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  assert.equal(new URL(origin).hostname, "127.0.0.1");
  assert(![4174, 4274, 4319, 4320, 4419, 4420, 4421].includes(Number(new URL(origin).port)));
  return {
    origin,
    write: (value) =>
      writeFile(
        join(root, "latest.json"),
        typeof value === "string" ? value : JSON.stringify(value),
      ),
    get: (path, options) => fetch(origin + path, options),
  };
}

test("Android channel parsing keeps stable default and rejects arbitrary channels", () => {
  assert.equal(parseAndroidUpdateChannel(undefined), "stable");
  assert.equal(parseAndroidUpdateChannel("stable"), "stable");
  assert.equal(parseAndroidUpdateChannel("preview"), "preview");
  for (const value of ["", " stable", "PREVIEW", "beta", "../preview", "preview/stable", null]) {
    assert.throws(() => parseAndroidUpdateChannel(value), /must be stable or preview/);
  }
  assert.throws(
    () =>
      createApiApp({ logger: false, isolateLegacyComponents: true, androidUpdateChannel: "beta" }),
    /must be stable or preview/,
  );
});

test("real HTTP stable default accepts legacy schema1 without channel and exposes no preview alias", async (t) => {
  const f = await fixture(t);
  const legacy = { ...previewManifest };
  delete legacy.channel;
  legacy.packageName = "com.relayqahub.android.debug";
  await f.write(legacy);
  const response = await f.get("/api/v1/android-updates/stable/latest.json");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), legacy);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await f.get("/api/v1/android-updates/preview/latest.json")).status, 404);
});

test("real HTTP explicit preview serves exact metadata/APK bytes, HEAD, ranges and conditional reads", async (t) => {
  const f = await fixture(t, "preview");
  await f.write(previewManifest);
  const base = "/api/v1/android-updates/preview/";
  const metadata = await f.get(base + "latest.json");
  assert.equal(metadata.status, 200);
  assert.equal(metadata.headers.get("cache-control"), "no-store");
  assert.deepEqual(await metadata.json(), previewManifest);
  const head = await f.get(base + "latest.json", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(
    Number(head.headers.get("content-length")),
    Buffer.byteLength(JSON.stringify(previewManifest)),
  );
  const conditional = await f.get(base + "latest.json", {
    headers: { "if-none-match": metadata.headers.get("etag") },
  });
  assert.equal(conditional.status, 304);
  const apk = await f.get(base + apkName);
  assert.equal(apk.status, 200);
  assert.equal(apk.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.equal(apk.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const bytes = Buffer.from(await apk.arrayBuffer());
  assert.deepEqual(bytes, apkBytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), previewManifest.sha256);
  const apkHead = await f.get(base + apkName, { method: "HEAD" });
  assert.equal(apkHead.status, 200);
  assert.equal(Number(apkHead.headers.get("content-length")), apkBytes.length);
  const partial = await f.get(base + apkName, { headers: { range: "bytes=4-8" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 4-8/${apkBytes.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), apkBytes.subarray(4, 9));
  const invalidRange = await f.get(base + apkName, { headers: { range: "bytes=999-1000" } });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get("content-range"), `bytes */${apkBytes.length}`);
  for (const channel of ["stable", "beta"]) {
    assert.equal((await f.get(`/api/v1/android-updates/${channel}/latest.json`)).status, 404);
    assert.equal((await f.get(`/api/v1/android-updates/${channel}/${apkName}`)).status, 404);
  }
});

test("real HTTP preview refuses wrong channel/package or malformed manifest without changing stable compatibility", async (t) => {
  const f = await fixture(t, "preview");
  const invalid = [
    { ...previewManifest, channel: undefined },
    { ...previewManifest, channel: "stable" },
    { ...previewManifest, packageName: "com.relayqahub.android.debug" },
    { ...previewManifest, packageName: "com.relayqahub.android.preview" },
    { ...previewManifest, schemaVersion: 2 },
    { ...previewManifest, versionCode: 22 },
    { ...previewManifest, fileName: "../outside.apk" },
    { ...previewManifest, sha256: "invalid" },
    { ...previewManifest, size: 0 },
    { ...previewManifest, size: 512 * 1024 * 1024 + 1 },
    "{broken",
    "null",
    "[]",
  ];
  for (const manifest of invalid) {
    await f.write(manifest);
    const response = await f.get("/api/v1/android-updates/preview/latest.json");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "ANDROID_UPDATE_METADATA_INVALID" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("real HTTP preview rejects traversal/unpublished filenames and reports missing feed without fallback", async (t) => {
  const f = await fixture(t, "preview");
  const absent = await f.get("/api/v1/android-updates/preview/latest.json");
  assert.equal(absent.status, 404);
  assert.deepEqual(await absent.json(), { code: "ANDROID_UPDATE_NOT_FOUND" });
  for (const fileName of [
    "unpublished.apk",
    "%2e%2e%2foutside.apk",
    "%2e%2e%5coutside.apk",
    "C%3A%5coutside.apk",
    "latest.json%00",
    "package-instance.json",
  ]) {
    const response = await f.get("/api/v1/android-updates/preview/" + fileName);
    assert.equal(response.status, 404);
    const text = await response.text();
    assert(
      !text.includes("outside-private-fixture") && !text.includes("unpublished-private-fixture"),
    );
  }
});
