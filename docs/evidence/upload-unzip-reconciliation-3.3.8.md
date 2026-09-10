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
