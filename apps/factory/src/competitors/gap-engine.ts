import {
  parseContentGapReportData,
  type CompetitorPageAnalysisData,
  type CompetitorEvidencePacket,
  type ContentGap,
  type CoverageLevel,
  type CoverageMatrix,
  type AcceptedSearchSemantics,
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
 * Deterministically generate a stable requirement ID from requirement text.
 */
export function generateRequirementId(requirement: string): string {
  return `req-${deterministicDigest(requirement.trim().toLowerCase()).slice(0, 12)}`;
}

/**
 * Deterministic coverage matrix: rows = user needs / semantic requirements
 * (from search intelligence userNeeds + semanticCoverageRequirements),
 * cells = per analyzed competitor page, derived from that page's analysis
 * coverage areas by bounded keyword matching on area labels and the page's
 * topics/subtopics. A cell stays ABSENT when no analysis supports coverage.
 */
export function buildCoverageMatrix(input: {
  requirements: Array<{ requirementId?: string; requirement: string }>;
  pages: Array<{
    pageSnapshotId: string;
    domain: string;
    analysis: CompetitorPageAnalysisData;
  }>;
}): CoverageMatrix {
  const seenIds = new Set<string>();
  const rows = input.requirements.slice(0, 40).map(({ requirementId, requirement }) => {
    const baseId = requirementId ?? generateRequirementId(requirement);
    let id = baseId;
    let counter = 1;
    while (seenIds.has(id)) {
      id = `${baseId}-${counter++}`;
    }
    seenIds.add(id);

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
    return { requirementId: id, requirement, cells };
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
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" references first-party evidence that does not exist in accepted inputs`,
        );
      }
      const excerpt = ref.excerpt.trim();
      if (excerpt && !match.text.startsWith(excerpt.slice(0, Math.min(excerpt.length, 80)))) {
        throw new FactoryError(
          "content_gap_invalid",
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
  coverageMatrix?: CoverageMatrix;
  acceptedEvidence?: FirstPartyEvidenceItem[];
}

/**
 * Strict cross-validation of model proposal grounding against authoritative upstream inputs:
 * 1. searchEvidenceRefs:
 *    - must be non-empty (at least one valid ref required)
 *    - every referenced ID + digest must match either the bound SERP snapshot or bound Search Intelligence snapshot
 *    - fabricated/foreign/mismatched refs throw
 * 2. competitorsCoveringIt & coverage invariants:
 *    - every ID must resolve to an included analyzed competitor page snapshot in this exact run lineage
 *    - unknown IDs or pages classified EXCLUDE / REFERENCE_ONLY throw
 *    - non-ABSENT coverage must have >= 1 evidenceRef and >= 1 competitorCoveringIt
 *    - ABSENT coverage must have 0 evidenceRefs and 0 competitorsCoveringIt
 * 3. evidenceRefs:
 *    - pageSnapshotId must resolve to an analyzed INCLUDE page in this run
 *    - segmentId must exist in that exact snapshot's extracted segments
 * 4. coverage <-> evidence cross-binding & matrix consistency:
 *    - every evidenceRef pageSnapshotId must belong to competitorsCoveringIt
 *    - model coverage must not contradict the deterministic coverage matrix
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

    // 2. Coverage grounding invariants (P1-03)
    if (gap.competitorCoverage !== "ABSENT") {
      if (!gap.evidenceRefs || gap.evidenceRefs.length === 0) {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" has ${gap.competitorCoverage} competitor coverage but empty evidenceRefs; competitor-derived coverage must cite real competitor evidence`,
        );
      }
      if (!gap.competitorsCoveringIt || gap.competitorsCoveringIt.length === 0) {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" has ${gap.competitorCoverage} competitor coverage but empty competitorsCoveringIt`,
        );
      }
    } else {
      if (gap.competitorsCoveringIt && gap.competitorsCoveringIt.length > 0) {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" has ABSENT competitor coverage but non-empty competitorsCoveringIt`,
        );
      }
      if (gap.evidenceRefs && gap.evidenceRefs.length > 0) {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" has ABSENT competitor coverage but non-empty evidenceRefs; ABSENT coverage cannot cite competitor evidence`,
        );
      }
    }

    // 3. competitorsCoveringIt: must resolve to included analyzed competitor page snapshots
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

    // 4. evidenceRefs: pageSnapshotId and segmentId must exist in the exact extracted snapshot
    for (const evRef of gap.evidenceRefs) {
      const page = pageMap.get(evRef.pageSnapshotId);
      if (!page) {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" references unknown page snapshot "${evRef.pageSnapshotId}" in evidenceRefs`,
        );
      }
      if (page.classification !== "INCLUDE") {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" references page "${evRef.pageSnapshotId}" with classification ${page.classification}; only INCLUDE pages may represent competitive coverage`,
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

    // 4b. Coverage <-> evidence cross-binding: every evidenceRef pageSnapshotId must belong to competitorsCoveringIt
    if (gap.competitorCoverage !== "ABSENT") {
      const coveringSet = new Set(gap.competitorsCoveringIt);
      for (const evRef of gap.evidenceRefs) {
        if (!coveringSet.has(evRef.pageSnapshotId)) {
          throw new FactoryError(
            "content_gap_invalid",
            `gap "${gap.id}" has evidenceRef for page "${evRef.pageSnapshotId}" that is not present in competitorsCoveringIt (fail closed)`,
          );
        }
      }
    }

    // 4c. Deterministic coverage matrix consistency (when matrix is provided)
    if (context.coverageMatrix) {
      const rowsById = new Map<string, (typeof context.coverageMatrix.rows)[number]>();
      const seenRowIds = new Set<string>();
      for (const row of context.coverageMatrix.rows) {
        if (seenRowIds.has(row.requirementId)) {
          throw new FactoryError(
            "content_gap_invalid",
            `Coverage matrix contains duplicate or ambiguous requirementId "${row.requirementId}" (fail closed)`,
          );
        }
        seenRowIds.add(row.requirementId);
        rowsById.set(row.requirementId, row);
      }

      if (!gap.coverageRequirementId) {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" requires a coverageRequirementId linking to the coverage matrix`,
        );
      }

      const boundRow = rowsById.get(gap.coverageRequirementId);
      if (!boundRow) {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" references unknown coverageRequirementId "${gap.coverageRequirementId}" (fail closed)`,
        );
      }

      // 4c-1. Competitor in competitorsCoveringIt cannot be evaluated as ABSENT in the deterministic coverage matrix for that requirement
      for (const competitorId of gap.competitorsCoveringIt) {
        const cell = boundRow.cells.find((c) => c.pageSnapshotId === competitorId);
        if (cell && cell.level === "ABSENT") {
          throw new FactoryError(
            "content_gap_invalid",
            `gap "${gap.id}" claims competitor "${competitorId}" covers requirement "${boundRow.requirement}" (id "${boundRow.requirementId}"), but deterministic coverage matrix evaluated it as ABSENT (fail closed)`,
          );
        }
      }

      // 4c-2. Claimed non-ABSENT coverage must be consistent with the exact bound row
      const maxLevel = boundRow.cells.reduce(
        (acc, c) => (LEVEL_ORDER[c.level] > LEVEL_ORDER[acc] ? c.level : acc),
        "ABSENT" as CoverageLevel,
      );
      if (maxLevel === "ABSENT" && gap.competitorCoverage !== "ABSENT") {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" claims ${gap.competitorCoverage} coverage for requirement "${boundRow.requirement}" (id "${boundRow.requirementId}"), but deterministic coverage matrix evaluated all competitors as ABSENT (fail closed)`,
        );
      }

      // 4c-3. Claimed ABSENT coverage must be consistent with the exact bound row
      if (maxLevel === "STRONG" && gap.competitorCoverage === "ABSENT") {
        throw new FactoryError(
          "content_gap_invalid",
          `gap "${gap.id}" claims ABSENT coverage for requirement "${boundRow.requirement}" (id "${boundRow.requirementId}"), but deterministic coverage matrix found STRONG competitor coverage (fail closed)`,
        );
      }
    }
  }

  // 5. First-party evidence separation validation (when provided in context)
  if (context.acceptedEvidence) {
    validateGapFirstPartyRefs(gaps, context.acceptedEvidence);
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
  searchSemantics: AcceptedSearchSemantics;
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
  if (!input.searchSemantics) {
    throw new FactoryError(
      "content_gap_invalid",
      "searchSemantics is mandatory for ContentGapReportData (fail closed).",
    );
  }
  if (
    input.searchSemantics.intelligenceSnapshotId !== input.intelligenceSnapshotId ||
    input.searchSemantics.intelligenceSnapshotDigest !== input.intelligenceSnapshotDigest
  ) {
    throw new FactoryError(
      "content_gap_invalid",
      "searchSemantics intelligence snapshot binding does not match report intelligence snapshot (fail closed).",
    );
  }
  const parsed = input.modelGaps as { gaps?: unknown; differentiationRequirements?: unknown };
  const gaps = Array.isArray(parsed?.gaps) ? parsed.gaps : [];
  const differentiation =
    (parsed?.differentiationRequirements as { items?: unknown } | undefined)?.items;
  const report = {
    serpSnapshotId: input.serpSnapshotId,
    serpSnapshotDigest: input.serpSnapshotDigest,
    intelligenceSnapshotId: input.intelligenceSnapshotId,
    intelligenceSnapshotDigest: input.intelligenceSnapshotDigest,
    searchSemantics: input.searchSemantics,
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
    input.grounding.coverageMatrix = input.coverageMatrix;
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
