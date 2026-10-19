import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedSutherlandProject } from "../fixtures/sutherland-seeds.js";
import { WriterStore, WriterSnapshotStore, WriterQaStore } from "../../src/writer/writer-store.js";
import { WriterService } from "../../src/writer/service.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { PageArchetypeStore } from "../../src/page-authority/store.js";
import { TrustGovernanceStore } from "../../src/trust/store.js";
import { and, eq } from "drizzle-orm";
import { acceptedPageContent } from "../../src/persistence/schema.js";

/**
 * RUN 12 — Sutherland governed writer pipeline smoke (real PostgreSQL).
 *
 * Proves the Sutherland seed supports the real governed path:
 *   approved WriterPolicy -> atomic brief+archetype -> snapshot -> proposal
 *   (provider seam) -> deterministic QA -> AcceptedPageContent
 * plus durable page-intent authority.
 */

const HOME_TARGET = {
  slug: "home",
  title: "Independent Buyer-Side Advisory for French Alps Property Decisions",
  objective: "Establish the Sutherland Private Office identity and the evidence-led advisory proposition.",
  audience: "International buyers evaluating a consequential French Alps property decision.",
  structureGuidance: ["Open with the advisory positioning", "Evidence-led method section", "Engagement boundaries"],
  internalLinkIntent: [],
  ctaIntent: "Explain how an engagement begins (Mode B: no conversion element)",
};

