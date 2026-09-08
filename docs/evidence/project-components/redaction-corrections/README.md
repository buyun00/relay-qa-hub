# Corrected redaction derivatives

Generated 2026-09-08T21:25:01.692Z. These eight files are new sanitized derivatives of the private originals named by the existing commit-safety-redaction ledger. They are not new business runs. The old public proofs and the private originals remain unchanged. The coverage matrix is not edited by this correction.

The previous evidence functions parsed and stringified every JSON-compatible string. That changed decimal-looking text such as JSON-RPC version "2.0" to "2" and event schema version "1.0" to "1". It could also normalize exponents, negative zero, whitespace and large integer text. Actual request bodies and business/schema assertions used the original response objects; the defect affected the evidence copies and error descriptions.

Both corrected real functions preserve number/boolean/null string text. Objects and arrays are recursively sanitized; repeated JSON string encoding is rebuilt only when its decoded content changes. The depth limit still fails closed. Eighteen parameterized tests cover both functions, secrets in MCP mirrors and nested JSON, string fidelity, unchanged original objects, idempotence, and decoding at the depth boundary. ESLint and Node syntax checks passed for the three modified scripts.

Before derivation, all eight private originals matched their recorded before SHA-256 and byte count, and all eight old public files matched their recorded after SHA-256. Private hashes were checked again before any public file was created. Each derivative was generated from its original object, never by guessing a replacement for an old "1" or "2". index.json associates each private-original, old-public and corrected-public SHA-256 and records both helper hashes.

The decoded public difference is exactly 104 JSON-RPC version fields and 240 event schema-version fields, including MCP text/structured mirrors and repeated readbacks. Every run ID, passed/failed result and check count is preserved; failed historical runs remain failed. Other decoded public fields are equal. JSON formatting may differ. These are sanitized semantic evidence copies, not byte-for-byte wire captures.

Private secret values existed only in memory for removal and exact-value scanning. The new public files and three modified scripts were scanned for every collected secret, JSON-escaped variants, JWTs, PEM private keys, literal bearer tokens and common provider-token shapes; matches were zero. No secret value is recorded in this directory. Private-data paths and hashes are provenance metadata only.

The two already committed frozen-workflow proof files are untouched: the shared defect was present in their helper, but this audit did not find a changed field in those particular stored responses. No HTTP request, client action, API/storage/UI change or acceptance rerun was performed.
