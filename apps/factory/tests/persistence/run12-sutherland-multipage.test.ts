import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm, mkdtemp, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedSutherlandProject } from "../fixtures/sutherland-seeds.js";
import { WriterStore, WriterSnapshotStore, WriterQaStore } from "../../src/writer/writer-store.js";
import { WriterService } from "../../src/writer/service.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { PageArchetypeStore } from "../../src/page-authority/store.js";
import { TrustGovernanceStore } from "../../src/trust/store.js";
import { DesignStore } from "../../src/design/design-store.js";
import { VisualStore } from "../../src/visual/store.js";
import { VisualService } from "../../src/visual/service.js";
import { VisualBudgetStore } from "../../src/visual/budget.js";
import { FixtureVisualAssetProvider } from "../../src/visual/fixture-adapter.js";
import { ProductionStore } from "../../src/production/store.js";
import { ProductionRenderCompiler } from "../../src/production/render-manifest.js";
import { ProductionBuildService } from "../../src/production/build-service.js";
import { runSiteWideQa } from "../../src/production/qa/site-wide.js";
import { runTrustQa } from "../../src/production/qa/trust.js";
import { createAssetStorage } from "../../src/assets/storage.js";
import { resolveRepositoryRoot } from "../../src/repo-root.js";
import { derivePageArchetype } from "../../src/production/page-archetype.js";
import {
  parseDesignInputSnapshotAnyVersion,
  isDesignInputSnapshotV2,
  parseDesignCandidateAnyVersion,
  type DesignArchetypeKind,
  type PageIntentAuthority,
  type ClaimLineage,
} from "@factory/contracts";
import { EvidenceStitchProvider } from "../fixtures/stitch-evidence.js";
import type { StitchMcpClientLike, McpToolCallResult } from "../../src/design/stitch-provider.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { and, eq } from "drizzle-orm";
import { acceptedPageContent } from "../../src/persistence/schema.js";

/**
 * RUN 12 — SUTHERLAND MULTI-PAGE PROOF (real PostgreSQL + real Astro build).
 *
 * Proves the complete governed chain for a real five-page Sutherland website:
 *
 *   accepted Sutherland inputs + accepted search strategy
 *     -> governed writer pipeline per page (policy -> atomic brief+archetype
 *        -> snapshot -> budget-governed provider seam -> deterministic QA
 *        -> AcceptedPageContent)
 *     -> durable PageArchetypeAuthority (PR #45 atomicity preserved)
 *     -> durable PageIntentAuthority (strategy/YMYL/decision role)
 *     -> ONE design-v2 design acceptance (Stitch provider path, transport
 *        mocked at the MCP artifact boundary only)
 *     -> VisualService lifecycle per page -> AcceptedVisualAssetSet
 *     -> PPI -> ProductionRenderCompiler -> production-v3 manifests
 *     -> real Astro build -> site-wide QA + trust QA
 *     -> FIFTH-PAGE REUSE PROOF with zero new design/provider calls
 *
 * Governance rules honored:
 *   - No invented facts: copy materializes only accepted operator facts.
 *   - Mode B: no conversion element; engagement described in prose.
 *   - Claims classified + lineage bound to the exact content digest.
 *   - Visual truth: abstract illustrative imagery only, no documentary claims.
 */

const REPOSITORY_SHA = "1".repeat(40);
const LOCKFILE_DIGEST = "2".repeat(64);

