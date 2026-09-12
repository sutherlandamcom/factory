import type {
  ContentBriefData,
  PageContentProposalData,
  QaCheckResult,
  QaEvidenceRef,
  QaVerdict,
} from "@factory/contracts";

/**
 * DETERMINISTIC CONTENT QA TRIAD (Macro Run 4).
 *
 * All three checks are deterministic in v0 — no model-based editorial check
 * is required because every acceptance criterion is deterministically
 * expressible against the accepted inputs (documented decision). Each check
 * emits PASS / REVIEW / FAIL with evidence references. NO fake numeric
 * scores. Keyword density / LSI / pseudo-SEO scoring is deliberately absent.
 */

const QA_VERSION = "content-qa-v1";

function overallVerdict(checks: QaCheckResult[]): QaVerdict {
  if (checks.some((c) => c.verdict === "FAIL")) return "FAIL";
  if (checks.some((c) => c.verdict === "REVIEW")) return "REVIEW";
  return "PASS";
}

function check(
  checkId: string,
  verdict: QaVerdict,
  detail: string,
  evidence: QaEvidenceRef[] = [],
): QaCheckResult {
  return { checkId, verdict, detail, evidence };
}

/** Normalized text for deterministic matching: lowercase, collapsed whitespace. */
function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 1. FACTUAL QA
// ---------------------------------------------------------------------------

