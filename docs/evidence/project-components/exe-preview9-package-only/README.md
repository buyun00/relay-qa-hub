# EXE preview.9 — isolated package-only proof

Source: `bc2b347dae282212a9119e5411b17fe144ca758c`. Version: `0.2.0-preview.9`, native `0.2.0.9`; release `20260909T011704801Z`. Status: **packaged and verified, not published or installed**.

The committed two-line detail-loading correction and three real-App asynchronous regressions are described in [the source proof](../web-detail-loading-fix.md). This package contains the corrected Web bundle, but no packaged native UI acceptance of the correction was performed in this run. The earlier .8 UI failure/upgrade evidence and the earlier 99/102-test evidence remain their original historical observations.

## Build boundary and exact inputs

The live Web process serves `apps/web/dist`. Its entire existing output was retained before building: 10 files, 4654639 bytes. Source → retained copy → source matched before build, and the complete served directory still matched after packaging. Vite output went only to `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\acceptance\exe-preview9-package-only-7ed02aa0-3669-4f85-932a-2cf3ed0eadaf\web-dist`. Vite's explicit service-target requirement applies to development/preview server hooks; this production bundle build starts neither server. The installed config supplies the runtime service addresses.

The original package helper was unchanged (SHA-256 `d36670be4ae8cf2c008f6be81c5fdc8982cdc0e2f3a2408c04903d6f1ba648e3`). Its private derived copy (SHA-256 `7b1dfb712b8ef52a6437a905fc69352fde03ed417370eca0d26cf8d3c7b61e0c`) replaces exactly one Web input expression; [the exact diff](package-helper.diff.txt) and both complete sources are retained. All other helper behavior remains original. The only config change for packaging is `downloadsRoot` → `C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\acceptance\exe-preview9-package-only-7ed02aa0-3669-4f85-932a-2cf3ed0eadaf\staged-downloads`. This ensures its signed `latest.json` is generated solely inside staging. The manifest field named `publishedAt` is helper-generated metadata and does not establish formal publication.

The existing Ed25519 private/public pair was required; no new key was generated. Preparation read only public-key content and private-key file metadata. Only the original signing helper read the private key to sign the new staged manifest. Installed public key/config matched before and after. Authenticode is reported separately in [authenticode.json](authenticode.json); a valid Ed25519 update signature does not imply Windows Authenticode signing.

## Inert runner and executed command

The runner's default mode is inert. The prepared run pins the exact source, helpers, NSIS executable, output roots and initial protected state. The executed command was:

```powershell
node .tools/preview9/package-only.mjs --build "C:\Users\lin0\.codex\parallel-runtimes\qa-hub-preview-7c86\acceptance\exe-preview9-package-only-7ed02aa0-3669-4f85-932a-2cf3ed0eadaf\prepared.json"
```

The unique private acceptance directory was created before the run. The runner refuses existing build-result/output content and verifies containment before Vite's `--emptyOutDir`. See [prepared.json](prepared.json) for complete parameter and preservation inventories, [runner source](package-only-runner.mjs.txt), and [build-result.json](build-result.json) for actual phase commands, hashes, exits and checks.

## Results and retained state

- Isolated Web build, desktop typecheck, all 104 desktop tests, desktop compilation and native package build passed.
- 29/29 package/boundary checks passed: the original public key verifies the manifest; installer bytes/hash/release are bound; every isolated Web file exactly matches its corresponding asar entry; asar release/source/instance and Windows versions match.
- The installed EXE remains `0.2.0-preview.8`. Its EXE/asar/config, the original instance/public key, the formal .8 manifest, three retained .8/.7 installer copies, all 8 rollback directory records, existing desktop source/helpers and the served Web tree are unchanged.
- Preview/daily client processes and tracked API/Web/MCP listeners/process creation identities matched before/after. There were no API/device requests, service/client start/stop actions, installation, formal manifest publication, or matrix changes.

The package is only in staging. Future publication/upgrade and native verification are separate work; this result does not claim the .9 application has run or the full client baseline has passed. Local build outputs in `apps/desktop/dist` changed as expected; they are separate from the installed application and the running API.

[Machine summary](result.json) · [actual package receipt](package-receipt.json) · [secret scan](secret-scan.json)
