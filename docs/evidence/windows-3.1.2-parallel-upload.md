# Windows 3.1.2: Parallel resumable uploads

- Date: 2026-09-08 (Asia/Shanghai)
- Release ID: `20260908T050537567Z`
- Product source: `e2d54112845169f8c44aa5d3a118ac12fd63924e`

Worker 0.3.1 sends four missing COS parts concurrently by default (configurable
1–8), with SDK connection pooling, coalesced credential refresh and serialized
durable ETag checkpoints. Existing upload IDs, part boundaries and identity
digests remain compatible. Failure/cancellation drains in-flight work before
return; multipart completion waits for every part. The page displays the actual
parallelism event from the worker.

Desktop 73/73, Web 46/46 and worker 30/30 tests passed, plus TypeScript,
changed-file lint/format, ADR/boundary and diff checks. The actual Tencent SDK
sent eight deterministic 256 KiB parts through a loopback HTTP server with 120 ms
per-request delay. Measured serial 1057 ms, parallel 283 ms, maximum concurrency
4; payload ranges and all MD5 receipts matched. Failure, resume and cancellation
tests passed. These timings establish concurrency, not real WAN/COS throughput.

Live Ed25519 signatures, streamed installer/portable sizes and hashes matched.
Packaged source, Web resources and worker hash matched. Full isolated portable
smoke and native upload IPC checks passed, including the four-part display,
legacy history, final confirmation guards and actual supervisor/worker dispatch
with invalid offline configurations. An actual archived 3.1.1 client upgraded
to 3.1.2 and restarted with its profile, uploader account/checkpoint and rollback
preserved. Daily client processes/startup entries were preserved and test ports
released. API readiness remained healthy at schema 12. Installer Authenticode is
`NotSigned`, separate from the verified update manifest signature.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Installer | 182602390 | `3775f85b0884485f2a17e6c21e99324a17604fd895910284f6c72ea1a711eada` |
| Portable ZIP | 188609100 | `17c0ad410059634d48a1b3022d1c1828db6ff33b1f846dde3b381b2201df7cd1` |
| Worker 0.3.1 | 73979463 | `1291cb0cc397cc53ca4f9af3fde42f95f49bba9a9b3f6f2b0e4bbb0dde42e663` |

Previous 3.1.1 files and committed source remain at
`apps/desktop/release/builds/prepublish-20260908T043816190Z-20260908T050256413Z`.
Local receipts/scripts are under `work/windows-3.1.2-release`.
No real business-platform upload, testing transition or publication was performed.