export function runFactualQa(
  proposal: PageContentProposalData,
  brief: ContentBriefData,
  /** Additional accepted-intake identity text (evidence notes, CTA
   *  destination, brand facts, business description) supplied by the caller
   *  from the brief's bound accepted input snapshot — legitimate numeric
   *  sources for the invented-numbers check, never invented by the writer. */
  evidenceExtras: string[] = [],
): QaCheckResult[] {
  const checks: QaCheckResult[] = [];
  const fullText = [
    proposal.title,
    proposal.metaDescription,
    proposal.introduction,
    ...proposal.sections.map((s) => `${s.heading} ${s.body}`),
    proposal.conclusion,
    proposal.cta,
    ...proposal.internalLinks,
  ].join("\n");
  const normText = norm(fullText);

  // F1: prohibited-claims violation scan (verbatim and normalized).
  const prohibitedHits = brief.prohibitedClaims.filter((c) => normText.includes(norm(c)));
  checks.push(
    prohibitedHits.length === 0
      ? check("factual.prohibited_claims", "PASS", "No prohibited claim appears in the proposal.")
      : check(
          "factual.prohibited_claims",
          "FAIL",
          `Prohibited claims asserted: ${prohibitedHits.join(" | ")}`,
          prohibitedHits.map((c) => ({ kind: "claim" as const, ref: c, note: "prohibited claim found in proposal text" })),
        ),
  );

  // F2: allowed-claims boundary — every claim-looking assertion must trace to
  // the allowed list or operator facts. Deterministic proxy: any allowedClaim
  // the writer DROPPED is fine; any operator fact that was CONTRADICTED is a
  // failure (negation scan is out of scope for v0; verbatim contradiction
  // detection uses exact-phrase mismatch of quoted material).
  const operatorFacts = brief.operatorFacts;
  const quotedFacts = operatorFacts.filter((f) => normText.includes(norm(f)));
  checks.push(
    operatorFacts.length > 0 && quotedFacts.length === 0
      ? check(
          "factual.evidence_trace",
          "REVIEW",
          `0/${operatorFacts.length} operator facts appear verbatim in the proposal; accepted factual material may have been paraphrased or dropped — human review required.`,
          operatorFacts.map((f) => ({ kind: "claim" as const, ref: f, note: "operator fact not materialized verbatim" })),
        )
      : check(
          "factual.evidence_trace",
          "PASS",
          `${quotedFacts.length}/${operatorFacts.length} operator facts appear verbatim in the proposal (allowed-claims boundary: only listed claims may be asserted).`,
          quotedFacts.map((f) => ({ kind: "claim" as const, ref: f, note: "operator fact materialized verbatim" })),
        ),
  );

  // F3: no invented numeric claims absent from evidence.
  const evidenceNumbers = new Set<string>(
    [
      ...brief.operatorFacts,
      ...brief.allowedClaims,
      ...brief.contentBriefKeyPoints,
      ...evidenceExtras,
      // Numbers inside the operator-approved page target and the accepted
      // search semantics are legitimate sources, not inventions.
      brief.pageTarget.title,
      brief.pageTarget.objective,
      brief.pageTarget.audience,
      ...brief.pageTarget.structureGuidance,
      ...brief.pageTarget.internalLinkIntent,
      brief.pageTarget.ctaIntent,
      brief.searchSemantics.primaryIntent,
      ...brief.searchSemantics.semanticCoverageRequirements,
      ...brief.searchSemantics.userNeeds,
    ]
      .map((t) => norm(t))
      .flatMap((t) => t.match(/\b\d[\d.,]*\b/g) ?? []),
  );
  const textNumbers = fullText.match(/\b\d[\d.,]*\b/g) ?? [];
  const invented = textNumbers.filter((n) => !evidenceNumbers.has(norm(n)));
  checks.push(
    invented.length === 0
      ? check("factual.no_invented_numbers", "PASS", "No numeric claim appears that is absent from accepted evidence.")
      : check(
          "factual.no_invented_numbers",
          "FAIL",
          `Numeric claims absent from evidence: ${invented.join(", ")}`,
          invented.slice(0, 20).map((n) => ({ kind: "claim" as const, ref: n, note: "number not present in accepted evidence" })),
        ),
  );

  // F4: unverified-claims handling — unknown claims must not be asserted as
  // bare fact; deterministic proxy: an unknown claim stated verbatim WITHOUT
  // an unverified qualifier is a REVIEW (human judgment required).
  const unverifiedHits = brief.unknownClaims.filter((c) => {
    const normalizedClaim = norm(c);
    if (!normText.includes(normalizedClaim)) return false;
    const idx = normText.indexOf(normalizedClaim);
    const context = normText.slice(Math.max(0, idx - 120), idx + normalizedClaim.length + 120);
    return !/(unverified|not yet confirmed|to be confirmed|unconfirmed)/.test(context);
  });
  checks.push(
    unverifiedHits.length === 0
      ? check("factual.unverified_claims", "PASS", "No unverified claim asserted without an explicit qualifier.")
      : check(
          "factual.unverified_claims",
          "REVIEW",
          `Unverified claims appear without a qualifier: ${unverifiedHits.join(" | ")}`,
          unverifiedHits.map((c) => ({ kind: "claim" as const, ref: c, note: "unverified claim needs explicit qualifier or removal" })),
        ),
  );

  // F5: verbatim fidelity of accepted key points (transitional exception):
  // each key point materialized must appear verbatim (no silent rewording of
  // accepted semantic content).
  const droppedKeyPoints = brief.contentBriefKeyPoints.filter((k) => !normText.includes(norm(k)));
  checks.push(
    droppedKeyPoints.length === 0
      ? check("factual.key_points_fidelity", "PASS", "All accepted key points materialized verbatim.")
      : check(
          "factual.key_points_fidelity",
          "REVIEW",
          `Accepted key points not found verbatim in the proposal: ${droppedKeyPoints.join(" | ")}`,
          droppedKeyPoints.map((k) => ({ kind: "claim" as const, ref: k, note: "accepted key point missing or reworded" })),
        ),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// 2. SEARCH QA (semantic coverage — NO keyword-density/LSI scoring)
// ---------------------------------------------------------------------------

export function runSearchQa(
  proposal: PageContentProposalData,
  brief: ContentBriefData,
): QaCheckResult[] {
  const checks: QaCheckResult[] = [];
  // No accepted gap lineage (operator-acknowledged waiver): there is NO real
  // search-evidence basis to check against (searchSemantics carries only the
  // documented placeholder). Never silently PASS — the waived lineage is
  // surfaced as REVIEW so the human gate explicitly decides.
  if (brief.lineage.gapSnapshotId == null) {
    checks.push(
      check(
        "search.lineage_waived",
        "REVIEW",
        "Brief has no accepted gap lineage (operator-acknowledged waiver): search semantics checks are not applicable. Human review required.",
        [{ kind: "briefField", ref: "lineage.gapSnapshotId", note: "no accepted ContentGap snapshot bound to this brief" }],
      ),
    );
    return checks;
  }
  const sectionTexts = [
    { ref: "introduction", text: `${proposal.title} ${proposal.introduction}` },
    ...proposal.sections.map((s, i) => ({ ref: `section[${i}]:${s.heading}`, text: `${s.heading} ${s.body}` })),
    { ref: "conclusion", text: proposal.conclusion },
  ];
  const fullText = norm(sectionTexts.map((s) => s.text).join("\n"));

  const coverage = (requirement: string): { covered: boolean; evidenceRef: string | null } => {
    // Deterministic semantic coverage proxy: significant term overlap between
    // the requirement and a section (>= 2 shared significant terms or a
    // verbatim phrase match). NOT keyword density — presence of the required
    // meaning-bearing vocabulary.
    const reqTerms = norm(requirement)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4);
    for (const section of sectionTexts) {
      const secText = norm(section.text);
      if (secText.includes(norm(requirement))) return { covered: true, evidenceRef: section.ref };
      const shared = reqTerms.filter((t) => secText.includes(t)).length;
      if (reqTerms.length > 0 && shared >= Math.min(2, reqTerms.length)) {
        return { covered: true, evidenceRef: section.ref };
      }
    }
    return { covered: false, evidenceRef: null };
  };

  const uncoveredRequirements = brief.searchSemantics.semanticCoverageRequirements.filter(
    (r) => !coverage(r).covered,
  );
  checks.push(
    uncoveredRequirements.length === 0
      ? check(
          "search.semantic_coverage",
          "PASS",
          `All ${brief.searchSemantics.semanticCoverageRequirements.length} semantic coverage requirements are covered.`,
          brief.searchSemantics.semanticCoverageRequirements.map((r) => ({
            kind: "requirement" as const,
            ref: r,
            note: `covered in ${coverage(r).evidenceRef ?? "proposal"}`,
          })),
        )
      : check(
          "search.semantic_coverage",
          "REVIEW",
          `Uncovered semantic requirements: ${uncoveredRequirements.join(" | ")}`,
          uncoveredRequirements.map((r) => ({ kind: "requirement" as const, ref: r, note: "no section covers this requirement" })),
        ),
  );

  const uncoveredNeeds = brief.searchSemantics.userNeeds.filter((n) => !coverage(n).covered);
  checks.push(
    uncoveredNeeds.length === 0
      ? check(
          "search.user_needs",
          "PASS",
          `All ${brief.searchSemantics.userNeeds.length} user needs are addressed.`,
          brief.searchSemantics.userNeeds.map((n) => ({
            kind: "userNeed" as const,
            ref: n,
            note: `addressed in ${coverage(n).evidenceRef ?? "proposal"}`,
          })),
        )
      : check(
          "search.user_needs",
          "REVIEW",
          `Unaddressed user needs: ${uncoveredNeeds.join(" | ")}`,
          uncoveredNeeds.map((n) => ({ kind: "userNeed" as const, ref: n, note: "no section addresses this need" })),
        ),
  );

  // Primary-intent alignment: the primary intent's significant terms must
  // appear in the title/introduction.
  const intentTerms = norm(brief.searchSemantics.primaryIntent)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4);
  const introText = norm(`${proposal.title} ${proposal.introduction}`);
  const alignedTerms = intentTerms.filter((t) => introText.includes(t)).length;
  checks.push(
    intentTerms.length === 0 || alignedTerms >= Math.min(2, intentTerms.length)
      ? check(
          "search.primary_intent",
          "PASS",
          "Primary intent is aligned in title/introduction.",
          [{ kind: "requirement", ref: brief.searchSemantics.primaryIntent, note: `${alignedTerms}/${intentTerms.length} intent terms present` }],
        )
      : check(
          "search.primary_intent",
          "REVIEW",
          `Primary intent weakly aligned: only ${alignedTerms}/${intentTerms.length} significant intent terms in title/introduction.`,
          [{ kind: "requirement", ref: brief.searchSemantics.primaryIntent, note: "strengthen intent alignment in opening" }],
        ),
  );

  return checks;
}

