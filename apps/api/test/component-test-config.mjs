import { buildParameters } from "../dist/jenkins-builds.js";
export const jenkinsConfig = {
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  version: 1,
  origin: "http://10.100.5.129:8080",
  downloadOrigin: "http://10.100.5.129:8000",
  jobPath: `/job/${encodeURIComponent("01-【OZDQP】【Android】")}/`,
  authorization: "Basic Zml4dHVyZTpub3QtYS1yZWFsLXRva2Vu",
  zipPath: "/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip",
  apkPath: "/apk/",
  ipaPath: "/ipa/",
  presets: Object.fromEntries(
    ["internal-nosdk", "internal-sdk", "external"].map((preset) => [
      preset,
      buildParameters(preset),
    ]),
  ),
};
