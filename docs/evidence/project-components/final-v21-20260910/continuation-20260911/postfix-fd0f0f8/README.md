# QA Hub v2.1 postfix `fd0f0f8` evidence

[`summary.json`](summary.json) is the machine-readable authority for Windows preview `0.2.0-preview.20`, release `20260911T000006100Z`, built from `fd0f0f850f907b8a77aac8ec8b6a71b308bdd711`.

The package publication and `.19 -> .20` installed upgrade passed their recorded checks. The installed EXE and ASAR are byte-identical to the portable release, the prior `.19` installation remains as the rollback backup, the existing preview configuration and two draft identities were preserved, local MCP reported `.20`, and the deterministic shortcut/CLSID/protocol registration passed.

Overall acceptance remains **NOT COMPLETE**. Authenticode is required and the installed EXE is `NotSigned`. Native Windows toast routing also remains failed: run `81c44b26-5c6f-47c6-a56a-d4eb27f19d7a` reached a preflight-only `WINDOWS_TOAST_SESSION_MISMATCH` because WPN targeted console Session 1 while the app and observer ran in RDP Session 2. The run created no business fixtures, sent no business write request, and issued exactly one read-only readiness request. It is an environment blocker and is not counted as a product pass. Exactly six user-only gates remain `not_run` under the label `用户自测／已移交，代理未执行`.

Run `node validate-postfix-evidence.mjs` from this directory to check the copied package, publication, upgrade, registration, and sibling notification proof against the declared summary.
