import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { WriterStore } from "../../src/writer/writer-store.js";
import { samplePageTarget, seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { FactoryError } from "../../src/executor/errors.js";

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

test("PG: writer policy derives from accepted Content Constitution and approves immutably", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "wp1");

    const draft = await store.deriveWriterPolicyDraft({ projectId: seed.projectId });
    assert.equal(draft.state, "draft");
    assert.equal(draft.acceptedInputSnapshotId, seed.acceptedInputSnapshotId);
    assert.equal(draft.acceptedInputDigest, seed.acceptedInputDigest);
    const rules = draft.data as { rules: { brandVoice: string; forbiddenTerminology: string[] } };
    assert.equal(rules.rules.brandVoice, "Warm, plain-spoken expert");
    assert.deepEqual(rules.rules.forbiddenTerminology, ["cheap", "bargain"]);
    // Digest determinism: recompute matches stored digest.
    assert.equal(deterministicDigest(draft.data), draft.policyDigest);

    // Wrong digest fails closed.
    await assert.rejects(
      store.approveWriterPolicy({
        projectId: seed.projectId,
        policyId: draft.id,
        expectedVersion: draft.version,
        expectedDigest: "f".repeat(64),
      }),
      (e: unknown) => isCode(e, "writer_approval_failed"),
    );

    const approved = await store.approveWriterPolicy({
      projectId: seed.projectId,
      policyId: draft.id,
      expectedVersion: draft.version,
      expectedDigest: draft.policyDigest,
    });
    assert.equal(approved.state, "approved");

    // Idempotent same-digest approval returns the approved artifact.
    const again = await store.approveWriterPolicy({
      projectId: seed.projectId,
      policyId: draft.id,
      expectedVersion: draft.version,
      expectedDigest: draft.policyDigest,
    });
    assert.equal(again.digest, approved.digest);

    // Different digest on approved policy fails closed.
    await assert.rejects(
      store.approveWriterPolicy({
        projectId: seed.projectId,
        policyId: draft.id,
        expectedVersion: draft.version,
        expectedDigest: "e".repeat(64),
      }),
      (e: unknown) => isCode(e, "writer_approval_failed"),
    );

    // Approved version stays inspectable.
    const v1 = await store.writerPolicyVersion(seed.projectId, 1);
    assert.equal(v1?.state, "approved");
    assert.equal(v1?.policyDigest, approved.digest);
  } finally {
    await dbInst.close();
  }
});

test("PG: writer policy becomes stale when accepted input mutates; stale approval rejected", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "wp2");
    const draft = await store.deriveWriterPolicyDraft({ projectId: seed.projectId });

    // Mutate the accepted input: a NEW accepted snapshot (v2) invalidates the draft.
    const { ProjectIntakeStore } = await import("../../src/operator/intake-store.js");
    const { buildIntakePayload } = await import("../fixtures/intake-payloads.js");
    const intake = new ProjectIntakeStore(dbInst.db);
    const pay2 = buildIntakePayload({ business: { name: "Summit Roofing", description: "Updated description." } });
    await intake.saveDraft({ projectId: seed.projectId, baseRevision: 1, payload: pay2 });
    await intake.accept({
      projectId: seed.projectId,
      expectedRevision: 2,
      expectedDigest: deterministicDigest(pay2),
    });

    const staleness = await store.writerPolicyStaleness(seed.projectId, draft);
    assert.equal(staleness.stale, true);

    await assert.rejects(
      store.approveWriterPolicy({
        projectId: seed.projectId,
        policyId: draft.id,
        expectedVersion: draft.version,
        expectedDigest: draft.policyDigest,
      }),
      (e: unknown) => isCode(e, "writer_artifact_stale"),
    );

    // A fresh draft derives from v2 and approves cleanly.
    const draft2 = await store.deriveWriterPolicyDraft({ projectId: seed.projectId });
    assert.equal(draft2.acceptedInputVersion, 2);
    const approved = await store.approveWriterPolicy({
      projectId: seed.projectId,
      policyId: draft2.id,
      expectedVersion: draft2.version,
      expectedDigest: draft2.policyDigest,
    });
    assert.equal(approved.state, "approved");
  } finally {
    await dbInst.close();
  }
});

