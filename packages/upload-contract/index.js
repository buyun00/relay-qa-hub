export const DEFAULT_UPLOAD_PARAMETERS = Object.freeze({
  productId: "2002",
  channelId: "1002",
  belongName: "[2002]Baloot Go|[1002]谷歌-国际正式",
  testerId: 11562,
});

export const UPLOAD_TARGETS = Object.freeze({
  android: Object.freeze({
    label: "Android",
    channelId: "1002",
    channelName: "谷歌-国际正式",
    sourceUrl: "http://10.100.5.129:8000/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip?download=true",
  }),
  ios: Object.freeze({
    label: "iOS",
    channelId: "2004",
    channelName: "iOS",
    sourceUrl: "http://10.100.5.129:8000/pkg_zip/ozdqp/ios/",
  }),
});
