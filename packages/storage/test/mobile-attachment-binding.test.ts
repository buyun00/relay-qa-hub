import assert from "node:assert/strict";
import test from "node:test";

import { bindMobileAttachment } from "../src/mobile-attachment-store.ts";
import { evidenceFixture, fingerprint, tx } from "./verification-result-evidence-fixture.ts";

test("attachment binding renews the same tuple exactly once after expiry", async (t) => {
  const fixture = await evidenceFixture(t);
  try {
    const staged = fixture.stage(1);
    const attachment = staged.attachments[0]!;
    const initial = staged.bindings[0]!;
    let clockMs = Date.parse(initial.expiresAt) - 1_000;
    fixture.database.function("unixepoch", { varargs: false }, (value) => {
      if (value === "now") return Math.floor(clockMs / 1_000);
      if (typeof value !== "string") return null;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null;
    });
    // This isolated fixture replaces SQLite's clock so the 15-minute lease can be
    // crossed without sleeping. Application connections keep trusted_schema off.
    fixture.database.exec("PRAGMA trusted_schema=ON");
    const renewal = (changes: Record<string, unknown> = {}) => ({
      ...fixture.scope,
      attachmentId: attachment.attachmentId,
      expectedVersion: initial.version,
      clientSubmissionId: attachment.clientSubmissionId,
      clientAttachmentId: attachment.clientAttachmentId,
      leaseGeneration: 2,
      intent: "verification_result" as const,
      targetQaItemId: staged.bugId,
      boundAt: new Date(clockMs).toISOString(),
      ...changes,
    });

    for (const invalid of [
      renewal(),
      renewal({ leaseGeneration: 3 }),
      renewal({ intent: "bug_create", targetQaItemId: undefined }),
    ]) {
      const before = fingerprint(fixture.database);
      assert.throws(
        () => tx(fixture.database, () => bindMobileAttachment(fixture.database, invalid)),
        /attachment (?:version conflict|reservation)/,
      );
      assert.deepEqual(fingerprint(fixture.database), before);
    }

    clockMs = Date.parse(initial.expiresAt) + 1_000;
    let before = fingerprint(fixture.database);
    assert.throws(
      () =>
        tx(fixture.database, () =>
          bindMobileAttachment(fixture.database, renewal({ expectedVersion: initial.version - 1 })),
        ),
      { code: "SQLITE_UPLOAD_VERSION_CONFLICT" },
    );
    assert.deepEqual(fingerprint(fixture.database), before);

    const renewed = tx(fixture.database, () => bindMobileAttachment(fixture.database, renewal()));
    assert.equal(renewed.bindingId, initial.bindingId);
    assert.equal(renewed.attachmentId, initial.attachmentId);
    assert.equal(renewed.clientSubmissionId, initial.clientSubmissionId);
    assert.equal(renewed.clientAttachmentId, initial.clientAttachmentId);
    assert.equal(renewed.intent, initial.intent);
    assert.equal(renewed.targetQaItemId, initial.targetQaItemId);
    assert.equal(renewed.leaseGeneration, 2);
    assert.equal(renewed.version, initial.version + 1);
    assert.equal(renewed.expiresAt, new Date(clockMs + 15 * 60_000).toISOString());
    assert.equal(renewed.replayed, false);
    assert.deepEqual(
      {
        ...fixture.database
          .prepare(
            `SELECT id, lease_generation, state, expires_at, claimed_at, bound_at, version
             FROM attachment_bindings WHERE id=?`,
          )
          .get(initial.bindingId),
      },
      {
        id: initial.bindingId,
        lease_generation: 2,
        state: "reserved",
        expires_at: renewed.expiresAt,
        claimed_at: null,
        bound_at: new Date(clockMs).toISOString(),
        version: 3,
      },
    );

    before = fingerprint(fixture.database);
    assert.deepEqual(
      tx(fixture.database, () => bindMobileAttachment(fixture.database, renewal())),
      {
        ...renewed,
        replayed: true,
      },
    );
    assert.deepEqual(fingerprint(fixture.database), before);

    assert.throws(
      () =>
        tx(fixture.database, () =>
          bindMobileAttachment(
            fixture.database,
            renewal({
              expectedVersion: renewed.version,
              leaseGeneration: 3,
              boundAt: new Date(clockMs).toISOString(),
            }),
          ),
        ),
      { code: "SQLITE_UPLOAD_VERSION_CONFLICT" },
    );

    clockMs = Date.now();
    fixture.submit(staged.input);
    clockMs = Date.parse(renewed.expiresAt) + 1_000;
    before = fingerprint(fixture.database);
    assert.throws(
      () =>
        tx(fixture.database, () =>
          bindMobileAttachment(fixture.database, {
            ...fixture.scope,
            attachmentId: attachment.attachmentId,
            expectedVersion: renewed.version,
            clientSubmissionId: attachment.clientSubmissionId,
            clientAttachmentId: attachment.clientAttachmentId,
            leaseGeneration: 3,
            intent: "verification_result",
            targetQaItemId: staged.bugId,
            boundAt: new Date(clockMs).toISOString(),
          }),
        ),
      { code: "SQLITE_IDEMPOTENCY_MISMATCH" },
    );
    assert.deepEqual(fingerprint(fixture.database), before);
  } finally {
    fixture.database.close();
  }
});
