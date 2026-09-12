import assert from "node:assert/strict";
import test from "node:test";
import { runEditorialQa } from "../src/writer/qa.js";
import type { PageContentProposalData } from "@factory/contracts";

/**
 * Run 4.1 W3 — editorial.readability (E6) tests.
 *
 * Fixture patterns follow apps/factory/tests/persistence/writer-qa.test.ts.
 * E6 is advisory (never FAIL) and English-gated: non-English locales receive
 * an explicit waiver REVIEW because the readability formulas are
 * English-calibrated.
 */

const BRIEF = {
  lineage: {
    acceptedInputSnapshotId: "s",
    acceptedInputSnapshotVersion: 1,
    acceptedInputDigest: "a".repeat(64),
    writerPolicyId: "p",
    writerPolicyVersion: 1,
    writerPolicyDigest: "b".repeat(64),
    gapSnapshotId: "g",
    gapSnapshotVersion: 1,
    gapSnapshotDigest: "c".repeat(64),
  },
  pageTarget: {
    route: "roof-replacement",
    title: "Roof Replacement in Denver",
    ctaIntent: "request a quote",
    structureGuidance: ["What a full roof replacement includes"],
  },
  allowedClaims: ["Licensed and insured"],
  prohibitedClaims: [],
  unknownClaims: [],
  operatorFacts: [],
  searchSemantics: {
    primaryIntent: "roof replacement",
    semanticCoverageRequirements: [],
    userNeeds: [],
  },
  contentBriefKeyPoints: [],
  noGapLineageAcknowledged: false,
} as never;

const POLICY = {
  forbiddenTerminology: [],
  aiLanguageAvoidance: [],
  clicheAvoidance: [],
  localePreferences: "US English",
};

function proposal(overrides: {
  introduction?: string;
  sections?: Array<{ heading: string; body: string }>;
  conclusion?: string;
}): PageContentProposalData {
  return {
    schemaVersion: "writer-content-v1",
    snapshotId: "s",
    snapshotVersion: 1,
    snapshotDigest: "a".repeat(64),
    title: "Roof Replacement in Denver",
    metaDescription: "Licensed Denver roof replacement with a limited warranty.",
    introduction: overrides.introduction ?? "Denver roofs face hail and freeze-thaw stress.",
    sections: overrides.sections ?? [
      { heading: "Process", body: "Licensed crews handle permits and disposal." },
    ],
    conclusion: overrides.conclusion ?? "Comparing roofers is straightforward with clear facts.",
    cta: "Book a free roof inspection today.",
    internalLinks: [],
  } as PageContentProposalData;
}

function readabilityCheck(checks: ReturnType<typeof runEditorialQa>) {
  const found = checks.find((c) => c.checkId === "editorial.readability");
  assert.ok(found, "editorial.readability check must always be present for English locales");
  return found!;
}

test("readability: clean short-sentence English proposal passes", () => {
  const checks = runEditorialQa(proposal({}), BRIEF, POLICY);
  const e6 = readabilityCheck(checks);
  assert.equal(e6.verdict, "PASS", JSON.stringify(e6, null, 2));
  assert.deepEqual(e6.evidence, []);
});

test("readability: 40+-word nested-clause sentences flag REVIEW with evidence", () => {
  const longBody =
    "The comprehensive residential roofing replacement methodology that our fully licensed and insured professional crews have meticulously developed over many years of dedicated service throughout the greater Denver metropolitan area encompasses an extensive array of technically sophisticated procedures including systematic tear-off operations, thorough structural deck inspections, premium weather-resistant underlayment installations, and precision-engineered shingle placement protocols that collectively ensure optimal long-term performance for every single property we serve in this region.";
  const longIntro =
    "The inspection process that our licensed crews complete before any replacement work begins includes a comprehensive structural evaluation of the underlying roof deck, flashing details, and drainage components that together determine the final scope.";
  const checks = runEditorialQa(
    proposal({ introduction: longIntro, sections: [{ heading: "Process", body: longBody }] }),
    BRIEF,
    POLICY,
  );
  const e6 = readabilityCheck(checks);
  assert.equal(e6.verdict, "REVIEW", JSON.stringify(e6, null, 2));
  assert.match(e6.detail, /2 sentence\(s\) flagged hard to read by readability formulas/);
  assert.ok(e6.evidence.length >= 1, "REVIEW must carry evidence refs");
  assert.ok(e6.evidence.length <= 5, "at most 5 evidence refs");
  for (const ref of e6.evidence) {
    assert.equal(ref.kind, "section");
    assert.ok(ref.ref.length <= 280, "evidence ref must respect the 280-char cap");
    // Each evidence ref is the flagged sentence text itself.
    assert.ok(longBody.includes(ref.ref) || longIntro.includes(ref.ref));
  }
});

