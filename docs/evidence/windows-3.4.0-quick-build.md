# Windows 3.4.0 — unified quick builds

Date: 2026-09-10. Product release verification is recorded below when complete.

## Implementation

- Web/EXE/MCP expose the eight current unified-job choices; every choice supports build-only or server-side build/upload.
- Android Debug 2001/1002; Android Release 2002/1002; iOS Debug 2001/2004; iOS Release 2002/2004.
- The successful parent build's archived result identifies its actual child through requestId and verified upstream cause. Artifact counter and Jenkins child number are distinct.
- RuiXue version and release notes equal releaseVersion. Fixed per-platform/config/version/build paths and ZIP SHA-256 prevent cross-build selection. New downloads and completed cache files are checked before upload writes.
- Worker 0.5.0 SHA-256: `86c3e80b74b6001b676cadc542eb40ff56ae5f2bddc099462779a95c5f740fbf`.
- Existing server jobs, original ZIPs, task checkpoints, shared history and legacy config digests are retained. Eight-part concurrency and tester 11562 defaults remain.
- The installed MCP runtime includes the shared upload contract; download links accept APK/AAB/IPA/ZIP from the new directories.

## Automated verification

Evidence root: `work/quick-build-compat/`.

- Relevant API suites: 91/91 (including all eight preset handoffs across MCP/HTTP/SQLite recovery).
- Desktop: 69/69; Web: 54/54; worker: 48/48 self-tests.
- API and desktop TypeScript builds; Web typecheck and affected-source lint passed.
- Additional desktop download whitelist regression verified encoded traversal rejection.
- Fixture-based integration tests verify workflow logic; they do not prove a real Unity build or RuiXue publication.

## Real build and current blocker

One real build-only probe was submitted, retaining its original request ID:

- request: `60a09a69-8afb-477c-a7b2-c6c42b306762`
- preset: `android-debug-res`
- queue: 797; unified job #2; Android child #10174
- started: 2026-09-10 18:15:01 +08:00; result FAILURE
- policy reported `Invalid Unity project path`; the workspace path was duplicated by the build-machine script/resolver.
- The API projects `BUILD_PROJECT_PATH_INVALID` from the verified child log. The automatic workflow does not upload after this failure.
- The log's artifact counter was 10175, independently confirming it must not be used to query Jenkins child #10174.

Existing real iOS Release 2.4.37 artifact #46 metadata and ZIP HEAD were read: 740874401 bytes; SHA-256 recorded by build-info is `03aa41f40e812ae1dfa26f41d6859485d9516f0086b98b87d2a9effe4b9d9a90`. The probe did not upload or publish this existing version.

**A successful real build-to-upload/publication is not verified.** The build-machine path error remains a dependency blocker; passing the EXE tests or publishing the compatibility release does not remove it.