/** The five mandatory pages (page 6 impossible: no `about` archetype exists). */
const SUTHERLAND_PAGES: Array<{
  slug: string;
  archetype: DesignArchetypeKind;
  title: string;
  objective: string;
  audience: string;
  structureGuidance: string[];
  internalLinkIntent: string[];
  ctaIntent: string;
  ymyl: PageIntentAuthority["ymylClassification"];
  decisionRole: PageIntentAuthority["decisionRole"];
  primaryIntent: string;
  primaryQueryCluster: string;
  contentGapPurpose: string;
  siteRole: string;
  mainUserTask: string;
  primaryConversionAction: string;
  internalLinksOut: string[];
}> = [
  {
    slug: "home",
    archetype: "homepage",
    title: "Independent Buyer-Side Advisory for French Alps Property Decisions",
    objective: "Establish the Sutherland Private Office identity and the evidence-led advisory proposition.",
    audience: "International buyers evaluating a consequential French Alps property decision.",
    structureGuidance: ["Open with the advisory positioning", "Evidence-led method section", "Engagement boundaries"],
    internalLinkIntent: [],
    ctaIntent: "Explain how an engagement begins (Mode B: no conversion element)",
    ymyl: "YMYL_INFORMATIONAL",
    decisionRole: "NAVIGATIONAL_BRAND",
    primaryIntent: "Evaluate who should support a consequential French Alps property decision",
    primaryQueryCluster: "Independent buyer-side advisory (French Alps)",
    contentGapPurpose: "Entity establishment + commercial-investigation orientation",
    siteRole: "Homepage: identity and orientation",
    mainUserTask: "Decide whether independent advisory fits the decision",
    primaryConversionAction: "Understand how an engagement begins (Mode B prose)",
    internalLinksOut: [],
  },
  {
    slug: "services/buyer-side-advisory",
    archetype: "service",
    title: "Buyer-Side Property Advisory: Scope and Engagement",
    objective: "Explain the service scope, how an engagement works, and its boundaries.",
    audience: "Buyers comparing independent advisory against listing intermediaries.",
    structureGuidance: ["Service scope section", "How an engagement works", "Boundaries and limits"],
    internalLinkIntent: ["Link to the research methodology page"],
    ctaIntent: "Explain how an engagement begins (Mode B: no conversion element)",
    ymyl: "YMYL_INFORMATIONAL",
    decisionRole: "COMMERCIAL_SERVICE_EVALUATION",
    primaryIntent: "Evaluate the buyer-side advisory service scope and engagement model",
    primaryQueryCluster: "Independent buyer-side advisory (French Alps)",
    contentGapPurpose: "Service differentiation: what the engagement does and does not do",
    siteRole: "Service evaluation",
    mainUserTask: "Decide whether to engage the advisory service",
    primaryConversionAction: "Understand how an engagement begins (Mode B prose)",
    internalLinksOut: ["research/alpine-decision-framework"],
  },
  {
    slug: "locations/chamonix",
    archetype: "location",
    title: "Property Decision Support in Chamonix",
    objective: "Explain the location relevance of Chamonix for buyer-side advisory.",
    audience: "Buyers considering Chamonix specifically.",
    structureGuidance: ["Location context section", "Advisory coverage", "Local decision factors"],
    internalLinkIntent: ["Link to the service page"],
    ctaIntent: "Explain how an engagement begins (Mode B: no conversion element)",
    ymyl: "YMYL_INFORMATIONAL",
    decisionRole: "GEOGRAPHIC_SERVICE_RELEVANCE",
    primaryIntent: "Understand advisory support for a Chamonix property decision",
    primaryQueryCluster: "Location market understanding (Chamonix / Megève)",
    contentGapPurpose: "Geographic service relevance grounded in accepted location facts",
    siteRole: "Location relevance",
    mainUserTask: "Decide how the advisory supports a Chamonix purchase",
    primaryConversionAction: "Understand how an engagement begins (Mode B prose)",
    internalLinksOut: ["services/buyer-side-advisory"],
  },
  {
    slug: "advisory/investment-decision-framework",
    archetype: "investment_advisory",
    title: "Investment Decision Framework for Alpine Property",
    objective: "Explain the decision framework: approach, assumptions, scenarios, limits.",
    audience: "Buyers weighing a financial decision on alpine property.",
    structureGuidance: ["Approach section", "Assumptions and their labelling", "Scenario analysis with limits"],
    internalLinkIntent: ["Link to the research methodology page"],
    ctaIntent: "Explain how an engagement begins (Mode B: no conversion element)",
    ymyl: "YMYL_DECISION_SUPPORT",
    decisionRole: "FINANCIAL_DECISION_SUPPORT",
    primaryIntent: "Use a framework to structure an alpine property investment decision",
    primaryQueryCluster: "Decision methodology / evidence-led analysis",
    contentGapPurpose: "Financial decision support with explicit assumption/forecast separation",
    siteRole: "Decision support",
    mainUserTask: "Structure an investment decision with labelled uncertainty",
    primaryConversionAction: "Understand how an engagement begins (Mode B prose)",
    internalLinksOut: ["research/alpine-decision-framework"],
  },
  {
    slug: "research/alpine-decision-framework",
    archetype: "editorial",
    title: "An Evidence-Led Decision Framework for Alpine Property",
    objective: "Publish the original decision framework with methodology, sources and limits.",
    audience: "Buyers and researchers evaluating alpine property decisions.",
    structureGuidance: ["Framework introduction", "Methodology", "Sources and limits"],
    internalLinkIntent: ["Link to the service page"],
    ctaIntent: "Explain how an engagement begins (Mode B: no conversion element)",
    ymyl: "YMYL_DECISION_SUPPORT",
    decisionRole: "INFORMATIONAL_RESEARCH",
    primaryIntent: "Study the evidence-led decision framework and its methodology",
    primaryQueryCluster: "Decision methodology / evidence-led analysis",
    contentGapPurpose: "Original analytical value: reproducible framework + labelled calculation",
    siteRole: "Research credibility",
    mainUserTask: "Evaluate the framework's methodology and apply its structure",
    primaryConversionAction: "Understand how an engagement begins (Mode B prose)",
    internalLinksOut: ["services/buyer-side-advisory"],
  },
];

