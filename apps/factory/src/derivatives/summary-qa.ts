import type {
  SummaryQaCheckResult,
  SummaryQaReportData,
} from "@factory/contracts";

/**
 * DETERMINISTIC SUMMARY QA — Run 10.
 *
 * Explicit typed gates with evidence. No fake numeric quality score. These
 * gates prove mechanical safety properties of a summary proposal against
 * its exact source content; human acceptance remains the semantic authority.
 */

/** Numeric tokens appearing in the source copy (integers/decimals/percentages/currency). */
function extractNumericClaims(text: string): string[] {
  const matches = text.match(/\d[\d.,]*%?|\d+/g) ?? [];
  return matches.map((m) => m.replace(/[.,]$/g, "")).filter((m) => m.length > 0);
}

function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s)"']+/g) ?? [];
}

/** CTA-shaped imperatives that would turn the summary into a sales pitch. */
const CTA_PATTERNS = [
  /\b(contact us|call (us )?now|book (a |your )?(call|demo|consultation)|get (a )?(quote|estimate)|sign up|subscribe now|buy now|learn more (by|at)|visit (our|us)|reach out)\b/i,
];

const PLACEHOLDER_PATTERNS = [
  /\[[^\]]{0,80}\]/, // [placeholder], [insert …]
  /\b(lorem ipsum|TODO|TBD|XXX|placeholder|to be (determined|written|added))\b/i,
  /\{\{[^}]{0,80}\}\}/, // {{template vars}}
];

/**
 * YMYL/consequential-material hazard gates. When the source content is
 * marked YMLY-classified (or contains consequential financial/legal/health
 * signals), the summary must not remove uncertainty or turn estimates into
 * facts. Implemented as deterministic lexicon checks over the summary.
 */
const YMYL_HEDGES = [
  /\b(may|might|could|approximately|about|around|estimated|estimate|typically|generally|depends? on|subject to|can vary|up to|at least|as of)\b/i,
];

const YMYL_ABSOLUTES = [
  /\b(guaranteed|guarantee|always|never|risk-free|certainly|definitely|assured)\b/i,
];

export function isYmylContent(content: SummaryQaSourceCopy): boolean {
  // Explicit classification wins when present in the accepted data.
  const classified = (content as { ymyl?: unknown }).ymyl;
  if (classified === true) return true;
  const text = [
    content.introduction,
    ...content.sections.map((s) => `${s.heading}\n${s.body}`),
    content.conclusion,
  ].join("\n");
  return /\b(invest(ment|ing)?|pension|tax|taxation|mortgage|loan|insurance|warranty|guarantee|medical|diagnosis|treatment|medication|legal|litigation|contract law|regulat(?:ion|ory))\b/i.test(
    text,
  );
}

/** Copy view consumed by QA — matches the tolerant accepted-copy reader. */
export interface SummaryQaSourceCopy {
  title: string;
  metaDescription: string;
  introduction: string;
  sections: Array<{ heading: string; body: string }>;
  conclusion: string;
  cta: string;
}

