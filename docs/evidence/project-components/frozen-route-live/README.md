# Frozen route live audit evidence

This directory preserves development and final live route-registration probes for the isolated `qa-hub-preview-final-sol-0909` instance. The probe uses the two frozen API manifests as its input. It never sends a valid mutation body: mutating requests use the intentionally unsupported media type `application/x-qa-hub-route-probe`, while read requests use an authenticated preview-only employee session.

## Superseded development probe

`f469debc-aebd-46f0-8c62-134ac579944a/proof.json` is retained as failed development evidence. It did not authenticate. The API's global authorization hook therefore returned a non-404 response for routes that were not actually registered, so its reported `50 / 54` registration count is not valid route-registration evidence.

## Authenticated baseline

`65402e22-2be1-4638-a45e-bdd12813c49a/proof.json` is the first valid baseline. It created an ephemeral passwordless session only in the isolated preview database, supplied that bearer credential to every protected probe, and revoked the session before writing the proof. It found 39 of the 54 frozen-manifest routes registered and recorded 15 actual Fastify route misses.

The 15 misses are evidence gaps, not passes. They comprise:

- Four historical password-based native-session routes. They are not applicable to the v2.1 product acceptance scope: the approved design replaces them with the project-and-name flow `{ projectId, name, client }` at `/api/v1/auth/login`. A source search excluding contracts, documentation, generated output, and evidence found no Web, Android, EXE, API, server MCP, or local MCP runtime call to `/auth/native/*`; all current clients use `/api/v1/auth/login`. They remain visible here only because the route probe preserves the old frozen manifests as historical input.
- One path compatibility gap for Relay continuation. The implementation exposes `/api/v1/repair-attempts/{attemptId}/dispatch/relay/continue`; the frozen manifest names `/api/v1/repair-attempts/{attemptId}/continue-relay`.
- Ten missing or not-yet-proven routes: occurrence creation, event streaming, notification read, Web Push subscription, project Build listing, Build webhook ingestion, upload-session lookup, attachment metadata, and Android notification-device registration/revocation.

The source was dirty and the preview service was running an earlier build during this baseline. A clean-source final build must be deployed to the same guarded preview instance and probed again. Only that later proof may be used as final route evidence; no development run in this directory establishes full HTTP acceptance.
