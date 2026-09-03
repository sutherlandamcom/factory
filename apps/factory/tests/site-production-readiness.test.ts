import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluatePageReadiness,
  evaluateSiteReadiness,
} from "../src/site-production/readiness.js";
import {
  makeGenericBlueprint,
  makeGenericEvidenceBundle,
  makeGenericProductionSpec,
  makeGenericSiteProfile,
} from "./fixtures/site-production-fixtures.js";
import type { EvidenceIndex } from "../src/site-production/validation.js";

async function createMockInputRoot(): Promise<{
  tempDir: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "site-production-readiness-"));
  await mkdir(path.join(tempDir, "references"), { recursive: true });
  await mkdir(path.join(tempDir, "assets"), { recursive: true });

  await writeFile(
    path.join(tempDir, "references", "swiss-banking-annual-report.png"),
    "mock-png-bytes",
  );
  await writeFile(
    path.join(tempDir, "assets", "meridian-headquarters-exterior.jpg"),
    "mock-jpg-bytes",
  );
  await writeFile(
    path.join(tempDir, "assets", "meridian-mark.svg"),
    "<svg>mock</svg>",
  );

  return {
    tempDir,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function setupContext(inputRoot: string) {
  const blueprint = makeGenericBlueprint();
  const siteProfile = makeGenericSiteProfile();
  const { evidence, operatorFacts } = makeGenericEvidenceBundle();
  const evidenceIndex: EvidenceIndex = {
    evidenceIds: new Set(evidence.items.map((i) => i.id)),
    operatorFactIds: new Set(operatorFacts.map((f) => f.id)),
  };
  const spec = makeGenericProductionSpec(blueprint);

  return { spec, blueprint, siteProfile, evidenceIndex, inputRoot };
}

test("complete valid page with existing files evaluates to READY", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const ctx = setupContext(tempDir);
    const res = await evaluatePageReadiness(ctx.spec.pages[0]!, ctx.spec, ctx);

    assert.equal(res.status, "READY");
    assert.equal(res.blockers.length, 0);
  } finally {
    await cleanup();
  }
});

test("required primary CTA missing causes readiness BLOCKED", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const ctx = setupContext(tempDir);
    ctx.spec.pages[0]!.requirements.primaryCtaRequired = true;
    ctx.spec.pages[0]!.primaryCta = undefined;

    const res = await evaluatePageReadiness(ctx.spec.pages[0]!, ctx.spec, ctx);
    assert.equal(res.status, "BLOCKED");
    assert.ok(res.blockers.some((b) => b.includes("primaryCtaRequired is true but primaryCta is not configured")));
  } finally {
    await cleanup();
  }
});

test("required SEO missing causes readiness BLOCKED", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const ctx = setupContext(tempDir);
    ctx.spec.pages[0]!.requirements.seoTargetingRequired = true;
    ctx.spec.pages[0]!.seo = undefined;

    const res = await evaluatePageReadiness(ctx.spec.pages[0]!, ctx.spec, ctx);
    assert.equal(res.status, "BLOCKED");
    assert.ok(res.blockers.some((b) => b.includes("seoTargetingRequired is true but seo configuration is absent")));
  } finally {
    await cleanup();
  }
});

test("seoTargetingRequired with empty primaryKeyword causes BLOCKED", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const ctx = setupContext(tempDir);
    ctx.spec.pages[0]!.requirements.seoTargetingRequired = true;
    ctx.spec.pages[0]!.seo!.primaryKeyword = "";

    const res = await evaluatePageReadiness(ctx.spec.pages[0]!, ctx.spec, ctx);
    assert.equal(res.status, "BLOCKED");
    assert.ok(res.blockers.some((b) => b.includes("primaryKeyword is missing or blank")));
  } finally {
    await cleanup();
  }
});

test("localVisualReferenceRequired with only URL references causes BLOCKED", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const ctx = setupContext(tempDir);
    ctx.spec.pages[0]!.requirements.localVisualReferenceRequired = true;
    // Keep only URL-only references on the page
    ctx.spec.pages[0]!.referenceIds = ["ref-ft-lex", "ref-saas-anti"];
    ctx.spec.pages[0]!.sections[0]!.referenceIds = [];

    const res = await evaluatePageReadiness(ctx.spec.pages[0]!, ctx.spec, ctx);
    assert.equal(res.status, "BLOCKED");
    assert.ok(res.blockers.some((b) => b.includes("localVisualReferenceRequired is true but no inspectable local visual reference exists")));
  } finally {
    await cleanup();
  }
});

test("assigned local reference file missing on disk causes BLOCKED", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const ctx = setupContext(tempDir);
    // Delete the reference file
    await rm(path.join(tempDir, "references", "swiss-banking-annual-report.png"));

    const res = await evaluatePageReadiness(ctx.spec.pages[0]!, ctx.spec, ctx);
    assert.equal(res.status, "BLOCKED");
    assert.ok(res.blockers.some((b) => b.includes("does not exist on disk")));
  } finally {
    await cleanup();
  }
});

test("assigned production asset file missing on disk causes BLOCKED", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const ctx = setupContext(tempDir);
    // Delete the hero image file
    await rm(path.join(tempDir, "assets", "meridian-headquarters-exterior.jpg"));

    const res = await evaluatePageReadiness(ctx.spec.pages[0]!, ctx.spec, ctx);
    assert.equal(res.status, "BLOCKED");
    assert.ok(res.blockers.some((b) => b.includes("does not exist on disk")));
  } finally {
    await cleanup();
  }
});

test("assigned production asset with unknown rights causes BLOCKED", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const ctx = setupContext(tempDir);
    const heroAsset = ctx.spec.assets.find((a) => a.id === "asset-hero-monochrome")!;
    heroAsset.rightsStatus = "unknown";

    const res = await evaluatePageReadiness(ctx.spec.pages[0]!, ctx.spec, ctx);
    assert.equal(res.status, "BLOCKED");
    assert.ok(res.blockers.some((b) => b.includes("has rightsStatus \"unknown\"")));
  } finally {
    await cleanup();
  }
});

test("site aggregate readiness reports READY when all pages are READY", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const ctx = setupContext(tempDir);
    const siteRes = await evaluateSiteReadiness(ctx.spec, ctx);

    assert.equal(siteRes.status, "READY");
    assert.equal(siteRes.readyPageCount, 1);
    assert.equal(siteRes.blockedPageCount, 0);
    assert.equal(siteRes.siteBlockers.length, 0);
  } finally {
    await cleanup();
  }
});

test("site aggregate readiness reports BLOCKED when any page is BLOCKED", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const ctx = setupContext(tempDir);
    ctx.spec.pages[0]!.primaryCta = undefined;
    ctx.spec.pages[0]!.requirements.primaryCtaRequired = true;

    const siteRes = await evaluateSiteReadiness(ctx.spec, ctx);
    assert.equal(siteRes.status, "BLOCKED");
    assert.equal(siteRes.readyPageCount, 0);
    assert.equal(siteRes.blockedPageCount, 1);
  } finally {
    await cleanup();
  }
});
