# ADR-0004: Quarantined resumable uploads and content-addressed evidence

- Status: Accepted
- Date: 2026-08-24
- Owners: Relay QA Hub evidence pipeline

## Context

Phone reports include large photos, video, audio, and logs over unreliable networks. Retrying an entire upload wastes time and bandwidth. Accepting browser filenames or MIME claims creates path traversal and active-content risks, while storing duplicate blobs increases disk and backup cost. QA evidence must remain accessible when Relay is offline and must not expose server paths.

## Decision

1. QA Hub owns attachment metadata and physical evidence. Relay never becomes the canonical attachment store.
2. Upload is a four-stage protocol: `init -> chunks -> finalize -> bind`. Sessions have actor, project, expected size, chunk size, expiry, quota, and state.
3. Chunks stream to a quarantine area. The server validates offsets, chunk hashes, total size, declared media type, file signature/magic, filename normalization, project permission, quota, and final SHA-256.
4. A finalized physical blob is addressed by SHA-256 and referenced by attachment metadata. Binding to a Bug/Occurrence/Event is transactional; orphan sessions and unbound blobs are reclaimed by a measured retention job.
5. Finalization is concurrency-safe and idempotent. Duplicate content produces one blob with consistent reference accounting.
6. Antivirus/malware scanning is an explicit state. Files cannot receive normal inline treatment before required scanning and validation pass.
7. HTML, SVG, unknown, and other active types are forced downloads with safe disposition and `nosniff`; user filenames never determine storage paths.
8. Browser API responses expose opaque attachment IDs and safe metadata, never host paths, secrets, or quarantine locations.
9. Offline drafts store Blob data in a user/project IndexedDB namespace. The UI distinguishes local-only, uploading, and submitted states; it never reports success before server binding.
10. Relay handoff selects only allowed small evidence and uses bounded, signed, expiring pull URLs. Large videos stay in QA Hub.

## Consequences

### Positive

- Interrupted mobile uploads resume from confirmed chunks.
- Content deduplication reduces storage and backup volume.
- Security checks happen before evidence becomes generally accessible.
- QA retains evidence through Relay outages or task lifecycle changes.

### Costs and risks

- Quarantine, chunk/session cleanup, scanning, thumbnails, and reference reconciliation require workers and metrics.
- Content-addressing needs manifests so database backups and blob backups can be verified together.
- Browser and platform media capabilities vary and require real-device validation.

## Rejected alternatives

- **Direct multipart upload into final storage:** cannot robustly resume or fail closed before validation.
- **Trust client MIME and filename:** enables active-content and path attacks.
- **Store files in SQLite:** complicates large streaming, backup cadence, and evidence serving.
- **Use Relay uploads as QA evidence:** couples availability, access control, retention, and path exposure to Relay.