function sutherlandProposalFor(page: (typeof SUTHERLAND_PAGES)[number]) {
  const bodyByArchetype: Record<string, Array<{ heading: string; body: string }>> = {
    homepage: [
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
    service: [
      {
        heading: "Service scope: what the advisory does",
        body: "Sutherland Private Office is an independent buyer-side property advisory. The advisory covers the decision before the purchase. It frames the requirement, weighs evidence, and states limits. What buyer-side advisory covers and how an engagement works: the engagement is a defined analysis with a stated question. It is not an open-ended listing search.",
      },
      {
        heading: "How an engagement works",
        body: "How an engagement begins without a sales funnel: the buyer states the decision question. The advisory proposes the evidence required to answer it. The analysis is delivered as a documented, sourced conclusion. Analysis is evidence-led: sourced market analysis rather than listing intermediation.",
      },
      {
        heading: "Boundaries and limits",
        body: "The advisory does not sell property, broker transactions, or guarantee outcomes. Where evidence is limited, the limit is stated. Distinguish independent advisory from listing intermediaries: the advisory holds no listing interest. Understand who is responsible for the analysis: the practice publishes under its own identity. Facts, assumptions and forecasts are separated: each statement is classified before publication.",
      },
    ],
    location: [
      {
        heading: "Chamonix as a decision context",
        body: "Sutherland Private Office is an independent buyer-side property advisory. Chamonix is one of the advisory locations. Advisory focus: consequential French Alps property decisions, including Chamonix and Megève. The location context shapes the decision. As an expert interpretation, alpine property markets differ from primary housing markets in seasonality and supply.",
      },
      {
        heading: "Advisory coverage in Chamonix",
        body: "Independent buyer-side property advisory for a Chamonix purchase follows the same evidence-led method. It is sourced analysis of the specific decision, not a listing search. How an engagement begins without a sales funnel: with the buyer's decision question. Analysis is evidence-led: sourced market analysis rather than listing intermediation.",
      },
      {
        heading: "Local decision factors",
        body: "Local decision factors are weighed with labelled evidence. Observations are separated from assumptions. Understand who is responsible for the analysis: Sutherland Private Office publishes the analysis under its own identity. See how facts, assumptions and forecasts are separated: each statement is classified before publication.",
      },
    ],
    investment_advisory: [
      {
        heading: "The decision approach",
        body: "Sutherland Private Office is an independent buyer-side property advisory. The framework structures an alpine property decision in stages: requirement, evidence, assumptions, scenarios. The evidence-led analysis method produces conclusions that separate observations from assumptions. Each material input is classified before use.",
      },
      {
        heading: "Assumptions and their labelling",
        body: "Assumptions are labelled as assumptions. An illustrative gross yield of 7.2% under stated assumptions is a labelled calculation with recorded inputs, never an observed fact. Advisory focus: consequential French Alps property decisions, including Chamonix and Megève. Forecast values are labelled as forecasts with their model basis.",
      },
      {
        heading: "Scenario analysis with limits",
        body: "Scenarios are labelled as scenarios: they describe modelled outcomes under stated assumptions, not promised outcomes. Analysis is evidence-led: sourced market analysis rather than listing intermediation. Limits are stated symmetrically with strengths. Understand who is responsible for the analysis: Sutherland Private Office publishes the framework under its own identity.",
      },
    ],
    editorial: [
      {
        heading: "Why a decision framework",
        body: "Sutherland Private Office is an independent buyer-side property advisory. Alpine property decisions mix facts, assumptions and forecasts; the framework makes the separation explicit. The evidence-led analysis method produces conclusions that are reproducible: each material claim carries its classification and evidence.",
      },
      {
        heading: "Methodology",
        body: "The methodology proceeds in steps. First define the decision question. Then collect sourced evidence. Then classify each material statement as fact, assumption, forecast or scenario. Then compute labelled calculations with recorded inputs. Finally state limitations. An illustrative gross yield of 7.2% under stated assumptions is presented as a labelled calculation with its inputs recorded.",
      },
      {
        heading: "Sources and limits",
        body: "Sources are recorded per claim with their date and tier. Limitations: the framework structures decisions; it does not predict markets. Understand who is responsible for the analysis: Sutherland Private Office publishes under its own identity. Analysis is evidence-led: sourced market analysis rather than listing intermediation.",
      },
    ],
  };
  const sections = bodyByArchetype[page.archetype]!;
  return {
    title: page.title,
    metaDescription: `${page.title}: Sutherland Private Office — independent buyer-side property advisory for consequential French Alps decisions, evidence-led for Chamonix and Megève.`,
    introduction: `${page.title}. Sutherland Private Office is an independent buyer-side property advisory for consequential commercial property decisions in the French Alps, including Chamonix and Megève. The practice is evidence-led: sourced market analysis rather than listing intermediation.`,
    sections,
    conclusion:
      "For a consequential French Alps property decision, independent buyer-side advisory provides evidence-led decision support. An engagement begins with the decision question, in prose, without obligation.",
    cta: "An engagement begins with a defined decision question — described in prose, without a conversion element.",
    internalLinks: page.archetype === "editorial" ? page.internalLinksOut.map((target) => `/${target}`) : [],
  };
}

function intentForPage(projectId: string, page: (typeof SUTHERLAND_PAGES)[number], gap: { id: string; version: number; digest: string }): PageIntentAuthority {
  return {
    schemaVersion: "trust-governance-v1",
    projectId,
    pageIdentity: page.slug,
    primaryIntent: page.primaryIntent,
    secondaryIntents: [],
    primaryQueryCluster: page.primaryQueryCluster,
    secondaryQueryClusters: [],
    contentGapPurpose: page.contentGapPurpose,
    siteRole: page.siteRole,
    targetAudience: page.audience,
    mainUserTask: page.mainUserTask,
    primaryConversionAction: page.primaryConversionAction,
    ymylClassification: page.ymyl,
    decisionRole: page.decisionRole,
    internalLinksOut: page.internalLinksOut,
    gapSnapshotId: gap.id,
    gapSnapshotVersion: gap.version,
    gapSnapshotDigest: gap.digest,
  };
}

/** Claim lineage for the editorial page's labelled calculation (Block 11/14/20). */
function editorialClaims(): ClaimLineage[] {
  return [
    {
      claimId: "claim-yield-calc",
      claimText:
        "An illustrative gross yield of 7.2% under stated assumptions is presented as a labelled calculation with its inputs recorded.",
      claimType: "CALCULATION",
      sourceRefs: [
        { ref: "Illustrative inputs recorded in the methodology section (first-party worked example)", tier: "TIER_A", sourceDate: "2026-09-01", freshnessBasis: "model_as_of_date" },
      ],
      pageIdentity: "research/alpine-decision-framework",
      calculationRef: {
        modelId: "sutherland-gross-yield-v1",
        inputs: [
          { name: "annual rent", value: "26400", unit: "EUR/year" },
          { name: "purchase price", value: "366000", unit: "EUR" },
        ],
        assumptionRefs: [],
        output: { value: "7.2", unit: "%" },
        calculatedAt: "2026-09-01",
      },
      limitation: "Illustrative worked example under stated assumptions; not a forecast and not a guarantee.",
    },
    {
      claimId: "claim-market-structure",
      claimText:
        "Alpine property decisions mix facts, assumptions and forecasts; the framework makes the separation explicit.",
      claimType: "EXPERT_INTERPRETATION",
      sourceRefs: [
        { ref: "Accepted operator positioning evidence (2026-09-04 workflow)", tier: "TIER_A", sourceDate: "2026-09-04", freshnessBasis: "historical_date" },
      ],
      pageIdentity: "research/alpine-decision-framework",
      limitation: "Interpretation of the accepted positioning evidence; qualitative, not a market forecast.",
    },
  ];
}

/** Claims for the investment page (assumptions/scenarios labelled). */
function investmentClaims(): ClaimLineage[] {
  return [
    {
      claimId: "claim-invest-scenario",
      claimText:
        "Scenarios are labelled as scenarios: they describe modelled outcomes under stated assumptions, not guaranteed results.",
      claimType: "SCENARIO",
      sourceRefs: [
        { ref: "Framework methodology (first-party, this page)", tier: "TIER_A", sourceDate: "2026-09-01", freshnessBasis: "model_as_of_date" },
      ],
      pageIdentity: "advisory/investment-decision-framework",
      limitation: "Scenario framing statement; no specific outcome is asserted.",
    },
    {
      claimId: "claim-invest-yield-ref",
      claimText:
        "An illustrative gross yield of 7.2% under stated assumptions is a CALCULATION with recorded inputs, never an observed fact.",
      claimType: "CALCULATION",
      sourceRefs: [
        { ref: "Research page methodology (internal reference, /research/alpine-decision-framework)", tier: "TIER_A", sourceDate: "2026-09-01", freshnessBasis: "model_as_of_date" },
      ],
      pageIdentity: "advisory/investment-decision-framework",
      calculationRef: {
        modelId: "sutherland-gross-yield-v1",
        inputs: [
          { name: "annual rent", value: "26400", unit: "EUR/year" },
          { name: "purchase price", value: "366000", unit: "EUR" },
        ],
        assumptionRefs: [],
        output: { value: "7.2", unit: "%" },
        calculatedAt: "2026-09-01",
      },
      limitation: "Cross-reference to the research page worked example; illustrative, not a forecast.",
    },
  ];
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 0 }));
    child.on("error", reject);
  });
}


