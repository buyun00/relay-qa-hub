import assert from "node:assert/strict";
import test from "node:test";
import { latestIosUploadSource } from "../src/upload-source.js";

const origin = "http://10.100.5.129:8000/pkg_zip/ozdqp/ios/";
const mtime = Date.parse("2026-09-08T09:16:23Z") + 385;
const latest = { name: "ozdqp_ios_2.1.157_38_full.zip", type: "file", size: 12345, mtime };
test("iOS selects the newest ZIP by modification time and pins matching HEAD identity", async () => {
  const calls: string[] = [];
  const result = await latestIosUploadSource(async (url, options) => {
    assert.equal(options?.redirect, "error");
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.headers, undefined);
    calls.push(String(url));
    if (options?.method === "HEAD")
      return new Response(null, {
        headers: {
          "content-length": String(latest.size),
          "last-modified": new Date(mtime).toUTCString(),
        },
      });
    return Response.json({
      files: [
        { ...latest, name: "z_larger_version_999.zip", mtime: mtime - 1000 },
        latest,
        { ...latest, name: "directory.zip", type: "dir", mtime: mtime + 1000 },
        { ...latest, name: "latest.zip.sha256", mtime: mtime + 1000 },
        { ...latest, name: "../other.zip", mtime: mtime + 1000 },
        { ...latest, name: "http:evil.zip", mtime: mtime + 1000 },
        { ...latest, name: "empty.zip", size: 0, mtime: mtime + 1000 },
      ],
    });
  });
  assert.deepEqual(calls, [origin + "?json=true", origin + latest.name + "?download=true"]);
  assert.deepEqual(result, {
    downloadUrl: calls[1],
    sourceFileName: latest.name,
    expectedSource: { size: latest.size, lastModified: new Date(mtime).toUTCString() },
  });
});
test("empty, invalid and changing iOS sources stop before dispatch", async () => {
  for (const files of [[], [{ ...latest, name: "only.sha256" }]])
    await assert.rejects(
      latestIosUploadSource(async () => Response.json({ files })),
      /UPLOAD_SOURCE_NO_ZIP/,
    );
  await assert.rejects(
    latestIosUploadSource(async () => Response.json({ unexpected: [] })),
    /UPLOAD_SOURCE_UNAVAILABLE/,
  );
  await assert.rejects(
    latestIosUploadSource(async () => new Response("bad", { status: 503 })),
    /UPLOAD_SOURCE_UNAVAILABLE/,
  );
  await assert.rejects(
    latestIosUploadSource(
      async () => new Response("", { headers: { "content-length": "9000000" } }),
    ),
    /UPLOAD_SOURCE_UNAVAILABLE/,
  );
  for (const headers of [
    { "content-length": "12346", "last-modified": new Date(mtime).toUTCString() },
    { "content-length": "12345", "last-modified": new Date(mtime + 1000).toUTCString() },
    { "content-length": "12345", "last-modified": "invalid" },
  ])
    await assert.rejects(
      latestIosUploadSource(async (_url, options) =>
        options?.method === "HEAD"
          ? new Response(null, { headers })
          : Response.json({ files: [latest] }),
      ),
      /BUILD_ZIP_CHANGED/,
    );
});
