import AppIcon from "./AppIcon";
import type { CompatibilityCheck } from "./packaging-api";
export function compatibilityVerdict(check?: CompatibilityCheck, unavailable = false) {
  if (unavailable || check?.state === "error") return "检测未完成，请重试";
  if (!check || check.state === "pending" || check.state === "submitting") return "正在刷新判断…";
  if (check.errorCode) return "检测连接暂时中断，正在重试…";
  if (check.state === "queued") return "检测排队中…";
  if (check.state === "running") return "正在比较累计修改…";
  switch (check.report?.result) {
    case "PLAYER_REBUILD_REQUIRED":
      return "需要重新打完整包";
    case "HOT_UPDATE_ALLOWED":
      return "无需重打安装包，可只打热更";
    case "NO_BASELINE":
      return "暂无历史安装包，先打完整包";
    default:
      return "暂时无法判断，请核对检测报告";
  }
}
function versionLabel(reference: string | null) {
  const parts = reference?.split("/");
  return parts?.length === 4 ? `${parts[2]} · #${parts[3]}` : "未取得";
}
export default function BuildCompatibilitySummary({
  check,
  unavailable = false,
}: {
  check?: CompatibilityCheck | undefined;
  unavailable?: boolean;
}) {
  const report = !unavailable && check?.state === "complete" ? check.report : null;
  const result = report?.result ?? "UNKNOWN";
  const loading = !unavailable && (!check || !["complete", "error"].includes(check.state));
  return (
    <div className="package-compatibility" data-result={result}>
      <div className="package-compatibility-verdict" role="status">
        <AppIcon
          name={loading ? "loader" : result === "HOT_UPDATE_ALLOWED" ? "check" : "verification"}
          busy={loading}
          size={15}
        />
        <span>{compatibilityVerdict(check, unavailable)}</span>
      </div>
      {report && check?.checkedAt ? (
        <details className="package-compatibility-detail">
          <summary>
            检测依据 · {new Date(check.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })}
          </summary>
          <dl>
            <div>
              <dt>参考版本</dt>
              <dd>{versionLabel(report.selectedVersion)}</dd>
            </div>
            <div>
              <dt>对应安装包</dt>
              <dd>{versionLabel(report.playerVersion)}</dd>
            </div>
            <div>
              <dt>对比源码</dt>
              <dd>
                <code>
                  {report.baseRevision?.slice(0, 8) ?? "未取得"} →{" "}
                  {report.targetRevision?.slice(0, 8) ?? "未取得"}
                </code>
              </dd>
            </div>
            <div>
              <dt>累计修改</dt>
              <dd>
                {report.commitCount} 个提交 · {report.changeCount} 个文件
              </dd>
            </div>
          </dl>
          {report.result === "HOT_UPDATE_ALLOWED" ? (
            <p>包体兼容性允许热更；ZIP 能否生成纯增量，仍需已确认上传的资源基线。</p>
          ) : null}
          {check.reportUrl ? (
            <a href={check.reportUrl} target="_blank" rel="noreferrer">
              查看打包机完整检测报告 <AppIcon name="external" size={13} />
            </a>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
