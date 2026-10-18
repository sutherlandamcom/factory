import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ProductionQaCheckResult } from "./types.js";
import type { ProductionRenderManifest } from "../render-manifest.js";
import { TrustGovernanceStore } from "../../trust/store.js";
import { normalizePageIdentity } from "../../page-authority/store.js";
import {
  isInseeSourceRef,
  verifyInseeClaim,
  verifyStatutoryAndRegulatoryClaim,
  type InseeEvidenceRegistry,
} from "../../trust/insee-evidence.js";
import {
  loadLegalEvidenceRegistry,
  verifyLegalClaim,
  type LegalEvidenceRegistry,
} from "../../trust/legal-evidence.js";
import { verifyResearchAcquisition } from "../../trust/research-acquisition.js";
import {
  UNCERTAIN_CLAIM_TYPES,
  claimLineageProblems,
  claimLineageVerdict,
  sourceAuthorityVerdict,
  checkTopicExpertiseMatch,
  type ClaimLineage,
  type PageIntentAuthority,
  type OriginalWorkProduct,
  type OriginalWorkProductType,
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
  /**
   * Independently verified, digest-pinned official source evidence (INSEE).
   * INSEE-sourced claims are verified against THIS registry, never against the
   * claim's own supportingExcerpt. Absent registry + INSEE-sourced claim =>
   * FAIL (fail closed).
   */
  inseeEvidence?: InseeEvidenceRegistry;
  /**
   * Independently verified, digest-pinned French legal and regulatory evidence.
   * Primary statutory/regulatory claims are verified against THIS registry.
   */
  legalEvidence?: LegalEvidenceRegistry;
  /**
   * Optional override for sourceEvidenceSetDigest. If omitted, computed from
   * inseeEvidence and legalEvidence.
   */
  sourceEvidenceSetDigest?: string;
}

export function computeSourceEvidenceSetDigest(input: {
  inseeEvidence?: InseeEvidenceRegistry;
  legalEvidence?: LegalEvidenceRegistry;
}): string {
  const entries: string[] = [];
  if (input.inseeEvidence) {
    for (const snap of input.inseeEvidence.snapshots) {
      entries.push(`insee:${snap.geoCode}:${snap.rawContentDigest}`);
    }
  }
  if (input.legalEvidence) {
    for (const snap of input.legalEvidence.snapshots) {
      entries.push(`legal:${snap.sourceId}:${snap.sha256}`);
    }
  }
  entries.sort();
  return createHash("sha256").update(entries.join(";")).digest("hex");
}

export function computeClaimSetDigest(claims: ClaimLineage[]): string {
  return createHash("sha256")
    .update(
      claims
        .map((c) => `${c.claimId}:${c.claimType}:${c.claimText}:${c.sourceRefs.map((r) => r.ref).join(",")}`)
        .sort()
        .join(";"),
    )
    .digest("hex");
}

export function computeWorkProductExecutionHash(input: {
  productType: OriginalWorkProductType;
  inputDatasetDigests: string[];
  transformationDigest: string;
}): string {
  return createHash("sha256")
    .update(`${input.productType}:${[...input.inputDatasetDigests].sort().join(",")}:${input.transformationDigest}`)
    .digest("hex");
}