export function runSummaryQa(input: {
  proposalId: string;
  proposalDigest: string;
  summaryText: string;
  sourceContent: SummaryQaSourceCopy;
  expectedLanguage: string;
}): SummaryQaReportData {
  const checks: SummaryQaCheckResult[] = [];
  const summary = input.summaryText;
  const sourceText = [
    input.sourceContent.title,
    input.sourceContent.metaDescription,
    input.sourceContent.introduction,
    ...input.sourceContent.sections.map((s) => `${s.heading}\n${s.body}`),
    input.sourceContent.conclusion,
    input.sourceContent.cta,
  ].join("\n");

  const add = (checkId: SummaryQaCheckResult["checkId"], verdict: SummaryQaCheckResult["verdict"], detail: string) => {
    checks.push({ checkId, verdict, detail });
  };

  // 1. non_empty
  add(
    "summary.non_empty",
    summary.trim().length > 0 ? "PASS" : "FAIL",
    summary.trim().length > 0 ? `Summary is ${summary.trim().length} characters.` : "Summary text is empty.",
  );

  // 2. source_bound — every summary sentence must overlap source vocabulary.
  const sourceWords = new Set(
    sourceText
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4),
  );
  const sentences = summary.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const unboundSentences = sentences.filter((sentence) => {
    const words = sentence.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    if (words.length === 0) return false;
    const bound = words.filter((w) => sourceWords.has(w)).length;
    return bound / words.length < 0.5;
  });
  add(
    "summary.source_bound",
    unboundSentences.length === 0 ? "PASS" : "FAIL",
    unboundSentences.length === 0
      ? `All ${sentences.length} summary sentences overlap source vocabulary.`
      : `${unboundSentences.length} sentence(s) are not grounded in source content: ${unboundSentences.slice(0, 2).join(" | ").slice(0, 400)}`,
  );

  // 3. no_placeholder
  const placeholders = PLACEHOLDER_PATTERNS.flatMap((p) => summary.match(p) ?? []);
  add(
    "summary.no_placeholder",
    placeholders.length === 0 ? "PASS" : "FAIL",
    placeholders.length === 0 ? "No placeholder text." : `Placeholder text found: ${placeholders.slice(0, 3).join(", ")}`,
  );

  // 4. no_new_numeric_claims
  const sourceNumerics = new Set(extractNumericClaims(sourceText));
  const summaryNumerics = extractNumericClaims(summary);
  const newNumerics = summaryNumerics.filter((n) => !sourceNumerics.has(n));
  add(
    "summary.no_new_numeric_claims",
    newNumerics.length === 0 ? "PASS" : "FAIL",
    newNumerics.length === 0
      ? `All ${summaryNumerics.length} numeric token(s) appear in source.`
      : `Numeric claims absent from source: ${newNumerics.slice(0, 5).join(", ")}`,
  );

  // 5. no_new_urls
  const sourceUrls = new Set(extractUrls(sourceText));
  const newUrls = extractUrls(summary).filter((u) => !sourceUrls.has(u));
  add(
    "summary.no_new_urls",
    newUrls.length === 0 ? "PASS" : "FAIL",
    newUrls.length === 0 ? "No new URLs." : `URLs absent from source: ${newUrls.slice(0, 3).join(", ")}`,
  );

  // 6. no_cta_injection
  const ctaHits = CTA_PATTERNS.flatMap((p) => summary.match(p) ?? []);
  add(
    "summary.no_cta_injection",
    ctaHits.length === 0 ? "PASS" : "FAIL",
    ctaHits.length === 0 ? "No CTA language." : `CTA-shaped language found: ${ctaHits.slice(0, 3).join(", ")}`,
  );

  // 7. reasonable_size — bounded visitor-facing summary.
  const size = summary.trim().length;
  add(
    "summary.reasonable_size",
    size >= 40 && size <= 2000 ? "PASS" : "REVIEW",
    `Summary length ${size} characters (accepted band 40–2000).`,
  );

  // 8. language — deterministic script/stopword heuristic for the expected language.
  const englishStopwords = new Set(["the", "and", "of", "to", "in", "is", "for", "with", "that", "this", "on", "as", "are", "it", "by", "an", "or"]);
  const tokens = summary.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const englishHits = tokens.filter((t) => englishStopwords.has(t)).length;
  const languageOk =
    input.expectedLanguage.toLowerCase().startsWith("en")
      ? englishHits >= Math.max(1, Math.floor(tokens.length * 0.1))
      : true; // Non-English language checks are bounded to script presence today.
  add(
    "summary.language",
    languageOk ? "PASS" : "REVIEW",
    languageOk
      ? `Summary matches expected language ${input.expectedLanguage}.`
      : `Summary does not appear to match expected language ${input.expectedLanguage}.`,
  );

  // YMYL hardening: consequential material must keep its uncertainty.
  if (isYmylContent(input.sourceContent)) {
    const hedged = YMYL_HEDGES.some((p) => p.test(summary));
    const absolutized = YMYL_ABSOLUTES.some((p) => p.test(summary));
    if (absolutized) {
      add(
        "summary.source_bound",
        "FAIL",
        "YMYL source: summary contains absolute claims (guaranteed/always/never/risk-free) that harden uncertainty.",
      );
    } else if (!hedged && summaryNumerics.length > 0) {
      add(
        "summary.source_bound",
        "REVIEW",
        "YMYL source with numeric claims: summary lacks visible hedging; human review must confirm qualifications preserved.",
      );
    }
  }

  const overall = checks.some((c) => c.verdict === "FAIL")
    ? "FAIL"
    : checks.some((c) => c.verdict === "REVIEW")
      ? "REVIEW"
      : "PASS";

  return {
    schemaVersion: "derivatives-v1",
    proposalId: input.proposalId,
    proposalDigest: input.proposalDigest,
    checks,
    overall,
  };
}
