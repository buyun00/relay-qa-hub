# Server MCP membership acceptance preparation

Preparation passed five pure guard/redaction/inert-CLI tests, both syntax checks, ESLint and Prettier. Logs and command exits are retained in `checks.json` and the adjacent text files. No service, network, browser, client, device or database was opened by preparation.

Frozen runner: `scripts/project-components/server-mcp-membership-live.mjs`, SHA-256 `78551518f34c5703f083c26f558e07076ee518cadea9209f71890f82bbd418c2`. Tests: SHA-256 `e000b8d2b454428acc02bff30419c507ea0a02a2c78b7bfe478337e6014d173a`.

The armed run pins the preview instance configuration, API 4419 PID 22852 and server MCP 4421 PID 15736 with their reviewed start times. It uses only the fixed loopback MCP endpoint plus one proxy health read. The existing EXE/local MCP identity and drafts are outside its operations.

It creates two fresh projects, one A-only employee and one shared A/B employee. All writes use MCP: GM login, two project creations, fresh employee logins, and exactly one disable followed by one restore of the new shared employee's A membership. Explicit guards reject other projects, names, users, business writes and mixed payloads. The scenario checks stable user IDs, exact project directories, no duplicate employee rows, current denial after A revocation, B remaining usable, original identity after restoration, exact disable/restore audit events and all five components staying disabled. It creates no Bugs, comments, uploads or component tasks. The new fixture records and all evidence remain after completion; no cleanup or automatic business retry runs after failure.

Execute once after review:

```powershell
node scripts/project-components/server-mcp-membership-live.mjs --run C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-7c86/instance.json
```

The actual run writes a fresh UUID evidence directory, copied runner and recursively redacted request/response ledger. Authentication bodies are not retained verbatim; response lengths/hashes are recorded. This preparation does not establish actual MCP behavior, old imported-name aliases, local EXE MCP behavior, native client UI or complete cross-surface baselines. Any actual failure must be retained and assessed before a separate new run.
