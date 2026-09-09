# Follow-up to the retained first preparation

The original plan, syntax/test/lint/format logs and first-run output remain historical bytes. The first runner is retained in failed run `09b01307-28c0-4d3a-a7d9-49bb4cb1c07c/runner.mjs.txt`, SHA-256 `9ec11b0dec69dd8060edeeb3a1494b5c9cbf75abaa8f04ae88691a4fea73ecaa`. The first test file's SHA was `441d7fc636ff76590789eaf68665674ece9f8fdfc7094c39a6427373a32911f4`; its test log and plan reference remain, but a separate original test-source copy was not retained. No reconstructed bytes are represented as an original copy.

The initial actual run stopped before launch/authentication because `makeCopyConfig` required CSRF origin 4419. Installed .9 actually uses API origin 4419 and CSRF/Web origin 4274. The corrected evidence helper retains that exact CSRF value, derives its fresh unpublished update URL from 4274, and verifies the existing Web PID/start along with API and original EXE. Product source, original installed configuration and original profile were not changed.

R2 helper SHA-256: `b116392325539b228102796fff008c2aae5975f6e019f17482da5ec91754cb8d`.

R2 test SHA-256: `a1d9d64af7afed4050cccef2a9f3c9f109d472021a709539440cb35636870bc0`.

R2 syntax, five pure tests, ESLint and Prettier passed in the `*-r2.txt` logs. `actual-second-run.txt` records actual exit-0 success. The successful [run README](../../local-mcp-membership-live/2de5de4f-aa73-4b77-b8b0-4273ec83f5b9/README.md) distinguishes 99 actual checks, 39 scenario requests and the later artifact review. The two test profiles and immutable app copies remain private; no session/profile bytes are proposed for Git.

All file hashes in the freeze manifest identify the bytes actually tested or reviewed. Where Git normalizes CRLF to LF, the manifest also records the LF-canonical hash, without rewriting the executed-source provenance. The existing server helper is a read-only dependency, not a new file in this task's proposed commit list. Root owns the matrix and decides the precise evidence mapping.
