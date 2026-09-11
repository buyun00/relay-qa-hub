# QA Hub LAN project onboarding v2.2 delivery record

Date: 2026-09-11

This record covers the isolated `qa-hub-lan-v22-0911` deployment only. It does not certify or modify daily production, the earlier v2.1 preview, a Windows installation, or a physical Android device.

## Delivered instance

| Item | Delivered value |
| --- | --- |
| Source branch | `codex/lan-project-onboarding-v2-2` |
| Package source commit | `b32d280f691f0fcc726587222de5ddf17a85c556` |
| Runtime | `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-lan-v22-0911` |
| Backup archive | `C:\Users\lin0\.codex\parallel-archives\qa-hub-lan-v22-0911` |
| Employee Web entry | `http://10.100.5.157:4740` |
| Download page | `http://10.100.5.157:4740/downloads/` |
| Server MCP | `http://10.100.5.157:4741` |
| API | `127.0.0.1:4739`, reached by clients through the Web proxy |
| Scheduled task | `Relay QA Hub LAN - qa-hub-lan-v22-0911` |

The scheduled task is installed with two triggers, runs hidden at highest privileges through S4U, and reported `Ready` with last result `0`. The final status check reported the API, Web and server MCP processes running and API readiness `true`.

The Web and server MCP listeners are limited to ports 4740 and 4741. Their enabled inbound firewall rules apply to the actual `Public` profile, the selected Node executable, and `10.100.0.0/21`. Port 4739 remains loopback-only; desktop MCP port 4742 was not started or tested.

The host address `10.100.5.157/21` is still DHCP-assigned on `vEthernet (CorpAccess)`. A router-side DHCP reservation remains a user or network-administrator action. No adapter, gateway, network profile, or Hyper-V switch was changed.

## Functional evidence

The final real-LAN acceptance run passed all 35 recorded checks through the published address. Evidence is retained at:

`C:\Users\lin0\.codex\parallel-runtimes\qa-hub-lan-v22-0911\logs\acceptance\lan-onboarding-2026-09-11T07-41-30-604Z.json`

It covers:

- Web landing and readiness through `10.100.5.157`.
- GM creation and independent initialization of two projects, including project names, logos, initial members, and disabled test-project cleanup after the run.
- Three-field project login, wrong-code/missing-project behavior, authenticated logo access, and per-project visibility.
- Upload initialization, chunk transfer, finalization, attachment binding, Bug creation, and attachment readback.
- Server MCP initialization, tool inventory, three-field login in two projects, Bug listing/comment/action, attachment read, project isolation, notifications, and final GM readback.

The Web UI was also inspected in a real browser through the LAN address. The login screen showed project name, fixed four-digit code, and name fields; the download page showed the actual Windows and Android versions, sizes, SHA-256 values, and links.

Source verification completed before deployment included 28 storage tests, 21 targeted API tests followed by the final relevant API regression set, 55 Web tests plus typecheck/build, PowerShell parser checks, relevant linting, Android unit/instrumentation compilation/lint/assembly tasks, desktop code-unit checks, package-isolation checks, and `git diff --check`.

## Recovery evidence

Recovery point:

`C:\Users\lin0\.codex\parallel-archives\qa-hub-lan-v22-0911\rpo\2026-09-11T07-41-59.686Z.2b2b7518-6e40-4a04-b186-e171b47049c0.sqlite`

- Size: 1,961,984 bytes
- SHA-256: `9d33ab8bb26a9b399589f9ca364653ce57bf9af08a5c70bc09d8f74ae088e58f`
- Sidecars: attachment archive plus recovery manifest retained beside the database

It was restored only into the new isolated directory:

`C:\Users\lin0\.codex\parallel-restores\qa-hub-lan-v22-0911-verify-20260911-1543`

The completed restore contains the database, recovery-required local configuration, attachment inventory/completion records, and the single referenced attachment blob. The running LAN instance was not replaced.

## Client artifacts

### Windows package

- Version: `0.2.0-lan.1`
- Release ID: `20260911T081035555Z`
- Installer: `http://10.100.5.157:4740/downloads/qa-hub-lan-v22-0911-windows-0.2.0-lan.1-20260911T081035555Z.exe`
- Size: 107,989,239 bytes
- SHA-256: `3e3dbbfc09a1168e76c42fb8163bdf0a57356dd49ae9b50972dab5750d747c4a`
- Latest manifest: `http://10.100.5.157:4740/downloads/qa-hub-lan-v22-0911-windows-latest.json`
- Manifest SHA-256: `43ec02a7e2347a9d57f410016ade991d44e63e03f2ec99f0659be107b7fdbcb7`

The installer was built and its published bytes, range response, size, and hash were verified. It was not launched, installed, upgraded, debugged, observed, or used for desktop notifications or local MCP. All Windows EXE behavior is user self-test / agent not executed.

### Android package

- Version name/code: `0.2.0-lan.1` / `24`
- Package: `com.relayqahub.android.lan.v22.debug`
- APK: `http://10.100.5.157:4740/downloads/android/qa-hub-lan-v22-0911/Relay-QA-Hub-Android-24-0.2.0-lan.1.apk`
- Size: 35,930,169 bytes
- SHA-256: `2bf6da8770f768498afd38f675e5d0c75cd4feba92a24a0318d73c6510b7f956`
- Update manifest: `http://10.100.5.157:4740/api/v1/android-updates/preview/latest.json`

The APK was built with the LAN API base, statically inspected with AAPT2, and its published bytes, range response, size, hash, package identity, and update manifest were verified. Unit tests, Android-test compilation, lint, and assembly passed. No emulator was available. A physical device was visible through ADB, so it was deliberately not installed to or touched; physical Android behavior remains user self-test / agent not executed.

The machine-readable client manifest is `http://10.100.5.157:4740/downloads/distribution.json`.

## Preserved boundaries and handoff

- Daily production remained ready on API 4319 and its existing listeners on 4174/4320 were not restarted or changed.
- The earlier isolated preview remained ready on API 4639 and its listeners on 4640/4641/4642 were not restarted or changed.
- No second independent LAN endpoint was available to the agent. Office-wide reachability is therefore not claimed; the recorded LAN request and browser checks were performed from this host through the published LAN address.
- Real Windows installation/upgrade/notification/local-MCP checks and physical Android checks are handed to the user. Game packaging, one-click upload, real incremental publication, Relay AI production delivery, and Qingyu closure remain outside this bounded delivery.
- GM credentials, initialization tokens, and project join codes are intentionally absent from this record. Obtain the GM credential only from the restricted local instance configuration when performing the user-owned onboarding flow.
