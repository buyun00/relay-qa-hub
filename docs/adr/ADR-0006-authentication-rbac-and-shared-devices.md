# ADR-0006: Authentication, project RBAC, machine scopes, and shared-device isolation

- Status: Accepted
- Date: 2026-08-24
- Owners: Relay QA Hub security

## Context

The product contains confidential evidence and human acceptance decisions, is used across multiple projects, and must support borrowed test phones. Browser sessions, report invitation links, and integration services have different trust levels. A system administrator or machine identity must not implicitly gain the verifier's business authority.

## Decision

1. Production prefers OIDC through an adapter. The independent fallback is a local identity store with a one-time administrator bootstrap, modern password hashing, reset/revocation, and login throttling.
2. Browser authentication uses QA Hub sessions only. Cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`; state-changing requests also enforce CSRF token, strict Origin, and allowed Host checks.
3. Authorization is project-scoped RBAC for viewer, reporter, developer, verifier, triager, release manager, and project admin. System admin is operational and does not automatically receive business verification rights.
4. Machine identities are separate principals with narrow scopes such as handoff creation or signed event ingestion. They cannot verify, close, reject, defer, or decide semantic duplicates.
5. Resource access is resolved through project membership before returning data. Cross-project IDs for Bugs, attachments, builds, verifications, notifications, and integrations return a non-disclosing 403/404 policy result.
6. Critical writes create append-only audit Events in the same transaction with actor, request/correlation IDs, before/after state, and reason. Audit failure fails the critical action closed.
7. Audit and application logs exclude request bodies, cookies, authorization, passwords, tokens, raw attachments, and unredacted account identifiers.
8. Reporter invitation QR links are short-lived, revocable, and limited to a project/build/test-cycle report capability; they do not grant list or administrative access.
9. Shared-device sessions default to 30 minutes idle, do not request Push, and on logout revoke device subscriptions and clear that user's IndexedDB, Cache Storage, and in-memory previews.
10. Security headers, rate limits, safe attachment delivery, secret rotation, and automated RBAC/CSRF/IDOR tests are release gates rather than optional hardening.

## Consequences

### Positive

- Human decisions remain attributable and cannot be performed by integrations.
- Project boundaries and borrowed-device data isolation are explicit and testable.
- OIDC can be added without coupling identity to Relay or Qingyu.

### Costs and risks

- Local authentication fallback, session revocation, CSRF, invitations, and device cleanup add implementation and test surface.
- Shared-device cleanup is browser-capability dependent and needs real-device evidence.
- RBAC must be tested endpoint-by-endpoint to avoid authorization drift.

## Rejected alternatives

- **Reuse Relay or Qingyu sessions:** couples availability, cookies, identity lifecycle, and privilege models.
- **Global role only:** cannot prevent cross-project access and assignment leakage.
- **System admin implies verifier:** breaks separation of operational and business authority.
- **One API token for all integrations:** prevents least privilege and safe rotation.
- **Persistent shared-phone session and drafts:** risks data exposure between testers.
