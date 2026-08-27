# Windows EXE cross-PC LAN portability fix

> The initial endpoint-portability package documented below was superseded on
> 2026-08-27 by the browser-session continuity package. Current artifact:
> `150,404,868` bytes, SHA-256 `896E09F61622305580765354A9FD276F129D722832CA127F805FA0A6A4FD0478`.
> See [`EXE-NATIVE-SESSION-FIX-2026-08-27.md`](EXE-NATIVE-SESSION-FIX-2026-08-27.md).

Verified on 2026-08-27 (Asia/Shanghai) against the live QA Hub services at
`10.100.5.157:4174/4319`. Unity and Jenkins were not invoked.

## Reported failure and root cause

On another Windows computer, the packaged App showed `QA Hub 暂时无法连接`
and `服务没有返回可验证的登录状态`.

The API and Web services were healthy. The fresh client had no
`%LOCALAPPDATA%\Relay QA Hub\desktop-runtime.json`, so the old package fell back
to `127.0.0.1:4319`. On a second computer that address means the second
computer itself. The initial `/api/v1/auth/me` proxy request therefore became a
bounded `503 NETWORK_ERROR`, which the old login gate rendered as the generic
failure page.

The previous runtime configuration script was not a cross-PC workaround: it
required the server-only `D:\Relay-QA-Hub-Data\mvp-e2e-current.json` and rejected
non-loopback HTTP.

## Portable and bounded fix

- The package now includes a non-secret `desktop-runtime.json` beside the EXE.
  Its default API, WSS, and CSRF endpoints use `10.100.5.157`.
- Fresh profiles use the adjacent portable config only when no explicit
  environment or per-user config exists. A per-user config remains the normal
  override when the host address changes.
- Cleartext LAN transport requires a separate `allowPrivateLanHttp` opt-in and
  accepts only literal RFC1918 IPv4. Public IPs, DNS hostnames, link-local IPs,
  URL credentials, queries, and fragments remain rejected.
- `Configure-QAHubPortableClient.ps1` is shipped beside the EXE. It writes only
  endpoint settings to the current user's LocalAppData and never reads or
  copies the server runtime credential.
- The failure page now shows the exact API endpoint selected by the EXE.
- The Windows ZIP is available from a fixed LAN download route.

The package intentionally contains no bearer token. Pinyin login and the full
Web management workflow use the user's `HttpOnly` browser session and work
without a main-process token. A fresh remote package therefore reports desktop
background notifications as `disabled`; the visible workbench still refreshes
every five seconds and on focus. Cross-PC native toast delivery requires a
future short-lived, notification-scoped enrollment flow and must not be solved
by embedding the current debug bearer.

## Verification

Targeted checks:

```text
Desktop tests:               21/21
Desktop/Web TypeScript:      pass
Web Vitest:                  6/6
Targeted ESLint:             pass, zero warnings
Desktop and Web builds:      pass
Private LAN script smoke:    10.100.5.157 accepted
Public address negative:     8.8.8.8 rejected
Packaged credential scan:    78 files, zero current-runtime-token matches
ZIP secret-named entries:    0
```

A real packaged process was then launched with fresh LocalAppData, fresh
Chromium data, no endpoint environment override, and no token. The adjacent
sidecar was therefore the only possible service configuration:

```text
freshProfile:                  true
portableSidecarAutoLoaded:     true
loginVisibleBeforeLogin:       true
apiUnavailableBeforeLogin:     false
notificationsCredentialState:  disabled
pinyinLoginSucceeded:          true
rendererUrl:                   qa-hub://app/index.html
```

The same final ZIP was downloaded through its LAN route without a local file
shortcut. The complete response matched the release artifact byte-for-byte:

```text
URL:          http://10.100.5.157:4174/downloads/Relay-QA-Hub-Windows-x64.zip
HTTP:         200 application/zip
Bytes:        155,023,058
SHA-256:      0C6782C770ECA33E413CBE0F7CAEB25E39315247AC453D5FC3E1631D392DD625

EXE bytes:    235,534,336
EXE SHA-256:  A603A6026D0D1C01298DD390019519154137E073D7D11C945D7C50B3CF199C93
ZIP entries:  78
```

Final host readback:

```text
Web / ZIP route:        200
API /auth/me unsigned:  401 (expected login state)
Listeners:              0.0.0.0:4174, 0.0.0.0:4319
Firewall remote scope:  10.100.0.0/21
Final EXE main PID:      23844
Package processes:      4
Established API conns:  3
```

## Second-computer run

1. Download and extract the complete ZIP; do not copy only `RelayQaHub.exe`.
2. Run `RelayQaHub.exe` and log in with the person's full pinyin.
3. If the server address changes or an old per-user loopback config exists, run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Configure-QAHubPortableClient.ps1 -ServerAddress 10.100.5.157
   ```

The client computer must currently be in the intentionally allowed
`10.100.0.0/21` network. A computer on another routed subnet remains blocked by
the host firewall until that exact subnet is reviewed and added; the rule is
not widened silently because login intentionally has no password.

The post-fix package has not yet been observed on the reporting second
computer. That one physical retest remains the final confirmation for this
specific machine/network path.
