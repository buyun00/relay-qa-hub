import { QUICK_JOB_NAME, COMPATIBILITY_JOB_NAME } from "@relay-qa-hub/upload-contract";
/** Only fixed package downloads and the exact archived comparison report may leave the shell. */
export function isCompatibilityReportUrl(value: string): boolean {
  try {
    const raw = decodeURIComponent(value),
      url = new URL(value);
    if (
      raw.includes("..") ||
      raw.includes("\\") ||
      url.origin !== "http://10.100.5.129:8080" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    const pathname = decodeURIComponent(url.pathname);
    return [QUICK_JOB_NAME, COMPATIBILITY_JOB_NAME].some((name) => {
      const prefix = "/job/" + name + "/";
      return (
        pathname.startsWith(prefix) &&
        /^[1-9][0-9]*\/artifact\/compatibility\.html$/u.test(pathname.slice(prefix.length))
      );
    });
  } catch {
    return false;
  }
}
export function isPackageDownloadUrl(value: string): boolean {
  try {
    const raw = decodeURIComponent(value);
    if (raw.includes("..") || raw.includes("\\")) return false;
    const url = new URL(value);
    if (
      url.origin !== "http://10.100.5.129:8000" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false;
    const path = decodeURIComponent(url.pathname);
    if (value.includes("..") || path.includes("..") || path.includes("\\")) return false;
    return (
      /^\/ozdqp\/(Android|iOS)\/(Debug|Release)\/\d+\.\d+\.\d+\/[1-9]\d*\/(packages\/[A-Za-z0-9][A-Za-z0-9._-]+\.(apk|aab|ipa)|hot-update\/[A-Za-z0-9][A-Za-z0-9._-]+\.zip)$/u.test(
        path,
      ) ||
      path === "/ipa/" ||
      path === "/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip" ||
      /^\/apk\/[^/\\\u0000-\u001f]+\.apk$/u.test(path) ||
      /^\/ipa\/[^/\\\u0000-\u001f]+\.ipa$/u.test(path)
    );
  } catch {
    return false;
  }
}
