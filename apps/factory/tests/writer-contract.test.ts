import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  pageTargetSchema,
  writerPolicyDataSchema,
  contentBriefDataSchema,
  writerPromptSnapshotDataSchema,
  pageContentProposalDataSchema,
  parseWriterPolicyData,
  parsePageTarget,
  parseContentBriefData,
} from "@factory/contracts";
import { deterministicDigest } from "../src/intelligence/digest.js";

const VALID_PAGE_TARGET = {
  slug: "roof-replacement-denver",
  title: "Roof Replacement in Denver",
  objective: "Convert homeowners into inspection requests.",
  audience: "Denver homeowners",
  structureGuidance: ["Section one"],
  internalLinkIntent: ["Link to repairs"],
  ctaIntent: "Book a free inspection",
};

test("page target schema is strict: unknown keys rejected", () => {
  assert.throws(() => pageTargetSchema.parse({ ...VALID_PAGE_TARGET, extra: 1 }), z.ZodError);
  assert.throws(() => pageTargetSchema.parse({ ...VALID_PAGE_TARGET, slug: "UPPER" }), z.ZodError);
  assert.throws(() => pageTargetSchema.parse({ ...VALID_PAGE_TARGET, slug: "" }), z.ZodError);
  assert.doesNotThrow(() => parsePageTarget(VALID_PAGE_TARGET));
});

test("writer policy data requires exact accepted-input lineage fields", () => {
  const base = {
    schemaVersion: "writer-content-v1",
    acceptedInputSnapshotId: "snap-1",
    acceptedInputSnapshotVersion: 1,
    acceptedInputDigest: "a".repeat(64),
    rules: {
      brandVoice: "v",
      tone: "t",
      audiencePrinciples: [],
      writingPrinciples: [],
      preferredTerminology: [],
      forbiddenTerminology: [],
      evidencePolicy: "e",
      peopleFirstPrinciples: [],
      trustExpectations: "x",
      aiLanguageAvoidance: [],
      clicheAvoidance: [],
      localePreferences: "en-US",
      customWriterInstructions: "",
    },
  };
  assert.doesNotThrow(() => parseWriterPolicyData(base));
  // Bad digest shape rejected.
  assert.throws(() => parseWriterPolicyData({ ...base, acceptedInputDigest: "short" }), z.ZodError);
  // Unknown key rejected.
  assert.throws(() => parseWriterPolicyData({ ...base, extra: true }), z.ZodError);
});

test("content brief data: no silent truncation — oversized fields fail validation instead", () => {
  const base = {
    schemaVersion: "writer-content-v1",
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
    pageTarget: VALID_PAGE_TARGET,
    allowedClaims: [],
    prohibitedClaims: [],
    unknownClaims: [],
    operatorFacts: [],
    searchSemantics: { primaryIntent: "i", semanticCoverageRequirements: [], userNeeds: [] },
    contentBriefKeyPoints: [],
    noGapLineageAcknowledged: false,
  };
  assert.doesNotThrow(() => parseContentBriefData(base));
  // A 301-char allowed claim exceeds the boundedText(300) limit -> reject (never silently truncate).
  assert.throws(() => parseContentBriefData({ ...base, allowedClaims: ["x".repeat(301)] }), z.ZodError);
  // 31 semantic coverage requirements exceed max 30 -> reject.
  assert.throws(
    () =>
      parseContentBriefData({
        ...base,
        searchSemantics: {
          primaryIntent: "i",
          semanticCoverageRequirements: Array.from({ length: 31 }, (_, i) => `r${i}`),
          userNeeds: [],
        },
      }),
    z.ZodError,
  );
});

test("digest determinism: canonical JSON digests depend only on content", () => {
  const a = { b: 1, a: [1, { y: 2, x: 3 }] };
  const b = { a: [1, { x: 3, y: 2 }], b: 1 };
  assert.equal(deterministicDigest(a), deterministicDigest(b));
  assert.notEqual(deterministicDigest(a), deterministicDigest({ ...a, b: 2 }));
});

test("prompt snapshot schema requires bounded maxOutputTokens", () => {
  const base = {
    schemaVersion: "writer-content-v1",
    briefId: "b",
    briefVersion: 1,
    briefDigest: "a".repeat(64),
    systemPrompt: "s",
    userPrompt: "u",
    maxOutputTokens: 16000,
  };
  assert.doesNotThrow(() => writerPromptSnapshotDataSchema.parse(base));
  assert.throws(() => writerPromptSnapshotDataSchema.parse({ ...base, maxOutputTokens: 0 }), z.ZodError);
  assert.throws(() => writerPromptSnapshotDataSchema.parse({ ...base, maxOutputTokens: 65_000 }), z.ZodError);
});

test("proposal schema rejects malformed shapes (fail closed inputs)", () => {
  const base = {
    schemaVersion: "writer-content-v1",
    snapshotId: "s",
    snapshotVersion: 1,
    snapshotDigest: "a".repeat(64),
    title: "T",
    metaDescription: "m",
    introduction: "i",
    sections: [{ heading: "h", body: "b" }],
    conclusion: "c",
    cta: "cta",
    internalLinks: [],
  };
  assert.doesNotThrow(() => pageContentProposalDataSchema.parse(base));
  assert.throws(() => pageContentProposalDataSchema.parse({ ...base, sections: "not-array" }), z.ZodError);
  assert.throws(() => pageContentProposalDataSchema.parse({ ...base, snapshotDigest: "nope" }), z.ZodError);
});
