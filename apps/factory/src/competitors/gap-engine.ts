import {
  parseContentGapReportData,
  type CompetitorPageAnalysisData,
  type CompetitorEvidencePacket,
  type ContentGap,
  type CoverageLevel,
  type CoverageMatrix,
} from "@factory/contracts";
import { deterministicDigest } from "../intelligence/digest.js";
import { FactoryError } from "../executor/errors.js";

/**
 * Content Gap Engine (Macro Run 3, P5) — deterministic aggregation layer.
 *
 * Two-pass AI strategy: PASS 1 produced per-page analyses; PASS 2 (the
 * model gap proposal) receives ONLY compact analyses + search intelligence
 * + accepted first-party evidence — never competitor HTML.
 *
 * This module owns the deterministic parts:
 * - coverage matrix computed from stored analyses (not model prose);
 * - first-party evidence separation: model-proposed "our evidence" refs
 *   must point at real accepted intake evidence items;
 * - report finalization: provenance binding + strict validation.
 *
 * Authority rules enforced here:
 * - a competitor claim can NEVER become our claim: ourEvidenceAvailable
 *   must reference accepted operator evidence, competitor statements stay
 *   in competitorCoverage/treatmentPattern;
 * - no fabricated scores; categorical levels only;
 * - every evidence ref the model emits must resolve upstream.
 */

export const COVERAGE_MATRIX_POLICY_VERSION = "coverage-matrix-v1";

const LEVEL_ORDER: Record<CoverageLevel, number> = { ABSENT: 0, WEAK: 1, PARTIAL: 2, STRONG: 3 };

/**
 * Deterministic coverage matrix: rows = user needs / semantic requirements
 * (from search intelligence userNeeds + semanticCoverageRequirements),
 * cells = per analyzed competitor page, derived from that page's analysis
 * coverage areas by bounded keyword matching on area labels and the page's
 * topics/subtopics. A cell stays ABSENT when no analysis supports coverage.
 */
export function buildCoverageMatrix(input: {
  requirements: Array<{ requirement: string }>;
  pages: Array<{
    pageSnapshotId: string;
    domain: string;
    analysis: CompetitorPageAnalysisData;
  }>;
}): CoverageMatrix {
  const rows = input.requirements.slice(0, 40).map(({ requirement }) => {
    const reqTokens = requirement
      .toLowerCase()
      .split(/[^a-zà-ÿ0-9]+/)
      .filter((t) => t.length >= 4);
    const cells = input.pages.map(({ pageSnapshotId, domain, analysis }) => {
      // Match analysis coverage areas whose label overlaps the requirement
      // tokens; strongest matched level wins; no match => ABSENT.
      let best: CoverageLevel = "ABSENT";
      for (const area of analysis.coverageAreas) {
        const areaTokens = area.area
          .toLowerCase()
          .split(/[^a-zà-ÿ0-9]+/)
          .filter((t) => t.length >= 4);
        const overlap = reqTokens.some((rt) => areaTokens.some((at) => at.startsWith(rt) || rt.startsWith(at)));
        if (overlap && LEVEL_ORDER[area.level] > LEVEL_ORDER[best]) {
          best = area.level;
        }
      }
      return { pageSnapshotId, domain, level: best };
    });
    return { requirement, cells };
  });
  return { policyVersion: COVERAGE_MATRIX_POLICY_VERSION, rows };
}

/** First-party evidence item from accepted ProjectInputSnapshot payload. */
export interface FirstPartyEvidenceItem {
  field: "operatorFacts" | "allowedClaims";
  index: number;
  text: string;
}

/**
 * Collect accepted first-party evidence items from the intake payload.
 * These are the ONLY items the model may reference as "our evidence".
 */