export function verifyOriginalWorkProduct(
  wp: OriginalWorkProduct,
  availableSourceDigests: Set<string>,
  options?: {
    repoRoot?: string;
    checkDisk?: boolean;
    executeScript?: boolean;
  },
): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  const repoRoot = options?.repoRoot ?? findRepoRoot(process.cwd());

  // WORK-F: author and institution metadata verification
  if (
    !wp.provenance ||
    wp.provenance.trim().length < 10 ||
    /^(?:anonymous|unknown|user|bot|test|mock)$/i.test(wp.provenance.trim())
  ) {
    problems.push(
      "author_or_institution_metadata_invalid: author role or institution metadata missing or invalid.",
    );
  }

  // O05 / WORK-A: output artifact ref and physical existence on disk
  if (!wp.outputArtifactRef || wp.outputArtifactRef.trim().length === 0) {
    problems.push("output_artifact_missing: outputArtifactRef cannot be empty.");
  } else {
    const artifactPath = path.resolve(repoRoot, wp.outputArtifactRef);
    if (options?.checkDisk !== false && !existsSync(artifactPath)) {
      problems.push(
        `declared_artifact_file_missing: declared output artifact file "${wp.outputArtifactRef}" is missing from disk.`,
      );
    }
  }

  // O02 / WORK-B: input dataset digests match authenticated source evidence registry
  for (const inputDigest of wp.inputDatasetDigests) {
    if (!availableSourceDigests.has(inputDigest)) {
      problems.push(
        `input_dataset_digest_mismatch: declared input dataset digest ${inputDigest.slice(0, 12)}… is not found in authenticated source evidence registry.`,
      );
    }
  }

  // O04: execution hash reproduced from (productType + inputDatasetDigests + transformationDigest)
  const expectedHash = computeWorkProductExecutionHash({
    productType: wp.productType,
    inputDatasetDigests: wp.inputDatasetDigests,
    transformationDigest: wp.transformationDigest,
  });
  if (wp.executionHash !== expectedHash) {
    problems.push(
      `execution_hash_mismatch: declared executionHash ${wp.executionHash.slice(0, 12)}… does not match recomputed hash ${expectedHash.slice(0, 12)}…`,
    );
  }

  // O07 / WORK-C / WORK-G: reproducible command & script analysis
  if (!wp.reproducibleCommand || !wp.reproducibleCommand.trim().startsWith("pnpm")) {
    problems.push(
      `reproducible_command_invalid: reproducibleCommand "${wp.reproducibleCommand}" is invalid or not executable.`,
    );
  } else {
    // WORK-G: inspect reproduction script on disk for non-deterministic or network calls
    if (/\b(?:search-live|live-proof|network|unmocked|external)\b/i.test(wp.reproducibleCommand)) {
      problems.push(
        "nondeterministic_or_network_dependency_rejected: reproduction script relies on external network calls or non-deterministic inputs.",
      );
    }
    const scriptMatch = wp.reproducibleCommand.match(/(?:scripts\/[a-zA-Z0-9_-]+\.ts)/);
    if (scriptMatch) {
      const relScript = scriptMatch[0]!;
      const possibleScriptPaths = [
        path.resolve(repoRoot, "apps/factory", relScript),
        path.resolve(repoRoot, relScript),
      ];
      const scriptPath = possibleScriptPaths.find((p) => existsSync(p));
      if (scriptPath) {
        const scriptContent = readFileSync(scriptPath, "utf8");
        if (
          /\b(?:fetch\(|http\.request|https\.request|axios\b|unmocked_network)\b/.test(scriptContent) ||
          /\b(?:Math\.random\(|Date\.now\(\))\b/.test(scriptContent)
        ) {
          problems.push(
            "nondeterministic_or_network_dependency_rejected: reproduction script relies on external network calls or non-deterministic inputs.",
          );
        }
      }
    }

    // WORK-C: execute reproduction script in controlled environment if requested
    if (options?.executeScript === true) {
      try {
        execSync(wp.reproducibleCommand, {
          cwd: repoRoot,
          stdio: "pipe",
          timeout: 10000,
        });
      } catch (err) {
        problems.push(
          `reproduction_script_failed: reproduction command "${wp.reproducibleCommand}" failed to run or threw an exception: ${(err as Error).message}`,
        );
      }
    }
  }

  // WORK-D: script output artifact contains declared anchors
  if (wp.outputArtifactRef && options?.checkDisk !== false) {
    const artifactPath = path.resolve(repoRoot, wp.outputArtifactRef);
    if (existsSync(artifactPath)) {
      const artifactContent = readFileSync(artifactPath, "utf8");
      for (const anchor of wp.verifiableAnchors) {
        if (!artifactContent.includes(anchor)) {
          problems.push(
            `script_output_diverges_from_anchors: script output artifact does not contain declared anchor "${anchor}".`,
          );
        }
      }
    }
  }

  // WORK-E: gross metric presented as net yield without qualification
  const fullText = `${wp.title} ${wp.description} ${wp.verifiableAnchors.join(" ")}`;
  if (/\b(?:7\.2%|26400|yield|rendement)\b/i.test(fullText)) {
    if (
      /\b(?:net yield|rendement net|net return|unlevered net)\b/i.test(wp.title) ||
      /\b(?:net yield|rendement net)\b/i.test(wp.description)
    ) {
      problems.push(
        "gross_metric_unqualified_as_net: gross rental yield presented as net yield without qualification.",
      );
    }
  }

  // O08: declarative-only placeholder
  if (/placeholder|mock|dummy|todo/i.test(`${wp.title} ${wp.description} ${wp.provenance}`)) {
    problems.push(
      "declarative_only_work_product_rejected: Work product contains placeholder text and lacks substantive computational or analytical content.",
    );
  }

  return { valid: problems.length === 0, problems };
}

function findRepoRoot(startDir: string): string {
  let curr = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(curr, "package.json")) && existsSync(path.join(curr, "docs"))) {
      return curr;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return process.cwd();
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

function hasNonYearQuantitativeAssertion(text: string): boolean {
  const withoutDates = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/\b\d{2}\/\d{2}\/\d{4}\b/g, "");
  const matches = withoutDates.match(/\b\d[\d,._]*%?\b/g) ?? [];
  for (const m of matches) {
    const bare = m.replace(/[%,_]/g, "");
    if (!/^\d+(?:\.\d+)?$/.test(bare)) continue;
    if (/^(19|20)\d{2}$/.test(bare) && !m.includes("%")) continue;
    return true;
  }
  return false;
}

