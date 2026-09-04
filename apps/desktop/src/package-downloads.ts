/** Only the fixed build server's package downloads may leave the desktop shell. */
export function isPackageDownloadUrl(value: string): boolean {
  try {
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
    return (
      path === "/ipa/" ||
      path === "/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip" ||
      /^\/apk\/[^/\\\u0000-\u001f]+\.apk$/u.test(path) ||
      /^\/ipa\/[^/\\\u0000-\u001f]+\.ipa$/u.test(path)
    );
  } catch {
    return false;
  }
}