export function collectFirstPartyEvidence(intakePayload: Record<string, unknown>): FirstPartyEvidenceItem[] {
  const evidence = (intakePayload.evidence ?? {}) as Record<string, unknown>;
  const operatorFacts = ((evidence.operatorFacts ?? []) as string[]).slice(0, 30);
  const allowedClaims = ((evidence.allowedClaims ?? []) as string[]).slice(0, 20);
  return [
    ...operatorFacts.map((text, index) => ({ field: "operatorFacts" as const, index, text })),
    ...allowedClaims.map((text, index) => ({ field: "allowedClaims" as const, index, text })),
  ];
}

/**
 * Validate a model-proposed gap set against Factory authority:
 * - every ourEvidenceAvailable ref must resolve to a real accepted evidence
 *   item with matching excerpt prefix (model cannot invent our facts);
 * - evidenceRefs (page-segment anchors) are validated by the caller against
 *   stored analyses (model cannot anchor to nonexistent evidence);
 * - categorical constraints already enforced by the strict contract.
 */
export function validateGapFirstPartyRefs(
  gaps: ContentGap[],
  acceptedEvidence: FirstPartyEvidenceItem[],
): void {
  for (const gap of gaps) {
    for (const ref of gap.ourEvidenceAvailable) {
      const match = acceptedEvidence.find(
        (item) => item.field === ref.intakeField && item.index === ref.itemIndex,
      );
      if (!match) {
        throw new Error(
          `gap "${gap.id}" references first-party evidence that does not exist in accepted inputs`,
        );
      }
      const excerpt = ref.excerpt.trim();
      if (excerpt && !match.text.startsWith(excerpt.slice(0, Math.min(excerpt.length, 80)))) {
        throw new Error(
          `gap "${gap.id}" misquotes first-party evidence (model cannot invent operator facts)`,
        );
      }
    }
  }
}

/**
 * Compute the decisions digest for acceptance binding.
 * Deterministic across restarts; the acceptance binds report digest +
 * decisions digest so any post-review edit produces a new version.
 */
export function decisionsDigest(
  reportDigest: string,
  decisions: Array<{ gapId: string; disposition: string; priority?: string | null; note?: string | null }>,
): string {
  const canonical = decisions
    .map((d) => ({ gapId: d.gapId, disposition: d.disposition, priority: d.priority ?? null, note: d.note ?? null }))
    .sort((a, b) => (a.gapId < b.gapId ? -1 : a.gapId > b.gapId ? 1 : 0));
  return deterministicDigest({ reportDigest, decisions: canonical });
}

/**
 * Staleness: an accepted (or reviewable) gap snapshot is stale when any
 * authoritative upstream digest/version differs from what it bound.
 */
export function computeGapStaleness(input: {
  bound: {
    acceptedInputVersion: number;
    acceptedInputDigest: string;
    serpSnapshotDigest: string;
    intelligenceSnapshotDigest: string;
    pageSnapshotDigests: string[];
  };
  current: {
    acceptedInputVersion: number;
    acceptedInputDigest: string;
    serpSnapshotDigest: string;
    intelligenceSnapshotDigest: string;
    pageSnapshotDigests: string[];
  };
}): { stale: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (
    input.bound.acceptedInputVersion !== input.current.acceptedInputVersion ||
    input.bound.acceptedInputDigest !== input.current.acceptedInputDigest
  ) {
    reasons.push("Accepted project inputs changed.");
  }
  if (input.bound.serpSnapshotDigest !== input.current.serpSnapshotDigest) {
    reasons.push("SERP evidence changed.");
  }
  if (input.bound.intelligenceSnapshotDigest !== input.current.intelligenceSnapshotDigest) {
    reasons.push("Search intelligence changed.");
  }
  const boundPages = new Set(input.bound.pageSnapshotDigests);
  if (
    boundPages.size !== input.current.pageSnapshotDigests.length ||
    input.current.pageSnapshotDigests.some((d) => !boundPages.has(d))
  ) {
    reasons.push("Competitor evidence changed.");
  }
  return { stale: reasons.length > 0, reasons };
}

