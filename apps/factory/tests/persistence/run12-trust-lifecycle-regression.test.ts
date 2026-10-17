import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedSutherlandProject } from "../fixtures/sutherland-seeds.js";
import { TrustGovernanceStore } from "../../src/trust/store.js";
import { runTrustQa } from "../../src/production/qa/trust.js";
import type { PageIntentAuthority } from "@factory/contracts";

/**
 * RUN 12 REMEDIATION — CI regression root cause (Run 11 golden/staleness
 * journeys). Root cause: (1) no operator surface recorded a PageIntentAuthority,
 * so the mandatory trust gates correctly failed every Run 11 candidate;
 * (2) the Run 11 journey uses the deterministic FIXTURE writer whose output
 * legitimately trips trust.fixture_leakage.
 *
 * Preserved requirements proven here:
 *   - legitimate synthetic (fixture-writer) authority + declared NON_YMYL intent => PASS, stamped SYNTHETIC_FIXTURE_MODE
 *   - the same candidate under the strict production policy => FAIL (fixture_leakage)
 *   - missing intent still FAILS even in synthetic mode
 *   - the synthetic policy never relaxes YMYL review/claim/source/original-value gates
 *   - only fixture-origin leak labels are tolerated (starter identities still FAIL)
 */

function intent(projectId: string, pageIdentity: string, ymyl: PageIntentAuthority["ymylClassification"]): PageIntentAuthority {
  return {
    schemaVersion: "trust-governance-v1",
    projectId,
    pageIdentity,
    primaryIntent: "Convert homeowners researching roof repair into inspection requests",
    secondaryIntents: [],
    primaryQueryCluster: "roof repair austin",
    secondaryQueryClusters: [],
    contentGapPurpose: "Local roof repair service explanation",
    siteRole: "Primary service page",
    targetAudience: "Austin homeowners",
    mainUserTask: "Decide whether to request an inspection",
    primaryConversionAction: "Book a free roof inspection",
    ymylClassification: ymyl,
    decisionRole: "COMMERCIAL_SERVICE_EVALUATION",
    internalLinksOut: [],
  };
}

function manifestFor(projectId: string, pageIdentity: string, digest: string) {
  return {
    schemaVersion: "production-v3" as const,
    input: {
      id: "ppin-r11",
      version: 1,
      digest: "e".repeat(64),
      projectId,
      pageIdentity,
      pageType: "editorial" as const,
      route: `/${pageIdentity}`,
      siteIdentity: { siteId: "s", siteName: "Run11 Golden Roofing", canonicalOrigin: "https://example.test", language: "en", profileDigest: "f".repeat(64) },
    },
    seo: { fullTitle: "Roof", description: "d", canonicalUrl: `https://example.test/${pageIdentity}`, ogTitle: "Roof", ogDescription: "d", ogUrl: `https://example.test/${pageIdentity}` },
    content: {
      acceptedId: "wacc-r11",
      acceptedVersion: 1,
      acceptedDigest: digest,
      title: "Roof",
      metaDescription: "d",
      introduction: "This fixture introduction restates the objective",
      sections: [{ heading: "Section", body: "Fixture section body covering the brief" }],
      conclusion: "End",
      cta: "Cta",
      internalLinks: [],
    },
    design: {} as never,
    links: [],
    breadcrumbs: [],
    assets: [],
    manifestDigest: "1".repeat(64),
  };
}

async function run(opts: { html: string; ymyl?: PageIntentAuthority["ymylClassification"] | null; synthetic: boolean }) {
  const dbInst = await setupMigratedTestDatabase();
  const dist = await mkdtemp(path.join(tmpdir(), "r11-trust-"));
  try {
    const { projectId } = await seedSutherlandProject(dbInst, `r11-${Math.random().toString(36).slice(2, 8)}`);
    const trust = new TrustGovernanceStore(dbInst.db);
    const pageIdentity = "homepage";
    const digest = "a".repeat(64);
    if (opts.ymyl) await trust.setPageIntentAuthority({ projectId, intent: intent(projectId, pageIdentity, opts.ymyl) });
    await mkdir(path.join(dist, pageIdentity), { recursive: true });
    await writeFile(path.join(dist, pageIdentity, "index.html"), opts.html, "utf8");
    const report = await runTrustQa({
      manifests: [manifestFor(projectId, pageIdentity, digest)],
      distDir: dist,
      projectId,
      trust,
      contentDigests: new Map([[pageIdentity, digest]]),
      manifestSetDigest: "2".repeat(64),
      syntheticFixtureContent: opts.synthetic,
    });
    return new Map(report.checks.map((c) => [c.checkId, c] as const)).set("__overall" as never, { verdict: report.overall } as never);
  } finally {
    await rm(dist, { recursive: true, force: true });
    await dbInst.close();
  }
}

const FIXTURE_HTML = `<!doctype html><html><body><h1>Roof Repair in Austin</h1><p>This fixture introduction restates the objective</p></body></html>`;

test("R11 regression: declared NON_YMYL intent + synthetic fixture-writer content => PASS, stamped SYNTHETIC_FIXTURE_MODE", async () => {
  const r = await run({ html: FIXTURE_HTML, ymyl: "NON_YMYL", synthetic: true });
  const failing = [...r.entries()].filter(([k, v]) => k !== ("__overall" as never) && v.verdict !== "PASS").map(([k, v]) => `${k}: ${v.detail}`);
  assert.deepEqual(failing, []);
  assert.equal((r.get("__overall" as never) as { verdict: string }).verdict, "PASS");
  assert.match(r.get("trust.fixture_leakage")!.detail, /SYNTHETIC_FIXTURE_MODE.*NOT publication-eligible/);
});

test("R11 regression (negative): identical candidate under strict production policy FAILS trust.fixture_leakage", async () => {
  const r = await run({ html: FIXTURE_HTML, ymyl: "NON_YMYL", synthetic: false });
  assert.equal(r.get("trust.fixture_leakage")!.verdict, "FAIL");
  assert.match(r.get("trust.fixture_leakage")!.detail, /Fixture leakage detected/);
});

test("R11 regression (negative): missing PageIntentAuthority still FAILS in synthetic mode", async () => {
  const r = await run({ html: FIXTURE_HTML, ymyl: null, synthetic: true });
  assert.equal(r.get("trust.page_intent_present")!.verdict, "FAIL");
  assert.equal(r.get("trust.ymll_classification")!.verdict, "FAIL");
});

test("R11 regression (negative): synthetic mode never relaxes YMYL review/claim/source/original-value gates", async () => {
  const r = await run({ html: FIXTURE_HTML, ymyl: "YMYL_DECISION_SUPPORT", synthetic: true });
  for (const id of ["trust.claim_lineage", "trust.source_authority", "trust.review_authority", "trust.original_value"]) {
    assert.equal(r.get(id as never)!.verdict, "FAIL", `${id} must still FAIL for a YMYL page in synthetic mode`);
  }
  assert.equal((r.get("__overall" as never) as { verdict: string }).verdict, "FAIL");
});

test("R11 regression (negative): synthetic mode tolerates only fixture-origin labels (starter identity still FAILS)", async () => {
  const html = FIXTURE_HTML.replace("</body>", "<p>Call Summit Roofing today</p></body>");
  const r = await run({ html, ymyl: "NON_YMYL", synthetic: true });
  assert.equal(r.get("trust.fixture_leakage")!.verdict, "FAIL");
  assert.match(r.get("trust.fixture_leakage")!.detail, /Summit Roofing/);
});
