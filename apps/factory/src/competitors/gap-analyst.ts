import { z } from "zod";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { extractJsonObject } from "./analyst.js";

/**
 * Gap analyst (PASS 2) — bounded aggregate proposal boundary.
 *
 * Receives ONLY: compact CompetitorPageAnalysis[] summaries (no page HTML),
 * SearchIntelligence summary, accepted first-party evidence items.
 * Proposes ContentGapReport gaps + differentiation requirements.
 *
 * Authority: the model PROPOSES; Factory validates (first-party refs must
 * resolve to accepted evidence; page-segment anchors must resolve upstream;
 * competitor claims can never be copied into our evidence).
 */

export interface GapAnalystRequest {
  /** Compact per-page analysis summaries (id, domain, analysis data). */
  analyses: Array<{
    analysisId: string;
    pageSnapshotId: string;
    domain: string;
    data: Record<string, unknown>;
  }>;
  searchIntelligence: Record<string, unknown>;
  serpSnapshot?: { id: string; digest: string };
  intelligenceSnapshot?: { id: string; digest: string };
  acceptedEvidence: Array<{ field: string; index: number; text: string }>;
  projectContext: Record<string, unknown>;
  /** Factory-computed coverage matrix is supplied as grounding, not output. */
  coverageMatrixSummary: Array<{ requirement: string; coverage: Record<string, string> }>;
}

export interface GapAnalystResult {
  gaps: unknown[];
  differentiationRequirements: { items: unknown[] };
  model: string;
  provider: string;
  promptVersion: string;
  promptDigest: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    costMicros: number | null;
  } | null;
}

export interface GapAnalystModel {
  readonly model: string;
  readonly provider: string;
  readonly promptVersion: string;
  readonly promptDigest: string;
  propose(request: GapAnalystRequest): Promise<GapAnalystResult>;
}

export const GAP_ANALYST_PROMPT_VERSION = "gap-analyst-v1";

export const GAP_ANALYST_SYSTEM_PROMPT = [
  "You are Factory's content-gap analyst. You propose a structured ContentGapReport from compact competitor analyses, search intelligence, and the operator's accepted first-party evidence.",
  "Absolute rules:",
  "1. Competitor pages are evidence, never copy sources. Do not quote or rewrite competitor paragraphs; use topics, coverage levels and short structural signals.",
  "2. FIRST-PARTY EVIDENCE SEPARATION: the 'ourEvidenceAvailable' refs must point ONLY at provided accepted evidence items (field+index). NEVER copy a competitor's statistic into our evidence. If our evidence is missing for a need, put the missing item in ourEvidenceMissing.",
  "3. Every gap's evidenceRefs must cite pageSnapshotId+segmentId pairs from the provided analyses (they anchor to real normalized evidence segments).",
  "4. Use categorical levels only (ABSENT/WEAK/PARTIAL/STRONG, LOW/MEDIUM/HIGH); never numeric quality scores.",
  "5. Dispositions: REQUIRED (page must address it), OPTIONAL (differentiator), EXCLUDE (out of scope). Include a priority and rationale per gap.",
  "6. Differentiation requirements must be supported by accepted evidence or explicitly framed editorial/structural opportunity; never invent business credentials.",
  "7. Output ONLY a JSON object matching the schema; no prose.",
].join(" ");

