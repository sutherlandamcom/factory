import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { WriterStore, WriterSnapshotStore, WriterQaStore } from "../../src/writer/writer-store.js";
import { WriterService } from "../../src/writer/service.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { runContentQa } from "../../src/writer/qa.js";
import { samplePageTarget, seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { FactoryError } from "../../src/executor/errors.js";
import type { PageContentProposalData } from "@factory/contracts";

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

const GOOD_PROPOSAL = {
  title: "Roof Replacement in Denver",
  metaDescription: "Licensed Denver roof replacement with a limited warranty.",
  introduction:
    "Commercial roofing decisions in Denver involve hailstorms and freeze-thaw cycles put every roof under storm-damage stress. Homeowners comparing local roofers need clear answers about roof replacement cost drivers, process and trust signals before requesting a quote.",
  sections: [
    {
      heading: "What a full roof replacement includes",
      body:
        "A full roof replacement covers tear-off, deck inspection, underlayment and shingle installation. Licensed and insured crews handle permits and disposal.",
    },
    {
      heading: "Timeline and process",
      body:
        "Most replacements finish within days of material delivery. The inspection, scheduling and installation steps are explained before work begins.",
    },
    {
      heading: "Warranty and workmanship",
      body:
        "Work carries a 25-year limited warranty. Licensing and insurance details are provided on request so homeowners can verify trust signals.",
    },
  ],
  conclusion:
    "Understanding cost drivers and process steps makes comparing roofers straightforward. Serving Denver since 1998 with a BBB A+ rating.",
  cta: "Book a free roof inspection today.",
  internalLinks: ["storm-damage-repair"],
};

const BRIEF_DATA = {
  lineage: {
    acceptedInputSnapshotId: "s",
    acceptedInputSnapshotVersion: 1,
    acceptedInputDigest: "a".repeat(64),
    writerPolicyId: "p",
    writerPolicyVersion: 1,
    writerPolicyDigest: "b".repeat(64),
    gapSnapshotId: "g",
    gapSnapshotVersion: 1,
    gapSnapshotDigest: "c".repeat(64),
  },
  pageTarget: samplePageTarget,
  allowedClaims: ["Licensed and insured", "25-year limited warranty"],
  prohibitedClaims: ["#1 roofing company", "Cheapest prices in Denver"],
  unknownClaims: ["Insurance approval timelines"],
  operatorFacts: ["Serving Denver since 1998", "BBB A+ rating"],
  searchSemantics: {
    primaryIntent: "commercial investigation — local roofing replacement",
    semanticCoverageRequirements: [
      "What a full roof replacement includes",
      "Typical timeline and process steps",
      "Warranty and workmanship guarantees",
    ],
    userNeeds: [
      "Understand cost drivers before requesting a quote",
      "Trust signals: licensing, insurance, reviews",
    ],
  },
  contentBriefKeyPoints: [],
  noGapLineageAcknowledged: false,
} as never;

const POLICY_RULES = {
  forbiddenTerminology: ["cheap", "bargain"],
  aiLanguageAvoidance: ["delve", "unleash", "elevate"],
  clicheAvoidance: ["your one-stop shop", "we've got you covered"],
  localePreferences: "US English",
};

function proposalData(overrides: Partial<PageContentProposalData> = {}): PageContentProposalData {
  return {
    schemaVersion: "writer-content-v1",
    snapshotId: "s",
    snapshotVersion: 1,
    snapshotDigest: "a".repeat(64),
    ...GOOD_PROPOSAL,
    ...overrides,
  } as PageContentProposalData;
}

// ---- Deterministic triad unit checks ------------------------------------------

test("QA triad: clean proposal passes all three families", () => {
  const report = runContentQa(proposalData(), BRIEF_DATA, POLICY_RULES);
  assert.equal(report.overall, "PASS", JSON.stringify(report, null, 2));
  assert.ok(report.factual.length >= 4);
  assert.ok(report.search.length >= 3);
  assert.ok(report.editorial.length >= 4);
  // No fake numeric scores anywhere.
  for (const c of [...report.factual, ...report.search, ...report.editorial]) {
    assert.ok(!("score" in c));
    assert.ok(["PASS", "REVIEW", "FAIL"].includes(c.verdict));
  }
});

test("QA factual: prohibited claim -> FAIL; invented number -> FAIL; unverified -> REVIEW", () => {
  const withProhibited = proposalData({
    introduction: "We are the #1 roofing company in Denver with the cheapest prices in Denver.",
  });
  const r1 = runContentQa(withProhibited, BRIEF_DATA, POLICY_RULES);
  assert.equal(r1.overall, "FAIL");
  assert.ok(r1.factual.some((c) => c.checkId === "factual.prohibited_claims" && c.verdict === "FAIL"));

  const withInvented = proposalData({
    sections: [
      ...GOOD_PROPOSAL.sections,
      { heading: "Pricing", body: "Roof replacement costs exactly 14750 dollars for every home." },
    ],
  });
  const r2 = runContentQa(withInvented, BRIEF_DATA, POLICY_RULES);
  assert.ok(r2.factual.some((c) => c.checkId === "factual.no_invented_numbers" && c.verdict === "FAIL"));

  const withUnverified = proposalData({
    sections: [
      ...GOOD_PROPOSAL.sections,
      { heading: "Insurance", body: "Insurance approval timelines are handled by our office." },
    ],
  });
  const r3 = runContentQa(withUnverified, BRIEF_DATA, POLICY_RULES);
  assert.ok(r3.factual.some((c) => c.checkId === "factual.unverified_claims" && c.verdict === "REVIEW"));
});

test("QA factual: zero materialized operator facts -> REVIEW (never silent PASS)", () => {
  const factless = proposalData({
    conclusion: "Understanding cost drivers and process steps makes comparing roofers straightforward.",
  });
  const report = runContentQa(factless, BRIEF_DATA, POLICY_RULES);
  const f2 = report.factual.find((c) => c.checkId === "factual.evidence_trace")!;
  assert.equal(f2.verdict, "REVIEW");
  assert.match(f2.detail, /^0\/2 operator facts/);
});

test("QA factual: intake identity numbers are legitimate evidence (no false-positive FAIL)", () => {
  const withPhone = proposalData({ cta: "Call (555) 010-0100 to book a free roof inspection today." });
  const withoutExtras = runContentQa(withPhone, BRIEF_DATA, POLICY_RULES);
  assert.ok(
    withoutExtras.factual.some((c) => c.checkId === "factual.no_invented_numbers" && c.verdict === "FAIL"),
    "without the intake identity extras, the CTA phone reads as invented (proves the check bites)",
  );
  const withExtras = runContentQa(withPhone, BRIEF_DATA, POLICY_RULES, ["(555) 010-0100"]);
  assert.ok(
    !withExtras.factual.some((c) => c.checkId === "factual.no_invented_numbers" && c.verdict === "FAIL"),
    "accepted intake identity numbers must not false-positive",
  );
});

test("QA search: waived gap lineage -> explicit REVIEW (never silent PASS)", () => {
  const waivedBrief = {
    ...(BRIEF_DATA as Record<string, unknown>),
    lineage: {
      acceptedInputSnapshotId: "s",
      acceptedInputSnapshotVersion: 1,
      acceptedInputDigest: "a".repeat(64),
      writerPolicyId: "p",
      writerPolicyVersion: 1,
      writerPolicyDigest: "b".repeat(64),
    },
    noGapLineageAcknowledged: true,
  } as never;
  const report = runContentQa(proposalData(), waivedBrief, POLICY_RULES);
  assert.equal(report.search.length, 1);
  assert.equal(report.search[0]!.checkId, "search.lineage_waived");
  assert.equal(report.search[0]!.verdict, "REVIEW");
  assert.equal(report.overall, "REVIEW", "waived search lineage must surface to the human gate");
});

test("QA search: uncovered requirement -> REVIEW; no keyword-density scoring exists", () => {
  const missing = proposalData({
    sections: GOOD_PROPOSAL.sections.slice(0, 1), // drops timeline + warranty coverage
  });
  const r = runContentQa(missing, BRIEF_DATA, POLICY_RULES);
  assert.equal(r.overall, "REVIEW");
  assert.ok(r.search.some((c) => c.checkId === "search.semantic_coverage" && c.verdict === "REVIEW"));
  // Evidence refs point at covering sections for covered requirements.
  const covered = runContentQa(proposalData(), BRIEF_DATA, POLICY_RULES);
  const covCheck = covered.search.find((c) => c.checkId === "search.semantic_coverage")!;
  assert.ok(covCheck.evidence.every((e) => (e.note ?? "").includes("covered in")));
});

test("QA editorial: forbidden terminology -> FAIL; AI cliché -> FAIL; structure drift -> REVIEW", () => {
  const withForbidden = proposalData({ cta: "Get the cheapest bargain roof inspection today." });
  const r1 = runContentQa(withForbidden, BRIEF_DATA, POLICY_RULES);
  assert.ok(r1.editorial.some((c) => c.checkId === "editorial.forbidden_terminology" && c.verdict === "FAIL"));

  const withCliche = proposalData({
    introduction: "Let's delve into why we've got you covered — we are your one-stop shop.",
  });
  const r2 = runContentQa(withCliche, BRIEF_DATA, POLICY_RULES);
  assert.ok(r2.editorial.some((c) => c.checkId === "editorial.ai_cliche" && c.verdict === "FAIL"));

  const withStructureDrift = proposalData({
    sections: [{ heading: "Something unrelated", body: "Text." }],
  });
  const r3 = runContentQa(withStructureDrift, BRIEF_DATA, POLICY_RULES);
  assert.ok(r3.editorial.some((c) => c.checkId === "editorial.structure_integrity" && c.verdict === "REVIEW"));

  const withEmptyCta = proposalData({ cta: "" });
  const r4 = runContentQa(withEmptyCta, BRIEF_DATA, POLICY_RULES);
  assert.throws(() => pageContentProposalDataSchema.parse(withEmptyCta)); // schema itself rejects empty CTA
  void r4;
});

import { pageContentProposalDataSchema } from "@factory/contracts";

// ---- Service-level QA + acceptance gate ----------------------------------------

async function setupThroughProposal(key: string, proposalOverride: Partial<PageContentProposalData> = {}) {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  const snapshotStore = new WriterSnapshotStore(dbInst.db);
  const qaStore = new WriterQaStore(dbInst.db);
  const service = new WriterService(store, snapshotStore, new WriterBudgetStore(dbInst.db), qaStore);
  const seed = await seedProjectWithAcceptedInputs(dbInst, key);
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
  await store.approveBrief({
    projectId: seed.projectId,
    briefId: saved.id,
    expectedVersion: saved.version,
    expectedDigest: saved.digest,
  });
  const snap = await service.compileSnapshot({ projectId: seed.projectId });
  await service.approveSnapshot({
    projectId: seed.projectId,
    snapshotId: snap.id,
    expectedVersion: snap.version,
    expectedDigest: snap.digest,
  });
  const proposal = await service.generateProposal(
    { projectId: seed.projectId, snapshotId: snap.id },
    {
      invoke: async () => ({
        requestedModel: "m",
        respondedModel: "m",
        provider: "p",
        durationMs: 1,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        costUsd: null,
        content: JSON.stringify({ ...GOOD_PROPOSAL, ...proposalOverride }),
      }),
      env: { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" },
    },
  );
  return { dbInst, service, store, qaStore, seed, proposal };
}

test("service QA: verdicts persisted bound to exact proposal digest; accept blocked without QA", async () => {
  const { dbInst, service, seed, proposal } = await setupThroughProposal("wq1");
  try {
    // Acceptance WITHOUT a QA report fails closed.
    await assert.rejects(
      service.acceptContent({
        projectId: seed.projectId,
        proposalId: proposal.id,
        expectedProposalDigest: proposal.digest,
      }),
      (e: unknown) => isCode(e, "content_accept_failed"),
    );

    const qa = await service.runQa({ projectId: seed.projectId });
    assert.equal(qa.proposalDigest, proposal.digest);
    assert.equal(qa.overall, "PASS");

    const accepted = await service.acceptContent({
      projectId: seed.projectId,
      proposalId: proposal.id,
      expectedProposalDigest: proposal.digest,
    });
    assert.equal(accepted.version, 1);
    assert.equal(accepted.slug, samplePageTarget.slug);

    // Wrong digest fails closed.
    await assert.rejects(
      service.acceptContent({
        projectId: seed.projectId,
        proposalId: proposal.id,
        expectedProposalDigest: "f".repeat(64),
      }),
      (e: unknown) => isCode(e, "content_accept_failed"),
    );
  } finally {
    await dbInst.close();
  }
});

test("service QA: FAIL overall blocks acceptance; accepted content persists and is inspectable", async () => {
  const { dbInst, service, seed, proposal } = await setupThroughProposal("wq2", {
    introduction: "We are the #1 roofing company serving Denver since 1998.",
  });
  try {
    const qa = await service.runQa({ projectId: seed.projectId });
    assert.equal(qa.overall, "FAIL");
    await assert.rejects(
      service.acceptContent({
        projectId: seed.projectId,
        proposalId: proposal.id,
        expectedProposalDigest: proposal.digest,
      }),
      (e: unknown) => isCode(e, "content_accept_failed"),
    );
    const ws = await service.acceptedContentWorkspace(seed.projectId);
    assert.equal(ws.latest, null);
  } finally {
    await dbInst.close();
  }
});

test("service QA: REVIEW overall permits human acceptance (human gate decides)", async () => {
  const { dbInst, service, seed, proposal } = await setupThroughProposal("wq3", {
    sections: GOOD_PROPOSAL.sections.slice(0, 2), // one requirement uncovered -> REVIEW
  });
  try {
    const qa = await service.runQa({ projectId: seed.projectId });
    assert.equal(qa.overall, "REVIEW");
    const accepted = await service.acceptContent({
      projectId: seed.projectId,
      proposalId: proposal.id,
      expectedProposalDigest: proposal.digest,
    });
    assert.equal(accepted.version, 1);
    const ws = await service.acceptedContentWorkspace(seed.projectId);
    assert.equal(ws.latest?.version, 1);
  } finally {
    await dbInst.close();
  }
});

test("service QA: report is insert-only — same-digest re-run idempotent; accepted view digests populated and never orphaned", async () => {
  const { dbInst, service, seed, proposal } = await setupThroughProposal("wq4");
  try {
    const qa1 = await service.runQa({ projectId: seed.projectId });
    assert.equal(qa1.overall, "PASS");
    const qa2 = await service.runQa({ projectId: seed.projectId });
    assert.equal(qa2.reportId, qa1.reportId, "same-digest re-run returns the SAME stored report");
    assert.equal(qa2.digest, qa1.digest);
    assert.equal(qa2.overall, qa1.overall);
    const { contentQaReports, acceptedPageContent, writerPolicies } = await import("../../src/persistence/schema.js");
    const { eq } = await import("drizzle-orm");
    let rows = await dbInst.db.select().from(contentQaReports).where(eq(contentQaReports.proposalId, proposal.id));
    assert.equal(rows.length, 1, "exactly one stored report row (never replaced)");

    // Accept: the view carries the binding digests from the stored record.
    const accepted = await service.acceptContent({
      projectId: seed.projectId,
      proposalId: proposal.id,
      expectedProposalDigest: proposal.digest,
    });
    assert.equal(accepted.proposalId, proposal.id);
    assert.equal(accepted.proposalDigest, proposal.digest);
    assert.equal(accepted.qaReportDigest, qa1.digest);
    const ws = await service.acceptedContentWorkspace(seed.projectId);
    assert.equal(ws.latest!.proposalId, proposal.id);
    assert.equal(ws.latest!.proposalDigest, proposal.digest);
    assert.equal(ws.latest!.qaReportDigest, qa1.digest);

    // Post-acceptance re-QA under a CHANGED writer policy (fresh recompute
    // would now FAIL) must not replace the stored report nor orphan the
    // accepted row's qa_report_digest reference.
    const [policyRow] = await dbInst.db.select().from(writerPolicies).where(eq(writerPolicies.projectId, seed.projectId));
    const mutatedData = JSON.parse(JSON.stringify(policyRow!.data));
    mutatedData.rules.forbiddenTerminology = [...(mutatedData.rules.forbiddenTerminology ?? []), "roof"];
    await dbInst.db.update(writerPolicies).set({ data: mutatedData }).where(eq(writerPolicies.id, policyRow!.id));

    const qa3 = await service.runQa({ projectId: seed.projectId });
    assert.equal(qa3.reportId, qa1.reportId);
    assert.equal(qa3.digest, qa1.digest, "stored digest unchanged (insert-only)");
    assert.equal(qa3.overall, "PASS", "persisted verdicts win over the silently recomputed FAIL");
    rows = await dbInst.db.select().from(contentQaReports).where(eq(contentQaReports.proposalId, proposal.id));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.reportDigest, qa1.digest);
    const [acceptedRow] = await dbInst.db
      .select()
      .from(acceptedPageContent)
      .where(eq(acceptedPageContent.projectId, seed.projectId));
    assert.equal(acceptedRow!.qaReportDigest, qa1.digest, "accepted reference still resolves to the stored report");
  } finally {
    await dbInst.close();
  }
});

test("service QA: acceptance verifies the TRANSITIVE upstream chain (policy, gap, intake) and rejects stale with writer_artifact_stale", async () => {
  const { dbInst, service, seed, proposal } = await setupThroughProposal("wq6");
  try {
    await service.runQa({ projectId: seed.projectId });
    const accept = () =>
      service.acceptContent({
        projectId: seed.projectId,
        proposalId: proposal.id,
        expectedProposalDigest: proposal.digest,
      });
    const { writerPolicies, acceptedContentGapSnapshots } = await import("../../src/persistence/schema.js");
    const { eq } = await import("drizzle-orm");

    // Writer policy mutated -> stale.
    const [policyRow] = await dbInst.db.select().from(writerPolicies).where(eq(writerPolicies.projectId, seed.projectId));
    const originalPolicyDigest = policyRow!.policyDigest;
    await dbInst.db.update(writerPolicies).set({ policyDigest: "7".repeat(64) }).where(eq(writerPolicies.id, policyRow!.id));
    await assert.rejects(accept, (e: unknown) => isCode(e, "writer_artifact_stale"));
    await dbInst.db.update(writerPolicies).set({ policyDigest: originalPolicyDigest }).where(eq(writerPolicies.id, policyRow!.id));

    // Gap snapshot mutated -> stale.
    const [gapRow] = await dbInst.db
      .select()
      .from(acceptedContentGapSnapshots)
      .where(eq(acceptedContentGapSnapshots.projectId, seed.projectId));
    const originalGapDigest = gapRow!.snapshotDigest;
    await dbInst.db
      .update(acceptedContentGapSnapshots)
      .set({ snapshotDigest: "6".repeat(64) })
      .where(eq(acceptedContentGapSnapshots.id, gapRow!.id));
    await assert.rejects(accept, (e: unknown) => isCode(e, "writer_artifact_stale"));
    await dbInst.db
      .update(acceptedContentGapSnapshots)
      .set({ snapshotDigest: originalGapDigest })
      .where(eq(acceptedContentGapSnapshots.id, gapRow!.id));

    // Chain current again -> acceptance succeeds (default path unchanged).
    const accepted = await accept();
    assert.equal(accepted.version, 1);

    // Exact proposal replay returns historical acceptance without promoting it;
    // changed intake still prevents the page from conferring current authority.
    const { ProjectIntakeStore } = await import("../../src/operator/intake-store.js");
    const { buildIntakePayload } = await import("../fixtures/intake-payloads.js");
    const { deterministicDigest } = await import("../../src/intelligence/digest.js");
    const intake = new ProjectIntakeStore(dbInst.db);
    const pay2 = buildIntakePayload({ business: { name: "Summit Roofing", description: "Updated description." } });
    await intake.saveDraft({ projectId: seed.projectId, baseRevision: 1, payload: pay2 });
    await intake.accept({
      projectId: seed.projectId,
      expectedRevision: 2,
      expectedDigest: deterministicDigest(pay2),
    });
    assert.equal((await accept()).id, accepted.id);
    const { PageAuthorityReader } = await import("../../src/writer/page-authority.js");
    await assert.rejects(new PageAuthorityReader(dbInst.db).requireCurrent(seed.projectId, { id: accepted.id, version: accepted.version, slug: accepted.slug, contentDigest: accepted.digest }), (e: unknown) => isCode(e, "writer_artifact_stale"));
  } finally {
    await dbInst.close();
  }
});

test("service QA: concurrent acceptance of two slugs never 500s — typed content_accept_failed, contiguous versions", async () => {
  const { dbInst, service, store, seed, proposal } = await setupThroughProposal("wq7");
  try {
    await service.runQa({ projectId: seed.projectId }); // QA report for proposal A

    // Second slug: brief v2 -> snapshot v2 -> proposal B -> QA report for B.
    const slugB = "roof-inspection-austin";
    const saved2 = await store.saveBriefDraft({
      projectId: seed.projectId,
      pageTarget: { ...samplePageTarget, slug: slugB, title: "Roof Inspection in Austin" },
      contentBriefKeyPoints: [],
    });
    await store.approveBrief({
      projectId: seed.projectId,
      briefId: saved2.id,
      expectedVersion: saved2.version,
      expectedDigest: saved2.digest,
    });
    const snap2 = await service.compileSnapshot({ projectId: seed.projectId });
    await service.approveSnapshot({
      projectId: seed.projectId,
      snapshotId: snap2.id,
      expectedVersion: snap2.version,
      expectedDigest: snap2.digest,
    });
    const proposalB = await service.generateProposal(
      { projectId: seed.projectId, snapshotId: snap2.id },
      {
        invoke: async () => ({
          requestedModel: "m",
          respondedModel: "m",
          provider: "p",
          durationMs: 1,
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          costUsd: null,
          content: JSON.stringify({ ...GOOD_PROPOSAL }),
        }),
        env: { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" },
      },
    );
    await service.runQa({ projectId: seed.projectId }); // QA for the latest proposal (B)

    const results = await Promise.allSettled([
      service.acceptContent({ projectId: seed.projectId, proposalId: proposal.id, expectedProposalDigest: proposal.digest }),
      service.acceptContent({ projectId: seed.projectId, proposalId: proposalB.id, expectedProposalDigest: proposalB.digest }),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        assert.ok(
          isCode(r.reason, "content_accept_failed"),
          `rejections must be the typed acceptance conflict, got: ${String(r.reason)}`,
        );
      }
    }
    const fulfilled = results.filter((r) => r.status === "fulfilled") as Array<
      PromiseFulfilledResult<{ version: number; slug: string }>
    >;
    assert.ok(fulfilled.length >= 1, "at least one acceptance succeeds");

    const { acceptedPageContent } = await import("../../src/persistence/schema.js");
    const { eq } = await import("drizzle-orm");
    const rows = await dbInst.db
      .select()
      .from(acceptedPageContent)
      .where(eq(acceptedPageContent.projectId, seed.projectId));
    assert.equal(rows.length, fulfilled.length, "no partial/duplicated acceptance");
    const versions = rows.map((r) => r.version).sort((a, b) => a - b);
    assert.equal(new Set(versions).size, versions.length, "no duplicate version numbers");
    assert.deepEqual(versions, versions.map((_, i) => i + 1), "contiguous versions starting at 1");
    assert.equal(new Set(rows.map((r) => r.slug)).size, rows.length, "one accepted row per slug");
  } finally {
    await dbInst.close();
  }
});

test("service QA: rules come from the BOUND approved policy — newer drafts never leak in", async () => {
  const { dbInst, service, seed, proposal } = await setupThroughProposal("wq7");
  try {
    // Insert a NEWER unapproved policy draft whose (unapproved) rules forbid a
    // term the proposal legitimately uses. QA must still judge by the BOUND
    // approved policy — the draft must not leak into verdicts.
    const { writerPolicies, contentQaReports } = await import("../../src/persistence/schema.js");
    const { eq, and } = await import("drizzle-orm");
    const store = new WriterStore(dbInst.db);
    const bound = await store.writerPolicyVersion(seed.projectId, 1);
    assert.ok(bound && bound.state === "approved");
    const tamperedData = {
      ...(bound.data as { rules: Record<string, unknown> }),
      rules: {
        ...(bound.data as { rules: Record<string, unknown> }).rules,
        forbiddenTerminology: ["roof"],
      },
    };
    await dbInst.db.insert(writerPolicies).values({
      id: "wpol-tampered-draft",
      projectId: seed.projectId,
      version: 2,
      state: "draft",
      acceptedInputSnapshotId: bound.acceptedInputSnapshotId,
      acceptedInputVersion: bound.acceptedInputVersion,
      acceptedInputDigest: bound.acceptedInputDigest,
      data: tamperedData,
      policyDigest: "e".repeat(64),
    });
    const qa = await service.runQa({ projectId: seed.projectId });
    assert.equal(qa.overall, "PASS", "newer unapproved draft rules must not affect QA verdicts");

    // Drift on the BOUND policy itself (digest no longer matches the brief
    // lineage) fails closed as stale. (Insert-only QA history: remove the
    // stored report first so the re-run recomputes.)
    await dbInst.db
      .update(writerPolicies)
      .set({ policyDigest: "f".repeat(64) })
      .where(and(eq(writerPolicies.id, bound.id), eq(writerPolicies.projectId, seed.projectId)));
    await dbInst.db.delete(contentQaReports).where(eq(contentQaReports.proposalId, proposal.id));
    await assert.rejects(
      service.runQa({ projectId: seed.projectId }),
      (e: unknown) => isCode(e, "writer_artifact_stale"),
    );
  } finally {
    await dbInst.close();
  }
});

test("service journey: no-gap acknowledged brief — waiver visible end-to-end, search REVIEW, REVIEW acceptance", async () => {
  const dbInst = await setupMigratedTestDatabase();
  const store = new WriterStore(dbInst.db);
  const snapshotStore = new WriterSnapshotStore(dbInst.db);
  const qaStore = new WriterQaStore(dbInst.db);
  const service = new WriterService(store, snapshotStore, new WriterBudgetStore(dbInst.db), qaStore);
  try {
    const seed = await seedProjectWithAcceptedInputs(dbInst, "wq8");
    const draft = await store.deriveWriterPolicyDraft({ projectId: seed.projectId });
    await store.approveWriterPolicy({
      projectId: seed.projectId,
      policyId: draft.id,
      expectedVersion: draft.version,
      expectedDigest: draft.policyDigest,
    });
    // Remove the accepted gap snapshot: the explicit no-gap acknowledgement path.
    const { acceptedContentGapSnapshots } = await import("../../src/persistence/schema.js");
    const { eq } = await import("drizzle-orm");
    await dbInst.db.delete(acceptedContentGapSnapshots).where(eq(acceptedContentGapSnapshots.projectId, seed.projectId));

    const saved = await store.saveBriefDraft({
      projectId: seed.projectId,
      pageTarget: samplePageTarget,
      contentBriefKeyPoints: [],
      noGapLineageAcknowledged: true,
    });
    const approved = await store.approveBrief({
      projectId: seed.projectId,
      briefId: saved.id,
      expectedVersion: saved.version,
      expectedDigest: saved.digest,
      noGapLineageAcknowledged: true,
    });
    assert.equal(approved.digest, saved.digest, "draft-time ack is already digest-bound; approval does not re-digest");

    const snap = await service.compileSnapshot({ projectId: seed.projectId });
    assert.match(snap.userPrompt, /no accepted gap snapshot \(explicit operator acknowledgement\)/);
    await service.approveSnapshot({
      projectId: seed.projectId,
      snapshotId: snap.id,
      expectedVersion: snap.version,
      expectedDigest: snap.digest,
    });
    const proposal = await service.generateProposal(
      { projectId: seed.projectId, snapshotId: snap.id },
      {
        invoke: async () => ({
          requestedModel: "m",
          respondedModel: "m",
          provider: "p",
          durationMs: 1,
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          costUsd: null,
          content: JSON.stringify({ ...GOOD_PROPOSAL }),
        }),
        env: { FACTORY_MODEL_OVERRIDE__CONTENT_WRITER: "z-ai/glm-5.3-flash" },
      },
    );
    const qa = await service.runQa({ projectId: seed.projectId });
    assert.equal(qa.overall, "REVIEW", "waived search lineage must surface as REVIEW");
    const waived = (qa.search as Array<{ checkId: string; verdict: string }>).find(
      (c) => c.checkId === "search.lineage_waived",
    );
    assert.equal(waived?.verdict, "REVIEW");
    const accepted = await service.acceptContent({
      projectId: seed.projectId,
      proposalId: proposal.id,
      expectedProposalDigest: proposal.digest,
    });
    assert.equal(accepted.version, 1, "REVIEW overall permits human acceptance");
    assert.match(accepted.qaReportDigest, /^[0-9a-f]{64}$/);
  } finally {
    await dbInst.close();
  }
});
