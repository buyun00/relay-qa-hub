# iOS incremental upload — 3.3.4

The upload page now selects Android or iOS. iOS uses channel 2004 and the newest
ZIP by modification time in `/pkg_zip/ozdqp/ios/`; product 2002, tester 11562 and
the two publication modes retain their existing defaults. Android keeps its
original fixed package. Summary and description remain version-only.

Selection runs on the server. The selected filename, URL, size and Last-Modified
are frozen before worker launch; download preconditions and final HEAD reject
replacement. Resume reuses the original ZIP. API input cannot supply a source URL,
and the worker limits sources to the fixed build server and authorized ZIP paths.
Worker 0.4.3 retains eight concurrent COS parts and the existing recovery rules.

Validation completed before release:

- Web: 54 tests, TypeScript and changed-file ESLint passed.
- Upload host, source selection and build coordinator: 32 tests passed.
- API, persisted queue, real supervisor and Jenkins routes: 49 tests passed.
- Worker: 38 self-tests passed, including iOS source validation and original-file reuse.
- Isolated browser: platform switching, retained parameters/draft, server queue
  payload and the guard against uploading an Android build to iOS all passed.
- Real read-only download: `ozdqp_ios_2.1.157_38_full_20260908171621.zip`,
  757,858,476 bytes, 1,589 ZIP entries, SHA-256
  `fe7799959b5eac08341141766e2d3c37d6532484e191db4231084269d9c70648`.
  Reopening the completed download reused the same file.

These checks made no new COS upload or platform release. Local receipts and the
read-only download are retained in `work/ios-upload`; Windows release receipts are
retained in `work/windows-3.3.4-release`.

Release verified on 2026-09-08:

- Source: `b05d93686dd27d2e34e8b3f7e601cb9a3611085f`; release ID `20260908T095214316Z`.
- Live Web assets match the package. Signed update manifests and downloaded
  installer/portable hashes match; API is ready with worker 0.4.3.
- Packaged EXE selects iOS/channel 2004 and reads the server-owned upload service.
- Isolated 3.3.3 to 3.3.4 download, installation and restart passed; profile,
  runtime configuration, upload checkpoints/accounts and rollback remain intact.
- Existing Android 2.4.31 digest and published record remain unchanged. The
  real iOS download also matches its publisher-provided SHA-256 sidecar.
- The four daily-client processes and startup registry entries were preserved.
