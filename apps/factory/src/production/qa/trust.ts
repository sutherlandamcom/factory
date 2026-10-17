import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProductionQaCheckResult } from "./types.js";
import type { ProductionRenderManifest } from "../render-manifest.js";
import { TrustGovernanceStore } from "../../trust/store.js";
import { normalizePageIdentity } from "../../page-authority/store.js";
import {
  UNCERTAIN_CLAIM_TYPES,
  claimLineageProblems,
  claimLineageVerdict,
  sourceAuthorityVerdict,
  checkTopicExpertiseMatch,
  type ClaimLineage,
  type PageIntentAuthority,
} from "@factory/contracts";
import { bindQaCheck } from "./registry.js";

/**
 * TRUST GOVERNANCE QA — Macro Run 12.
 *
 * Deterministic post-build trust gates over the built production output and
 * the stored governance authorities:
 *
 *   trust.page_intent_present  — every production page has a durable intent
 *   trust.cannibalization      — no unexplained primary-purpose overlap
 *   trust.ymll_classification  — every page carries exactly one YMYL class
 *   trust.claim_lineage        — all material assertions in published copy are covered by verified ClaimLineage records
 *   trust.source_authority     — source tiers and entailment satisfy the YMYL level
 *   trust.review_authority     — YMYL decision-support/high-impact pages have non-stale APPROVED ReviewAuthority rendered visibly in HTML
 *   trust.original_value       — YMYL pages carry original-value records bound to claim lineage and verifiable anchors in built HTML
 *   trust.fixture_leakage      — no fixture/demo/test identities in output
 *
 * All verdicts are the typed PASS/REVIEW/FAIL triad; no numeric scores.
 */

const FIXTURE_LEAK_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /governed-service-fixture/i, label: "governed-service-fixture" },
  { pattern: /\broof repair\b/i, label: "starter fixture business (roof repair)" },
  { pattern: /\bSummit Roofing\b/i, label: "starter fixture identity (Summit Roofing)" },
  { pattern: /\bDenver Premier Roofing\b/i, label: "starter fixture identity" },
  { pattern: /\bfixture\b/i, label: "fixture" },
  { pattern: /\bdemo page\b/i, label: "demo page" },
  { pattern: /\bplaceholder\b/i, label: "placeholder" },
  { pattern: /\bRun 9\b/i, label: "Run 9" },
  { pattern: /\bRun 10\b/i, label: "Run 10" },
  { pattern: /\bRun 11\b/i, label: "Run 11" },
  { pattern: /\bLorem ipsum\b/i, label: "lorem ipsum" },
];

const MATERIAL_ASSERTION_TERM_PATTERN =
  /\b(?:Loi\s+Hoguet|Law\s+No\.|Article\s+\d|INSEE|DGFiP|DVF|PLU|PPRN|DPE|IFI|Notaires|Géorisques|Georisques|Cour\s+des\s+comptes|SRU|mandat\s+de\s+recherche|carte\s+professionnelle|cooling-off|secondary\s+residences|vacant\s+dwellings|price-to-rent)\b/i;

export interface TrustQaInput {
  manifests: ProductionRenderManifest[];
  distDir: string;
  projectId: string;
  trust: TrustGovernanceStore;
  /** Current accepted content digest per page identity (staleness anchor). */
  contentDigests: Map<string, string>;
  manifestSetDigest: string;
  /**
   * TRUSTED BACKEND POLICY (never request-derived). True only when the
   * operator service is wired with the deterministic fixture writer
   * (FACTORY_WRITER_MODE=fixture), i.e. accepted content is synthetic by
   * construction. In that mode ONLY fixture-origin leak labels are tolerated,
   * the check is stamped SYNTHETIC_FIXTURE_MODE, and the result must never be
   * treated as publication-eligible. Default is the strict production policy.
   */
  syntheticFixtureContent?: boolean;
}

/** Leak labels inherent to deterministic fixture-writer output. */
const SYNTHETIC_FIXTURE_TOLERATED_LABELS = new Set<string>([
  "fixture",
  "starter fixture business (roof repair)",
]);

export interface TrustQaResult {
  checks: ProductionQaCheckResult[];
  overall: "PASS" | "REVIEW" | "FAIL";
}

function pageCheck(
  route: string,
  checkId: ProductionQaCheckResult["checkId"],
  verdict: ProductionQaCheckResult["verdict"],
  detail: string,
  evidence: ProductionQaCheckResult["evidence"] = [],
): ProductionQaCheckResult {
  return bindQaCheck(
    { checkId, group: "content", verdict, detail, evidence },
    {
      scope: "page",
      subject: route,
      tool: "factory-trust-qa",
      toolVersion: "trust-governance-v1",
    },
  );
}