export interface GapGroundingContext {
  serpSnapshotId: string;
  serpSnapshotDigest: string;
  intelligenceSnapshotId: string;
  intelligenceSnapshotDigest: string;
  pageSnapshots: Array<{
    id: string;
    digest: string;
    classification: string;
    validSegmentIds?: ReadonlySet<string> | string[];
  }>;
  analyses: Array<{
    id: string;
    digest: string;
    pageSnapshotId: string;
  }>;
}

/**
 * Strict cross-validation of model proposal grounding against authoritative upstream inputs:
 * 1. searchEvidenceRefs:
 *    - must be non-empty (at least one valid ref required)
 *    - every referenced ID + digest must match either the bound SERP snapshot or bound Search Intelligence snapshot
 *    - fabricated/foreign/mismatched refs throw
 * 2. competitorsCoveringIt:
 *    - every ID must resolve to an included analyzed competitor page snapshot in this exact run lineage
 *    - unknown IDs or pages classified EXCLUDE / REFERENCE_ONLY throw
 * 3. evidenceRefs:
 *    - pageSnapshotId must resolve to an analyzed page in this run
 *    - segmentId must exist in that exact snapshot's extracted segments
 * 4. pageSnapshotRefs & analysisRefs:
 *    - cross-checks IDs + digests against persisted dependencies; rejects mismatches
 * 5. first-party evidence:
 *    - separate from competitor claims; exact excerpt check
 */
export function validateContentGapGrounding(
  gaps: ContentGap[],
  context: GapGroundingContext,
): void {
  const pageMap = new Map(context.pageSnapshots.map((p) => [p.id, p]));
  const analysisPageIds = new Set(context.analyses.map((a) => a.pageSnapshotId));

  for (const gap of gaps) {
    // 1. searchEvidenceRefs: cannot be empty where search evidence is required
    if (!gap.searchEvidenceRefs || gap.searchEvidenceRefs.length === 0) {
      throw new FactoryError(
        "content_gap_invalid",
        `gap "${gap.id}" requires searchEvidenceRefs; empty array is not grounded`,
      );
    }
    for (const ref of gap.searchEvidenceRefs) {
      if (ref.kind === "serp_snapshot") {
        if (ref.id !== context.serpSnapshotId || ref.digest !== context.serpSnapshotDigest) {
          throw new FactoryError(
            "content_gap_invalid",
            `gap "${gap.id}" references invalid or foreign SERP snapshot "${ref.id}" (digest mismatch or unknown ID)`,
          );
        }
      } else if (ref.kind === "search_intelligence_snapshot") {
        if (ref.id !== context.intelligenceSnapshotId || ref.digest !== context.intelligenceSnapshotDigest) {
          throw new FactoryError(
            "content_gap_invalid",
            `gap "${gap.id}" references invalid or foreign search intelligence snapshot "${ref.id}" (digest mismatch or unknown ID)`,
          );
        }
      } else {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" has unsupported searchEvidenceRef kind "${(ref as { kind: string }).kind}"`,
        );
      }
    }

    // 2. competitorsCoveringIt: must resolve to included analyzed competitor page snapshots
    for (const competitorId of gap.competitorsCoveringIt) {
      const page = pageMap.get(competitorId);
      if (!page) {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" references unknown competitor page "${competitorId}"`,
        );
      }
      if (page.classification !== "INCLUDE") {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" references competitor page "${competitorId}" with classification ${page.classification}; only INCLUDE pages may represent competitive coverage`,
        );
      }
      if (!analysisPageIds.has(competitorId)) {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" references competitor page "${competitorId}" which was not analyzed in this run`,
        );
      }
    }

    // 3. evidenceRefs: pageSnapshotId and segmentId must exist in the exact extracted snapshot
    for (const evRef of gap.evidenceRefs) {
      const page = pageMap.get(evRef.pageSnapshotId);
      if (!page) {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" references unknown page snapshot "${evRef.pageSnapshotId}" in evidenceRefs`,
        );
      }
      if (!analysisPageIds.has(evRef.pageSnapshotId)) {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" references page "${evRef.pageSnapshotId}" in evidenceRefs that does not belong to the analyzed set for this report`,
        );
      }
      if (page.validSegmentIds) {
        const segSet =
          page.validSegmentIds instanceof Set
            ? page.validSegmentIds
            : new Set(page.validSegmentIds);
        if (!segSet.has(evRef.segmentId)) {
          throw new FactoryError(
            "content_gap_invalid",
            `gap "${gap.id}" references unknown segment "${evRef.segmentId}" for page "${evRef.pageSnapshotId}"`,
          );
        }
      }
    }
  }
}

