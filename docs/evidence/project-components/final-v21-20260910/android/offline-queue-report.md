# Retry 5 offline receipt (2026-09-10)

- Preserved all three files for active preview Room DB and older DB candidates, including WAL and SHM. Active DB: qa-hub-preview-247f5d6c-7482-3ca2-a7a1-cc913052bfda.db plus matching -wal/-shm.
- Read-only active DB query found operationId 5a36736c-e35d-45d9-999a-ea7521f4848d, project .004, actor 8e082dee..., operationKind CREATE_BUG, payload clientSubmissionId 3c63b590-1ec7-4707-ad57-63cacbc38231, title/description V21_OFFLINE_TEXT_ONV21_OFFLINE_TEXT_RETRY4LY_0910, state SUCCEEDED, attemptCount 2, lastError null.
- Receipt table contains exactly one receipt for that clientSubmissionId: bugId c5b37b84-85f5-416a-8d5c-6605d135de03, key LOCAL-2, disposition created, replayed false. No second receipt for the same clientSubmissionId.
- API readback is saved in api-bugs.json and contains the matching LOCAL-2 Bug. This proves the same queued submission reached the server once and did not duplicate.
- UI before/after state XML is saved as ui.xml and ui-final.xml; native screen showed pending/completed workflow labels, but did not expose a direct receipt text after returning to the list.
- Reverse 4639 was restored; 4419 remained throughout. Daily unchanged.
- PASS: persistent device queue, retry, reconnect arrival, no duplicate, server receipt. PASS: pure-text draft visibility after reopening New Bug (r4reopen.xml). Screenshot attachment remains UNRUN due MediaProjection blocker.