function siteCheck(
  manifestSetDigest: string,
  checkId: ProductionQaCheckResult["checkId"],
  verdict: ProductionQaCheckResult["verdict"],
  detail: string,
  evidence: ProductionQaCheckResult["evidence"] = [],
): ProductionQaCheckResult {
  return bindQaCheck(
    { checkId, group: "content", verdict, detail, evidence },
    {
      scope: "site",
      subject: manifestSetDigest,
      tool: "factory-trust-qa",
      toolVersion: "trust-governance-v1",
    },
  );
}

function normalizeWhitespace(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeAlphaNum(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractNumbers(text: string): string[] {
  const matches = text.match(/\b\d[\d,._]*\b/g) ?? [];
  return matches
    .map((m) => m.replace(/[,_]/g, ""))
    .filter((m) => /^\d+(?:\.\d+)?$/.test(m));
}

function extractMaterialSentences(content: ProductionRenderManifest["content"]): string[] {
  const blocks = [
    content.introduction,
    ...content.sections.map((s) => s.body),
    content.conclusion,
  ];
  const sentences: string[] = [];
  for (const block of blocks) {
    const paragraphs = block.split(/\n+/);
    for (const para of paragraphs) {
      const parts = para
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 20);
      for (const sentence of parts) {
        if (/\b\d[\d,._]*\b/.test(sentence) || MATERIAL_ASSERTION_TERM_PATTERN.test(sentence)) {
          sentences.push(sentence);
        }
      }
    }
  }
  return sentences;
}

function isSentenceCoveredByClaims(sentence: string, claims: ReadonlyArray<ClaimLineage>): boolean {
  const normSentence = normalizeAlphaNum(sentence);
  const sentenceNumbers = extractNumbers(sentence);
  const sentenceTokens = new Set(normSentence.split(" ").filter((t) => t.length >= 4));

  for (const claim of claims) {
    const normClaim = normalizeAlphaNum(claim.claimText);
    if (!normClaim) continue;
    if (normSentence.includes(normClaim) || normClaim.includes(normSentence)) {
      return true;
    }
    const claimNumbers = new Set(extractNumbers(claim.claimText));
    const allNumbersCovered = sentenceNumbers.every((n) => claimNumbers.has(n));
    if (!allNumbersCovered) continue;

    const claimTokens = normClaim.split(" ").filter((t) => t.length >= 4);
    if (claimTokens.length === 0) continue;
    const overlapCount = claimTokens.filter((t) => sentenceTokens.has(t)).length;
    const ratio = overlapCount / Math.min(claimTokens.length, Math.max(1, sentenceTokens.size));
    if (ratio >= 0.6) {
      return true;
    }
  }
  return false;
}

export async function runTrustQa(input: TrustQaInput): Promise<TrustQaResult> {
  const checks: ProductionQaCheckResult[] = [];
  const intentsByPage = new Map<string, PageIntentAuthority>();
  for (const intent of await input.trust.listCurrentIntentAuthorities(input.projectId)) {
    intentsByPage.set(normalizePageIdentity(intent.pageIdentity), intent);
  }

  // 1. Site-wide anti-cannibalization check.
  const cann = await input.trust.cannibalizationVerdict(input.projectId);
  checks.push(
    siteCheck(
      input.manifestSetDigest,
      "trust.cannibalization",
      cann.verdict,
      cann.verdict === "PASS"
        ? `No primary-purpose overlap across ${intentsByPage.size} production pages.`
        : cann.findings.map((f) => f.detail).join(" | ").slice(0, 1900),
      cann.findings.map((f) => ({ kind: "route" as const, ref: `${f.pageA}~${f.pageB}` })),
    ),
  );

  // 2. Per-page trust governance checks (every page check emitted once per route).
  for (const manifest of input.manifests) {
    const identity = manifest.input.pageIdentity;
    const route = manifest.input.route;
    const digest = input.contentDigests.get(identity);
    const intent = intentsByPage.get(normalizePageIdentity(identity));
    const html = await readBuiltHtml(input.distDir, route);

    // 2a. trust.page_intent_present
    checks.push(
      pageCheck(
        route,
        "trust.page_intent_present",
        intent ? "PASS" : "FAIL",
        intent
          ? `Page ${identity} carries durable page-intent authority (strategy bound).`
          : `Page ${identity} has no durable page-intent authority; page strategy is not governed.`,
        [{ kind: "route", ref: route }],
      ),
    );

    // 2b. trust.ymll_classification
    checks.push(
      pageCheck(
        route,
        "trust.ymll_classification",
        intent ? "PASS" : "FAIL",
        intent
          ? `Page ${identity} YMYL classification: ${intent.ymylClassification}.`
          : `Page ${identity} has no YMYL classification.`,
        [{ kind: "route", ref: route }],
      ),
    );

    const claims = digest ? await input.trust.listClaimLineage(input.projectId, identity, digest) : [];
    const ymylPage = intent ? intent.ymylClassification !== "NON_YMYL" : true;
    const requiresStrictReview =
      intent?.ymylClassification === "YMYL_DECISION_SUPPORT" ||
      intent?.ymylClassification === "YMYL_HIGH_IMPACT";

    // 2c. trust.claim_lineage (single consolidated check per page)
    if (!digest || !intent) {
      checks.push(
        pageCheck(
          route,
          "trust.claim_lineage",
          "FAIL",
          `Page ${identity} has no accepted content digest or intent binding for claim lineage.`,
          [{ kind: "route", ref: route }],
        ),
      );
    } else if (ymylPage && claims.length === 0) {
      checks.push(
        pageCheck(
          route,
          "trust.claim_lineage",
          "FAIL",
          `YMYL page ${identity} (${intent.ymylClassification}) carries no claim lineage records.`,
          [{ kind: "route", ref: route }],
        ),
      );
    } else {
      const invalidClaims = claims.filter((c) => claimLineageVerdict(c) !== "PASS");
      const uncertain = claims.filter((c) => UNCERTAIN_CLAIM_TYPES.has(c.claimType));
      const missingLabels = uncertain.filter((c) => !html || !visibleLabelPresent(html, c));
      const materialSentences = ymylPage ? extractMaterialSentences(manifest.content) : [];
      const uncoveredSentences = materialSentences.filter((s) => !isSentenceCoveredByClaims(s, claims));

      if (invalidClaims.length > 0) {
        const reasons = invalidClaims
          .map((c) => `${c.claimId}: ${claimLineageProblems(c).join("; ")}`)
          .join(" | ")
          .slice(0, 1800);
        checks.push(
          pageCheck(
            route,
            "trust.claim_lineage",
            "FAIL",
            `Page ${identity}: ${invalidClaims.length} claim(s) failed lineage/entailment verification (${reasons}).`,
            invalidClaims.slice(0, 10).map((c) => ({ kind: "artifact" as const, ref: c.claimId })),
          ),
        );
      } else if (missingLabels.length > 0) {
        checks.push(
          pageCheck(
            route,
            "trust.claim_lineage",
            "FAIL",
            `Page ${identity}: ${missingLabels.length} uncertain claim(s) not visibly labelled as assumption/forecast/scenario/estimate/opinion in built HTML.`,
            missingLabels.slice(0, 10).map((c) => ({ kind: "artifact" as const, ref: c.claimId })),
          ),
        );
      } else if (uncoveredSentences.length > 0) {
        checks.push(
          pageCheck(
            route,
            "trust.claim_lineage",
            "FAIL",
            `Page ${identity}: ${uncoveredSentences.length} material assertion(s) in published copy lack ClaimLineage coverage (first uncovered: "${uncoveredSentences[0]!.slice(0, 220)}").`,
            [{ kind: "route", ref: route }],
          ),
        );
      } else {
        checks.push(
          pageCheck(
            route,
            "trust.claim_lineage",
            "PASS",
            `Page ${identity}: ${claims.length} verified claim(s) cover all ${materialSentences.length} material assertion(s) bound to content digest ${digest.slice(0, 12)}…${uncertain.length > 0 ? ` (${uncertain.length} uncertain claim(s) visibly labelled)` : ""}.`,
            claims.slice(0, 10).map((c) => ({ kind: "artifact" as const, ref: c.claimId })),
          ),
        );
      }
    }

    // 2d. trust.source_authority
    if (!digest || !intent || (ymylPage && claims.length === 0)) {
      checks.push(
        pageCheck(
          route,
          "trust.source_authority",
          "FAIL",
          `Page ${identity}: cannot verify source authority without bound intent and claim lineage.`,
          [{ kind: "route", ref: route }],
        ),
      );
    } else {
      const sourcedClaims = claims.filter(
        (c) =>
          c.sourceRefs.length > 0 ||
          (c.claimType !== "EXPERT_INTERPRETATION" &&
            c.claimType !== "OPINION" &&
            c.claimType !== "ASSUMPTION"),
      );
      if (ymylPage && sourcedClaims.length === 0) {
        checks.push(
          pageCheck(
            route,
            "trust.source_authority",
            "FAIL",
            `YMYL page ${identity} has no source-backed claims.`,
            [{ kind: "route", ref: route }],
          ),
        );
      } else {
        const sourceVerdicts = sourcedClaims.map((c) =>
          sourceAuthorityVerdict(c.sourceRefs, intent.ymylClassification),
        );
        const worst = sourceVerdicts.includes("FAIL")
          ? "FAIL"
          : sourceVerdicts.includes("REVIEW")
            ? "REVIEW"
            : "PASS";
        checks.push(
          pageCheck(
            route,
            "trust.source_authority",
            worst,
            worst === "PASS"
              ? `Page ${identity}: all ${sourcedClaims.length} sourced claim(s) carry verified SUPPORTED entailment and satisfy the ${intent.ymylClassification} authority floor.`
              : `Page ${identity}: source authority or entailment verification failed on ${sourceVerdicts.filter((v) => v !== "PASS").length} claim(s) for ${intent.ymylClassification}.`,
            sourcedClaims.slice(0, 10).map((c) => ({ kind: "artifact" as const, ref: c.claimId })),
          ),
        );
      }
    }

    // 2e. trust.review_authority (never skipped when data-review-authority is absent)
    if (!digest || !intent) {
      checks.push(
        pageCheck(
          route,
          "trust.review_authority",
          "FAIL",
          `Page ${identity}: missing content digest or intent authority for review verification.`,
          [{ kind: "route", ref: route }],
        ),
      );
    } else {
      const current = await input.trust.currentReview(input.projectId, identity, digest);
      const htmlHasReviewAttr = Boolean(html && /data-review-authority="([^"]+)"/i.test(html));
      const htmlReviewerMatch = html?.match(/data-review-authority="([^"]+)"/i);
      const htmlDigestMatch = html?.match(/data-reviewed-digest="([^"]+)"/i);

      if (requiresStrictReview || htmlHasReviewAttr) {
        if (!current.review) {
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity} (${intent.ymylClassification}) requires a governed ReviewAuthority bound to digest ${digest.slice(0, 12)}…, but no review record exists.`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (current.stale) {
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: ReviewAuthority is STALE (${current.reason}).`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (current.review.result !== "APPROVED") {
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: ReviewAuthority result is ${current.review.result} (APPROVED required).`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (
          checkTopicExpertiseMatch(["property", "advisory"], current.review.reviewerExpertise).verdict !== "PASS"
        ) {
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: reviewer expertise does not cover required property advisory competence domains.`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (
          !htmlHasReviewAttr ||
          htmlReviewerMatch?.[1] !== current.review.reviewerRef ||
          htmlDigestMatch?.[1] !== digest
        ) {
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity} (${intent.ymylClassification}) is missing visible data-review-authority="${current.review.reviewerRef}" and data-reviewed-digest="${digest.slice(0, 12)}…" in built HTML.`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else {
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "PASS",
              `Page ${identity}: APPROVED ReviewAuthority (${current.review.reviewerRef}) is current for digest ${digest.slice(0, 12)}… and visibly rendered in HTML.`,
              [{ kind: "route", ref: route }],
            ),
          );
        }
      } else if (current.review && (current.stale || current.review.result !== "APPROVED")) {
        checks.push(
          pageCheck(
            route,
            "trust.review_authority",
            "FAIL",
            `Page ${identity}: recorded ReviewAuthority is stale or not approved.`,
            [{ kind: "route", ref: route }],
          ),
        );
      } else {
        checks.push(
          pageCheck(
            route,
            "trust.review_authority",
            "PASS",
            `Page ${identity} (${intent.ymylClassification}): review governance satisfied.`,
            [{ kind: "route", ref: route }],
          ),
        );
      }
    }

    // 2f. trust.original_value (verifies lineageClaimId + verifiableAnchors in built HTML)
    if (!intent || !ymylPage) {
      checks.push(
        pageCheck(
          route,
          "trust.original_value",
          intent ? "PASS" : "FAIL",
          intent
            ? `Page ${identity} (NON_YMYL): original value check satisfied.`
            : `Page ${identity}: missing intent authority for original value check.`,
          [{ kind: "route", ref: route }],
        ),
      );
    } else {
      const originals = await input.trust.listOriginalValues(input.projectId, identity);
      if (originals.length === 0) {
        checks.push(
          pageCheck(
            route,
            "trust.original_value",
            "FAIL",
            `Page ${identity} (${intent.ymylClassification}) records no OriginalValueRecord; YMYL pages require verifiable original analytical/observational value.`,
            [{ kind: "route", ref: route }],
          ),
        );
      } else {
        const validClaimIds = new Set(
          claims.filter((c) => claimLineageVerdict(c) === "PASS").map((c) => c.claimId),
        );
        const normHtml = html ? normalizeWhitespace(html) : "";
        const verifiedOriginals = originals.filter((record) => {
          if (!record.lineageClaimId || !validClaimIds.has(record.lineageClaimId)) {
            return false;
          }
          if (!record.verifiableAnchors || record.verifiableAnchors.length < 2) {
            return false;
          }
          return record.verifiableAnchors.every((anchor) =>
            normHtml.includes(normalizeWhitespace(anchor)),
          );
        });

        if (verifiedOriginals.length === 0) {
          checks.push(
            pageCheck(
              route,
              "trust.original_value",
              "FAIL",
              `Page ${identity}: OriginalValueRecord is declarative-only (must bind a valid lineageClaimId and >=2 verifiableAnchors present in built HTML).`,
              originals.slice(0, 5).map((r) => ({ kind: "artifact" as const, ref: r.kind })),
            ),
          );
        } else {
          checks.push(
            pageCheck(
              route,
              "trust.original_value",
              "PASS",
              `Page ${identity}: ${verifiedOriginals.length} original-value record(s) verified against ClaimLineage and concrete HTML anchors.`,
              verifiedOriginals.slice(0, 5).map((r) => ({ kind: "artifact" as const, ref: r.kind })),
            ),
          );
        }
      }
    }
  }

  // 3. Site-wide fixture leakage across built HTML + metadata.
  const leakHits: Array<{ route: string; label: string }> = [];
  for (const manifest of input.manifests) {
    const html = await readBuiltHtml(input.distDir, manifest.input.route);
    if (!html) continue;
    for (const { pattern, label } of FIXTURE_LEAK_PATTERNS) {
      if (pattern.test(html)) leakHits.push({ route: manifest.input.route, label });
    }
  }
  const tolerated = input.syntheticFixtureContent === true;
  const blockingHits = leakHits.filter((hit) => !(tolerated && SYNTHETIC_FIXTURE_TOLERATED_LABELS.has(hit.label)));
  const toleratedHits = leakHits.filter((hit) => tolerated && SYNTHETIC_FIXTURE_TOLERATED_LABELS.has(hit.label));
  checks.push(
    siteCheck(
      input.manifestSetDigest,
      "trust.fixture_leakage",
      blockingHits.length === 0 ? "PASS" : "FAIL",
      blockingHits.length > 0
        ? `Fixture leakage detected: ${blockingHits.map((hit) => `${hit.route}: ${hit.label}`).join("; ").slice(0, 1800)}`
        : toleratedHits.length > 0
          ? `SYNTHETIC_FIXTURE_MODE: deterministic fixture-writer content present on ${new Set(toleratedHits.map((h) => h.route)).size} page(s); NOT publication-eligible.`
          : `No fixture/demo/test identities in ${input.manifests.length} built production pages.`,
      (blockingHits.length > 0 ? blockingHits : toleratedHits).slice(0, 20).map((hit) => ({ kind: "route" as const, ref: hit.route })),
    ),
  );


  const overall = checks.some((c) => c.verdict === "FAIL")
    ? "FAIL"
    : checks.some((c) => c.verdict === "REVIEW")
      ? "REVIEW"
      : "PASS";
  return { checks, overall };
}

/** Visible labelling check: uncertain claims need an explicit label nearby. */
function visibleLabelPresent(html: string, claim: ClaimLineage): boolean {
  const LABELS = [
    "assumption",
    "forecast",
    "scenario",
    "estimate",
    "opinion",
    "expert interpretation",
    "illustrative",
    "modelled",
    "modeled",
  ];
  const lower = html.toLowerCase();
  const claimKey = claim.claimId.toLowerCase();
  const idx = lower.indexOf(claimKey);
  if (idx >= 0) {
    const context = lower.slice(Math.max(0, idx - 500), idx + claim.claimText.length + 500);
    return LABELS.some((label) => context.includes(label));
  }
  const textKey = claim.claimText.toLowerCase().slice(0, 60).replace(/\s+/g, " ");
  const textIdx = lower.indexOf(textKey);
  if (textIdx >= 0) {
    const context = lower.slice(Math.max(0, textIdx - 500), textIdx + claim.claimText.length + 500);
    return LABELS.some((label) => context.includes(label));
  }
  return false;
}

async function readBuiltHtml(distDir: string, route: string): Promise<string | null> {
  const file =
    route === "/"
      ? path.join(distDir, "index.html")
      : path.join(distDir, route.replace(/^\//, ""), "index.html");
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}
