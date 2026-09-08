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