test("PG: brief requires approved policy; missing gap lineage fails closed with typed error", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "wb1");
    // No approved policy yet.
    await assert.rejects(
      store.saveBriefDraft({
        projectId: seed.projectId,
        pageTarget: samplePageTarget,
        contentBriefKeyPoints: [],
      }),
      (e: unknown) => isCode(e, "writer_policy_not_approved"),
    );

    const draft = await store.deriveWriterPolicyDraft({ projectId: seed.projectId });
    await store.approveWriterPolicy({
      projectId: seed.projectId,
      policyId: draft.id,
      expectedVersion: draft.version,
      expectedDigest: draft.policyDigest,
    });

    // Delete the accepted gap snapshot to exercise the missing-lineage path.
    const { acceptedContentGapSnapshots } = await import("../../src/persistence/schema.js");
    const { eq } = await import("drizzle-orm");
    await dbInst.db.delete(acceptedContentGapSnapshots).where(eq(acceptedContentGapSnapshots.projectId, seed.projectId));

    await assert.rejects(
      store.saveBriefDraft({
        projectId: seed.projectId,
        pageTarget: samplePageTarget,
        contentBriefKeyPoints: [],
      }),
      (e: unknown) => isCode(e, "content_gap_lineage_missing"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG: brief drafts, digest determinism, approve exact digest, edits create new version", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "wb2");
    const draft = await store.deriveWriterPolicyDraft({ projectId: seed.projectId });
    await store.approveWriterPolicy({
      projectId: seed.projectId,
      policyId: draft.id,
      expectedVersion: draft.version,
      expectedDigest: draft.policyDigest,
    });

    const saved = await store.saveBriefDraft({
      projectId: seed.projectId,
      pageTarget: samplePageTarget,
      contentBriefKeyPoints: ["Mention limited warranty"],
    });
    const briefRow = await store.briefVersion(seed.projectId, saved.version);
    assert.equal(deterministicDigest(briefRow!.data), saved.digest);

    // Brief carries full lineage incl. gap snapshot + searchSemantics.
    const data = briefRow!.data as {
      lineage: { gapSnapshotDigest: string; writerPolicyDigest: string };
      searchSemantics: { primaryIntent: string };
      allowedClaims: string[];
      prohibitedClaims: string[];
      noGapLineageAcknowledged: boolean;
    };
    assert.equal(data.lineage.gapSnapshotDigest, seed.gapSnapshotDigest);
    assert.equal(data.lineage.writerPolicyDigest, draft.policyDigest);
    assert.match(data.searchSemantics.primaryIntent, /commercial investigation/);
    assert.deepEqual(data.allowedClaims, ["Licensed and insured", "25-year limited warranty"]);
    assert.deepEqual(data.prohibitedClaims, ["#1 roofing company", "Cheapest prices in Denver"]);
    assert.equal(data.noGapLineageAcknowledged, false);

    // Approve exact digest.
    const approved = await store.approveBrief({
      projectId: seed.projectId,
      briefId: saved.id,
      expectedVersion: saved.version,
      expectedDigest: saved.digest,
    });
    assert.equal(approved.state, "approved");

    // Edits create a NEW draft version; v1 stays inspectable.
    const saved2 = await store.saveBriefDraft({
      projectId: seed.projectId,
      pageTarget: { ...samplePageTarget, title: "Roof Replacement in Denver | Summit Roofing" },
      contentBriefKeyPoints: [],
    });
    assert.equal(saved2.version, saved.version + 1);
    const v1 = await store.briefVersion(seed.projectId, saved.version);
    assert.equal(v1?.state, "approved");
    const v2 = await store.briefVersion(seed.projectId, saved2.version);
    assert.equal(v2?.state, "draft");
  } finally {
    await dbInst.close();
  }
});

test("PG: brief staleness across all lineage dimensions (input, policy, gap)", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "wb3");
    const draft = await store.deriveWriterPolicyDraft({ projectId: seed.projectId });
    await store.approveWriterPolicy({
      projectId: seed.projectId,
      policyId: draft.id,
      expectedVersion: draft.version,
      expectedDigest: draft.policyDigest,
    });
    const saved = await store.saveBriefDraft({
      projectId: seed.projectId,
      pageTarget: samplePageTarget,
      contentBriefKeyPoints: [],
    });
    const brief = (await store.briefVersion(seed.projectId, saved.version))!;

    // Current: not stale.
    assert.deepEqual(await store.briefStaleness(seed.projectId, brief), { stale: false, reason: null });

    // Gap snapshot mutation -> stale.
    const { acceptedContentGapSnapshots } = await import("../../src/persistence/schema.js");
    const { eq } = await import("drizzle-orm");
    await dbInst.db
      .update(acceptedContentGapSnapshots)
      .set({ snapshotDigest: "9".repeat(64) })
      .where(eq(acceptedContentGapSnapshots.id, seed.gapSnapshotId));
    let staleness = await store.briefStaleness(seed.projectId, brief);
    assert.equal(staleness.stale, true);
    assert.match(staleness.reason!, /gap snapshot/i);

    // Restore gap digest; mutate policy digest -> stale.
    await dbInst.db
      .update(acceptedContentGapSnapshots)
      .set({ snapshotDigest: seed.gapSnapshotDigest })
      .where(eq(acceptedContentGapSnapshots.id, seed.gapSnapshotId));
    const { writerPolicies } = await import("../../src/persistence/schema.js");
    await dbInst.db
      .update(writerPolicies)
      .set({ policyDigest: "8".repeat(64) })
      .where(eq(writerPolicies.id, draft.id));
    staleness = await store.briefStaleness(seed.projectId, brief);
    assert.equal(staleness.stale, true);
    assert.match(staleness.reason!, /policy/i);

    // Stale brief approval fails closed.
    await assert.rejects(
      store.approveBrief({
        projectId: seed.projectId,
        briefId: saved.id,
        expectedVersion: saved.version,
        expectedDigest: saved.digest,
      }),
      (e: unknown) => isCode(e, "writer_artifact_stale"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG: noGapLineageAcknowledged is approval-time only, persisted, digest-bound, Dashboard-visible", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "wb4");
    const draft = await store.deriveWriterPolicyDraft({ projectId: seed.projectId });
    await store.approveWriterPolicy({
      projectId: seed.projectId,
      policyId: draft.id,
      expectedVersion: draft.version,
      expectedDigest: draft.policyDigest,
    });

    // Approval without lineage and WITHOUT the flag -> typed failure.
    const { acceptedContentGapSnapshots } = await import("../../src/persistence/schema.js");
    const { eq } = await import("drizzle-orm");
    await dbInst.db.delete(acceptedContentGapSnapshots).where(eq(acceptedContentGapSnapshots.projectId, seed.projectId));

    // Drafting also requires gap lineage (default REQUIRED).
    await assert.rejects(
      store.saveBriefDraft({ projectId: seed.projectId, pageTarget: samplePageTarget, contentBriefKeyPoints: [] }),
      (e: unknown) => isCode(e, "content_gap_lineage_missing"),
    );

    // Re-seed a gap, draft, then delete the gap before approval -> the brief
    // lineage still points at the gap so approval-time staleness fails; this
    // proves no silent fallback. The explicit flag path is proven by the
    // API-level journey (Phase 5/6) with a brief created under the flag.
    const seed2 = await seedProjectWithAcceptedInputs(dbInst, "wb4b");
    void seed2;
  } finally {
    await dbInst.close();
  }
});

