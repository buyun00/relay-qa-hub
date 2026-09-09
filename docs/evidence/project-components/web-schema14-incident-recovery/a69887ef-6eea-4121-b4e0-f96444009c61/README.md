# Schema 14 preview Web recovery

Run `a69887ef-6eea-4121-b4e0-f96444009c61` restored the preview Web entry point on port 4274 to the previously accepted schema-14 `Br-CEXQI` bundle after a local validation build had written a schema-19 candidate into the served `apps/web/dist` directory. The API on port 4419 remained ready on schema 14, and both preview process identities stayed unchanged.

The one-shot recovery retained exact private snapshots of the eight-file candidate and eight-file accepted baseline, installed their non-conflicting union, and atomically switched only `index.html` back to the accepted baseline. It deleted no files and performed no build, restart, business-data write, device action, or production access. The candidate JavaScript, source map, stylesheet, icons, and license file remain available in the served tree, but the restored index selects `assets/index-Br-CEXQI.js` and `assets/index-CgNw0fhl.css`.

[`prepare.json`](prepare.json) records the immutable preimage and approved baseline. [`recovery.json`](recovery.json) records 38 successful GET/HEAD checks, the exact merged tree, retained snapshots, unchanged process identities, and ready schema-14 API. [`independent-review.json`](independent-review.json) passed all 21 recovery-proof checks and all 9 baseline-lineage checks. The restored baseline is byte-identical to the earlier bundle covered by the retained 59/59 browser acceptance; this incident review did not rerun that browser flow.

The production instance, daily executable, local MCP, production data, and production ports were not read or changed during recovery. Future Web builds for schema 19 must use an isolated output directory under its independent runtime and must never target this served schema-14 directory.
