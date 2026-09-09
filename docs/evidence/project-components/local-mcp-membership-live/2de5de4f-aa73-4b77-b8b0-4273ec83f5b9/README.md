# Independent copied EXE .9: real local MCP membership isolation

The actual run on 2026-09-09 passed **99/99 checks** and exited 0. It used the same installed preview .9 EXE and ASAR bytes in a new application directory, with two fresh profiles and local MCP **4470**. This proves the local MCP behavior of an independent copy; it is not an original-profile GUI test. No original 4420 request or GUI operation was performed.

- Actual run: `2de5de4f-aa73-4b77-b8b0-4273ec83f5b9`, 03:40:07.375–03:40:35.899 UTC.
- [Original public proof](proof.json), SHA-256 `763e49a4d2cc8edeef42c1448c189641828686d6e221fd366d73a7c4d33a05a3`.
- [Executed runner bytes](runner.mjs.txt), SHA-256 `b116392325539b228102796fff008c2aae5975f6e019f17482da5ec91754cb8d`.
- [Artifact review R2](artifact-review-r2.json), **575/575 checks**, SHA-256 `cc6cc6bf903d5b621047e6bbd8fe929953eb53c883f661e3749f3df43d6d0eda`. This is a subsequent artifact-only review by the executing agent, not a second E2E run or independent operator observation.

## Actual fixture and responses

| Item | Actual identity |
| --- | --- |
| Project A | `b8fbf7ff-b9ab-4e01-ab1d-ac8cd99c1b65` |
| Project B | `07cde190-2365-48b3-8b01-16a5fc421fae` |
| Single employee | `bca2f4c5-f1b9-4ae8-87a7-277c52b8d270` |
| Shared employee | `839183ea-02ef-491c-87e0-a158f60701c2` |

Both names contain this run's nonce. First and repeated Single logins returned the same ID and only A in the effective project directory. Shared first joined A, then joined B using the same employee ID. The directory then contained exactly A and B. No Single membership appeared in B. The existing GM creator also receives a membership in each new project; there are two new employees and three new employee relationships, plus those two creator relationships.

The copy established a real Shared A session, then the separate GM HTTP session changed only that employee's A relationship from active v1 to inactive v2. The next local MCP request used the copy's existing A cookie and was refused: JSON-RPC HTTP 200, `isError:true`, `PROJECT_NOT_ACCESSIBLE`, business status 403. Same-name A login was also refused with `PROJECT_MEMBERSHIP_DISABLED`/403. Those are business denials inside the MCP envelope, not successful business reads.

Shared B login still returned the same employee, the effective directory contained only B, and B remained readable. The GM restored A using expectedVersion 2; the result was active v3, and A login returned the same Shared ID with A/B visible again. The B comparison preserves user ID, membership status/version, roles and identity; it does not compare volatile active-session counts. Final A and B readbacks contained zero Bugs and five disabled components. Management history contained exactly one Shared A disable and one activation, and neither event in B.

The script did not emulate independent actors by putting tokens in arbitrary local MCP tool arguments. Each local login changed the copied application's shared session. GM auxiliary HTTP was necessary to revoke A while retaining the copy's real A session for the old-cookie check.

## Request accounting

The proof's **39 entries** are the bounded scenario request ledger:

| Transport and operation | Count |
| --- | ---: |
| Local 4470 JSON-RPC initialize | 1 |
| Local 4470 tools/list | 1 |
| Local 4470 tools/call | 34 |
| Explicit GM auxiliary HTTP login on 4419 | 1 |
| Explicit GM auxiliary HTTP PATCH of the new Shared A relationship | 2 |
| Total recorded scenario entries | 39 |

The 34 tool calls include 11 authentication attempts (including the refused A login), two project creations and 21 read calls. The catalog advertised 90 tools. The auxiliary PATCH bodies were exactly `{active:false,expectedVersion:1}` and `{active:true,expectedVersion:2}`.

