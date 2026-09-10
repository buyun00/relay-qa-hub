import assert from "node:assert/strict";
import test from "node:test";
import { QUICK_BUILD_PRESETS, quickUploadInput } from "@relay-qa-hub/upload-contract";
import { validateBuildResult, artifactCatalog, pinBuildSource } from "../src/build-artifacts.js";
import { buildInfo, catalogFetch } from "./quick-build-fixture.mjs";
for (const preset of QUICK_BUILD_PRESETS)
  test(`exact artifact and RuiXue target for ${preset.id}`, async () => {
    const raw = buildInfo(preset),
      result = validateBuildResult(raw, preset, true);
    assert.equal(result.productId, preset.configuration === "Debug" ? "2001" : "2002");
    assert.equal(result.channelId, preset.platform === "Android" ? "1002" : "2004");
    assert.equal(result.version, "2.4.37");
    assert.equal(
      result.hotUpdate.url,
      `http://10.100.5.129:8000/ozdqp/${preset.platform}/${preset.configuration}/2.4.37/46/${raw.hotUpdate.file}`,
    );
    const source = await pinBuildSource(result, catalogFetch as typeof fetch);
    assert.equal(source.sha256, raw.hotUpdate.sha256);
    assert.equal(source.url, result.hotUpdate.url + "?download=true");
  });
test("wrong target, stale request, unsafe paths and incomplete artifact metadata fail closed", () => {
  const preset = QUICK_BUILD_PRESETS[2]!;
  const mutations = [
    (v: any) => {
      v.requestId = "another-job#45";
    },
    (v: any) => {
      v.productId = "2001";
    },
    (v: any) => {
      v.channelId = "2004";
    },
    (v: any) => {
      v.platform = "iOS";
    },
    (v: any) => {
      v.resourceConfiguration = "Debug";
    },
    (v: any) => {
      v.expectedRuiXueTarget.version = "2.4.38";
    },
    (v: any) => {
      v.status = "building";
    },
    (v: any) => {
      v.hotUpdate.file = "hot-update/../other.zip";
    },
    (v: any) => {
      v.hotUpdate.file = "https://elsewhere/a.zip";
    },
    (v: any) => {
      v.hotUpdate.sha256 = "";
    },
    (v: any) => {
      v.hotUpdate.size = 0;
    },
  ];
  for (const mutate of mutations) {
    const value = buildInfo(preset);
    mutate(value);
    assert.throws(() => validateBuildResult(value, preset, true), /BUILD_ARTIFACT_MISMATCH/);
  }
});
test("catalog understands collapsed version/build directories for all four configurations", async () => {
  const catalog = await artifactCatalog(catalogFetch as typeof fetch);
  assert.equal(catalog.length, 4);
  assert.deepEqual(
    new Set(catalog.map((c) => c.productId + "/" + c.channelId)),
    new Set(["2001/1002", "2002/1002", "2001/2004", "2002/2004"]),
  );
});
test("a mismatched HEAD never pins a different source", async () => {
  const result = validateBuildResult(buildInfo(), QUICK_BUILD_PRESETS[2]!);
  await assert.rejects(
    pinBuildSource(
      result,
      async () =>
        new Response(null, {
          headers: { "content-length": "1235", "last-modified": "Thu, 10 Sep 2026 09:49:00 GMT" },
        }),
    ),
    /BUILD_ZIP_CHANGED/,
  );
});
