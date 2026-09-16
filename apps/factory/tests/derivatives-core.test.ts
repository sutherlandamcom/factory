import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProjectDerivativePolicyData,
  parsePageDerivativeOverrideData,
  parsePageDerivativeIntentSnapshotData,
  parseAcceptedDerivativeSetData,
  parseProductionPageInputV2Data,
  parseProductionPageInputData,
  DERIVATIVE_ERROR_CODES,
} from "@factory/contracts";
import {
  acceptedDerivativeSetDigest,
  pageDerivativeIntentSnapshotDigest,
  projectDerivativePolicyDigest,
  projectNarrationText,
  resolveEffectiveDerivativeSettings,
  derivativeSourceStaleness,
  derivativeSetStaleness,
  NARRATION_POLICY_VERSION,
} from "../src/derivatives/core.js";
import { runSummaryQa } from "../src/derivatives/summary-qa.js";
import { runSummaryInvocation, SUMMARY_ROLE_ID } from "../src/derivatives/summary-provider.js";
import { MODEL_ROLE_POLICY } from "../src/models/policy.js";
import { FactoryError } from "../src/executor/errors.js";
import type { AcceptedPageContentData } from "@factory/contracts";

const hex = (c: string) => c.repeat(64);

export function fixtureAcceptedContent(overrides: Partial<AcceptedPageContentData> = {}): AcceptedPageContentData {
  return {
    schemaVersion: "writer-content-v1",
    proposalId: "wprop-1",
    proposalVersion: 1,
    proposalDigest: hex("a"),
    qaReportDigest: hex("b"),
    slug: "roof-repair",
    title: "Roof repair services",
    content: {
      schemaVersion: "writer-content-v1",
      snapshotId: "wsnap-1",
      snapshotVersion: 1,
      snapshotDigest: hex("c"),
      title: "Roof repair services",
      metaDescription: "Learn about roof repair timelines and warranties.",
      introduction:
        "Roof repair typically takes two to five days depending on damage. Costs vary by material and roof size, and every estimate is subject to an on-site inspection.",
      sections: [
        {
          heading: "Timeline and process",
          body: "Most repairs complete within five days. Weather can extend the schedule; approximately 10% of jobs need a follow-up visit.",
        },
        {
          heading: "Warranty",
          body: "Workmanship warranty is 10 years. Materials carry the manufacturer warranty; terms depend on the product line.",
        },
      ],
      conclusion:
        "An on-site inspection determines the final scope. Estimates are approximate until the inspection is complete.",
      cta: "Request an inspection",
      internalLinks: ["/", "/services/roof-replacement"],
    },
    ...overrides,
  } as AcceptedPageContentData;
}


/** Flat copy view (the actual stored authority shape) for QA calls. */
function fixtureAcceptedCopy() {
  const c = fixtureAcceptedContent();
  return {
    title: c.title,
    metaDescription: c.content.metaDescription,
    introduction: c.content.introduction,
    sections: c.content.sections,
    conclusion: c.content.conclusion,
    cta: c.content.cta,
    internalLinks: c.content.internalLinks,
  };
}