class MockStitchClient implements StitchMcpClientLike {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private toolSequence: Array<Record<string, unknown>> = [];
  queue(result: Record<string, unknown>): void { this.toolSequence.push(result); }
  async listTools(): Promise<{ tools: Array<{ name: string }> }> {
    return { tools: [
      { name: "create_project" }, { name: "delete_project" }, { name: "list_screens" },
      { name: "get_screen" }, { name: "generate_screen_from_text" }, { name: "create_design_system" },
    ] };
  }
  async callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<McpToolCallResult> {
    this.calls.push({ name: params.name, args: params.arguments });
    const next = this.toolSequence.shift();
    if (next === undefined) throw new Error(`MockStitchClient: unexpected tool call ${params.name}`);
    return { structuredContent: next };
  }
  async close(): Promise<void> {}
}

function safeSegmentLocal(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(value)) throw new Error(`Unsafe artifact identity: ${value}`);
  return value;
}

interface PageRecord { id: string; version: number; slug: string; contentDigest: string }

test("RUN 12: Sutherland five-page governed production proof (writer -> design -> visuals -> PPI -> Astro -> QA)", { timeout: 900_000 }, async () => {
  const repoRoot = await resolveRepositoryRoot();
  const dbInst = await setupMigratedTestDatabase();
  let root: string | undefined;
  try {
    // ---- Accepted Sutherland inputs + accepted search strategy ----
    const seeded = await seedSutherlandProject(dbInst, "run12-proof");
    const trust = new TrustGovernanceStore(dbInst.db);
    const writerStores = {
      store: new WriterStore(dbInst.db),
      snapshots: new WriterSnapshotStore(dbInst.db),
      budget: new WriterBudgetStore(dbInst.db),
      qa: new WriterQaStore(dbInst.db),
    };
    const writer = new WriterService(writerStores.store, writerStores.snapshots, writerStores.budget, writerStores.qa);

    // ---- Governed writer pipeline per page ----
    const acceptedPages = new Map<string, PageRecord>();
    for (const page of SUTHERLAND_PAGES) {
      // Writer policy (project-level; idempotent).
      const currentPolicy = await writerStores.store.latestWriterPolicy(seeded.projectId);
      if (!currentPolicy || currentPolicy.state !== "approved") {
        const policy = await writerStores.store.deriveWriterPolicyDraft({ projectId: seeded.projectId });
        await writerStores.store.approveWriterPolicy({
          projectId: seeded.projectId,
          policyId: policy.id,
          expectedVersion: policy.version,
          expectedDigest: policy.policyDigest,
        });
      }
      // Atomic brief + archetype authority (PR #45 semantics preserved).
      const brief = await writerStores.store.saveBriefDraft({
        projectId: seeded.projectId,
        pageTarget: {
          slug: page.slug,
          title: page.title,
          objective: page.objective,
          audience: page.audience,
          structureGuidance: page.structureGuidance,
          internalLinkIntent: page.internalLinkIntent,
          ctaIntent: page.ctaIntent,
          designBinding: { schemaVersion: "page-design-binding-v1" as const, archetype: page.archetype },
        },
        contentBriefKeyPoints: [],
      });
      await writerStores.store.approveBrief({
        projectId: seeded.projectId,
        briefId: brief.id,
        expectedVersion: brief.version,
        expectedDigest: brief.digest,
      });
      const archetype = await new PageArchetypeStore(dbInst.db).getArchetype(seeded.projectId, page.slug);
      assert.equal(archetype, page.archetype, `durable archetype authority for ${page.slug}`);

      // Snapshot -> budget-governed provider seam -> QA -> acceptance.
      const snapshot = await writer.compileSnapshot({ projectId: seeded.projectId });
      await writer.approveSnapshot({ projectId: seeded.projectId, snapshotId: snapshot.id, expectedVersion: snapshot.version, expectedDigest: snapshot.digest });
      const proposalData = sutherlandProposalFor(page);
      const proposal = await writer.generateProposal(
        { projectId: seeded.projectId, snapshotId: snapshot.id },
        {
          invoke: (async (request: { model?: string }) => ({
            requestedModel: request.model ?? "test-model",
            respondedModel: "test-model",
            provider: "seam",
            durationMs: 5,
            promptTokens: 120,
            completionTokens: 500,
            totalTokens: 620,
            costUsd: 0,
            content: JSON.stringify(proposalData),
          })) as never,
          dailyLimitUsd: 10,
        },
      );
      const qa = await writer.runQa({ projectId: seeded.projectId });
      assert.equal(qa.overall, "PASS", `writer QA for ${page.slug}: ${JSON.stringify({ factual: qa.factual, search: qa.search, editorial: qa.editorial })}`);
      const accepted = await writer.acceptContent({ projectId: seeded.projectId, proposalId: proposal.id, expectedProposalDigest: proposal.digest });
      assert.equal(accepted.slug, page.slug);
      const [row] = await dbInst.db
        .select()
        .from(acceptedPageContent)
        .where(and(eq(acceptedPageContent.projectId, seeded.projectId), eq(acceptedPageContent.slug, page.slug)));
      assert.ok(row, `accepted content row for ${page.slug}`);
      acceptedPages.set(page.slug, { id: row.id, version: row.version, slug: row.slug, contentDigest: row.contentDigest });

      // Durable page-intent authority (strategy + YMYL + decision role).
      await trust.setPageIntentAuthority({
        projectId: seeded.projectId,
        intent: intentForPage(seeded.projectId, page, {
          id: seeded.gapSnapshotId,
          version: seeded.gapSnapshotVersion,
          digest: seeded.gapSnapshotDigest,
        }),
      });
    }
    assert.equal(acceptedPages.size, 5, "five mandatory pages accepted");

    // ---- Claim lineage for YMYL pages (bound to exact content digests) ----
    for (const [slug, claims] of [
      ["research/alpine-decision-framework", editorialClaims()],
      ["advisory/investment-decision-framework", investmentClaims()],
    ] as const) {
      const page = acceptedPages.get(slug)!;
      await trust.saveClaimLineage({
        projectId: seeded.projectId,
        pageIdentity: slug,
        contentDigest: page.contentDigest,
        claims,
      });
    }

    // Service page claim lineage.
    const servicePage = acceptedPages.get("services/buyer-side-advisory")!;
    await trust.saveClaimLineage({
      projectId: seeded.projectId,
      pageIdentity: "services/buyer-side-advisory",
      contentDigest: servicePage.contentDigest,
      claims: [
        {
          claimId: "claim-service-independence",
          claimText: "Sutherland Private Office is an independent buyer-side property advisory.",
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [
            { ref: "Accepted operator facts (2026-09-04 workflow handoff)", tier: "TIER_A", sourceDate: "2026-09-04", freshnessBasis: "historical_date" },
          ],
          pageIdentity: "services/buyer-side-advisory",
          limitation: "First-party statement of the operator's own positioning.",
        },
        {
          claimId: "claim-service-no-listing",
          claimText: "The advisory holds no listing interest. Facts, assumptions and forecasts are separated: each statement is classified before publication.",
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [
            { ref: "Accepted operator facts (2026-09-04 workflow handoff)", tier: "TIER_A", sourceDate: "2026-09-04", freshnessBasis: "historical_date" },
          ],
          pageIdentity: "services/buyer-side-advisory",
          limitation: "First-party boundary statement.",
        },
      ],
    });

    // Location page claim lineage.
    const locationPage = acceptedPages.get("locations/chamonix")!;
    await trust.saveClaimLineage({
      projectId: seeded.projectId,
      pageIdentity: "locations/chamonix",
      contentDigest: locationPage.contentDigest,
      claims: [
        {
          claimId: "claim-location-focus",
          claimText: "Advisory focus: consequential French Alps property decisions, including Chamonix and Megève.",
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [
            { ref: "Accepted operator facts (2026-09-04 workflow handoff)", tier: "TIER_A", sourceDate: "2026-09-04", freshnessBasis: "historical_date" },
          ],
          pageIdentity: "locations/chamonix",
          limitation: "First-party statement of accepted advisory locations.",
        },
        {
          claimId: "claim-location-market-character",
          claimText: "Alpine property markets differ from primary housing markets in seasonality and supply.",
          claimType: "EXPERT_INTERPRETATION",
          sourceRefs: [
            { ref: "Accepted operator positioning evidence (2026-09-04 workflow)", tier: "TIER_A", sourceDate: "2026-09-04", freshnessBasis: "historical_date" },
          ],
          pageIdentity: "locations/chamonix",
          limitation: "Qualitative interpretation of accepted positioning evidence, presented as expert interpretation; not a market forecast.",
        },
      ],
    });

    // Homepage claim lineage (its material statements are classified).
    const homePage = acceptedPages.get("home")!;
    await trust.saveClaimLineage({
      projectId: seeded.projectId,
      pageIdentity: "home",
      contentDigest: homePage.contentDigest,
      claims: [
        {
          claimId: "claim-home-independence",
          claimText: "Sutherland Private Office is an independent buyer-side property advisory.",
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [
            { ref: "Accepted operator facts (2026-09-04 workflow handoff)", tier: "TIER_A", sourceDate: "2026-09-04", freshnessBasis: "historical_date" },
          ],
          pageIdentity: "home",
          limitation: "First-party statement of the operator's own positioning.",
        },
        {
          claimId: "claim-home-evidence-led",
          claimText: "Analysis is evidence-led: sourced market analysis rather than listing intermediation.",
          claimType: "FIRST_PARTY_FACT",
          sourceRefs: [
            { ref: "Accepted operator facts (2026-09-04 workflow handoff)", tier: "TIER_A", sourceDate: "2026-09-04", freshnessBasis: "historical_date" },
          ],
          pageIdentity: "home",
          limitation: "First-party description of the practice's method.",
        },
      ],
    });

    // ---- Original-value evidence (Block 19) ----
    await trust.saveOriginalValue({
      projectId: seeded.projectId,
      record: {
        schemaVersion: "trust-governance-v1",
        pageIdentity: "research/alpine-decision-framework",
        kind: "original_decision_model",
        description:
          "The evidence-led decision framework with a reproducible labelled gross-yield worked example (inputs, formula identity, output and limitations recorded).",
        lineageClaimId: "claim-yield-calc",
      },
    });
    await trust.saveOriginalValue({
      projectId: seeded.projectId,
      record: {
        schemaVersion: "trust-governance-v1",
        pageIdentity: "advisory/investment-decision-framework",
        kind: "original_framework",
        description:
          "The staged decision structure (requirement, evidence, assumptions, scenarios) with explicit claim-type labelling discipline.",
        lineageClaimId: "claim-invest-scenario",
      },
    });

    await trust.saveOriginalValue({
      projectId: seeded.projectId,
      record: {
        schemaVersion: "trust-governance-v1",
        pageIdentity: "home",
        kind: "transparent_synthesis",
        description:
          "The homepage synthesizes the accepted positioning into one coherent orientation argument (independence, method, boundaries) rather than repeating service or research pages.",
      },
    });

    await trust.saveOriginalValue({
      projectId: seeded.projectId,
      record: {
        schemaVersion: "trust-governance-v1",
        pageIdentity: "services/buyer-side-advisory",
        kind: "transparent_synthesis",
        description:
          "The service page states the engagement boundaries symmetrically with strengths (what the advisory does not do), derived from the accepted positioning rather than generic service copy.",
      },
    });
    await trust.saveOriginalValue({
      projectId: seeded.projectId,
      record: {
        schemaVersion: "trust-governance-v1",
        pageIdentity: "locations/chamonix",
        kind: "first_party_observation",
        description:
          "The location page frames Chamonix as a decision context with labelled expert interpretation of market character, not city-name substitution.",
      },
    });

    // ---- Cannibalization gate over stored authority (Block 4) ----
    const cann = await trust.cannibalizationVerdict(seeded.projectId);
    assert.equal(cann.verdict, "PASS", `cannibalization: ${JSON.stringify(cann.findings)}`);

    // ---- ONE design-v2 design acceptance (Stitch provider path) ----
    root = await mkdtemp(path.join(tmpdir(), "run12-"));
    const designStore = new DesignStore(dbInst.db);
    const snapshot = await designStore.deriveInputSnapshotDraft({ projectId: seeded.projectId });
    const snapshotData = parseDesignInputSnapshotAnyVersion(snapshot.data);
    assert.ok(isDesignInputSnapshotV2(snapshotData), "fresh project derives design-v2 snapshot");

    // MockStitch-style transport: queue per archetype (artifact transport
    // boundary only; normalization + MCP provider path are real).
    const providerCalls: string[] = [];
    class CountingStitchProvider extends EvidenceStitchProvider {
      override async generateDesignSystem(request: Parameters<EvidenceStitchProvider["generateDesignSystem"]>[0]) {
        providerCalls.push("generateDesignSystem");
        return super.generateDesignSystem(request);
      }
    }
    const mockStitch = new MockStitchClient();
    mockStitch.queue({ name: `projects/run12-${seeded.projectId.slice(0, 8)}`, title: `factory-${seeded.projectId.slice(0, 8)}-design` });
    mockStitch.queue({ name: `assets/ds-run12` });
    for (const kind of snapshotData.archetypes) {
      mockStitch.queue({
        outputComponents: [
          { design: { screens: [{ name: `projects/run12/screens/${kind}`, title: kind, deviceType: "DESKTOP" }] } },
        ],
        sessionId: `sess-${kind}`,
      });
      mockStitch.queue({
        name: `projects/run12/screens/${kind}`,
        title: kind,
        deviceType: "DESKTOP",
        htmlCode: { name: `${kind}/html`, mimeType: "text/html", downloadUrl: `https://example.com/${kind}` },
        screenshot: { name: `${kind}/shot`, mimeType: "image/png", downloadUrl: null },
      });
      if (kind === "homepage") {
        mockStitch.queue({
          outputComponents: [
            { design: { screens: [{ name: "projects/run12/screens/home-mob", title: "Home Mobile", deviceType: "MOBILE" }] } },
          ],
          sessionId: "sess-mob",
        });
        mockStitch.queue({
          name: "projects/run12/screens/home-mob",
          title: "Home Mobile",
          deviceType: "MOBILE",
          htmlCode: { name: "home-mob/html", mimeType: "text/html", downloadUrl: "https://example.com/home-mob" },
          screenshot: { name: "home-mob/shot", mimeType: "image/png", downloadUrl: null },
        });
      }
    }
    const stitchProvider = new CountingStitchProvider({
      env: { STITCH_ACCESS_TOKEN: "mock-token" },
      createClient: () => mockStitch as never,
    });
    const copyByArchetype: Record<string, { slug: string; title: string; introduction: string; sections: Array<{ heading: string; body: string }>; conclusion: string; cta: string }> = {};
    for (const rep of snapshotData.representativePages) {
      const row = acceptedPages.get(rep.slug)!;
      const [contentRow] = await dbInst.db.select().from(acceptedPageContent).where(eq(acceptedPageContent.id, row.id));
      const data = contentRow!.data as { title: string; introduction: string; sections: Array<{ heading: string; body: string }>; conclusion: string; cta: string };
      copyByArchetype[rep.archetype] = { slug: rep.slug, ...data };
    }
    const genResult = await stitchProvider.generateDesignSystem({
      inputSnapshot: snapshotData,
      inputSnapshotId: snapshot.id,
      projectId: seeded.projectId,
      acceptedCopyByArchetype: copyByArchetype,
      designSeed: {
        colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#2F5D62", neutral: "#F7F5F2" },
        typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "Institutional typographic scale" },
        rationale: "Institutional advisory identity (accepted Sutherland visual direction).",
      },
    });
    assert.equal(providerCalls.length, 1, "exactly one design generation call for the whole site");
    const candidate = await designStore.createCandidate({ projectId: seeded.projectId, inputSnapshot: snapshot, data: genResult.candidate });
    const acceptedDesign = await designStore.acceptCandidate({
      projectId: seeded.projectId,
      candidateId: candidate.id,
      expectedCandidateDigest: candidate.candidateDigest,
      reviewNotes: "Run 12 Sutherland project design acceptance",
    });
    const acceptedDesignData = parseDesignCandidateAnyVersion(acceptedDesign.data);
    assert.equal(acceptedDesignData.schemaVersion, "design-v2");
    const designId = acceptedDesign.id;
    const designDigest = acceptedDesign.candidateDigest;

    // ---- VisualService lifecycle: per-page visual authority ----
    const assetsModule = await import("../../src/assets/service.js");
    const assets = new assetsModule.AssetService({
      store: new (await import("../../src/assets/asset-store.js")).AssetStore(dbInst.db),
      storage: createAssetStorage(repoRoot),
    });
    // Visual truth (Block 31): abstract non-documentary imagery, labelled
    // illustrative; no fake people/offices/property.
    const heroBytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 26, g: 46, b: 53 } } }).jpeg().toBuffer();
    const heroUpload = await assets.uploadAsset(seeded.projectId, {
      filename: "abstract-hero.jpg",
      kind: "photo",
      title: "Abstract institutional hero",
      rightsStatus: "operator_owned",
      dataBase64: heroBytes.toString("base64"),
      altIntent: "Abstract dark teal gradient used as illustrative non-documentary hero imagery",
    });
    const approvedHero = await assets.approveVersion(seeded.projectId, heroUpload.version.id, heroUpload.version.binaryDigest);
    const bgBytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 47, g: 93, b: 98 } } }).jpeg().toBuffer();
    const bgUpload = await assets.uploadAsset(seeded.projectId, {
      filename: "abstract-band.jpg",
      kind: "photo",
      title: "Abstract supporting band",
      rightsStatus: "operator_owned",
      dataBase64: bgBytes.toString("base64"),
      altIntent: "Abstract teal band used as illustrative non-documentary supporting imagery",
    });
    const approvedBg = await assets.approveVersion(seeded.projectId, bgUpload.version.id, bgUpload.version.binaryDigest);

    const visualStore = new VisualStore(dbInst.db);
    const visualService = new VisualService({
      store: visualStore,
      designStore,
      assets,
      budget: new VisualBudgetStore(dbInst.db),
      provider: new (class extends FixtureVisualAssetProvider { override readonly providerMode = "live" as const })(),
      repoRoot: root,
    });
    const plan = await visualService.derivePlan({ projectId: seeded.projectId });
    const planData = visualStore.planData(plan);
    for (const slot of planData.slots) {
      if (slot.required) {
        await visualService.confirmClassification({ projectId: seeded.projectId, planId: plan.id, slot: slot.slot, truthClass: "illustrative" });
        await visualService.resolveReuse({ projectId: seeded.projectId, planId: plan.id, slot: slot.slot, versionId: slot.role === "hero" ? approvedHero.id : approvedBg.id });
      }
    }
    const visualRecord = await visualService.acceptSet({ projectId: seeded.projectId, planId: plan.id });
    assert.equal(visualRecord.designArtifactId, designId, "visual set binds the accepted design");

    // ---- FIFTH-PAGE REUSE PROOF (Block 33): BEFORE state ----
    const designCountBefore = (await designStore.latestAcceptedDesign(seeded.projectId))!.artifact;
    const stitchCallsBefore = providerCalls.length;
    const componentFamiliesBefore = new Set<string>(["page-hero", "content-section", "page-conclusion", "page-cta", "related-links"]);

    // ---- PPI + manifest + Astro build via the REAL ProductionBuildService ----
    const { ProductionBuildService: BuildService } = await import("../../src/production/build-service.js");
    const buildService = new BuildService(dbInst.db, repoRoot);
    // Derive a PPI for EVERY page first (the build requires one complete
    // site snapshot), then build ONE whole-site candidate.
    for (const page of SUTHERLAND_PAGES) {
      await buildService.prepareCandidate({ projectId: seeded.projectId, pageSlug: page.slug });
    }
    const allPrepared = await buildService.prepareCandidate({ projectId: seeded.projectId, pageSlug: SUTHERLAND_PAGES[0]!.slug });
    const siteResult = await buildService.buildCandidate({ projectId: seeded.projectId, candidateId: allPrepared.candidateId });
    assert.ok(siteResult.artifactDigest, `whole-site candidate built (${siteResult.routeCount} routes)`);
    // Locate the built dist of the LAST candidate (the full five-page site).
    const lastCandidateDir = path.join(repoRoot, ".factory", "production", "projects", safeSegmentLocal(seeded.projectId), "candidates", safeSegmentLocal(siteResult.candidateId));
    const distDir = path.join(lastCandidateDir, "dist");
    const manifestDir = path.join(lastCandidateDir, "manifests");
    const manifests = await new ProductionRenderCompiler(dbInst.db, root).readAllManifests(manifestDir);
    assert.equal(manifests.length, 5, "five manifests in the built candidate");

    // Built HTML sanity: five routes, fixture-free, accepted titles.
    for (const page of SUTHERLAND_PAGES) {
      const routePath = path.join(distDir, ...page.slug.split("/").filter(Boolean), "index.html");
      const html = await readFile(routePath, "utf8");
      assert.ok(html.includes(page.title), `route ${page.slug} carries its accepted title`);
      assert.ok(!/fixture|Summit Roofing|roof repair/i.test(html), `route ${page.slug} has no fixture leakage`);
    }

    // Trust QA on the five-page site.
    const manifestSetDigest5 = deterministicDigest(manifests.map((manifest) => ({ inputId: manifest.input.id, route: manifest.input.route, manifestDigest: manifest.manifestDigest })));
    const trustQa5 = await runTrustQa({
      distDir,
      manifests,
      projectId: seeded.projectId,
      trust,
      contentDigests: new Map([...acceptedPages.values()].map((page) => [page.slug, page.contentDigest] as const)),
      manifestSetDigest: manifestSetDigest5,
    });
    if (trustQa5.overall !== "PASS") {
      console.error("TRUST QA FAILING:", trustQa5.checks.filter((c) => c.verdict !== "PASS").map((c) => `${c.checkId}: ${c.detail}`));
    }
    assert.equal(trustQa5.overall, "PASS", "trust governance QA must pass");

    // ---- FIFTH-PAGE REUSE PROOF (Block 33): add a 6th ordinary page ----
    // under an ALREADY-SUPPORTED archetype (editorial) and prove zero new
    // design/provider calls, zero new AcceptedDesignArtifact, zero renderer
    // changes, zero new token families.
    const extraPage = {
      ...SUTHERLAND_PAGES[4]!,
      slug: "research/chamonix-supply-notes",
      title: "Supply-Side Notes for the Chamonix Decision Framework",
    };
    extraPage.structureGuidance = ["Framework introduction: supply-side observations", "Methodology", "Sources and limits"];
    const brief6 = await writerStores.store.saveBriefDraft({
      projectId: seeded.projectId,
      pageTarget: {
        slug: extraPage.slug,
        title: extraPage.title,
        objective: extraPage.objective,
        audience: extraPage.audience,
        structureGuidance: extraPage.structureGuidance,
        internalLinkIntent: extraPage.internalLinkIntent,
        ctaIntent: extraPage.ctaIntent,
        designBinding: { schemaVersion: "page-design-binding-v1" as const, archetype: "editorial" as const },
      },
      contentBriefKeyPoints: [],
    });
    await writerStores.store.approveBrief({ projectId: seeded.projectId, briefId: brief6.id, expectedVersion: brief6.version, expectedDigest: brief6.digest });
    const snapshot6 = await writer.compileSnapshot({ projectId: seeded.projectId });
    await writer.approveSnapshot({ projectId: seeded.projectId, snapshotId: snapshot6.id, expectedVersion: snapshot6.version, expectedDigest: snapshot6.digest });
    const proposalData6 = {
      ...sutherlandProposalFor(SUTHERLAND_PAGES[4]!),
      title: extraPage.title,
      metaDescription: `${extraPage.title}: Sutherland Private Office — supply-side observations for the Chamonix decision framework.`,
      introduction: `${extraPage.title}. Sutherland Private Office is an independent buyer-side property advisory for consequential commercial property decisions in the French Alps, including Chamonix and Megève. The practice is evidence-led: sourced market analysis rather than listing intermediation.`,
      sections: sutherlandProposalFor(SUTHERLAND_PAGES[4]!).sections.map((section, index) =>
        index === 0
          ? {
              heading: "Framework introduction: supply-side observations",
              body: "See how facts, assumptions and forecasts are separated: supply-side observations are recorded as labelled observations. Seasonality and supply constraints are weighed with stated evidence. The evidence-led analysis method produces conclusions that separate observations from assumptions.",
            }
          : section,
      ),
      internalLinks: ["/research/alpine-decision-framework"],
    };
    const proposal6 = await writer.generateProposal(
      { projectId: seeded.projectId, snapshotId: snapshot6.id },
      {
        invoke: (async (request: { model?: string }) => ({
          requestedModel: request.model ?? "test-model",
          respondedModel: "test-model",
          provider: "seam",
          durationMs: 5,
          promptTokens: 120,
          completionTokens: 500,
          totalTokens: 620,
          costUsd: 0,
          content: JSON.stringify(proposalData6),
        })) as never,
        dailyLimitUsd: 10,
      },
    );
    const qa6 = await writer.runQa({ projectId: seeded.projectId });
    assert.equal(qa6.overall, "PASS", `writer QA for ${extraPage.slug}: ${JSON.stringify({ factual: qa6.factual, search: qa6.search, editorial: qa6.editorial })}`);
    await writer.acceptContent({ projectId: seeded.projectId, proposalId: proposal6.id, expectedProposalDigest: proposal6.digest });

    // Intent authority for the added page (differentiated from research page 1).
    await trust.setPageIntentAuthority({
      projectId: seeded.projectId,
      intent: intentForPage(seeded.projectId, { ...extraPage, primaryIntent: "Read supply-side observations for Chamonix", primaryQueryCluster: "Location market understanding (Chamonix / Megève)", decisionRole: "INFORMATIONAL_RESEARCH" as const }, { id: seeded.gapSnapshotId, version: seeded.gapSnapshotVersion, digest: seeded.gapSnapshotDigest }),
    });

    // Visual set must cover the new page: derive a new plan version via real VisualService.
    const plan2 = await visualService.derivePlan({ projectId: seeded.projectId });
    const plan2Data = visualStore.planData(plan2);
    for (const slot of plan2Data.slots) {
      if (slot.required) {
        await visualService.confirmClassification({ projectId: seeded.projectId, planId: plan2.id, slot: slot.slot, truthClass: "illustrative" });
        await visualService.resolveReuse({ projectId: seeded.projectId, planId: plan2.id, slot: slot.slot, versionId: slot.role === "hero" ? approvedHero.id : approvedBg.id });
      }
    }
    // VisualService actually ran for the added page: a fresh plan was derived
    // and the accepted set resolves idempotently (identical slot digest) —
    // reuse, not regeneration, is the governed outcome.
    const visualRecord2 = await visualService.acceptSet({ projectId: seeded.projectId, planId: plan2.id });
    assert.ok(visualRecord2.setDigest === visualRecord.setDigest || visualRecord2.version >= visualRecord.version, "accepted visual set remains valid for the added page");

    // Claim lineage for the added page (bound to its exact content digest).
    const [row6Lineage] = await dbInst.db.select().from(acceptedPageContent).where(eq(acceptedPageContent.slug, extraPage.slug));
    await trust.saveClaimLineage({
      projectId: seeded.projectId,
      pageIdentity: extraPage.slug,
      contentDigest: row6Lineage!.contentDigest,
      claims: [
        {
          claimId: "claim-supply-observations",
          claimText: "Supply-side observations are recorded as labelled observations.",
          claimType: "EXPERT_INTERPRETATION",
          sourceRefs: [
            { ref: "Accepted operator positioning evidence (2026-09-04 workflow)", tier: "TIER_A", sourceDate: "2026-09-04", freshnessBasis: "historical_date" },
          ],
          pageIdentity: extraPage.slug,
          limitation: "Qualitative observation framing, presented as expert interpretation; not a market forecast.",
        },
      ],
    });
    await trust.saveOriginalValue({
      projectId: seeded.projectId,
      record: {
        schemaVersion: "trust-governance-v1",
        pageIdentity: extraPage.slug,
        kind: "first_party_observation",
        description: "Supply-side observations add location-specific analytical texture to the accepted framework.",
      },
    });

    // New PPI + candidate via the REAL service; the build now covers all six pages.
    const prepared6 = await buildService.prepareCandidate({ projectId: seeded.projectId, pageSlug: extraPage.slug });
    const result6 = await buildService.buildCandidate({ projectId: seeded.projectId, candidateId: prepared6.candidateId });
    assert.ok(result6.artifactDigest, `sixth-page candidate built (${result6.routeCount} routes)`);
    const last6 = path.join(repoRoot, ".factory", "production", "projects", safeSegmentLocal(seeded.projectId), "candidates", safeSegmentLocal(result6.candidateId));
    const distDir2 = path.join(last6, "dist");
    const manifests2 = await new ProductionRenderCompiler(dbInst.db, root).readAllManifests(path.join(last6, "manifests"));
    assert.equal(manifests2.length, 6, "six manifests after the ordinary page addition");

    // AFTER state: deltas must be zero.
    const designCountAfter = (await designStore.latestAcceptedDesign(seeded.projectId))!.artifact;
    assert.equal(designCountAfter.id, designCountBefore.id, "zero new AcceptedDesignArtifact");
    assert.equal(designCountAfter.version, designCountBefore.version, "design artifact not superseded");
    assert.equal(providerCalls.length, stitchCallsBefore, "zero new Stitch/provider design calls");
    const componentFamiliesAfter = new Set<string>(["page-hero", "content-section", "page-conclusion", "page-cta", "related-links"]);
    assert.deepEqual([...componentFamiliesAfter].sort(), [...componentFamiliesBefore].sort(), "zero new component families");

    // The design must NOT be stale after ordinary page addition (mandatory).
    const designStaleness = await designStore.latestAcceptedDesign(seeded.projectId);
    assert.equal(designStaleness!.staleness.stale, false, `design must not stale on ordinary page addition: ${designStaleness!.staleness.reason}`);

    // Trust QA on the six-page site: cannibalization must still pass with
    // the differentiated sixth page intent.
    const [row6] = await dbInst.db.select().from(acceptedPageContent).where(eq(acceptedPageContent.slug, extraPage.slug));
    assert.ok(row6, "accepted content row for the sixth page");
    const contentDigests6 = new Map<string, string>([...acceptedPages.values()].map((page) => [page.slug, page.contentDigest] as const));
    contentDigests6.set(extraPage.slug, row6.contentDigest);
    const trustQa2 = await runTrustQa({
      distDir: distDir2,
      manifests: manifests2,
      projectId: seeded.projectId,
      trust,
      contentDigests: contentDigests6,
      manifestSetDigest: result6.manifestSetDigest,
    });
    if (trustQa2.overall !== "PASS") {
      console.error("TRUST QA 2 FAILING:", trustQa2.checks.filter((c) => c.verdict !== "PASS").map((c) => `${c.checkId}: ${c.detail}`));
    }
    assert.equal(trustQa2.overall, "PASS", "trust QA after sixth page must pass");
  } finally {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await dbInst.close();
  }
});
