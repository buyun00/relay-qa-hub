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
  presets: {
    "internal-nosdk": {
      networkScope: "内网_自动判断",
      internalUseSdk: "不接入SDK",
      buildMode: "Auto_自动判断",
    },
    "internal-sdk": {
      networkScope: "内网_自动判断",
      internalUseSdk: "接入SDK",
      buildMode: "Auto_自动判断",
    },
    external: {
      networkScope: "外网_保留原参数",
      internalUseSdk: "不接入SDK",
      buildMode: "App_资源和包体",
    },
  },
};