The number 39 is **not a complete network count**. A separate explicit GET of the copy's unique update manifest is recorded as a real 404 with an empty body. Inspector discovery on 4471, Inspector WebSocket commands, and `/health` readiness polling on 4470 are outside the scenario ledger; their exact polling attempt counts were not retained. The hidden copied app's normal startup notification/renderer reads and automatic nonce update checks are also outside that ledger. There was no Bug, attachment, comment, component configuration or external-task write in this scenario.

## Process isolation and exit

The immutable package inventory contains **78 files / 378,180,695 bytes**, all copied files rehashed in the artifact review. The copied EXE is SHA-256 `da3e107e4219f0f3d068b6178f92abd9a232b44faaa47977db1ffcf556b8dd59`; ASAR is `6bc9f7508f663bd34c3896894369a7f9cafc6cc8c57542465315373a77790636`. The .9 release is `20260909T011704801Z`. The actual packaged configuration parser accepted the new configuration. The executable's existing Node CLI inspect fuse was enabled; no fuse or application byte was changed.

The first fresh profile proved normal shutdown before any membership scenario. Quit-probe PID **16684** was identified through its own Inspector as the expected EXE, profile and .9 version, then `app.quit()` exited 0 at **03:40:20.106Z**. The membership copy PID **21384** was likewise identified and exited 0 at **03:40:30.971Z**. Port 4470 and Inspector 4471 were recorded absent after shutdown. Each copy had an armed four-minute normal `app.quit()` deadline; explicit normal quit occurred before it fired. No force-stop, kill, uninstall or installation was used.

The two new profiles, private configs and logs remain under:

`C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\acceptance\local-mcp-membership-copy-2de5de4f-aa73-4b77-b8b0-4273ec83f5b9`

The copied application's final session was the GM session used for the final management read. That identity belongs only to this retained test profile. The process is no longer running. The copy retained the logical instance ID/cookie name needed for API 4419 compatibility, but its application directory, configuration, profile, remembered identity, local MCP port and unpublished update URL were independent. No live original LevelDB/WAL or draft files were copied.

## Original-client preservation and limits

Actual before/after snapshots recorded the same original EXE PID **13564**, start **2026-09-09T01:44:08.4163170Z**, and 4420 listener ownership; API PID **22852** and Web PID **20284** retained their start times. Six exact file hashes also stayed unchanged: instance configuration, installed preview configuration, original EXE, original ASAR, original remembered-identity file, and Windows latest manifest. The evidence hashes the remembered-identity file without decoding its contents.

This is a six-file and observed-process preservation claim, not a whole-profile or every-process census. The review did not repeat reads of original files or ports. It does not prove original GUI behavior, original unsent PNG bytes, Android feed preservation, physical-device behavior, component execution, or update installation. No GUI screenshots were taken because this task used JSON-RPC rather than UI input.

## Retention and review failure history

Private `raw/` holds **27 non-auth response bodies**, all matched to the recorded SHA and parsed readback. The 12 authentication responses (11 local and one auxiliary) were deliberately not stored raw; redacted identity/result and original response hashes are retained publicly. Those original auth bodies cannot be rehashed later. The executing runner removed sensitive fields and checked its in-memory actual-secret set before writing public proof. No credentials were read again for this artifact review.

The [first actual run](../09b01307-28c0-4d3a-a7d9-49bb4cb1c07c/proof.json) failed safely after 18 checks, before any process launch or request: its helper incorrectly expected CSRF origin 4419 instead of the actual installed 4274. Its proof and executed source remain unchanged. R2 preserved the actual 4274 CSRF origin and derives the unique unpublished update URL from that origin.

The first [artifact-only review](artifact-review.json) also remains: 552 passed / 23 failed. It incorrectly compared pretty-printed raw MCP `content.text` with the compact equivalent in redacted public evidence as literal strings. R2 compares valid embedded JSON objects structurally while preserving primitive strings; raw byte hashes remain mandatory. All 575 checks then passed, with no original proof, raw response or actual-run source changed. Both review sources and logs are retained. These failures are harness/audit corrections, not additional business runs.
