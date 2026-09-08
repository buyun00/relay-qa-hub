# Windows 3.1.0: Incremental upload page

- Date: 2026-09-08 (Asia/Shanghai)
- Release ID: `20260908T034800193Z`
- Product source: `2cacda3e8aaf193fca1144ff288070ebbae6bdd7`

The sidebar now includes 上传增量 after 打包下载. The page configures the uploader's
platform account, reviews target/product/channel/version and workflow scope, shows
download/upload and server processing progress, preserves drafts, and resumes
durable local jobs. Complete publication can wait for an actual tester ID and
test-result reference. Upload progress at 100% is not reported as publication.

The unchanged, hash-pinned uploader 0.2.0 is bundled outside ASAR. Login follows
the handover's actual recorded contract because the existing EXE accepts only
interactive password entry. Upload, token renewal and remote reconciliation stay
inside the supplied EXE. A detached supervisor maintains output, heartbeat and
completion receipts independently of the application window. See
`docs/INCREMENT-UPLOAD.md` for the integration contract and local paths.

## Validation

- Desktop: 71/71 tests; Web: 44/44 tests. New host tests cover login contract/cache
  compatibility, credential exclusion, failed-login preservation, subaccount token
  origin checks, corrupt local records, duplicate starts, target immutability,
  testing identity locks, heartbeat expiry, resume and binary integrity.
- Supplied EXE: 23/23 local self-tests passed, with `realPlatformTested: false`.
- Web/Desktop TypeScript, changed-file ESLint and Prettier, ADR/boundary checks and
  Git diff checks passed. Third-party license trailing whitespace was normalized.
- Browser interaction fixtures verified sidebar navigation, account submission,
  password clearing, draft preservation across navigation/reload, review before
  starting, duplicate clicks, 100% transfer without false publication, editable
  test-result drafts during refresh, resume, history and compact layout. Screenshots
  were visually inspected. Browser fixture operations did not reach the platform.
- Packaged native IPC identified uploader 0.2.0; missing auth prevented a start
  before side effects; arbitrary local paths were rejected. Display fixtures in an
  isolated profile retained history across reload.
- The packaged supervisor actually launched the bundled EXE from the packaged ASAR
  runtime. An invalid offline config was rejected by the real worker before auth
  or network access; its JSONL error and durable exit-code 6 receipt were verified.
  This proves executable dispatch and receipt handling, not a business upload.
- Full portable smoke passed login, notifications, 18 MCP tools, Bug details,
  overview/date navigation, Qingyu and production-task reads.
- ASAR Web resources, main/preload/host/supervisor outputs, source/release metadata,
  and the external uploader hash matched the release build.
- Live Ed25519 manifests and streamed installer/ZIP sizes and SHA-256 verified.
  Authenticode remains `NotSigned`; this is separate from update-manifest signing.
  API remained ready at schema 12 with database/evidence/worker checks all OK.
- Isolated self-update installed the live release and relaunched with its profile,
  runtime config and rollback directory preserved. A seeded upload checkpoint was
  byte-identical after upgrade, and the installed uploader hash matched.
- Daily client processes/startup entries remained unchanged. Test ports were freed.

## Published artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Installer | 182590082 | `07bd91f6e6baeccf8ed36b642c94c2ba999900a1c8bff0bd097ad8c72997f594` |
| Portable ZIP | 188596817 | `4dd2115d7e13a217094e1f2940c0613f07408a8b9e34a1da647390039af022d5` |
| Bundled uploader | 73946695 | `9ffa226d0c6dc6e971963e7d1fc838dd2e1110f3120c716e548d33e80934dc23` |

The previous 3.0.1 installers, manifests, portable directory, Web build and committed
source are retained at
`apps/desktop/release/builds/prepublish-20260908T031155792Z-20260908T033756265Z`.
Detailed receipts/scripts/screenshots are under
`D:\Relay-QA-Hub\work\windows-3.1.0-release`.

## Remaining business acceptance

No real platform account or designated new release was supplied for this change.
Actual platform login/renewal, cross-origin permissions, COS upload/recovery,
server unzip/copy results and final publication still require business acceptance.
No historical version was replayed and no real platform release was created or
published during these checks. These were already unverified in the handover.