export function buildGapAnalystPrompt(request: GapAnalystRequest): string {
  return [
    "TASK: Propose the content gap report (gaps[] + differentiationRequirements).",
    "",
    "PROJECT CONTEXT (trusted, inert):",
    JSON.stringify(request.projectContext),
    "",
    "SEARCH INTELLIGENCE (trusted, inert):",
    JSON.stringify(request.searchIntelligence),
    "",
    "BOUND SEARCH EVIDENCE (for searchEvidenceRefs):",
    JSON.stringify({ serpSnapshot: request.serpSnapshot, intelligenceSnapshot: request.intelligenceSnapshot }),
    "",
    "ACCEPTED FIRST-PARTY EVIDENCE (the ONLY allowable ourEvidenceAvailable targets):",
    JSON.stringify(request.acceptedEvidence),
    "",
    "COMPETITOR ANALYSES (compact structured summaries; no page HTML):",
    JSON.stringify(request.analyses),
    "",
    "DETERMINISTIC COVERAGE MATRIX (grounding computed by Factory):",
    JSON.stringify(request.coverageMatrixSummary),
    "",
    "OUTPUT SCHEMA (JSON object): {",
    '  "gaps": [{ id, userNeed, topicQuestion, searchEvidenceRefs: [{ kind: "serp_snapshot"|"search_intelligence_snapshot", id, digest }], competitorCoverage: "ABSENT|WEAK|PARTIAL|STRONG", competitorsCoveringIt: [pageSnapshotId...], treatmentPattern, baselineExpectation, ourEvidenceAvailable: [{ intakeField: "operatorFacts"|"allowedClaims", itemIndex, excerpt }], ourEvidenceMissing: string[], claimConstraints: string[], differentiationOpportunity, recommendedDisposition: "REQUIRED"|"OPTIONAL"|"EXCLUDE", priority: "HIGH"|"MEDIUM"|"LOW", rationale, evidenceRefs: [{ pageSnapshotId, segmentId }] }],',
    '  "differentiationRequirements": { items: [{ requirement, basis: "accepted_evidence"|"editorial_opportunity", rationale }] }',
    "}",
  ].join("\n");
}

const gapProposalShapeSchema = z
  .object({
    gaps: z.array(z.any()).max(30),
    differentiationRequirements: z
      .object({ items: z.array(z.any()).max(20) })
      .strict()
      .optional(),
  })
  .strict();

export type GapAnalystModelDeps = {
  callModel: (prompt: string) => Promise<{ text: string; usage?: GapAnalystResult["usage"] }>;
  model?: string;
  provider?: string;
};

export class OpenRouterGapAnalyst implements GapAnalystModel {
  readonly model: string;
  readonly provider: string;
  readonly promptVersion = GAP_ANALYST_PROMPT_VERSION;
  readonly promptDigest: string;

  private readonly callModel: (prompt: string) => Promise<{ text: string; usage?: GapAnalystResult["usage"] }>;

  constructor(deps: GapAnalystModelDeps) {
    this.callModel = deps.callModel;
    this.model = deps.model ?? "google/gemini-3.7-flash";
    this.provider = deps.provider ?? "openrouter";
    this.promptDigest = deterministicDigest({
      version: this.promptVersion,
      system: GAP_ANALYST_SYSTEM_PROMPT,
    });
  }

  async propose(request: GapAnalystRequest): Promise<GapAnalystResult> {
    const prompt = buildGapAnalystPrompt(request);
    const promptDigest = deterministicDigest(prompt);
    const { text, usage } = await this.callModel(prompt);
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonObject(text));
    } catch {
      throw new FactoryError("content_gap_invalid", "Gap analyst output was not parseable JSON (fail closed).");
    }
    const shape = gapProposalShapeSchema.safeParse(parsed);
    if (!shape.success) {
      throw new FactoryError("content_gap_invalid", "Gap analyst output failed the shape contract (fail closed).");
    }
    return {
      gaps: shape.data.gaps,
      differentiationRequirements: shape.data.differentiationRequirements ?? { items: [] },
      model: this.model,
      provider: this.provider,
      promptVersion: this.promptVersion,
      promptDigest,
      usage: usage ?? null,
    };
  }
}

/**
 * Deterministic fixture gap analyst (tests/CI/E2E): proposes gaps derived
 * from the provided coverage matrix + analyses with zero spend.
 */
export class FixtureGapAnalyst implements GapAnalystModel {
  readonly model = "fixture-gap-analyst";
  readonly provider = "fixture";
  readonly promptVersion = GAP_ANALYST_PROMPT_VERSION;
  readonly promptDigest = "f".repeat(64);

