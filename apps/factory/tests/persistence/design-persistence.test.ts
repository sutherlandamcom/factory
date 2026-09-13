import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { DesignStore } from "../../src/design/design-store.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";
import { FactoryError } from "../../src/executor/errors.js";
import { parseDesignCandidateData, type DesignCandidateData } from "@factory/contracts";

/**
 * Run 6 persistence suite — real PostgreSQL (dedicated factory_test DB).
 * Covers: input snapshot derivation/idempotency, staleness across upstream
 * mutation, candidate immutability, human-acceptance digest binding,
 * rejection immutability, accepted-version allocation, cross-project
 * isolation, and restart durability (fresh store instance over same DB).
 */

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

async function seedProject(dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>>, key: string) {
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const project = await store.createProject({ key, name: `Project ${key}` });
  const payload = buildIntakePayload();
  await intake.saveDraft({ projectId: project.id, baseRevision: 0, payload });
  const accepted = await intake.accept({
    projectId: project.id,
    expectedRevision: 1,
    expectedDigest: deterministicDigest(payload),
  });
  return { projectId: project.id, inputSnapshot: accepted };
}

function candidateData(): DesignCandidateData {
  return parseDesignCandidateData({
    schemaVersion: "design-v1",
    provider: "google-stitch",
    providerProjectName: "projects/fixture",
    designMdDigest: "d".repeat(64),
    designMdToolVersion: "@google/design.md 0.4.0",
    designMdLint: { errors: 0, warnings: 0, infos: 0 },
    tokens: {
      colors: { primary: "#1A2E35" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
      spacing: { md: "16px" },
      rounded: { md: "8px" },
    },
    screens: [
      {
        id: "screen-1",
        providerScreenName: "projects/fixture/screens/abc",
        title: "Homepage",
        deviceType: "DESKTOP",
        archetype: "homepage",
      },
    ],
    archetypes: [
      {
        kind: "homepage",
        purpose: "Trust-first entry",
        providerScreenNames: ["projects/fixture/screens/abc"],
        sectionPatterns: ["hero", "evidence", "cta"],
        contentRequirements: ["Primary CTA visible"],
        assetSlots: [{ slot: "hero.primary", requirement: "Hero placeholder", placeholder: true }],
        primaryCta: "Request assessment",
        secondaryCta: "",
        responsiveBehavior: "Mobile-first stack",
        trustPresentation: "Author/date areas visible",
      },
    ],
    rationale: "Fixture rationale",
  });
}

test("PG: design input snapshot derives from accepted inputs and is idempotent on identical upstream", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const designStore = new DesignStore(dbInst.db);
  try {
    const seed = await seedProject(dbInst, "dsn1");
    const v1 = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    assert.equal(v1.version, 1);
    assert.match(v1.inputDigest, /^[0-9a-f]{64}$/);
    // Re-derivation with unchanged upstream returns the same snapshot.
    const again = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    assert.equal(again.id, v1.id);
    assert.equal(again.version, 1);
    // No accepted inputs -> fail closed.
    const empty = await seedProject(dbInst, "dsn1b");
    void empty;
    await assert.rejects(
      designStore.deriveInputSnapshotDraft({ projectId: "no-such-project" }),
      (e: unknown) => isCode(e, "design_input_not_accepted"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG: accepted-input mutation creates a new input snapshot version", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const designStore = new DesignStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const seed = await seedProject(dbInst, "dsn2");
    const v1 = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    // Mutate accepted inputs: edit draft + accept v2.
    const payload = buildIntakePayload();
    const draft = await intake.getDraft(seed.projectId);
    assert.ok(draft);
    const mutated = structuredClone(payload);
    (mutated as { brand: { positioning: string } }).brand.positioning = "Changed positioning";
    await intake.saveDraft({ projectId: seed.projectId, baseRevision: draft.revision, payload: mutated });
    await intake.accept({
      projectId: seed.projectId,
      expectedRevision: draft.revision + 1,
      expectedDigest: deterministicDigest(mutated),
    });
    const v2 = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    assert.equal(v2.version, 2);
    assert.notEqual(v2.inputDigest, v1.inputDigest);
    // v1 is now stale.
    const staleness = await designStore.inputSnapshotStaleness(seed.projectId, v1);
    assert.equal(staleness.stale, true);
    assert.match(staleness.reason ?? "", /changed/i);
    // v2 is current.
    const staleness2 = await designStore.inputSnapshotStaleness(seed.projectId, v2);
    assert.equal(staleness2.stale, false);
  } finally {
    await dbInst.close();
  }
});

test("PG: candidate persists immutably and acceptance binds exact digest", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const designStore = new DesignStore(dbInst.db);
  try {
    const seed = await seedProject(dbInst, "dsn3");
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    const data = candidateData();
    const candidate = await designStore.createCandidate({
      projectId: seed.projectId,
      inputSnapshot: snapshot,
      data,
    });
    assert.equal(candidate.approvalState, "pending");
    assert.equal(candidate.candidateDigest, deterministicDigest(data));

    // Wrong digest fails closed.
    await assert.rejects(
      designStore.acceptCandidate({
        projectId: seed.projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: "f".repeat(64),
        reviewNotes: null,
      }),
      (e: unknown) => isCode(e, "design_approval_failed"),
    );

    const accepted = await designStore.acceptCandidate({
      projectId: seed.projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: "Approved in review",
    });
    assert.equal(accepted.version, 1);
    assert.equal(accepted.candidateDigest, candidate.candidateDigest);
    assert.equal(accepted.inputDigest, snapshot.inputDigest);
    assert.equal(accepted.designMdDigest, data.designMdDigest);

    // Idempotent same-digest acceptance returns the same artifact.
    const again = await designStore.acceptCandidate({
      projectId: seed.projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: null,
    });
    assert.equal(again.id, accepted.id);

    // Accepted candidate cannot be rejected (immutable).
    await assert.rejects(
      designStore.rejectCandidate({
        projectId: seed.projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: candidate.candidateDigest,
        reviewNotes: null,
      }),
      (e: unknown) => isCode(e, "design_approval_failed"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG: rejected candidate can never become accepted; cross-project access fails", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const designStore = new DesignStore(dbInst.db);
  try {
    const seedA = await seedProject(dbInst, "dsn4a");
    const seedB = await seedProject(dbInst, "dsn4b");
    const snapshotA = await designStore.deriveInputSnapshotDraft({ projectId: seedA.projectId });
    const candidate = await designStore.createCandidate({
      projectId: seedA.projectId,
      inputSnapshot: snapshotA,
      data: candidateData(),
    });
    const rejected = await designStore.rejectCandidate({
      projectId: seedA.projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: "Does not meet quality floor",
    });
    assert.equal(rejected.approvalState, "rejected");
    await assert.rejects(
      designStore.acceptCandidate({
        projectId: seedA.projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: candidate.candidateDigest,
        reviewNotes: null,
      }),
      (e: unknown) => isCode(e, "design_approval_failed"),
    );
    // Cross-project candidate access fails closed.
    assert.equal(await designStore.getCandidate(seedB.projectId, candidate.id), null);
    await assert.rejects(
      designStore.acceptCandidate({
        projectId: seedB.projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: candidate.candidateDigest,
        reviewNotes: null,
      }),
      (e: unknown) => isCode(e, "design_not_found"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG: stale candidate acceptance is rejected when upstream inputs moved", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const designStore = new DesignStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  try {
    const seed = await seedProject(dbInst, "dsn5");
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    const candidate = await designStore.createCandidate({
      projectId: seed.projectId,
      inputSnapshot: snapshot,
      data: candidateData(),
    });
    // Mutate accepted inputs AFTER candidate creation.
    const payload = buildIntakePayload();
    const draft = await intake.getDraft(seed.projectId);
    assert.ok(draft);
    const mutated = structuredClone(payload);
    (mutated as { brand: { tone: string } }).brand.tone = "New tone";
    await intake.saveDraft({ projectId: seed.projectId, baseRevision: draft.revision, payload: mutated });
    await intake.accept({
      projectId: seed.projectId,
      expectedRevision: draft.revision + 1,
      expectedDigest: deterministicDigest(mutated),
    });
    // Acceptance must fail closed on the stale input digest.
    await assert.rejects(
      designStore.acceptCandidate({
        projectId: seed.projectId,
        candidateId: candidate.id,
        expectedCandidateDigest: candidate.candidateDigest,
        reviewNotes: null,
      }),
      (e: unknown) => isCode(e, "design_input_stale"),
    );
  } finally {
    await dbInst.close();
  }
});

test("PG: accepted design staleness tracks upstream content mutation; restart durability", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const seed = await seedProject(dbInst, "dsn6");
    let designStore = new DesignStore(dbInst.db);
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    const candidate = await designStore.createCandidate({
      projectId: seed.projectId,
      inputSnapshot: snapshot,
      data: candidateData(),
    });
    await designStore.acceptCandidate({
      projectId: seed.projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: null,
    });
    const latest1 = await designStore.latestAcceptedDesign(seed.projectId);
    assert.ok(latest1);
    assert.equal(latest1.staleness.stale, false);

    // RESTART: fresh store instance over the same DB (no reset).
    designStore = new DesignStore(dbInst.db);
    const latest2 = await designStore.latestAcceptedDesign(seed.projectId);
    assert.ok(latest2);
    assert.equal(latest2.artifact.id, latest1.artifact.id);
    assert.equal(latest2.staleness.stale, false);

    // Mutate upstream authority behind the design -> design becomes stale.
    // The seed has no accepted page content, so staleness is proven through
    // the "new accepted content exists" path (an upstream addition the
    // design's bound snapshot does not know about).
    await dbInst.db.execute(
      `INSERT INTO accepted_page_content (id, project_id, version, slug, proposal_id, proposal_version, proposal_digest, qa_report_digest, data, content_digest)
       VALUES ('wacc-dbg-stale', '${seed.projectId}', 1, 'fixture-page', 'p1', 1, '${"a".repeat(64)}', '${"b".repeat(64)}', '{}', '${"c".repeat(64)}')`,
    );
    const latest3 = await designStore.latestAcceptedDesign(seed.projectId);
    assert.ok(latest3);
    assert.equal(latest3.staleness.stale, true);
    assert.match(latest3.staleness.reason ?? "", /accepted content/i);
  } finally {
    await dbInst.close();
  }
});

test("PG: accepted design version allocation increments per project", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const designStore = new DesignStore(dbInst.db);
  try {
    const seed = await seedProject(dbInst, "dsn7");
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    const c1 = await designStore.createCandidate({
      projectId: seed.projectId,
      inputSnapshot: snapshot,
      data: candidateData(),
    });
    const a1 = await designStore.acceptCandidate({
      projectId: seed.projectId,
      candidateId: c1.id,
      expectedCandidateDigest: c1.candidateDigest,
      reviewNotes: null,
    });
    assert.equal(a1.version, 1);
    // New candidate (different rationale) after a NEW input snapshot version.
    const snapshot2 = await designStore.deriveInputSnapshotDraft({ projectId: seed.projectId });
    assert.equal(snapshot2.version, 1); // idempotent — unchanged upstream
    const data2 = parseDesignCandidateData({
      ...JSON.parse(JSON.stringify(candidateData())),
      rationale: "Revised rationale",
    });
    const c2 = await designStore.createCandidate({
      projectId: seed.projectId,
      inputSnapshot: snapshot2,
      data: data2,
    });
    const a2 = await designStore.acceptCandidate({
      projectId: seed.projectId,
      candidateId: c2.id,
      expectedCandidateDigest: c2.candidateDigest,
      reviewNotes: null,
    });
    assert.equal(a2.version, 2);
    const all = await designStore.listAcceptedDesigns(seed.projectId);
    assert.equal(all.length, 2);
  } finally {
    await dbInst.close();
  }
});
