# Preview and external resource inventory — Sol continuation

Observed 2026-09-09 13:36 +08:00. This is a read-only inventory taken before schema 18/19 integration. It records availability and blocking resources; listener presence is not counted as feature acceptance.

## Runtime boundary

| Surface | Current observation | Acceptance meaning |
| --- | --- | --- |
| Preview API `127.0.0.1:4419` | Owned PID 22852; ready; schema 14 | Healthy old preview runtime, not current-source proof |
| Preview Web `127.0.0.1:4274` | Owned PID 20284; HTTP 200 | Reachable only |
| Preview server MCP `127.0.0.1:4421` | Owned PID 15736; ready; schema 14; 90 tools | Initializes, but predates schema 17 and the new result/workflow tools |
| Preview EXE / local MCP `4420` | `RelayQaHubPreview.exe` PID 13564; product `0.2.0-preview.9`; local MCP ready | Available for a later single-operator installed-client run |
| Preview Android | MuMu package `com.relayqahub.android.preview.debug`, version `0.2.0-preview.9`, code 23 | Installed emulator client; no physical device |
| Production API `4319` | PID 10844; ready; schema 12 | Read-only observation only |
| Production Web `4174` | PID 7420; HTTP 200 | Read-only observation only |
| Daily EXE / local MCP `4320` | PID 17160; installed 3.3.4 | Preserved and not upgraded or stopped |

`Manage-QAHubPreview.ps1 -Action Status` revalidated that API, Web, and server MCP belong to instance `qa-hub-preview-7c86`, use this worktree as `sourceRoot`, and use the isolated preview `dataRoot`. The preview and production readiness GETs returned all database/evidence/worker checks `ok`. No secret file contents were read.

## Client and release identity

- Preview Windows manifest: release `20260909T011704801Z`, version `0.2.0-preview.9`, 108,334,255 bytes, SHA-256 prefix `2c50fe1b`; the installed executable has SHA-256 prefix `da3e107e` and Authenticode reports `NotSigned`.
- Preview Android manifest and installed MuMu package agree on version code 23 and APK SHA-256 prefix `9cfa87eb`.
- MuMu is the only Android transport. The delegated read-only ADB inventory found `127.0.0.1:16384`, Android API 35, and the existing `tcp:4419 -> tcp:4419` reverse. It is an emulator and cannot satisfy the physical-device gate.
- Daily Android `com.relayqahub.android.debug` remains version code 14 and PID 5051.

## External chain resources

| Chain | Read-only finding | Status |
| --- | --- | --- |
| Jenkins/build | No independent preview Job, workspace, executor, or artifact source; no local Unity/Java build process | `not_run` |
| Single/incremental upload | Uploader executable exists, but no preview account, product/channel/tester, extraction root, or isolated COS prefix | `not_run` |
| Relay production | Only the shared `ozdqp` project was discoverable; unauthenticated M2M probe correctly returned 401; no preview project/M2M/callback mapping | `not_run` |
| Qingyu sync | No preview test project, order, or isolated identity configuration | `not_run` |
| Physical Android | No physical device connected | `not_run` |

The discovered Relay listener and scheduler health do not provide an authorized isolated executor. The shared `ozdqp` project and production external state are not used for preview writes.

## Operations performed

The inventory used only owned-process status, listener/process reads, HTTP GET, MCP initialize/tools-list, ADB device/package/hash reads, and Relay health/project GETs. It did not start or stop services, install clients, change reverse mappings, log in to a product, submit business data, read secret contents, or alter production.

The machine-readable companion records the current readiness and resource verdicts. Values that can drift must be refreshed immediately before installed-client or external-chain acceptance.