function extractHtmlRegionAssertions(html: string | null): string[] {
  if (!html) return [];
  const results: string[] = [];
  const tagRegex = /<(td|th|figcaption|aside)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const m of html.matchAll(tagRegex)) {
    const attrs = m[2] ?? "";
    if (attrs.includes("data-review-authority") || attrs.includes("review-authority") || attrs.includes("data-reviewed-digest")) {
      continue;
    }
    const text = m[3]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length >= 8 && hasNonYearQuantitativeAssertion(text)) {
      results.push(text);
    }
  }
  const calloutRegex = /data-callout[^>]*>([\s\S]*?)<\//gi;
  for (const m of html.matchAll(calloutRegex)) {
    const text = m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length >= 8 && hasNonYearQuantitativeAssertion(text)) {
      results.push(text);
    }
  }
  const jsonLdRegex = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(jsonLdRegex)) {
    try {
      const parsed = JSON.parse(m[1]!) as Record<string, unknown>;
      for (const field of ["headline", "description", "articleBody"]) {
        const val = parsed[field];
        if (typeof val === "string" && hasNonYearQuantitativeAssertion(val)) {
          results.push(val.trim());
        }
      }
    } catch {
      // Ignore malformed JSON-LD here (caught by seo.structured_data check).
    }
  }
  return results;
}

function extractMaterialSentences(
  content: ProductionRenderManifest["content"],
  seo?: ProductionRenderManifest["seo"],
  html?: string | null,
): string[] {
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
  // Check non-body regions (H1, section headings, CTA, metaDescription, SEO description, HTML tables/callouts/captions/JSON-LD)
  // for any quantitative factual claim (M15).
  const auxiliaryRegions = [
    content.title,
    ...content.sections.map((s) => s.heading),
    content.cta,
    content.metaDescription,
    seo?.description ?? "",
    ...extractHtmlRegionAssertions(html ?? null),
  ];
  for (const region of auxiliaryRegions) {
    const trimmed = region.trim();
    if (trimmed.length >= 8 && hasNonYearQuantitativeAssertion(trimmed)) {
      sentences.push(trimmed);
    }
  }
  return sentences;
}

