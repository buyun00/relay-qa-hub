import assert from "node:assert/strict";
import test from "node:test";
import { isPackageDownloadUrl } from "../src/package-downloads.js";

test("desktop opens only package downloads from the fixed build server", () => {
  for (const url of [
    "http://10.100.5.129:8000/apk/app.apk",
    "http://10.100.5.129:8000/ipa/app.ipa",
    "http://10.100.5.129:8000/ipa/",
    "http://10.100.5.129:8000/ozdqp/Android/Release/2.4.38/47/packages/app.aab",
    "http://10.100.5.129:8000/ozdqp/Android/Debug/2.1.171/10175/packages/app.apk",
    "http://10.100.5.129:8000/ozdqp/iOS/Release/2.4.37/46/packages/app.ipa",
    "http://10.100.5.129:8000/ozdqp/iOS/Debug/2.1.171/47/hot-update/resources.zip",
    "http://10.100.5.129:8000/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip",
  ])
    assert.equal(isPackageDownloadUrl(url), true);
  for (const url of [
    "file:///C:/Windows/test.apk",
    "http://evil.test/apk/app.apk",
    "http://10.100.5.129:8080/apk/app.apk",
    "http://admin:admin@10.100.5.129:8000/apk/app.apk",
    "http://10.100.5.129:8000/apk/a.exe",
    "http://10.100.5.129:8000/apk/a.apk?redirect=evil",
    "http://10.100.5.129:8000/apk/a%2fb.apk",
    "http://10.100.5.129:8000/else/app.apk",
    "http://10.100.5.129:8000/ozdqp/iOS/Release/2.4.37/46/packages/app.exe",
    "http://10.100.5.129:8000/ozdqp/iOS/Release/2.4.37/46/hot-update/../packages/app.ipa",
    "http://10.100.5.129:8000/ozdqp/iOS/Release/2.4.37/46/hot-update/%2e%2e/packages/app.ipa",
    "http://10.100.5.129:8000/ozdqp/iOS/Release/2.4.37/46/hot-update/a.zip?redirect=evil",
  ])
    assert.equal(isPackageDownloadUrl(url), false, url);
});