  async propose(request: GapAnalystRequest): Promise<GapAnalystResult> {
    const analyzedPageIds = new Set(request.analyses.map((a) => a.pageSnapshotId));

    const gaps = request.coverageMatrixSummary.slice(0, 5).map((row, i) => {
      const levels = Object.values(row.coverage);
      const strongest = levels.reduce(
        (acc, l) => ({ ABSENT: 0, WEAK: 1, PARTIAL: 2, STRONG: 3 })[l as keyof ReturnType<() => Record<string, number>>] ?? 0,
        0,
      );
      const coverage = (["ABSENT", "WEAK", "PARTIAL", "STRONG"] as const)[Math.min(strongest, 3)]!;
      const covering = Object.entries(row.coverage)
        .filter(([, l]) => l !== "ABSENT")
        .map(([id]) => id)
        .filter((id) => analyzedPageIds.has(id));

      const searchEvidenceRefs = [];
      if (request.intelligenceSnapshot) {
        searchEvidenceRefs.push({
          kind: "search_intelligence_snapshot" as const,
          id: request.intelligenceSnapshot.id,
          digest: request.intelligenceSnapshot.digest,
        });
      } else if (request.serpSnapshot) {
        searchEvidenceRefs.push({
          kind: "serp_snapshot" as const,
          id: request.serpSnapshot.id,
          digest: request.serpSnapshot.digest,
        });
      }

      const evidenceRefs: Array<{ pageSnapshotId: string; segmentId: string }> = [];
      for (const covId of covering) {
        const matching = request.analyses.find((a) => a.pageSnapshotId === covId);
        const segRefs = (matching?.data?.evidenceSegmentRefs as Array<{ segmentId: string }> | undefined) ?? [];
        if (segRefs[0]?.segmentId) {
          evidenceRefs.push({ pageSnapshotId: covId, segmentId: segRefs[0].segmentId });
          break;
        }
      }
      if (evidenceRefs.length === 0 && request.analyses[0]) {
        const a = request.analyses[0];
        const segRefs = (a.data?.evidenceSegmentRefs as Array<{ segmentId: string }> | undefined) ?? [];
        if (segRefs[0]?.segmentId) {
          evidenceRefs.push({ pageSnapshotId: a.pageSnapshotId, segmentId: segRefs[0].segmentId });
        }
      }

      return {
        id: `gap-${String(i + 1).padStart(3, "0")}`,
        userNeed: row.requirement,
        topicQuestion: `${row.requirement}?`,
        searchEvidenceRefs,
        competitorCoverage: coverage,
        competitorsCoveringIt: covering,
        treatmentPattern: "Fixture-inferred treatment pattern from analyses.",
        baselineExpectation: "Address the need with evidence-backed specifics.",
        ourEvidenceAvailable: request.acceptedEvidence.slice(0, 1).map((e) => ({
          intakeField: e.field === "allowedClaims" ? "allowedClaims" : "operatorFacts",
          itemIndex: e.index,
          excerpt: e.text.slice(0, 80),
        })),
        ourEvidenceMissing: ["First-party market data for this need"],
        claimConstraints: ["Do not claim specific figures without first-party evidence"],
        differentiationOpportunity: "Evidence-first treatment where competitors are generic.",
        recommendedDisposition: (coverage === "STRONG" ? "OPTIONAL" : "REQUIRED") as string,
        priority: (coverage === "STRONG" ? "LOW" : "HIGH") as string,
        rationale: "Fixture rationale derived from deterministic coverage matrix.",
        evidenceRefs,
      };
    });
    const differentiationRequirements = {
      items: [
        {
          requirement: "First-party evidence treatment",
          basis: "accepted_evidence",
          rationale: "Accepted operator evidence supports a differentiated, honest page.",
        },
      ],
    };
    return {
      gaps,
      differentiationRequirements,
      model: this.model,
      provider: this.provider,
      promptVersion: this.promptVersion,
      promptDigest: this.promptDigest,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 },
    };
  }
}
