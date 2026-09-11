import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PackagingPage, { PackageDownloads } from "./PackagingPage";
import { type PackagingStatus } from "./packaging-api";

describe("packaging page", () => {
  it("has precisely eight build purposes and no editable Jenkins settings", () => {
    const markup = renderToStaticMarkup(<PackagingPage active={true} refreshRevision={0} />);
    expect(markup.match(/data-build-preset=/gu)).toHaveLength(8);
    expect(markup).toContain("开始检测");
    expect(markup.match(/package-platform-group"/gu)).toHaveLength(2);
    expect(markup.match(/class="package-configuration-group"/gu)).toHaveLength(4);
    for (const label of ["Android Debug", "Android Release", "iOS Debug", "iOS Release"])
      expect(markup).toContain(label);
    expect(markup).toContain("APK、AAB、完整热更");
    expect(markup).not.toMatch(/<(input|select|textarea)\b/u);
  });

  it("download rows and QR links use only the selected build's versioned artifact paths", () => {
    const directory = "http://10.100.5.129:8000/ozdqp/Android/Release/2.4.37/46/";
    const apk = {
      name: "app.apk",
      url: directory + "packages/app.apk",
      size: 1234,
      sha256: "a".repeat(64),
      kind: "apk" as const,
    };
    const aab = {
      ...apk,
      name: "app.aab",
      url: directory + "packages/app.aab",
      kind: "aab" as const,
    };
    const zip = {
      ...apk,
      name: "hot.zip",
      url: directory + "hot-update/hot.zip",
      kind: "zip" as const,
    };
    const status: PackagingStatus = {
      checkedAt: "",
      jenkins: null,
      jenkinsError: null,
      apks: [],
      ipas: [],
      zip: null,
      apkError: null,
      ipaError: null,
      zipError: null,
      artifacts: [
        {
          platform: "Android",
          configuration: "Release",
          version: "2.4.37",
          buildNumber: 46,
          productId: "2002",
          channelId: "1002",
          directory,
          packages: [apk, aab],
          hotUpdate: zip,
          hotUpdateMode: "full",
        },
      ],
    };
    const markup = renderToStaticMarkup(<PackageDownloads status={status} />);
    for (const f of [apk, aab, zip]) expect(markup).toContain(`href="${f.url}"`);
    expect(markup).toContain("完整热更 ZIP");
    expect(markup).not.toContain("/pkg_zip/");
    expect(markup).not.toContain("8080");
  });
});
