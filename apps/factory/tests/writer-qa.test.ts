import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./persistence/helpers.js";
import { WriterStore, WriterSnapshotStore, WriterQaStore } from "../src/writer/writer-store.js";
import { WriterService } from "../src/writer/service.js";
import { WriterBudgetStore } from "../src/writer/budget.js";
import { runContentQa } from "../src/writer/qa.js";
import { samplePageTarget, seedProjectWithAcceptedInputs } from "./fixtures/writer-seeds.js";
import { FactoryError } from "../src/executor/errors.js";
import type { PageContentProposalData } from "@factory/contracts";

function isCode(err: unknown, code: string): boolean {
  return err instanceof FactoryError && err.code === code;
}

const GOOD_PROPOSAL = {
  title: "Roof Replacement in Denver",
  metaDescription: "Licensed Denver roof replacement with a limited warranty.",
  introduction:
    "Denver hailstorms and freeze-thaw cycles put every roof under storm-damage stress. Homeowners comparing local roofers need clear answers about roof replacement cost drivers, process and trust signals before requesting a quote.",
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
  conclusion: "Understanding cost drivers and process steps makes comparing roofers straightforward.",
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
  return { dbInst, service, qaStore, seed, proposal };
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
