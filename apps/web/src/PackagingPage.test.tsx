import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PackagingPage, { PackageDownloads } from "./PackagingPage";
import { type PackagingStatus } from "./packaging-api";

describe("packaging page", () => {
  it("has precisely three build buttons and no editable Jenkins settings", () => {
    const markup = renderToStaticMarkup(<PackagingPage active={false} refreshRevision={0} />);
    expect(markup.match(/<button /gu)).toHaveLength(3);
    expect(markup).toContain("打不带 SDK 的内网包");
    expect(markup).toContain("打带 SDK 的内网包");
    expect(markup).toContain("打外网包");
    expect(markup).not.toMatch(/<(input|select|textarea)\b/u);
  });

  it("QR codes and quick downloads use actual APK files; IPA and ZIP keep distinct paths", () => {
    const status: PackagingStatus = {
      checkedAt: "2026-09-04T08:00:00Z",
      jenkins: null,
      jenkinsError: null,
      apkError: null,
      ipaError: null,
      zipError: null,
      apks: ["internal-nosdk", "internal-sdk", "external"].map((preset) => ({
        name: `${preset}.apk`,
        size: 222333444,
        modifiedAt: "2026-09-04T07:00:00Z",
        url: `http://10.100.5.129:8000/apk/${preset}.apk`,
        kind: "apk",
        preset: preset as "external" | "internal-nosdk" | "internal-sdk",
      })),
      ipas: [
        {
          name: "app.ipa",
          size: 1000,
          modifiedAt: "2026-09-04T07:00:00Z",
          url: "http://10.100.5.129:8000/ipa/app.ipa",
          kind: "ipa",
          preset: null,
        },
      ],
      zip: {
        name: "_pkg_cfg_2001_1002.zip",
        url: "http://10.100.5.129:8000/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip",
        size: 741036214,
        modifiedAt: "2026-09-04T07:51:44Z",
      },
    };
    const markup = renderToStaticMarkup(<PackageDownloads status={status} />);
    expect(markup.match(/快速下载/gu)).toHaveLength(3);
    expect(markup.match(/最新 APK 下载二维码/gu)).toHaveLength(3);
    for (const item of [...status.apks, ...status.ipas])
      expect(markup).toContain(`href="${item.url}"`);
    expect(markup).toContain(`href="${status.zip?.url}"`);
    expect(markup).toContain("增量 ZIP 下载二维码");
    expect(markup).not.toContain("8080");
    expect(markup).not.toContain("admin");
  });
});