test("PG run12 sutherland: seed + governed writer path + trust authority", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const seeded = await seedSutherlandProject(dbInst, "sut-writer-1");
    assert.ok(seeded.projectId);
    assert.ok(seeded.gapSnapshotId);

    const store = new WriterStore(dbInst.db);
    const service = new WriterService(
      store,
      new WriterSnapshotStore(dbInst.db),
      new WriterBudgetStore(dbInst.db),
      new WriterQaStore(dbInst.db),
      // NO fixtureProvider override: the REAL governed invocation path runs,
      // with the external model transport supplied through the provider
      // seam (the live writer provider fails closed without
      // OPENROUTER_API_KEY, which is not configured in this environment;
      // the seam itself is the real budget-governed invocation boundary).
    );

    const sutherlandProposal = {
      title: "Independent Buyer-Side Advisory for French Alps Property Decisions",
      metaDescription:
        "Sutherland Private Office is an independent buyer-side property advisory for consequential French Alps decisions: evidence-led analysis for Chamonix and Megève.",
      introduction:
        "Sutherland Private Office is an independent buyer-side property advisory for consequential commercial property decisions in the French Alps. Advisory focus: consequential French Alps property decisions, including Chamonix and Megève. The practice is evidence-led: sourced market analysis rather than listing intermediation.",
      sections: [
        {
          heading: "Engagement boundaries and what buyer-side advisory covers",
          body: "The advisory covers the decision before the purchase: framing the requirement, weighing evidence, and stating limits. Independent buyer-side property advisory means the analysis serves the buyer, not a listing. How an engagement begins without a sales funnel: with a defined decision question, not a listing enquiry.",
        },
        {
          heading: "How the evidence-led analysis method produces conclusions",
          body: "The evidence-led analysis method produces conclusions from sourced market evidence: observations are separated from assumptions, and assumptions are labelled as assumptions. Analysis is evidence-led: sourced market analysis rather than listing intermediation.",
        },
        {
          heading: "Who is responsible and how facts are separated",
          body: "Understand who is responsible for the analysis: Sutherland Private Office publishes under its own identity. See how facts, assumptions and forecasts are separated: each material statement is classified before publication.",
        },
      ],
      conclusion:
        "For a consequential French Alps property decision, independent buyer-side advisory provides evidence-led decision support. An engagement begins with the decision question, in prose, without obligation.",
      cta: "An engagement begins with a defined decision question — contact is described in prose, without a conversion element.",
      internalLinks: [],
    };

    // 1. Writer policy: derive + approve (real path).
    const policy = await store.deriveWriterPolicyDraft({ projectId: seeded.projectId });
    await store.approveWriterPolicy({
      projectId: seeded.projectId,
      policyId: policy.id,
      expectedVersion: policy.version,
      expectedDigest: policy.policyDigest,
    });

    // 2. Atomic brief + archetype authority (PR #45 semantics).
    const brief = await store.saveBriefDraft({
      projectId: seeded.projectId,
      pageTarget: { ...HOME_TARGET, designBinding: { schemaVersion: "page-design-binding-v1" as const, archetype: "homepage" as const } },
      contentBriefKeyPoints: [],
    });
    await store.approveBrief({
      projectId: seeded.projectId,
      briefId: brief.id,
      expectedVersion: brief.version,
      expectedDigest: brief.digest,
    });
    const archetype = await new PageArchetypeStore(dbInst.db).getArchetype(seeded.projectId, "home");
    assert.equal(archetype, "homepage");

    // 3. Snapshot + proposal + QA + acceptance (real governed path).
    const snapshot = await service.compileSnapshot({ projectId: seeded.projectId });
    await service.approveSnapshot({ projectId: seeded.projectId, snapshotId: snapshot.id, expectedVersion: snapshot.version, expectedDigest: snapshot.digest });
    const proposal = await service.generateProposal(
      { projectId: seeded.projectId, snapshotId: snapshot.id },
      {
        // Model transport through the governed seam: full budget reservation
        // + settlement semantics execute; only the network boundary is
        // supplied deterministically (external model transport boundary).
        invoke: (async (request: { model?: string }) => ({
          requestedModel: request.model ?? "test-model",
          respondedModel: "test-model",
          provider: "seam",
          durationMs: 5,
          promptTokens: 100,
          completionTokens: 400,
          totalTokens: 500,
          costUsd: 0,
          content: JSON.stringify(sutherlandProposal),
        })) as never,
        dailyLimitUsd: 10,
      },
    );
    const qa = await service.runQa({ projectId: seeded.projectId });
    assert.equal(qa.overall, "PASS", `QA verdict: ${JSON.stringify({ factual: qa.factual, search: qa.search, editorial: qa.editorial })}`);
    const accepted = await service.acceptContent({ projectId: seeded.projectId, proposalId: proposal.id, expectedProposalDigest: proposal.digest });
    assert.equal(accepted.slug, "home");

    const [row] = await dbInst.db
      .select()
      .from(acceptedPageContent)
      .where(and(eq(acceptedPageContent.projectId, seeded.projectId), eq(acceptedPageContent.slug, "home")));
    assert.ok(row);

    // 4. Durable page-intent authority for the homepage strategy.
    const trust = new TrustGovernanceStore(dbInst.db);
    await trust.setPageIntentAuthority({
      projectId: seeded.projectId,
      intent: {
        schemaVersion: "trust-governance-v1",
        projectId: seeded.projectId,
        pageIdentity: "home",
        primaryIntent: "Evaluate who should support a consequential French Alps property decision",
        secondaryIntents: ["Understand the evidence-led method"],
        primaryQueryCluster: "Independent buyer-side advisory (French Alps)",
        secondaryQueryClusters: ["Brand / entity (Sutherland Private Office)"],
        contentGapPurpose: "Entity establishment + commercial-investigation orientation",
        siteRole: "Homepage: identity and orientation",
        targetAudience: "International buyers evaluating French Alps property",
        mainUserTask: "Decide whether independent advisory fits the decision",
        primaryConversionAction: "Understand how an engagement begins (Mode B prose)",
        ymylClassification: "YMYL_INFORMATIONAL",
        decisionRole: "NAVIGATIONAL_BRAND",
        internalLinksOut: [],
        gapSnapshotId: seeded.gapSnapshotId,
        gapSnapshotVersion: seeded.gapSnapshotVersion,
        gapSnapshotDigest: seeded.gapSnapshotDigest,
      },
    });
    const intent = await trust.getIntentAuthority(seeded.projectId, "home");
    assert.equal(intent!.ymylClassification, "YMYL_INFORMATIONAL");
    assert.equal(intent!.decisionRole, "NAVIGATIONAL_BRAND");
  } finally {
    await dbInst.close();
  }
});
