# Unzip wait and external publication reconciliation — 3.3.8 / 0.4.5

The user reported a stall first and completed the platform workflow manually
afterwards. Manual intervention was not the cause of the initial stall.

Task `46914a43-df35-431e-a292-1fbd18a514a7`, Android 2.4.36, platform version
843, uploaded 143 parts and 748182806 bytes by 12:04:33 Shanghai on 2026-09-10.
The worker completed binding and entered WAIT_TEST_ASSETS at 12:04:35. It then
emitted no further progress. Platform readback after the user's intervention
showed status 100, publication time 04:12:03 platform time (12:12:03 Shanghai),
and the exact release directory derived from this task's original object key.

Two defects were identified:

- The empty temporary-unzip record can be a zero row (`id=0`, `version_id=0`,
  `status=0`, empty `path` and `rely_path`) rather than JSON null. The old
  completion check required null, even when the task-specific test directory
  was already ready and the independent active log was null. Running the
  unmodified Engine from commit 2e5b117 against this response reproduced
  PROCESSING_TIMEOUT without any simulated manual operation. The same case
  passes with the fix. Existing logs did not retain polling response bodies,
  so the exact pre-intervention response for 843 cannot be reconstructed;
  the observed post-intervention response matches this reproduced defect.
- After external publication the old loop kept requiring the test directory.
  It did not recognize the confirmed final state and matching release directory.
  This explains the continued wait after manual completion, not the initial stall.

Worker 0.4.5 accepts only null or the specific empty-row representation, still
requiring the exact test directory and independent absence of an active job.
Active, malformed, mismatched and error-bearing logs remain blocking. On resume
and during processing polls it can reconcile status 100 only after checking
version/product/channel identity, the original uploaded object's release
directory and a valid publication time. It records the external result without
repeating upload/test/publish writes or inventing execution/test evidence.
Wait diagnostics are emitted every 30 seconds. Existing EXE/MCP task history and
ownership remain unchanged.

46 worker tests passed, including the original empty-row reproduction, active
and unknown logs, manual completion during a wait, resume after manual completion,
wrong version/channel/resource and invalid publication time. Evidence resides in
`work/upload-2.4.36`; release receipts are in `work/windows-3.3.8-release`.

## Production recovery

At 12:23:57 Shanghai the exact idle worker for this task was stopped after a
fresh, read-only platform identity/publication check and a checkpoint backup.
The backend was redeployed with worker 0.4.5, then the official resume route
created run `6c7f6910-bcfd-42a6-acd0-b5863d255260`. At 12:24:59 it completed
with `published=true`, `remoteStatus=100`, preserving the original platform
publication time `2026-09-10 04:12:03`.

The resumed run emitted only authentication, local package validation,
`remotePublicationReconciled` (`writesIssued=false`) and completion. It did not
repeat upload, testing or publication writes. The task/version identity, config
digest, original object key/test directory, all 143 parts and ZIP SHA-256
`db6fa844953c822d4bab2d646c86889bb680859b68e9a24e534503b78d7450f5`
remained unchanged. `verified-reconciliation.json` records the comparison.

## Release and acceptance

Windows/Web 3.3.8 release `20260910T042456721Z` was built from clean isolated
source commit `0bc89333c888bece25460784c2861858bd6580aa` and deployed at
12:29:41 Shanghai. Worker 0.4.5 is pinned to SHA-256
`2197bf2d6210f49f00e5420bf85ced723afdcc50d3f974f63d0b95c903625871`;
the actual backend worker file was checked against this hash.

- Worker self-test: 46/46; API upload/process tests: 35/35; Web tests: 54/54.
  API/Web type checks, relevant lint and diff checks passed. An initial API
  test invocation used the wrong working directory and was rerun from
  `apps/api`; both diagnostic logs were retained.
- Live signed manifests, LAN installer/portable downloads and SHA-256 matched.
  Installer: 150476761 bytes,
  `aedae25472230edde6c34d0e088a474871b6fee9ac9018bf9fed50fbc7a6963e`.
  Portable: 150832762 bytes,
  `89d2be4b4c0b687143ab28ed47364f1dc07ae98dc50d4d3b17a5434b6d4fb86f`.
  ASAR release/source and nine packaged Web resources matched the clean source;
  live Web assets matched the deployed build. API readiness passed all checks.
- A real isolated 3.3.8 EXE logged in, loaded production data, exposed all 27
  MCP tools and displayed this original task as formally published, with all
  seven stages complete and the new reconciliation message visible. The real
  EXE's MCP independently read back `published=true`, `remoteStatus=100`.
  Evidence: `portable-smoke.json`, `unzip-packaged.json`, `unzip-reconciled.png`.
  The first custom UI check encountered two matching message elements; its
  selectors were scoped to the status and log, and the full smoke then passed.
- The actual archived 3.3.7 EXE downloaded, installed and relaunched 3.3.8 in an
  isolated renamed directory. Profile/runtime configuration, uploader checkpoint
  and account fixtures, build/upload-chain fixture and updater rollback were
  verified. Evidence: `self-update.json`.
- The running daily client PIDs and Windows startup entries were preserved;
  temporary verification ports were released. The pre-release 3.3.7 archive
  and previous backend build remain available for rollback. The valid signed
  update manifest is separate from the installer's Authenticode `NotSigned`
  status, recorded in `final-runtime.json`.

This release acceptance read the original production publication and exercised
the repaired branches in worker tests. It did not create another production
version or claim a new fully automatic production publication after the user
had already completed version 843 manually.