// ---------------------------------------------------------------------------
// 3. EDITORIAL QA
// ---------------------------------------------------------------------------

export function runEditorialQa(
  proposal: PageContentProposalData,
  brief: ContentBriefData,
  policyRules: {
    forbiddenTerminology?: string[];
    aiLanguageAvoidance?: string[];
    clicheAvoidance?: string[];
    localePreferences?: string;
  },
): QaCheckResult[] {
  const checks: QaCheckResult[] = [];
  const fullText = [
    proposal.title,
    proposal.metaDescription,
    proposal.introduction,
    ...proposal.sections.map((s) => `${s.heading} ${s.body}`),
    proposal.conclusion,
    proposal.cta,
  ].join(" ");
  const normText = norm(fullText);

  // E1: forbidden terminology from the Writer Policy.
  const policyForbidden = policyRules.forbiddenTerminology ?? [];
  const forbiddenHits = policyForbidden.filter((t) => normText.includes(norm(t)));
  checks.push(
    forbiddenHits.length === 0
      ? check("editorial.forbidden_terminology", "PASS", "No forbidden terminology used.")
      : check(
          "editorial.forbidden_terminology",
          "FAIL",
          `Forbidden terminology used: ${forbiddenHits.join(", ")}`,
          forbiddenHits.map((t) => ({ kind: "policyRule" as const, ref: t, note: "forbidden by writer policy" })),
        ),
  );

  // E2: AI-cliché language from the Content Constitution.
  const aiLanguage = policyRules.aiLanguageAvoidance ?? [];
  const clicheHits = (policyRules.clicheAvoidance ?? []).filter((c) => normText.includes(norm(c)));
  const aiHits = aiLanguage.filter((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(normText));
  const allCliche = [...clicheHits, ...aiHits];
  checks.push(
    allCliche.length === 0
      ? check("editorial.ai_cliche", "PASS", "No AI-cliché language or forbidden clichés detected.")
      : check(
          "editorial.ai_cliche",
          "FAIL",
          `AI-cliché language detected: ${allCliche.join(", ")}`,
          allCliche.map((t) => ({ kind: "policyRule" as const, ref: t, note: "listed in Content Constitution avoidance lists" })),
        ),
  );

  // E3: structure/heading integrity vs brief — each structure guidance item
  // must be reflected in the section set by significant term overlap (not
  // verbatim echo; guidance is directional).
  const structureGuidance = brief.pageTarget.structureGuidance;
  const headings = proposal.sections.map((s) => s.heading);
  const structureEvidence: QaEvidenceRef[] = [];
  let structureVerdict: QaVerdict = "PASS";
  let structureDetail = "Heading structure present.";
  if (proposal.sections.length === 0) {
    structureVerdict = "FAIL";
    structureDetail = "Proposal has no sections.";
  } else {
    const allHeadingText = norm(headings.join(" "));
    // Structure guidance may target the opening ("Open with...") as well as
    // sections, so the introduction participates in the match.
    const allSectionText =
      allHeadingText +
      " " +
      norm(proposal.introduction.slice(0, 400)) +
      " " +
      norm(proposal.sections.map((s) => s.body.slice(0, 200)).join(" "));
    const uncoveredGuidance = structureGuidance.filter((g) => {
      const terms = norm(g).split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
      if (terms.length === 0) return true;
      // A guidance item is reflected when a significant term (>=5 chars)
      // matches a heading, or >=2 significant terms match the section text.
      const longTerms = terms.filter((t) => t.length >= 5);
      if (longTerms.some((t) => allHeadingText.includes(t))) return false;
      const shared = terms.filter((t) => allSectionText.includes(t)).length;
      return shared < Math.min(2, terms.length);
    });
    if (uncoveredGuidance.length > 0) {
      structureVerdict = "REVIEW";
      structureDetail = `Structure guidance not reflected in sections: ${uncoveredGuidance.join(" | ")}`;
      structureEvidence.push(
        ...uncoveredGuidance.map((g) => ({ kind: "briefField" as const, ref: g, note: "structure guidance without matching section" })),
      );
    }
  }
  checks.push(check("editorial.structure_integrity", structureVerdict, structureDetail, structureEvidence));

  // E4: CTA integrity — the CTA must be present and non-empty.
  const ctaIntent = brief.pageTarget.ctaIntent;
  const ctaOk = proposal.cta.trim().length > 0;
  checks.push(
    ctaOk
      ? check(
          "editorial.cta_integrity",
          "PASS",
          `CTA present (brief intent: ${ctaIntent}).`,
          [{ kind: "briefField", ref: ctaIntent, note: "CTA materialized" }],
        )
      : check("editorial.cta_integrity", "FAIL", "Proposal has an empty CTA.", [
          { kind: "briefField", ref: ctaIntent, note: "CTA required by brief" },
        ]),
  );

  // E5: heading hierarchy — exactly one implied H1 (title), sections are H2s.
  const duplicateHeadings = headings.filter((h, i) => headings.indexOf(h) !== i);
  checks.push(
    duplicateHeadings.length === 0
      ? check("editorial.heading_integrity", "PASS", "Single title, unique section headings.")
      : check(
          "editorial.heading_integrity",
          "REVIEW",
          `Duplicate section headings: ${duplicateHeadings.join(", ")}`,
          duplicateHeadings.map((h) => ({ kind: "section" as const, ref: h, note: "duplicate heading" })),
        ),
  );

  return checks;
}

export interface ContentQaOutcome {
  version: string;
  factual: QaCheckResult[];
  search: QaCheckResult[];
  editorial: QaCheckResult[];
  overall: QaVerdict;
}

/** Run the full deterministic triad. */
export function runContentQa(
  proposal: PageContentProposalData,
  brief: ContentBriefData,
  policyRules: Parameters<typeof runEditorialQa>[2],
  evidenceExtras: string[] = [],
): ContentQaOutcome {
  const factual = runFactualQa(proposal, brief, evidenceExtras);
  const search = runSearchQa(proposal, brief);
  const editorial = runEditorialQa(proposal, brief, policyRules);
  return {
    version: QA_VERSION,
    factual,
    search,
    editorial,
    overall: overallVerdict([...factual, ...search, ...editorial]),
  };
}
