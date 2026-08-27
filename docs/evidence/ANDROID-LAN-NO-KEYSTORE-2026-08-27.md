# Android LAN submission without Keystore — 2026-08-27

## Report and observed boundary

The Android 12 phone could read the shared QA Hub list but showed
`credential vault unavailable` when New Bug was submitted. API logs showed the
probable phone address `10.99.2.196` reading list/detail/attachment routes with
HTTP 200 and no corresponding `POST /api/v1/bugs`, proving that submission was
stopped locally before the backend request.

The former implementation wrote the controlled-QA build credential through
Android Keystore before it even constructed the durable queue operation. It also
used `setUnlockedDeviceRequired(true)`, which has documented Android 12-14
platform limitations around secure lock screens and biometric unlock. For this
controlled-LAN product the user explicitly rejected that additional credential
and device-security layer.

## Product-aligned repair

- Removed `AndroidKeystoreCredentialVault`, its encrypted preferences and its
  device instrumentation test from the shipped App.
- Removed every foreground `credentialVault.put(...)` gate from New Bug and the
  old internal debug command paths.
- Added one immutable bundled-LAN configuration provider. It writes nothing to
  Android storage, generates no key, and does not depend on PIN, pattern,
  fingerprint, face unlock, or a per-user password/token setup.
- WorkManager reads the same bundled configuration as foreground submission, so
  process restart and offline retry do not require a device vault.
- Pinyin identity remains separate and still comes from `qa-people.json`.

Repository scan after the repair returned no `android.security.keystore`,
`AndroidKeystoreCredentialVault`, `credentialVault.put`, or
`CREDENTIAL_VAULT_UNAVAILABLE` under the Android App source.

## Final artifact

```text
path       apps/android/app/build/outputs/apk/debug/app-debug.apk
package    com.relayqahub.android.debug
version    0.1.3-debug (code 4)
minSdk     31
targetSdk  37
bytes      33,947,528
sha256     F1B706A2C07001226B6D35C9CAD23A6504FD718FC59B9404C92A602A99CC0850
download   http://10.100.5.157:4174/downloads/Relay-QA-Hub-Android12-debug.apk
```

The controlled build wrapper ran the complete debug JVM suite (56/56) and
assemble task successfully; targeted bundled-provider tests were 3/3 and lint
completed with zero errors. `aapt2` read back code 4, version `0.1.3-debug`, minSdk 31 and
targetSdk 37. The installed MuMu `base.apk`, build artifact and full HTTP download
all reproduced the exact SHA-256 above. The route returned HTTP 200, the Android
APK MIME type, attachment filename and `no-store`.

## Real direct-LAN result

Regression device: MuMu `127.0.0.1:16384`, Android 15/API35. `adb reverse --list`
was empty before and after the smoke.

The exact final APK retained the configured 罗东乐 identity, loaded the project
list, submitted content `LAN-0.1.3-final-no-vault-20260827-1242`, and refreshed to
17 rows with `LOCAL-17` at the top. The API log recorded `POST /api/v1/bugs` with
HTTP 201. Independent authenticated API readback returned Bug
`4dab32e7-f7fd-450a-8f8e-82e086a7cae5`, key `LOCAL-17`, reporter 罗东乐, owner
林步云 and verifier 罗东乐. Screenshot evidence is
[`android-lan-no-keystore-submit-2026-08-27.png`](android-lan-no-keystore-submit-2026-08-27.png).

The reporting Android 12 phone is not connected to this host through ADB, so its
reinstall is still the final physical-device confirmation. It must download this
code-4 artifact rather than reuse the cached code-3 package. No Unity or Jenkins
build was started.
