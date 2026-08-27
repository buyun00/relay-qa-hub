# Local runtime paths

Verified on 2026-08-24 for the P0 bootstrap:

- Node.js: `C:\Users\lin0\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`
- Node.js version: `v24.19.0`
- npm CLI: `D:\Relay-QA-Hub\.tools\npm\node_modules\npm\bin\npm-cli.js`
- npm command shims for recursive workspace scripts: `D:\Relay-QA-Hub\.tools\npm\node_modules\.bin`
- npm version: `12.0.2`

PowerShell invocation pattern:

```powershell
$qaHubNode = 'C:\Users\lin0\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$qaHubNpmCli = 'D:\Relay-QA-Hub\.tools\npm\node_modules\npm\bin\npm-cli.js'
$qaHubNodeBin = Split-Path -Parent $qaHubNode
$qaHubNpmBin = 'D:\Relay-QA-Hub\.tools\npm\node_modules\.bin'
$env:PATH = "$qaHubNodeBin;$qaHubNpmBin;$env:PATH"
& $qaHubNode $qaHubNpmCli ci --ignore-scripts
& $qaHubNode $qaHubNpmCli run verify
```

The npm shim directory must be on `PATH` for the duration of the command because
root scripts invoke nested `npm run ... --workspaces` commands. This changes only
the current PowerShell process; it does not modify the machine or user PATH.

The `.tools` directory is bootstrap tooling only and is ignored by Git. Product runtime data belongs under the separately configured `D:\Relay-QA-Hub-Data` tree and must never be nested in this repository.

Current production persistence and recovery paths (verified 2026-08-27):

- Data root: `D:\Relay-QA-Hub-Data\production`
- SQLite fact source: `D:\Relay-QA-Hub-Data\production\db\qa-hub.sqlite`
- Content-addressed evidence: `D:\Relay-QA-Hub-Data\production\evidence\sha256`
- Backend-only account/membership seed: `D:\Relay-QA-Hub-Config\qa-people.json`
- Local online SQLite recovery points: `D:\Relay-QA-Hub-Backups\production\rpo`
- Separate-disk DB + attachment archive: `E:\Relay-QA-Hub-Archives\production\rpo`
- Content-hash people configuration copies: `E:\Relay-QA-Hub-Archives\production\configuration`
- Runtime pointer: `D:\Relay-QA-Hub-Data\mvp-e2e-current.json`

The current policy runs on API start and every 15 minutes. The D: source/local
recovery point and E: archive are on physical disks 1 and 0 respectively. The
restore validator is `scripts\Verify-QAHubRecoveryPoint.mjs`; it admits only an
exact `.sqlite` + `.manifest.json` + `.sqlite.attachments` set whose database,
attachment inventory, completion marker, binding marker, sizes, and hashes all
match. It never restores over an existing directory.