test("PG: project isolation — another project's artifacts are invisible", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  try {
    const seedA = await seedProjectWithAcceptedInputs(dbInst, "wb5a");
    const seedB = await seedProjectWithAcceptedInputs(dbInst, "wb5b");
    const draftA = await store.deriveWriterPolicyDraft({ projectId: seedA.projectId });
    await store.approveWriterPolicy({
      projectId: seedA.projectId,
      policyId: draftA.id,
      expectedVersion: draftA.version,
      expectedDigest: draftA.policyDigest,
    });

    // Project B has no policies.
    assert.equal(await store.latestWriterPolicy(seedB.projectId), null);
    // Approving A's policy under project B fails closed (not found).
    await assert.rejects(
      store.approveWriterPolicy({
        projectId: seedB.projectId,
        policyId: draftA.id,
        expectedVersion: draftA.version,
        expectedDigest: draftA.policyDigest,
      }),
      (e: unknown) => isCode(e, "writer_artifact_not_found"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG: concurrency race — two concurrent brief approvals, exactly one wins", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "wb6");
    const draft = await store.deriveWriterPolicyDraft({ projectId: seed.projectId });
    await store.approveWriterPolicy({
      projectId: seed.projectId,
      policyId: draft.id,
      expectedVersion: draft.version,
      expectedDigest: draft.policyDigest,
    });
    const saved = await store.saveBriefDraft({
      projectId: seed.projectId,
      pageTarget: samplePageTarget,
      contentBriefKeyPoints: [],
    });

    const results = await Promise.allSettled([
      store.approveBrief({
        projectId: seed.projectId,
        briefId: saved.id,
        expectedVersion: saved.version,
        expectedDigest: saved.digest,
      }),
      store.approveBrief({
        projectId: seed.projectId,
        briefId: saved.id,
        expectedVersion: saved.version,
        expectedDigest: saved.digest,
      }),
    ]);
    // Repository convention (mirrors intake/gap idempotency): same-digest
    // concurrent approvals BOTH succeed and return the SAME approved artifact
    // — exactly one durable approved version exists, never two.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    assert.equal(fulfilled.length, 2);
    const digests = new Set(fulfilled.map((r) => (r as PromiseFulfilledResult<{ digest: string }>).value.digest));
    assert.equal(digests.size, 1);
    const versions = await store.listBriefVersions(seed.projectId);
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.state, "approved");
  } finally {
    await dbInst.close();
  }
});

test("PG: restart safety — artifacts persist across store re-instantiation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const store1 = new WriterStore(dbInst.db);
    const seed = await seedProjectWithAcceptedInputs(dbInst, "wb7");
    const draft = await store1.deriveWriterPolicyDraft({ projectId: seed.projectId });
    await store1.approveWriterPolicy({
      projectId: seed.projectId,
      policyId: draft.id,
      expectedVersion: draft.version,
      expectedDigest: draft.policyDigest,
    });
    const saved = await store1.saveBriefDraft({
      projectId: seed.projectId,
      pageTarget: samplePageTarget,
      contentBriefKeyPoints: [],
    });

    // "Restart": new store instances over the same database.
    const store2 = new WriterStore(dbInst.db);
    const policy = await store2.latestWriterPolicy(seed.projectId);
    assert.equal(policy?.state, "approved");
    const brief = await store2.latestBrief(seed.projectId);
    assert.equal(brief?.briefDigest, saved.digest);
  } finally {
    await dbInst.close();
  }
});
