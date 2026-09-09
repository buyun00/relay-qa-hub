# Upload checkpoint recovery — 3.3.6 / worker 0.4.4

Android task `5ce95bbe-0ff5-4da2-badc-8e61c56d0016`, version 2.4.35 (platform
version ID 840), stopped at 138/144 parts at 2026-09-09 16:21:37 Shanghai time.
The worker recorded `UnauthorizedAccessException`, with no COS request-failure
diagnostic. A progress event was missing for checkpoint 131 while later in-flight
acknowledgments were drained and retained. Original logs contain no stack trace,
so they cannot identify the particular external process that held the file.

An isolated Windows reproduction opened `state.json` for reading without delete
sharing. The unmodified writer threw the same exception (HRESULT 0x80070005) at
`File.Move` in `Journal.Save`; writing succeeded after closing that reader.
This demonstrates a checkpoint-replacement failure matching the incident evidence.

Recovery used the formal server resume API and the original task identity after
backing up metadata/events and verifying the ZIP SHA-256. The worker verified
138 existing remote parts, sent only the remaining six, and completed publication
with remote status 100. Version ID, config digest, upload ID, object key and ZIP
SHA-256 remained unchanged. Receipts are retained in `work/upload-2.4.35`.

Worker 0.4.4 retries only local atomic checkpoint writes for bounded transient
Windows file-access failures. Persistent failures preserve the durable checkpoint
and temporary file and produce a specific error, including an independent stdout
failure receipt if the journal cannot be updated. No platform write is retried by
this storage policy. Forty worker tests passed, including transient and persistent
Windows locks and preservation of confirmed parts.
