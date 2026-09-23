import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProductionQaCheckResult } from "./types.js";
import type { ProductionRenderManifest } from "../render-manifest.js";
import { TrustGovernanceStore } from "../../trust/store.js";
import {
  UNCERTAIN_CLAIM_TYPES,
  sourceAuthorityVerdict,
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
 *   trust.claim_lineage        — material claims carry valid lineage
 *   trust.source_authority     — source tiers satisfy the YMYL level
 *   trust.review_authority     — displayed reviews are real and current
 *   trust.original_value       — substantive YMYL pages carry original value
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

export interface TrustQaInput {
  manifests: ProductionRenderManifest[];
  distDir: string;
  projectId: string;
  trust: TrustGovernanceStore;
  /** Current accepted content digest per page identity (staleness anchor). */
  contentDigests: Map<string, string>;
  manifestSetDigest: string;
}

export interface TrustQaResult {
  checks: ProductionQaCheckResult[];
  overall: "PASS" | "REVIEW" | "FAIL";
}

function check(
  checkId: ProductionQaCheckResult["checkId"],
  verdict: ProductionQaCheckResult["verdict"],
  detail: string,
  evidence: ProductionQaCheckResult["evidence"] = [],
): ProductionQaCheckResult {
  return { checkId, group: "content", verdict, detail, evidence };
}

export async function runTrustQa(input: TrustQaInput): Promise<TrustQaResult> {
  const checks: ProductionQaCheckResult[] = [];
  const intentsByPage = new Map<string, PageIntentAuthority>();
  for (const intent of await input.trust.listCurrentIntentAuthorities(input.projectId)) {
    intentsByPage.set(intent.pageIdentity, intent);
  }

  // trust.page_intent_present + trust.ymll_classification per page.
  for (const manifest of input.manifests) {
    const identity = manifest.input.pageIdentity;
    const intent = intentsByPage.get(identity);
    checks.push(
      check(
        "trust.page_intent_present",
        intent ? "PASS" : "FAIL",
        intent
          ? `Page ${identity} carries durable page-intent authority v${intent.ymylClassification ? "" : ""}(strategy bound).`
          : `Page ${identity} has no durable page-intent authority; page strategy is not governed.`,
        [{ kind: "route", ref: manifest.input.route }],
      ),
    );
    checks.push(
      check(
        "trust.ymll_classification",
        intent ? "PASS" : "FAIL",
        intent
          ? `Page ${identity} YMYL classification: ${intent.ymylClassification}.`
          : `Page ${identity} has no YMYL classification.`,
        [{ kind: "route", ref: manifest.input.route }],
      ),
    );
  }

  // trust.cannibalization site-wide.
  const cann = await input.trust.cannibalizationVerdict(input.projectId);
  checks.push(
    check(
      "trust.cannibalization",
      cann.verdict,
      cann.verdict === "PASS"
        ? `No primary-purpose overlap across ${intentsByPage.size} production pages.`
        : cann.findings.map((f) => f.detail).join(" | ").slice(0, 1900),
      cann.findings.map((f) => ({ kind: "route" as const, ref: `${f.pageA}~${f.pageB}` })),
    ),
  );

  // trust.claim_lineage + trust.source_authority per page.
  for (const manifest of input.manifests) {
    const identity = manifest.input.pageIdentity;
    const digest = input.contentDigests.get(identity);
    const intent = intentsByPage.get(identity);
    if (!digest || !intent) {
      checks.push(
        check("trust.claim_lineage", "FAIL", `Page ${identity} has no accepted content digest binding for claim lineage.`, [
          { kind: "route", ref: manifest.input.route },
        ]),
      );
      continue;
    }
    const claims = await input.trust.listClaimLineage(input.projectId, identity, digest);
    const ymylPages = intent.ymylClassification !== "NON_YMYL";
    if (ymylPages && claims.length === 0) {
      checks.push(
        check(
          "trust.claim_lineage",
          "FAIL",
          `YMYL page ${identity} (${intent.ymylClassification}) carries no claim lineage records.`,
          [{ kind: "route", ref: manifest.input.route }],
        ),
      );
      continue;
    }
    const sourceVerdicts = claims.map((claim) => sourceAuthorityVerdict(claim.sourceRefs, intent.ymylClassification));
    const worst = sourceVerdicts.includes("FAIL") ? "FAIL" : sourceVerdicts.includes("REVIEW") ? "REVIEW" : "PASS";
    checks.push(
      check(
        "trust.claim_lineage",
        "PASS",
        `Page ${identity}: ${claims.length} material claim(s) carry lineage bound to content digest ${digest.slice(0, 12)}….`,
        claims.slice(0, 10).map((claim) => ({ kind: "artifact" as const, ref: claim.claimId })),
      ),
    );
    checks.push(
      check(
        "trust.source_authority",
        worst,
        worst === "PASS"
          ? `Page ${identity}: all claim sources satisfy the ${intent.ymylClassification} authority floor.`
          : `Page ${identity}: source authority below the ${intent.ymylClassification} floor on ${sourceVerdicts.filter((v) => v !== "PASS").length} claim(s).`,
        claims.slice(0, 10).map((claim) => ({ kind: "artifact" as const, ref: claim.claimId })),
      ),
    );

    // Uncertain claim types must be visibly labelled in the built HTML.
    const uncertain = claims.filter((claim) => UNCERTAIN_CLAIM_TYPES.has(claim.claimType));
    if (uncertain.length > 0) {
      const html = await readBuiltHtml(input.distDir, manifest.input.route);
      const missingLabels = uncertain.filter((claim) => !html || !visibleLabelPresent(html, claim));
      checks.push(
        check(
          "trust.claim_lineage",
          missingLabels.length === 0 ? "PASS" : "FAIL",
          missingLabels.length === 0
            ? `Page ${identity}: ${uncertain.length} uncertain claim(s) visibly labelled in built output.`
            : `Page ${identity}: ${missingLabels.length} uncertain claim(s) not visibly labelled as assumption/forecast/scenario/estimate/opinion.`,
          missingLabels.slice(0, 10).map((claim) => ({ kind: "artifact" as const, ref: claim.claimId })),
        ),
      );
    }

    // trust.original_value: substantive YMYL pages need original-value evidence.
    if (ymylPages) {
      const originals = await input.trust.listOriginalValues(input.projectId, identity);
      checks.push(
        check(
          "trust.original_value",
          originals.length > 0 ? "PASS" : "REVIEW",
          originals.length > 0
            ? `Page ${identity} records ${originals.length} original-value element(s).`
            : `Page ${identity} (YMYL) records no original-value element; human review must confirm value or rework.`,
          originals.slice(0, 5).map((record) => ({ kind: "artifact" as const, ref: record.kind })),
        ),
      );
    }
  }

  // trust.review_authority: reviews displayed in HTML must be real and current.
  for (const manifest of input.manifests) {
    const identity = manifest.input.pageIdentity;
    const digest = input.contentDigests.get(identity);
    if (!digest) continue;
    const html = await readBuiltHtml(input.distDir, manifest.input.route);
    if (!html || !/data-review-authority/i.test(html)) continue;
    const current = await input.trust.currentReview(input.projectId, identity, digest);
    checks.push(
      check(
        "trust.review_authority",
        current.review && !current.stale ? "PASS" : "FAIL",
        current.review && !current.stale
          ? `Page ${identity}: displayed review is a real governed review event (current digest).`
          : current.review
            ? `Page ${identity}: displayed review is STALE (${current.reason}).`
            : `Page ${identity} displays review markup without a governed review event.`,
        [{ kind: "route", ref: manifest.input.route }],
      ),
    );
  }

  // trust.fixture_leakage across built HTML + metadata.
  const leakHits: Array<{ route: string; label: string }> = [];
  for (const manifest of input.manifests) {
    const html = await readBuiltHtml(input.distDir, manifest.input.route);
    if (!html) continue;
    for (const { pattern, label } of FIXTURE_LEAK_PATTERNS) {
      if (pattern.test(html)) leakHits.push({ route: manifest.input.route, label });
    }
  }
  checks.push(
    check(
      "trust.fixture_leakage",
      leakHits.length === 0 ? "PASS" : "FAIL",
      leakHits.length === 0
        ? `No fixture/demo/test identities in ${input.manifests.length} built production pages.`
        : `Fixture leakage detected: ${leakHits.map((hit) => `${hit.route}: ${hit.label}`).join("; ").slice(0, 1800)}`,
      leakHits.slice(0, 20).map((hit) => ({ kind: "route" as const, ref: hit.route })),
    ),
  );

  const trustCheckIds = new Set([
    "trust.cannibalization",
    "trust.fixture_leakage",
  ]);
  const bound = checks.map((entry) =>
    entry.scope ? entry : bindQaCheck(entry, {
      scope: trustCheckIds.has(entry.checkId) ? "site" : "page",
      subject: trustCheckIds.has(entry.checkId) ? input.manifestSetDigest : input.manifests[0]!.input.route,
      tool: "factory-trust-qa",
      toolVersion: "trust-governance-v1",
    }),
  );
  const overall = bound.some((c) => c.verdict === "FAIL") ? "FAIL" : bound.some((c) => c.verdict === "REVIEW") ? "REVIEW" : "PASS";
  return { checks: bound, overall };
}

/** Visible labelling check: uncertain claims need an explicit label nearby. */
function visibleLabelPresent(html: string, claim: ClaimLineage): boolean {
  const LABELS = ["assumption", "forecast", "scenario", "estimate", "opinion", "expert interpretation", "illustrative", "modelled", "modeled"];
  const lower = html.toLowerCase();
  const claimKey = claim.claimId.toLowerCase();
  const idx = lower.indexOf(claimKey);
  if (idx >= 0) {
    const context = lower.slice(Math.max(0, idx - 500), idx + claim.claimText.length + 500);
    return LABELS.some((label) => context.includes(label));
  }
  // Claim text based fallback: label within the same rendered block.
  const textKey = claim.claimText.toLowerCase().slice(0, 60).replace(/\s+/g, " ");
  const textIdx = lower.indexOf(textKey);
  if (textIdx >= 0) {
    const context = lower.slice(Math.max(0, textIdx - 500), textIdx + claim.claimText.length + 500);
    return LABELS.some((label) => context.includes(label));
  }
  return false;
}

async function readBuiltHtml(distDir: string, route: string): Promise<string | null> {
  const file = route === "/" ? path.join(distDir, "index.html") : path.join(distDir, route.replace(/^\//, ""), "index.html");
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}
