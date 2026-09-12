import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runContentQa } from "../src/writer/qa.js";
import type { ContentBriefData, PageContentProposalData } from "@factory/contracts";

/**
 * Run 4.1 W5 — QA calibration regression.
 *
 * Runs the full deterministic triad over the three calibration corpus fixtures
 * with FACTORY_VALE_BIN explicitly unset (deterministic in every environment —
 * Vale is opt-in and must not influence the frozen vectors). Asserts the FULL
 * expected verdict vector per check id. The vectors were derived from the
 * implementation once and are justified below / in
 * docs/audits/2026-09-12-run41-calibration-baselines.md; any future change to
 * a check's semantics must update the corpus + baseline document together.
 */

const CALIBRATION_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "calibration");

delete process.env.FACTORY_VALE_BIN;

interface CalibrationFixture {
  name: string;
  proposal: PageContentProposalData;
  brief: ContentBriefData;
  policyRules: Parameters<typeof runContentQa>[2];
}

function loadFixture(name: string): CalibrationFixture {
  return JSON.parse(readFileSync(join(CALIBRATION_DIR, `${name}.json`), "utf8")) as CalibrationFixture;
}

/** Full verdict vector: checkId -> verdict, in emission order. */
function verdictVector(outcome: ReturnType<typeof runContentQa>): Array<[string, string]> {
  return [
    ...outcome.factual.map((c) => [c.checkId, c.verdict] as [string, string]),
    ...outcome.search.map((c) => [c.checkId, c.verdict] as [string, string]),
    ...outcome.editorial.map((c) => [c.checkId, c.verdict] as [string, string]),
  ];
}

test("calibration: good-page frozen verdict vector (clean page → all PASS)", () => {
  const fixture = loadFixture("good-page");
  const outcome = runContentQa(fixture.proposal, fixture.brief, fixture.policyRules);
  // Justification: clean short-sentence English proposal; every operator fact
  // appears verbatim; no prohibited/invented/unverified claims; all structure
  // guidance, user needs and intent terms covered; no forbidden terms or
  // clichés; CTA present; unique headings; no sentence >= 25 words is flagged.
  assert.deepEqual(verdictVector(outcome), [
    ["factual.prohibited_claims", "PASS"],
    ["factual.evidence_trace", "PASS"],
    ["factual.no_invented_numbers", "PASS"],
    ["factual.unverified_claims", "PASS"],
    ["factual.key_points_fidelity", "PASS"],
    ["search.semantic_coverage", "PASS"],
    ["search.user_needs", "PASS"],
    ["search.primary_intent", "PASS"],
    ["editorial.forbidden_terminology", "PASS"],
    ["editorial.ai_cliche", "PASS"],
    ["editorial.structure_integrity", "PASS"],
    ["editorial.cta_integrity", "PASS"],
    ["editorial.heading_integrity", "PASS"],
    ["editorial.readability", "PASS"],
  ]);
  assert.equal(outcome.overall, "PASS");
});

test("calibration: bad-page frozen verdict vector (weasel/passive/long sentences/cliché/superlative)", () => {
  const fixture = loadFixture("bad-page");
  const outcome = runContentQa(fixture.proposal, fixture.brief, fixture.policyRules);
  // Justifications:
  // - factual.prohibited_claims PASS — the prohibited superlative uses "best",
  //   which is not on the prohibited list (it is an unsupported claim, not a
  //   listed prohibited claim); the list only bans "#1 roofing company" and
  //   "Cheapest prices in Denver".
  // - factual.evidence_trace REVIEW — neither operator fact ("Serving Denver
  //   since 1998", "BBB A+ rating") appears verbatim.
  // - search.user_needs REVIEW — the trust-signals user need is not addressed.
  // - editorial.ai_cliche FAIL — avoidance-list hit: "we've got you covered".
  // - editorial.readability REVIEW — 2 sentences >= 25 words (42 and 37 words)
  //   flagged by the formulas.
  // - All other checks PASS (structure/CTA/headings intact, no forbidden
  //   terminology, no invented numbers).
  assert.deepEqual(verdictVector(outcome), [
    ["factual.prohibited_claims", "PASS"],
    ["factual.evidence_trace", "REVIEW"],
    ["factual.no_invented_numbers", "PASS"],
    ["factual.unverified_claims", "PASS"],
    ["factual.key_points_fidelity", "PASS"],
    ["search.semantic_coverage", "PASS"],
    ["search.user_needs", "REVIEW"],
    ["search.primary_intent", "PASS"],
    ["editorial.forbidden_terminology", "PASS"],
    ["editorial.ai_cliche", "FAIL"],
    ["editorial.structure_integrity", "PASS"],
    ["editorial.cta_integrity", "PASS"],
    ["editorial.heading_integrity", "PASS"],
    ["editorial.readability", "REVIEW"],
  ]);
  assert.equal(outcome.overall, "FAIL");
});

test("calibration: non-english-locale frozen verdict vector (readability waiver)", () => {
  const fixture = loadFixture("non-english-locale");
  const outcome = runContentQa(fixture.proposal, fixture.brief, fixture.policyRules);
  // Justification: identical proposal to good-page (which is fully PASS), but
  // localePreferences is "Russian". The ONLY delta is editorial.readability:
  // the formulas are English-calibrated, so the check emits an explicit waiver
  // REVIEW instead of a score. Everything else is unchanged.
  assert.deepEqual(verdictVector(outcome), [
    ["factual.prohibited_claims", "PASS"],
    ["factual.evidence_trace", "PASS"],
    ["factual.no_invented_numbers", "PASS"],
    ["factual.unverified_claims", "PASS"],
    ["factual.key_points_fidelity", "PASS"],
    ["search.semantic_coverage", "PASS"],
    ["search.user_needs", "PASS"],
    ["search.primary_intent", "PASS"],
    ["editorial.forbidden_terminology", "PASS"],
    ["editorial.ai_cliche", "PASS"],
    ["editorial.structure_integrity", "PASS"],
    ["editorial.cta_integrity", "PASS"],
    ["editorial.heading_integrity", "PASS"],
    ["editorial.readability", "REVIEW"],
  ]);
  const readability = outcome.editorial.find((c) => c.checkId === "editorial.readability");
  assert.match(
    readability!.detail,
    /Readability formulas are English-calibrated; locale "Russian" — check not applicable, human review required\./,
  );
  assert.equal(outcome.overall, "REVIEW");
});
