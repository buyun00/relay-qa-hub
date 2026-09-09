# Final evidence selection audit — 2026-09-09

This note records which newly captured evidence may be committed with the v2.1 implementation baseline. It does not promote historical or pre-commit results to final acceptance evidence.

## Included historical evidence

- `binding-lease-renewal-live/b6c91225-475b-4e3a-a872-92d9067b6ff8/`: include the complete directory. Its proof, executed runner snapshot, review record, source commit and file hashes agree. It proves the isolated schema 19 binding-renewal run only.
- `frozen-route-live/`: include the complete directory as failure-first history. The authenticated baseline found 39 of 54 required routes and recorded 15 missing routes; it is not a final route pass.
- `schema19-main-live/17c75a82-de8e-40a3-98d0-e11a37dec631/`: include as the retained guarded-listener failure-first attempt.
- `schema19-main-live/d1e79847-37a5-44ea-96db-1c5aec6579c6/`: include as the later 101/101 schema 19 HTTP and server-MCP pass. The stored runner hash agrees with the proof.
- `schema19-main-live/README.md`: include with the two retained runs above. The schema 19 pass remains historical after schema 20 is introduced.

## Included only as superseded audit history

- `android-terminal-evidence-candidate/`: the recorded source binding now matches only 1 of 12 Android files, and the referenced APK size and SHA-256 no longer match. Its README marks it superseded. Rebuild and bind a new APK after the implementation commit.
- `web-terminal-evidence-candidate/`: 4 of 8 recorded source hashes have changed. The directory also lacks the raw HTTP projection output underlying one README claim. Its README marks it superseded. Regenerate current Web evidence after the implementation commit.
- `schema19-main-live/10bdb9d2-d77d-4134-9e7e-3161ec9755e4/`: this repeats the same guarded-listener failure as the retained `17c75a82-...` run and adds no distinct evidence. A sibling note marks the duplicate.

These directories are committed only to preserve the audit trail. They are not counted as a pass and are not used to justify current-source acceptance.

## Integrity and secret review

At this selection point, the reviewed untracked evidence set contained 57 UTF-8 files totaling 997,673 bytes, excluding this audit note itself. All 11 JSON files parsed successfully. The review found no real bearer token, cookie, password, JWT, private key, credential-bearing URL or binary payload. Explicit local file references used by the included evidence existed at review time; external runtime paths remain host-local dependencies and are not treated as self-contained artifacts.

Final Web, Android, EXE, HTTP, server MCP, local MCP, migration and rollback evidence must be generated against the committed source and evaluated separately. Enabled external component runs remain blocked until dedicated non-production resources are available.