const fixturePolicy = {
  schemaVersion: "derivatives-v1" as const,
  projectId: "proj-1",
  summary: { enabled: true, language: "en", policyVersion: "summary-instructions-v1" },
  audio: { enabled: true, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  version: 1,
};

const fixtureOverride = {
  schemaVersion: "derivatives-v1" as const,
  projectId: "proj-1",
  pageIdentity: "roof-repair",
  summary: { mode: "inherit" as const },
  audio: { mode: "disabled" as const },
  version: 1,
};

test("derivative contracts parse valid policy/override/intent/set data", () => {
  const policy = parseProjectDerivativePolicyData(fixturePolicy);
  assert.equal(policy.summary.enabled, true);
  assert.equal(policy.audio.voiceId, "fixture-voice-1");

  const override = parsePageDerivativeOverrideData(fixtureOverride);
  assert.equal(override.audio.mode, "disabled");

  const intent = parsePageDerivativeIntentSnapshotData({
    schemaVersion: "derivatives-v1",
    projectId: "proj-1",
    pageIdentity: "roof-repair",
    acceptedContent: { id: "wacc-1", version: 1, digest: hex("1") },
    projectPolicy: { id: "deriv_policy_1", version: 1, digest: hex("2") },
    pageOverride: { id: "deriv_override_1", version: 1, digest: hex("3") },
    effectiveSummary: { state: "enabled", language: "en", policyVersion: "summary-instructions-v1" },
    effectiveAudio: { state: "disabled", language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  });
  assert.equal(intent.effectiveAudio.state, "disabled");

  const set = parseAcceptedDerivativeSetData({
    schemaVersion: "derivatives-v1",
    projectId: "proj-1",
    pageIdentity: "roof-repair",
    sourceContent: { id: "wacc-1", version: 1, digest: hex("1") },
    intentSnapshot: { id: "deriv_intent_1", digest: hex("4") },
    summary: { state: "accepted", acceptedArtifactId: "accepted_summary_1", version: 1, digest: hex("5") },
    audio: { state: "disabled" },
    version: 1,
  });
  assert.equal(set.summary.state, "accepted");
  assert.equal(set.audio.state, "disabled");
});

test("derivative contracts reject invalid shapes", () => {
  assert.throws(() => parseProjectDerivativePolicyData({ ...fixturePolicy, audio: { ...fixturePolicy.audio, voiceId: "bad voice!" } }));
  assert.throws(() => parsePageDerivativeOverrideData({ ...fixtureOverride, summary: { mode: "force" } }));
  assert.throws(() => parsePageDerivativeIntentSnapshotData({ schemaVersion: "derivatives-v1", projectId: "p" }));
  assert.throws(() => parseAcceptedDerivativeSetData({ schemaVersion: "derivatives-v1", projectId: "p", pageIdentity: "x" }));
});

test("production-v2 input parses and requires the derivative set binding", () => {
  const v2 = parseProductionPageInputV2Data({
    schemaVersion: "production-v2",
    projectId: "proj-123",
    pageIdentity: "sutherland-home",
    pageType: "homepage",
    route: "/",
    siteIdentity: { siteId: "sutherland-private-office", siteName: "Sutherland Private Office", canonicalOrigin: "https://sutherlandam.com", language: "en", profileDigest: hex("d") },
    acceptedContent: { id: "wacc-abc", version: 1, digest: hex("a") },
    acceptedDesign: { id: "dacc-abc", version: 2, digest: hex("b") },
    acceptedVisualSet: { id: "vset-abc", version: 1, digest: hex("c") },
    acceptedDerivativeSet: { id: "derivative_set_1", version: 1, digest: hex("e") },
    renderer: { id: "astro-static", version: "astro-7.2.9", policyVersion: "production-policy-v1" },
  });
  assert.equal(v2.acceptedDerivativeSet.id, "derivative_set_1");
  // v2 input must NOT parse under the strict v1 schema.
  assert.throws(() => parseProductionPageInputData({ ...v2 }));
});

test("production-v1 input still parses (historical truth preserved)", () => {
  const v1 = parseProductionPageInputData({
    schemaVersion: "production-v1",
    projectId: "proj-123",
    pageIdentity: "sutherland-home",
    pageType: "homepage",
    route: "/",
    siteIdentity: { siteId: "sutherland-private-office", siteName: "Sutherland Private Office", canonicalOrigin: "https://sutherlandam.com", language: "en", profileDigest: hex("d") },
    acceptedContent: { id: "wacc-abc", version: 1, digest: hex("a") },
    acceptedDesign: { id: "dacc-abc", version: 2, digest: hex("b") },
    acceptedVisualSet: { id: "vset-abc", version: 1, digest: hex("c") },
    renderer: { id: "astro-static", version: "astro-7.2.9", policyVersion: "production-policy-v1" },
  });
  assert.equal(v1.schemaVersion, "production-v1");
});

test("derivative error codes are exported for the operator contract", () => {
  assert.ok(DERIVATIVE_ERROR_CODES.includes("derivative_fixture_not_production_authority"));
  assert.ok(DERIVATIVE_ERROR_CODES.includes("derivative_binary_digest_mismatch"));
});

// ---------------------------------------------------------------------------
// Effective policy resolution
// ---------------------------------------------------------------------------

test("effective policy: absent project policy resolves to explicit disabled", () => {
  const effective = resolveEffectiveDerivativeSettings({ projectPolicy: null, pageOverride: null });
  assert.equal(effective.summary.state, "disabled");
  assert.equal(effective.audio.state, "disabled");
});

test("effective policy: override forcing enabled without project policy fails closed", () => {
  assert.throws(
    () =>
      resolveEffectiveDerivativeSettings({
        projectPolicy: null,
        pageOverride: { ...fixtureOverride, summary: { mode: "enabled" } },
      }),
    /no project derivative policy exists/i,
  );
});

test("effective policy: page override disables audio while summary inherits enabled", () => {
  const effective = resolveEffectiveDerivativeSettings({
    projectPolicy: parseProjectDerivativePolicyData(fixturePolicy),
    pageOverride: parsePageDerivativeOverrideData(fixtureOverride),
  });
  assert.equal(effective.summary.state, "enabled");
  assert.equal(effective.audio.state, "disabled");
});

test("effective policy: page override can refine language and voice", () => {
  const effective = resolveEffectiveDerivativeSettings({
    projectPolicy: parseProjectDerivativePolicyData(fixturePolicy),
    pageOverride: parsePageDerivativeOverrideData({
      ...fixtureOverride,
      summary: { mode: "inherit" },
      audio: { mode: "inherit", language: "fr", voiceId: "other-voice" },
    }),
  });
  assert.equal(effective.audio.language, "fr");
  assert.equal(effective.audio.voiceId, "other-voice");
  // Summary language unchanged (mode inherit).
  assert.equal(effective.summary.language, "en");
});

test("effective policy: enabled audio without any voiceId fails closed", () => {
  assert.throws(
    () =>
      resolveEffectiveDerivativeSettings({
        projectPolicy: {
          ...fixturePolicy,
          audio: { enabled: true, language: "en", policyVersion: "narration-projection-v1" },
        },
        pageOverride: null,
      }),
    /no voiceId is configured/i,
  );
});

// ---------------------------------------------------------------------------
// Digest normalization / mutation tests (Run 7 lesson)
// ---------------------------------------------------------------------------

test("derivative set digest covers authority fields only and is mutation-sensitive", () => {
  const base = {
    schemaVersion: "derivatives-v1" as const,
    projectId: "proj-1",
    pageIdentity: "roof-repair",
    sourceContent: { id: "wacc-1", version: 1, digest: hex("1") },
    intentSnapshot: { id: "deriv_intent_1", digest: hex("4") },
    summary: { state: "accepted" as const, acceptedArtifactId: "accepted_summary_1", version: 1, digest: hex("5") },
    audio: { state: "disabled" as const },
    version: 1,
  };
  const d1 = acceptedDerivativeSetDigest({ ...base, version: 1 } as never);

  // Mutating an authority field changes the digest.
  const mutatedContent = acceptedDerivativeSetDigest({
    ...base,
    sourceContent: { ...base.sourceContent, version: 2 },
  } as never);
  assert.notEqual(d1, mutatedContent);

  const mutatedSummary = acceptedDerivativeSetDigest({
    ...base,
    summary: { ...base.summary, digest: hex("6") },
  } as never);
  assert.notEqual(d1, mutatedSummary);

  // Key insertion order must not matter (canonical JSON).
  const reordered = acceptedDerivativeSetDigest({
    audio: base.audio,
    version: 1,
    summary: base.summary,
    intentSnapshot: base.intentSnapshot,
    sourceContent: base.sourceContent,
    pageIdentity: base.pageIdentity,
    projectId: base.projectId,
    schemaVersion: base.schemaVersion,
  } as never);
  assert.equal(d1, reordered);
});

test("intent snapshot digest binds exact policy/override/content refs", () => {
  const base = {
    schemaVersion: "derivatives-v1" as const,
    projectId: "proj-1",
    pageIdentity: "roof-repair",
    acceptedContent: { id: "wacc-1", version: 1, digest: hex("1") },
    projectPolicy: { id: "deriv_policy_1", version: 1, digest: hex("2") } as { id: string; version: number; digest: string } | null,
    pageOverride: null as { id: string; version: number; digest: string } | null,
    effectiveSummary: { state: "enabled" as const, language: "en", policyVersion: "summary-instructions-v1" },
    effectiveAudio: { state: "enabled" as const, language: "en", voiceId: "fixture-voice-1", policyVersion: "narration-projection-v1" },
  };
  const d1 = pageDerivativeIntentSnapshotDigest(base);
  assert.equal(pageDerivativeIntentSnapshotDigest({ ...base }), d1);
  assert.notEqual(pageDerivativeIntentSnapshotDigest({ ...base, pageOverride: { id: "o", version: 1, digest: hex("3") } }), d1);
  assert.notEqual(
    pageDerivativeIntentSnapshotDigest({
      ...base,
      projectPolicy: { ...base.projectPolicy!, version: 2 },
    }),
    d1,
  );
});

test("policy digest is version-sensitive", () => {
  const d1 = projectDerivativePolicyDigest(fixturePolicy);
  const d2 = projectDerivativePolicyDigest({ ...fixturePolicy, version: 2 });
  assert.notEqual(d1, d2);
});

// ---------------------------------------------------------------------------
// Narration projection
// ---------------------------------------------------------------------------

test("narration projection includes title/intro/sections/conclusion verbatim", () => {
  const content = fixtureAcceptedCopy();
  const narration = projectNarrationText(content);
  assert.ok(narration.includes(content.title));
  assert.ok(narration.includes(content.introduction));
  assert.ok(narration.includes("Timeline and process"));
  assert.ok(narration.includes("Most repairs complete within five days."));
  assert.ok(narration.includes(content.conclusion));
});

test("narration projection excludes meta description, CTA, links, SEO material", () => {
  const content = fixtureAcceptedCopy();
  const narration = projectNarrationText(content);
  assert.ok(!narration.includes(content.metaDescription));
  assert.ok(!narration.includes(content.cta));
  assert.ok(!narration.includes("/services/roof-replacement"));
});

test("narration projection is deterministic", () => {
  const content = fixtureAcceptedCopy();
  assert.equal(projectNarrationText(content), projectNarrationText(content));
  assert.equal(NARRATION_POLICY_VERSION, "narration-projection-v1");
});

// ---------------------------------------------------------------------------
// Staleness functions
// ---------------------------------------------------------------------------

test("staleness: source content mutation makes artifacts stale", () => {
  const verdict = derivativeSourceStaleness({
    artifactSource: { id: "wacc-1", version: 1, digest: hex("1") },
    currentContent: { id: "wacc-2", version: 2, digest: hex("9") },
  });
  assert.equal(verdict.stale, true);
  assert.match(verdict.reason!, /moved from/);

  const current = derivativeSourceStaleness({
    artifactSource: { id: "wacc-1", version: 1, digest: hex("1") },
    currentContent: { id: "wacc-1", version: 1, digest: hex("1") },
  });
  assert.equal(current.stale, false);
});

test("staleness: missing current content is stale", () => {
  const verdict = derivativeSourceStaleness({
    artifactSource: { id: "wacc-1", version: 1, digest: hex("1") },
    currentContent: null,
  });
  assert.equal(verdict.stale, true);
});

test("staleness: derivative set detects superseded members without over-invalidating", () => {
  const set = {
    schemaVersion: "derivatives-v1" as const,
    projectId: "proj-1",
    pageIdentity: "roof-repair",
    sourceContent: { id: "wacc-1", version: 1, digest: hex("1") },
    intentSnapshot: { id: "deriv_intent_1", digest: hex("4") },
    summary: { state: "accepted" as const, acceptedArtifactId: "accepted_summary_1", version: 1, digest: hex("5") },
    audio: { state: "disabled" as const },
    version: 1,
  };
  // Current everywhere: not stale.
  const ok = derivativeSetStaleness({
    set: set as never,
    currentContent: { id: "wacc-1", version: 1, digest: hex("1") },
    currentIntentSnapshot: { id: "deriv_intent_1", digest: hex("4") },
    currentSummary: { id: "accepted_summary_1", version: 1, digest: hex("5") },
    currentAudio: null,
  });
  assert.equal(ok.stale, false);

  // Summary superseded: stale.
  const summaryStale = derivativeSetStaleness({
    set: set as never,
    currentContent: { id: "wacc-1", version: 1, digest: hex("1") },
    currentIntentSnapshot: { id: "deriv_intent_1", digest: hex("4") },
    currentSummary: { id: "accepted_summary_1", version: 2, digest: hex("7") },
    currentAudio: null,
  });
  assert.equal(summaryStale.stale, true);
  assert.match(summaryStale.reason!, /summary/i);

  // Content mutated: stale (source rule wins).
  const contentStale = derivativeSetStaleness({
    set: set as never,
    currentContent: { id: "wacc-1", version: 2, digest: hex("8") },
    currentIntentSnapshot: { id: "deriv_intent_1", digest: hex("4") },
    currentSummary: { id: "accepted_summary_1", version: 1, digest: hex("5") },
    currentAudio: null,
  });
  assert.equal(contentStale.stale, true);
});

// ---------------------------------------------------------------------------
// Summary QA gates
// ---------------------------------------------------------------------------

test("summary QA: faithful grounded summary passes", () => {
  const content = fixtureAcceptedCopy();
  const report = runSummaryQa({
    proposalId: "sp-1",
    proposalDigest: hex("f"),
    summaryText:
      "Roof repair typically takes two to five days depending on damage, and costs vary by material and roof size subject to an on-site inspection. Most repairs complete within five days, and approximately 10% of jobs need a follow-up visit. The workmanship warranty is 10 years while materials carry the manufacturer warranty.",
    sourceContent: content,
    expectedLanguage: "en",
  });
  assert.equal(report.overall, "PASS");
});

test("summary QA: fabricated numeric claim fails", () => {
  const content = fixtureAcceptedCopy();
  const report = runSummaryQa({
    proposalId: "sp-2",
    proposalDigest: hex("f"),
    summaryText:
      "Roof repair typically takes two to five days. Costs vary by material. Workmanship warranty is 10 years and the company has completed 5000 roofs.",
    sourceContent: content,
    expectedLanguage: "en",
  });
  const check = report.checks.find((c) => c.checkId === "summary.no_new_numeric_claims")!;
  assert.equal(check.verdict, "FAIL");
  assert.equal(report.overall, "FAIL");
});

test("summary QA: injected URL fails", () => {
  const content = fixtureAcceptedCopy();
  const report = runSummaryQa({
    proposalId: "sp-3",
    proposalDigest: hex("f"),
    summaryText:
      "Roof repair typically takes two to five days. Costs vary by material. See https://example.com/deals for pricing details and warranty information.",
    sourceContent: content,
    expectedLanguage: "en",
  });
  const check = report.checks.find((c) => c.checkId === "summary.no_new_urls")!;
  assert.equal(check.verdict, "FAIL");
});

test("summary QA: CTA injection fails", () => {
  const content = fixtureAcceptedCopy();
  const report = runSummaryQa({
    proposalId: "sp-4",
    proposalDigest: hex("f"),
    summaryText:
      "Roof repair typically takes two to five days. Costs vary by material and roof size. Contact us today to book a call for your inspection.",
    sourceContent: content,
    expectedLanguage: "en",
  });
  const check = report.checks.find((c) => c.checkId === "summary.no_cta_injection")!;
  assert.equal(check.verdict, "FAIL");
});

test("summary QA: placeholder text fails", () => {
  const content = fixtureAcceptedCopy();
  const report = runSummaryQa({
    proposalId: "sp-5",
    proposalDigest: hex("f"),
    summaryText: "Roof repair typically takes two to five days. [Insert warranty details here] Costs vary by material.",
    sourceContent: content,
    expectedLanguage: "en",
  });
  const check = report.checks.find((c) => c.checkId === "summary.no_placeholder")!;
  assert.equal(check.verdict, "FAIL");
});

test("summary QA: ungrounded sentences fail source_bound", () => {
  const content = fixtureAcceptedCopy();
  const report = runSummaryQa({
    proposalId: "sp-6",
    proposalDigest: hex("f"),
    summaryText:
      "Roof repair typically takes two to five days depending on damage. Quantum entanglement research suggests materials could self-repair within minutes under laboratory conditions.",
    sourceContent: content,
    expectedLanguage: "en",
  });
  const check = report.checks.find((c) => c.checkId === "summary.source_bound")!;
  assert.equal(check.verdict, "FAIL");
});

test("summary QA: YMYL content hardening rejects absolutized claims", () => {
  const content = fixtureAcceptedCopy();
  const report = runSummaryQa({
    proposalId: "sp-7",
    proposalDigest: hex("f"),
    summaryText:
      "Roof repair typically takes two to five days. Costs vary by material. The workmanship warranty is 10 years and results are guaranteed for every roof.",
    sourceContent: content,
    expectedLanguage: "en",
  });
  assert.equal(report.overall, "FAIL");
});

test("Theorem D / Section 18-21: page_summarizer future role blocks live summary execution before network with zero calls", async () => {
  const policy = MODEL_ROLE_POLICY[SUMMARY_ROLE_ID as keyof typeof MODEL_ROLE_POLICY];
  assert.equal(policy.implementationStatus, "future");

  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("HARD NETWORK TRAP: network must never be reached!");
  }) as typeof globalThis.fetch;

  try {
    // Attempt live summary invocation without fixture override (deps.invoke undefined).
    // Provide a valid-looking OPENROUTER_API_KEY in env so missing credentials is NOT the reason for failure.
    await assert.rejects(
      () =>
        runSummaryInvocation(
          {
            promptSnapshotDigest: hex("1"),
            projectId: "proj-1",
            pageIdentity: "home",
            systemPrompt: "System prompt",
            userPrompt: "User prompt",
          },
          {
            budget: {} as any, // Fail closed before budget or network
            env: { OPENROUTER_API_KEY: "sk-or-v1-fake-test-key-12345678" },
          },
        ),
      (err: unknown) => {
        assert.ok(err instanceof FactoryError);
        assert.equal(err.code, "derivative_generation_blocked");
        assert.match(err.message, /implementationStatus is "future"/);
        return true;
      },
    );

    assert.equal(networkCalls, 0, "Network call count must be strictly 0");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