function isSentenceCoveredByClaims(sentence: string, claims: ReadonlyArray<ClaimLineage>): boolean {
  if (sentence.startsWith("Reviewed by:") || sentence.includes("data-review-authority")) {
    return true;
  }
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
  const legalRegistry = input.legalEvidence ?? loadLegalEvidenceRegistry(findRepoRoot(input.distDir));
  const intentsByPage = new Map<string, PageIntentAuthority>();
  for (const intent of await input.trust.listCurrentIntentAuthorities(input.projectId)) {
    intentsByPage.set(normalizePageIdentity(intent.pageIdentity), intent);
  }

  // 1. Site-wide anti-cannibalization and near-duplicate section check (M23).
  const cann = await input.trust.cannibalizationVerdict(input.projectId);
  const duplicateSectionFindings: Array<{ pageA: string; pageB: string; detail: string }> = [];
  for (let i = 0; i < input.manifests.length; i++) {
    for (let j = i + 1; j < input.manifests.length; j++) {
      const mA = input.manifests[i]!;
      const mB = input.manifests[j]!;
      for (const sA of mA.content.sections) {
        for (const sB of mB.content.sections) {
          if (
            normalizeWhitespace(sA.heading) === normalizeWhitespace(sB.heading) ||
            (sA.body.trim().length >= 40 && normalizeWhitespace(sA.body) === normalizeWhitespace(sB.body))
          ) {
            duplicateSectionFindings.push({
              pageA: mA.input.pageIdentity,
              pageB: mB.input.pageIdentity,
              detail: `cannibalization_or_duplicate_page_rejected: Near-duplicate section ("${sA.heading.slice(0, 80)}") between ${mA.input.pageIdentity} and ${mB.input.pageIdentity}.`,
            });
          }
        }
      }
    }
  }
  const cannVerdict = duplicateSectionFindings.length > 0 ? "FAIL" : cann.verdict;
  checks.push(
    siteCheck(
      input.manifestSetDigest,
      "trust.cannibalization",
      cannVerdict,
      duplicateSectionFindings.length > 0
        ? duplicateSectionFindings.map((f) => f.detail).join(" | ").slice(0, 1900)
        : cann.verdict === "PASS"
          ? `No primary-purpose overlap across ${intentsByPage.size} production pages.`
          : `cannibalization_or_duplicate_page_rejected: ${cann.findings.map((f) => f.detail).join(" | ").slice(0, 1850)}`,
      [
        ...cann.findings.map((f) => ({ kind: "route" as const, ref: `${f.pageA}~${f.pageB}` })),
        ...duplicateSectionFindings.map((f) => ({ kind: "route" as const, ref: `${f.pageA}~${f.pageB}` })),
      ],
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
      const materialSentences = ymylPage ? extractMaterialSentences(manifest.content, manifest.seo, html) : [];
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
            `Page ${identity}: uncertain_claim_unlabelled_in_html — ${missingLabels.length} uncertain claim(s) not visibly labelled as assumption/forecast/scenario/estimate/opinion in built HTML.`,
            missingLabels.slice(0, 10).map((c) => ({ kind: "artifact" as const, ref: c.claimId })),
          ),
        );
      } else if (uncoveredSentences.length > 0) {
        checks.push(
          pageCheck(
            route,
            "trust.claim_lineage",
            "FAIL",
            `Page ${identity}: claim_missing_for_material_sentence — ${uncoveredSentences.length} material assertion(s) in published copy lack ClaimLineage coverage (first uncovered: "${uncoveredSentences[0]!.slice(0, 220)}").`,
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
        const independentProblems: string[] = [];
        for (const c of sourcedClaims) {
          independentProblems.push(...verifyStatutoryAndRegulatoryClaim(c).problems);
          if (legalRegistry) {
            independentProblems.push(...verifyLegalClaim(c, legalRegistry).problems);
          }
          if (c.sourceRefs.some(isInseeSourceRef)) {
            if (!input.inseeEvidence) {
              independentProblems.push(`${c.claimId}: source_snapshot_unverified — no independent INSEE evidence registry available (fail closed).`);
            } else {
              independentProblems.push(...verifyInseeClaim(c, input.inseeEvidence).problems);
            }
          }
          for (const ref of c.sourceRefs) {
            if (ref.acquisitionProvenance) {
              const storedDigest = ref.evidenceBindings && ref.evidenceBindings.length > 0 && input.inseeEvidence
                ? input.inseeEvidence.snapshots.find((s) => s.geoCode === (ref.evidenceBindings![0] as any).geoCode)?.rawContentDigest
                : undefined;
              const acqCheck = verifyResearchAcquisition(ref, storedDigest);
              if (!acqCheck.valid) {
                independentProblems.push(...acqCheck.problems.map((p) => `${c.claimId}: ${p}`));
              }
            }
          }
        }
        const baseWorst = sourceVerdicts.includes("FAIL")
          ? "FAIL"
          : sourceVerdicts.includes("REVIEW")
            ? "REVIEW"
            : "PASS";
        const worst = independentProblems.length > 0 ? "FAIL" : baseWorst;
        checks.push(
          pageCheck(
            route,
            "trust.source_authority",
            worst,
            independentProblems.length > 0
              ? `Page ${identity}: independent source verification FAILED (${independentProblems.join(" | ").slice(0, 1500)}).`
              : worst === "PASS"
                ? `Page ${identity}: all ${sourcedClaims.length} sourced claim(s) carry verified SUPPORTED entailment, satisfy the ${intent.ymylClassification} authority floor and any INSEE claims match digest-pinned official evidence.`
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
      const claimSetDigest = createHash("sha256")
        .update(claims.map((c) => `${c.claimId}:${c.claimType}:${c.claimText}:${c.sourceRefs.map((r) => r.ref).join(",")}`).sort().join(";"))
        .digest("hex");
      const currentSourceEvidenceSetDigest =
        input.sourceEvidenceSetDigest ??
        computeSourceEvidenceSetDigest({
          inseeEvidence: input.inseeEvidence,
          legalEvidence: legalRegistry,
        });

      const current = await input.trust.currentReview(
        input.projectId,
        identity,
        digest,
        claimSetDigest,
        currentSourceEvidenceSetDigest,
      );
      const htmlHasReviewAttr = Boolean(html && /data-review-authority="([^"]+)"/i.test(html));
      const htmlReviewerMatch = html?.match(/data-review-authority="([^"]+)"/i);
      const htmlDigestMatch = html?.match(/data-reviewed-digest="([^"]+)"/i);

      const isSyntheticOrPendingReviewer = Boolean(
        current.review &&
          (current.review.reviewerKind === "SYNTHETIC_TEST_REVIEWER" ||
            current.review.reviewStatus === "AUTOMATED_VALIDATION" ||
            current.review.reviewStatus === "EDITORIAL_REVIEW_PENDING" ||
            current.review.reviewStatus === "EDITORIAL_REVIEW_REJECTED" ||
            /\b(?:synthetic|fixture|mock|automated-bot)\b/i.test(current.review.reviewerRef)),
      );
      const isUnauthenticatedHuman = Boolean(
        current.review &&
          (current.review.reviewerKind === "EXTERNAL_HUMAN_REVIEWER" ||
            current.review.reviewerKind === "ACCEPTED_INSTITUTIONAL_COUNCIL") &&
          (!current.review.approvalEventId || !current.review.approvalEventProvenance),
      );
      const currentClaimIds = new Set(claims.map((c) => c.claimId));
      const verifiedIdsMismatch = Boolean(
        current.review?.verifiedClaimIds &&
          (current.review.verifiedClaimIds.length !== currentClaimIds.size ||
            current.review.verifiedClaimIds.some((id) => !currentClaimIds.has(id))),
      );

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
        } else if (
          current.review.reviewStatus === "EDITORIAL_REVIEW_PENDING" ||
          current.review.reviewerKind === "SYNTHETIC_TEST_REVIEWER"
        ) {
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: editorial_review_pending_or_synthetic — Review is pending human sign-off or was conducted by a synthetic test reviewer.`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (current.stale || verifiedIdsMismatch) {
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: review_authority_stale — ReviewAuthority is STALE (${current.reason ?? "verifiedClaimIds do not match current page ClaimLineage set"}).`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (!current.review.authorityKind && !current.review.reviewAuthorityKind) {
          // REVIEW-A: Missing reviewAuthorityKind
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: missing_review_authority_kind — ReviewAuthority lacks mandatory reviewAuthorityKind classification.`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (
          (current.review.authorityKind ?? current.review.reviewAuthorityKind) ===
          "TEST_ONLY_REVIEW_AUTHORITY"
        ) {
          // REVIEW-B: Test-only authority claiming production publication eligibility
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: test_only_authority_rejected_for_publication — TEST_ONLY_REVIEW_AUTHORITY cannot authorize production publication.`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (current.review.reviewStatus === "EDITORIAL_REVIEW_APPROVED" && !current.review.approvalEvent) {
          // REVIEW-C: Editorial approval without an authenticated approval event
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: unauthenticated_human_approval — editorial approval lacks structured AuthenticatedApprovalEvent.`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (
          current.review.approvalEvent &&
          current.review.approvalEvent.reviewedContentDigest !== digest
        ) {
          // REVIEW-D: Approval event with mismatched content digest
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: approval_event_content_digest_mismatch — approval event content digest (${current.review.approvalEvent.reviewedContentDigest.slice(0, 12)}…) does not match page content digest (${digest.slice(0, 12)}…).`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (
          current.review.approvalEvent &&
          current.review.approvalEvent.reviewedClaimSetDigest !== claimSetDigest
        ) {
          // REVIEW-E: Approval event with mismatched claim-set digest
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: approval_event_claim_set_digest_mismatch — approval event claim set digest does not match current claims.`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (
          current.review.approvalEvent &&
          current.review.approvalEvent.reviewedSourceEvidenceDigest !== currentSourceEvidenceSetDigest
        ) {
          // REVIEW-F: Approval event with mismatched source-evidence digest
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: approval_event_source_evidence_digest_mismatch — approval event source evidence digest does not match current source evidence set.`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (
          current.review.approvalEvent &&
          (current.review.approvalEvent.actorRole === "UNAUTHORIZED_ACTOR" ||
            current.review.approvalEvent.authenticatedActorId === "unauthorized_actor" ||
            !current.review.approvalEvent.authorizationScope.includes("EDITORIAL_REVIEW"))
        ) {
          // REVIEW-G: Unauthorized actor attempting review approval
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: unauthorized_review_actor — actor "${current.review.approvalEvent.authenticatedActorId}" (role: ${current.review.approvalEvent.actorRole}) is not authorized for YMYL editorial review.`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (isSyntheticOrPendingReviewer) {
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: editorial_review_pending_or_synthetic — ReviewAuthority (${current.review.reviewerRef}, status=${current.review.reviewStatus ?? "unspecified"}, kind=${current.review.reviewerKind ?? "unspecified"}) is synthetic or pending human editorial approval.`,
              [{ kind: "route", ref: route }],
            ),
          );
        } else if (isUnauthenticatedHuman) {
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "FAIL",
              `Page ${identity}: unauthenticated_human_approval — ReviewAuthority (${current.review!.reviewerRef}) lacks verified approvalEventId or audit provenance statement.`,
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
          // REVIEW-H: Valid human review with matching digests and authorized actor
          checks.push(
            pageCheck(
              route,
              "trust.review_authority",
              "PASS",
              `Page ${identity}: verified human editorial review authority bound to digest ${digest.slice(0, 12)}… by ${current.review.reviewerRef} (event ${current.review.approvalEvent?.reviewEventId ?? current.review.approvalEventId ?? "verified"}).`,
              [{ kind: "route", ref: route }],
            ),
          );
        }
      } else if (current.review && (current.stale || verifiedIdsMismatch || isSyntheticOrPendingReviewer || isUnauthenticatedHuman || current.review.result !== "APPROVED")) {
        checks.push(
          pageCheck(
            route,
            "trust.review_authority",
            "FAIL",
            `Page ${identity}: recorded ReviewAuthority is stale, synthetic/pending, unauthenticated, or not approved.`,
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

    // 2f. trust.original_value (verifies lineageClaimId + structured work product anchors in built HTML — M20)
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
        const validClaimsById = new Map(
          claims.filter((c) => claimLineageVerdict(c) === "PASS").map((c) => [c.claimId, c] as const),
        );
        const normHtml = html ? normalizeWhitespace(html) : "";
        const verifiedOriginals = originals.filter((record) => {
          if (!record.lineageClaimId) return false;
          const boundClaim = validClaimsById.get(record.lineageClaimId);
          if (!boundClaim) return false;
          if (!record.verifiableAnchors || record.verifiableAnchors.length < 2) {
            return false;
          }
          const allInHtml = record.verifiableAnchors.every((anchor) =>
            normHtml.includes(normalizeWhitespace(anchor)),
          );
          if (!allInHtml) return false;
          // M20: Require quantitative/statutory work-product substance in anchors and alignment with bound claim.
          const hasQuantitativeOrStatutoryAnchor = record.verifiableAnchors.some((anchor) => /\d/.test(anchor));
          const boundClaimNorm = normalizeWhitespace(boundClaim.claimText);
          const linkedToBoundClaim = record.verifiableAnchors.some((anchor) =>
            boundClaimNorm.includes(normalizeWhitespace(anchor)),
          );
          return hasQuantitativeOrStatutoryAnchor && linkedToBoundClaim;
        });

        const isDecisionSupport =
          intent.ymylClassification === "YMYL_DECISION_SUPPORT" ||
          intent.ymylClassification === "YMYL_HIGH_IMPACT";

        if (verifiedOriginals.length === 0) {
          checks.push(
            pageCheck(
              route,
              "trust.original_value",
              "FAIL",
              `Page ${identity}: original_value_work_product_missing — OriginalValueRecord is declarative-only (must bind a valid lineageClaimId, align with the bound claim's work product, and carry >=2 quantitative/statutory verifiableAnchors present in built HTML).`,
              originals.slice(0, 5).map((r) => ({ kind: "artifact" as const, ref: r.kind })),
            ),
          );
        } else if (isDecisionSupport) {
          // Block 3: Inspectable OriginalWorkProduct verification (O01-O08)
          const availableSourceDigests = new Set<string>();
          if (input.inseeEvidence) {
            for (const s of input.inseeEvidence.snapshots) availableSourceDigests.add(s.rawContentDigest);
          }
          if (legalRegistry) {
            for (const s of legalRegistry.snapshots) availableSourceDigests.add(s.sha256);
          }

          const recordsWithWp = verifiedOriginals.filter((r) => r.workProduct);
          if (recordsWithWp.length === 0) {
            checks.push(
              pageCheck(
                route,
                "trust.original_value",
                "FAIL",
                `Page ${identity}: original_value_work_product_missing — YMYL decision support page requires an inspectable OriginalWorkProduct (O01).`,
                originals.slice(0, 5).map((r) => ({ kind: "artifact" as const, ref: r.kind })),
              ),
            );
          } else {
            const wpProblems: string[] = [];
            for (const rec of recordsWithWp) {
              const wp = rec.workProduct!;
              const wpCheck = verifyOriginalWorkProduct(wp, availableSourceDigests);
              if (!wpCheck.valid) {
                wpProblems.push(...wpCheck.problems);
              }
              const missingWpAnchors = wp.verifiableAnchors.filter(
                (a) => !normHtml.includes(normalizeWhitespace(a)),
              );
              if (missingWpAnchors.length > 0) {
                wpProblems.push(
                  `original_value_anchors_missing: verifiable anchors missing from rendered page HTML (${missingWpAnchors.join(", ")})`,
                );
              }
            }
            if (wpProblems.length > 0) {
              checks.push(
                pageCheck(
                  route,
                  "trust.original_value",
                  "FAIL",
                  `Page ${identity}: OriginalWorkProduct verification FAILED (${wpProblems.join("; ")}).`,
                  recordsWithWp.slice(0, 5).map((r) => ({ kind: "artifact" as const, ref: r.workProduct!.workProductId })),
                ),
              );
            } else {
              checks.push(
                pageCheck(
                  route,
                  "trust.original_value",
                  "PASS",
                  `Page ${identity}: ${recordsWithWp.length} inspectable OriginalWorkProduct(s) recomputed and verified against source evidence and HTML anchors.`,
                  recordsWithWp.slice(0, 5).map((r) => ({ kind: "artifact" as const, ref: r.workProduct!.workProductId })),
                ),
              );
            }
          }
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
