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
