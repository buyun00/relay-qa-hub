export const IOS_INSTALL_JOB = "【OZDQP】【测试机安装】";
export const IOS_DEFAULT_DEVICE = "iPhone 15";
export const IOS_INSTALL_ERRORS = {
  IOS_ADHOC_PROFILE_UNAVAILABLE: "Mac 缺少匹配且包含所选测试机的 Ad Hoc 描述文件或签名证书。",
  IOS_ADHOC_ENTITLEMENTS_MISMATCH: "Ad Hoc 描述文件未包含原应用所需能力，请更新描述文件后重试。",
  IOS_ADHOC_SIGNING_FAILED: "生成 Ad Hoc 测试副本失败，请检查 Mac 的签名证书和钥匙串访问权限。",
  IOS_ADHOC_NESTED_APP_UNSUPPORTED: "此 IPA 包含应用扩展，需要为扩展配置独立的 Ad Hoc 签名后安装。",
  IOS_DEVICE_OFFLINE: "测试机离线，请将手机与 Mac 打包机连接到同一局域网，解锁手机后刷新。",
  IOS_DEVICE_NOT_FOUND: "未找到所选测试机，请先在 Mac 上通过 USB 配对并启用无线连接，再刷新。",
  IOS_DEVICE_AMBIGUOUS: "有多台同型号测试机，请明确选择要安装的设备。",
  IOS_DEVELOPER_MODE_REQUIRED: "请在测试机上开启开发者模式，再重试安装。",
  IOS_DEVICE_LOCKED: "请解锁测试机、保持屏幕开启，然后重试。",
  IOS_SIGNING_NOT_SUPPORTED:
    "此 IPA 的签名不支持直接安装到测试机，请使用包含该测试机的开发或 Ad Hoc 签名重新打包。",
  IOS_DEVICE_NOT_PROVISIONED: "此 IPA 的签名未包含所选测试机，请将该设备加入描述文件后重新打包。",
  IOS_PROFILE_EXPIRED: "IPA 的签名描述文件已过期，请重新签名打包。",
  IOS_IPA_CHANGED: "IPA 与构建清单的大小或哈希不一致，已停止安装。",
  IOS_IPA_INVALID: "IPA 内容不完整，无法读取有效的应用或签名。",
  IOS_INSTALL_FAILED: "安装失败，请检查手机连接和签名后重试。",
  IOS_INSTALL_UNCONFIRMED: "安装结果尚未确认，请先检查手机，避免重复安装。",
  IOS_INSTALL_TIMEOUT: "安装等待超时，结果尚未确认，请先检查手机。",
  IOS_INSTALL_JOB_UNAVAILABLE: "测试机安装服务暂时不可用，请稍后刷新。",
  IOS_INSTALL_STATE_UNAVAILABLE: "安装记录暂时无法读取，请稍后重试。",
  IOS_INSTALL_BUSY: "这台测试机已有安装任务，请等待当前任务结束。",
  IOS_INSTALL_REQUEST_CONFLICT: "这个安装请求已关联其他 IPA 或测试机，请刷新后重新操作。",
  IOS_INSTALL_RESULT_MISMATCH: "安装回执与所选包或设备不一致，请检查手机后再操作。",
  IOS_INSTALL_CANCELLED: "安装任务已在打包机取消。",
  JENKINS_SUBMISSION_UNKNOWN: "尚未确认安装请求是否已提交，正在查询原任务，请勿重复点击。",
};
export function iosInstallError(code) {
  return IOS_INSTALL_ERRORS[code] ?? "测试机安装服务暂时不可用，请稍后刷新。";
}
export function iosInstallFinished(state) {
  return ["complete", "failed", "unconfirmed"].includes(state);
}
export function defaultIosDevice(devices) {
  const matches = devices.filter((device) => device.model === IOS_DEFAULT_DEVICE);
  return matches.length === 1 ? matches[0].id : "";
}
