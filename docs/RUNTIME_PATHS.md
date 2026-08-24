# Local runtime paths

Verified on 2026-08-24 for the P0 bootstrap:

- Node.js: `C:\Users\lin0\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`
- Node.js version: `v24.19.0`
- npm CLI: `D:\Relay-QA-Hub\.tools\npm\node_modules\npm\bin\npm-cli.js`
- npm version: `12.0.2`

PowerShell invocation pattern:

```powershell
$qaHubNode = 'C:\Users\lin0\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$qaHubNpmCli = 'D:\Relay-QA-Hub\.tools\npm\node_modules\npm\bin\npm-cli.js'
& $qaHubNode $qaHubNpmCli --version
```

The `.tools` directory is bootstrap tooling only and is ignored by Git. Product runtime data belongs under the separately configured `D:\Relay-QA-Hub-Data` tree and must never be nested in this repository.
