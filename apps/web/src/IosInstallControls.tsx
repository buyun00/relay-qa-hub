import { IOS_DEFAULT_DEVICE, iosInstallError } from "@relay-qa-hub/upload-contract";
import { iosJobLabel, type IosInstaller } from "./useIosInstall";

export default function IosInstallControls({ installer }: { installer: IosInstaller }) {
  const { snapshot, device, deviceId, choose, pending, scanning, error } = installer;
  return (
    <section className="ios-install-panel" aria-labelledby="ios-install-title">
      <div className="package-section-heading">
        <div>
          <h3 id="ios-install-title">Wi-Fi 快速安装到测试机</h3>
          <p>默认 {IOS_DEFAULT_DEVICE}，选择下方 IPA 旁的“快速安装”即可。</p>
        </div>
        <button type="button" onClick={installer.refresh} disabled={pending || scanning}>
          {scanning ? "正在刷新测试机…" : "刷新测试机"}
        </button>
      </div>
      <label className="ios-device-selection">
        安装到
        <select
          aria-label="iPhone 测试机"
          value={deviceId}
          onChange={(e) => choose(e.target.value)}
          disabled={pending}
        >
          <option value="">{snapshot.devices.length ? "请选择测试机" : "等待读取测试机"}</option>
          {deviceId && !device ? <option value={deviceId}>上次选择的测试机暂不可用</option> : null}
          {snapshot.devices.map((d) => (
            <option value={d.id} key={d.id}>
              {d.model} · {d.name} · {d.online ? "可连接" : "离线"}
            </option>
          ))}
        </select>
        {device ? (
          <span className={device.online ? "ios-device-online" : "ios-device-offline"}>
            {device.model} · iOS {device.osVersion} · {device.online ? "可连接" : "离线"}
          </span>
        ) : null}
      </label>
      <p className="package-hint">
        手机与 Mac 打包机连接同一局域网，并保持解锁。首次使用需通过 USB 在 Mac
        上配对并启用无线连接，此后可拔线安装。
      </p>
      <p className="package-hint">
        Debug 直接安装；Release 商店包会自动生成 Ad Hoc 测试副本后安装，保留原商店包与版本号。
      </p>
      {device && !device.online ? (
        <p className="ios-install-warning">{iosInstallError("IOS_DEVICE_OFFLINE")}</p>
      ) : null}
      {device && !device.developerMode ? (
        <p className="ios-install-warning">{iosInstallError("IOS_DEVELOPER_MODE_REQUIRED")}</p>
      ) : null}
      {snapshot.scan?.errorCode ? <p role="status">{iosJobLabel(snapshot.scan)}</p> : null}
      {error ? (
        <p className="banner error-banner" role="alert">
          {error}
        </p>
      ) : null}
      {snapshot.installs.length ? (
        <div className="ios-install-history" aria-label="最近 IPA 安装记录">
          {snapshot.installs.slice(0, 5).map((j) => (
            <div key={j.id} role="status" className={`ios-install-record is-${j.state}`}>
              <strong>
                {j.selection?.configuration} {j.selection?.version} · 构建 #
                {j.selection?.buildNumber}
              </strong>
              <span>
                →{" "}
                {snapshot.devices.find((d) => d.id === j.selection?.deviceId)?.model ??
                  "指定测试机"}
              </span>
              <span>
                {iosJobLabel(j)}
                {j.report?.signingMode === "adhoc" ? " · Ad Hoc 测试副本" : ""}
                {j.buildNumber ? ` · 安装任务 #${j.buildNumber}` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