/**
 * Finalize the model gap proposal into the strict report contract with
 * Factory-computed provenance (the model never sets digests/review state).
 */
export function finalizeGapReport(input: {
  modelGaps: unknown;
  serpSnapshotId: string;
  serpSnapshotDigest: string;
  intelligenceSnapshotId: string;
  intelligenceSnapshotDigest: string;
  pageSnapshotRefs: Array<{ id: string; digest: string }>;
  analysisRefs: Array<{ id: string; digest: string }>;
  acceptedInputSnapshotId: string;
  acceptedInputSnapshotVersion: number;
  acceptedInputDigest: string;
  classificationDigest?: string;
  effectiveClassifications?: Array<{ pageSnapshotId: string; classification: "INCLUDE" | "EXCLUDE" | "REFERENCE_ONLY"; reason?: string }>;
  coverageMatrix: CoverageMatrix;
  model: string;
  provider: string;
  promptVersion: string;
  acceptedEvidence: FirstPartyEvidenceItem[];
  grounding?: GapGroundingContext;
}): ReturnType<typeof parseContentGapReportData> {
  const parsed = input.modelGaps as { gaps?: unknown; differentiationRequirements?: unknown };
  const gaps = Array.isArray(parsed?.gaps) ? parsed.gaps : [];
  const differentiation =
    (parsed?.differentiationRequirements as { items?: unknown } | undefined)?.items;
  const report = {
    serpSnapshotId: input.serpSnapshotId,
    serpSnapshotDigest: input.serpSnapshotDigest,
    intelligenceSnapshotId: input.intelligenceSnapshotId,
    intelligenceSnapshotDigest: input.intelligenceSnapshotDigest,
    pageSnapshotRefs: input.pageSnapshotRefs,
    analysisRefs: input.analysisRefs,
    acceptedInputSnapshotId: input.acceptedInputSnapshotId,
    acceptedInputSnapshotVersion: input.acceptedInputSnapshotVersion,
    acceptedInputDigest: input.acceptedInputDigest,
    classificationDigest: input.classificationDigest,
    effectiveClassifications: input.effectiveClassifications,
    coverageMatrix: input.coverageMatrix,
    gaps,
    differentiationRequirements: { items: Array.isArray(differentiation) ? differentiation : [] },
    model: input.model,
    provider: input.provider,
    promptVersion: input.promptVersion,
    reviewState: "model_proposed" as const,
  };
  const data = parseContentGapReportData(report);

  if (input.grounding) {
    const pageMap = new Map(input.grounding.pageSnapshots.map((p) => [p.id, p]));
    for (const ref of input.pageSnapshotRefs) {
      const page = pageMap.get(ref.id);
      if (!page || page.digest !== ref.digest) {
        throw new FactoryError(
          "content_gap_invalid",
          `Page snapshot ref "${ref.id}" does not match authoritative stored dependencies`,
        );
      }
    }
    const analysisMap = new Map(input.grounding.analyses.map((a) => [a.id, a]));
    for (const ref of input.analysisRefs) {
      const analysis = analysisMap.get(ref.id);
      if (!analysis || analysis.digest !== ref.digest) {
        throw new FactoryError(
          "content_gap_invalid",
          `Analysis ref "${ref.id}" does not match authoritative stored dependencies`,
        );
      }
    }
    validateContentGapGrounding(data.gaps as ContentGap[], input.grounding);
  }

  validateGapFirstPartyRefs(data.gaps as ContentGap[], input.acceptedEvidence);
  return data;
}

/** Convenience: re-export for service use. */
export type { CompetitorEvidencePacket };
