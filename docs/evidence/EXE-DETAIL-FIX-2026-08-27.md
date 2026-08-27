# Windows EXE Bug detail and attachment fix

Verified on 2026-08-27 (Asia/Shanghai) against the live QA Hub API, the
production Web bundle, and the packaged Windows application. Unity and Jenkins
were not invoked, and the API process was not restarted.

## User-visible failure

Opening `LOCAL-11` in the packaged App left the centered dialog on
`正在读取 Bug 详情…`. The failure had three concrete causes:

1. The Electron API proxy limited every response to 4 MiB, while the Bug's PNG
   is 4,471,962 bytes.
2. The proxy removed `x-content-sha256` and `content-length`, but the Web client
   requires those headers for attachment and capture-artifact integrity checks.
3. Detail loading waited for every image before publishing the Bug metadata.
   Any image error left `detail=null`, and that state was rendered as loading
   even after the request had failed.

## Bounded fix

- Renderer request bodies are limited to 8 MiB, matching the upload-chunk
  contract.
- Ordinary API responses remain limited to 4 MiB.
- Only attachment and capture-artifact download routes may return up to 32 MiB.
  A larger response becomes a bounded HTTP 502
  `{"code":"RESPONSE_TOO_LARGE"}` instead of leaving the protocol request
  unresolved.
- Binary integrity headers (`content-length`, `x-content-sha256`, and
  `content-disposition`) are preserved.
- The detail dialog now publishes Bug content, assignment, workflow, and events
  before optional image/Poco enrichment completes. Images use independent
  settled results; a failed image produces an inline warning and retry action
  without disabling the Bug workflow. A metadata failure produces an explicit
  in-dialog error and retry action instead of an endless loading message.

## Real packaged verification

Live source-of-truth record:

```text
Bug:           LOCAL-11
Bug ID:        d50dfa1c-58d5-41f1-b3bf-dcb0d0153882
Attachment ID: 2c485f5a-6b3a-455b-8a70-648685a54f37
Filename:      capture-6cc11cf1-6640-414f-a460-ef96f7277b80.png
Media type:    image/png
Bytes:         4471962
SHA-256:       78d9da1a4f19d22d400f0cc86a2919620999bd8a860237eff1d5f4e521d5e557
```

The rebuilt EXE was started with a temporary loopback-only CDP port, signed in
through the real pinyin form as `luodongle`, and routed through a real
second-instance deep link:

```text
qa-hub://bug/d50dfa1c-58d5-41f1-b3bf-dcb0d0153882
```

The packaged renderer then reported:

```json
{
  "appReady": true,
  "detailOpen": true,
  "detailLoadingVisible": false,
  "detailErrorText": null,
  "evidenceImageCount": 1,
  "evidenceLoadedCount": 1,
  "desktopConnection": {
    "state": "connected",
    "reconnectAttempt": 0,
    "lastError": null
  }
}
```

This proves that the exact image that exceeded the old proxy limit traversed
the packaged custom-protocol proxy and completed browser image decoding. The
temporary debug instance was stopped after the check.

## Build and checks

```text
Web app TypeScript:       pass
Web node TypeScript:      pass
Web ESLint:               pass, zero warnings
Web Vitest:               2/2
Web production build:     pass, assets/index-BMGqc3It.js
Desktop TypeScript:       pass
Desktop tests:            16/16
Desktop Windows package:  pass, Electron 43.4.1 / win32-x64
```

The proxy regression suite includes the exact 4,471,962-byte response and
asserts that all integrity headers and bytes survive. It also verifies the
bounded 32 MiB failure path.

## Current deliverables

```text
apps/desktop/release/RelayQaHub-win32-x64/RelayQaHub.exe
  bytes:   235534336
  SHA-256: ADC709178104DA2D7B6DD887633642661DD06921C0852C9A988E6EA788275013

apps/desktop/release/RelayQaHub-win32-x64.zip
  bytes:   155004020
  SHA-256: 46797A0CD3A3940CE1011CE1E1B64739607CC6AEAE75DA976F8143FCAA5D7E18
```

The ZIP contains the complete 75-file portable directory. `RelayQaHub.exe`
depends on its adjacent `resources`, DLL, and locale files and must not be
copied by itself.

Final service readback after the package verification:

```text
http://127.0.0.1:4174/       200
http://10.100.5.157:4174/    200
10.100.5.157:4319 readiness  ready
API PID                       11468
Web PID                       23252
```

The CDP verification process was then stopped. Final handoff runs the same
package normally as PID `16316`: the visible `Relay QA Hub` window has handle
`92865268`, four package processes are alive, three API connections are
established, and no process listens on the temporary port 9333.
