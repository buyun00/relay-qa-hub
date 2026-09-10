# QA Hub v2.1 Windows build13 matrix

| Check | Result | Evidence |
|---|---|---|
| Candidate manifest/version/hash | PASS | `http-artifact-readback.json`; release `20260910T044149231Z`, `0.2.0-preview.13`, expected SHA matches HTTP/local bytes |
| Manifest Ed25519 signature | PASS | `http-artifact-readback.json`; detailed verifier `../final-builds/windows-build13-preinstall.json` |
| Authenticode | PASS as separate fact | Candidate is `NotSigned`; Ed25519 manifest remains valid |
| Build12 exact process/profile baseline | PASS | `baseline-before-ui-upgrade.json`; PID 20552, file/product version `.12`, `--updated`, isolated profile |
| Built-in UI check/download/install | PASS | `snapshot-build12-before.json`, `update-status-menu.json`, `install-click.json`; renderer showed build13 downloaded/signature passed, then showed installing/restarting |
| Build13 automatic restart / marker-helper handshake | PASS | `post-upgrade-process-mcp.json`; old PID 25508 replaced by PID 19564, marker/flags and updater log all acknowledged |
| Same profile login/project/Bug/draft retained after build13 | PASS | `post-upgrade-process-mcp.json`; same profile command line, project/Bug MCP readback, draft text remains in IndexedDB log and PNG hash matches baseline |
| Local MCP initialize/tools/list after build13 restart | PASS | `post-upgrade-process-mcp.json`; 4642 initialize reports `.13`, tools/list returns 96 |
| Local MCP read-only projects/Bugs | PASS | `post-upgrade-process-mcp.json`; existing isolated project `LUNAEXE246` and Bug `LUNAEXE246-1` read successfully |
| Production/daily and old previews unaffected | PASS observation | `baseline-before-ui-upgrade.json`; ports/processes observed, no mutation performed |

Overall Windows build13 E2E: **PASS** for the requested isolated Windows/MCP upgrade flow. External integrations remain outside this acceptance scope.