test("readability: evidence refs are truncated to 280 chars", () => {
  // A single sentence well over 280 characters.
  const huge =
    "The " + "extraordinarily detailed ".repeat(40) + "inspection procedure covers every conceivable structural element of the property.";
  const checks = runEditorialQa(
    proposal({ sections: [{ heading: "Process", body: huge }] }),
    BRIEF,
    POLICY,
  );
  const e6 = readabilityCheck(checks);
  assert.equal(e6.verdict, "REVIEW");
  for (const ref of e6.evidence) {
    assert.ok(ref.ref.length <= 280);
  }
});

test("readability: non-English locale receives explicit waiver REVIEW", () => {
  const checks = runEditorialQa(proposal({}), BRIEF, { ...POLICY, localePreferences: "Russian" });
  const e6 = checks.find((c) => c.checkId === "editorial.readability");
  assert.ok(e6, "waiver check must be present for non-English locale");
  assert.equal(e6!.verdict, "REVIEW");
  assert.match(
    e6!.detail,
    /Readability formulas are English-calibrated; locale "Russian" — check not applicable, human review required\./,
  );
});

test("readability: empty locale receives explicit waiver REVIEW", () => {
  const checks = runEditorialQa(proposal({}), BRIEF, { ...POLICY, localePreferences: "" });
  const e6 = checks.find((c) => c.checkId === "editorial.readability");
  assert.ok(e6, "waiver check must be present for empty locale");
  assert.equal(e6!.verdict, "REVIEW");
  assert.match(e6!.detail, /locale "" — check not applicable/);
});

test("readability: missing locale receives explicit waiver REVIEW", () => {
  const checks = runEditorialQa(proposal({}), BRIEF, {
    forbiddenTerminology: [],
    aiLanguageAvoidance: [],
    clicheAvoidance: [],
  });
  const e6 = checks.find((c) => c.checkId === "editorial.readability");
  assert.ok(e6, "waiver check must be present for missing locale");
  assert.equal(e6!.verdict, "REVIEW");
});

test("readability: check is advisory — never FAIL even for extreme prose", () => {
  const extreme =
    ("The " + "unprecedentedly multifaceted ".repeat(30) + "methodology").slice(0, 4000);
  const checks = runEditorialQa(
    proposal({ sections: [{ heading: "Process", body: extreme }] }),
    BRIEF,
    POLICY,
  );
  const e6 = readabilityCheck(checks);
  assert.equal(e6.verdict, "REVIEW");
  // Overall worst-of must not be pushed to FAIL by readability alone.
  const others = checks.filter((c) => c.checkId !== "editorial.readability");
  const worstOther = others.some((c) => c.verdict === "FAIL")
    ? "FAIL"
    : others.some((c) => c.verdict === "REVIEW")
      ? "REVIEW"
      : "PASS";
  assert.notEqual(e6.verdict, "FAIL");
  assert.equal(worstOther !== "FAIL" ? "PASS" : worstOther, "PASS");
});

test("readability: body text scope excludes title, meta, headings and CTA", () => {
  // Title/meta/CTA contain 40+-word prose; body is short. The check must PASS
  // because only body text is evaluated.
  const p = proposal({});
  (p as { title: string }).title =
    "The extremely long and convoluted title that our marketing department insists upon using despite every readability recommendation ever documented anywhere at all";
  (p as { metaDescription: string }).metaDescription =
    "The extremely long and convoluted meta description that our marketing department insists upon using despite every readability recommendation ever documented anywhere at all times";
  (p as { cta: string }).cta =
    "The extremely long and convoluted call to action that our marketing department insists upon using despite every readability recommendation ever documented anywhere at all times";
  const checks = runEditorialQa(p, BRIEF, POLICY);
  const e6 = readabilityCheck(checks);
  assert.equal(e6.verdict, "PASS", JSON.stringify(e6, null, 2));
});
