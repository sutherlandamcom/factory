import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compilePageProductionPacket,
} from "../src/site-production/packet.js";
import {
  makeGenericBlueprint,
  makeGenericEvidenceBundle,
  makeGenericProductionSpec,
  makeGenericSiteProfile,
} from "./fixtures/site-production-fixtures.js";
import type { ReferenceEntry, AssetEntry } from "@factory/contracts";

async function createMockInputRoot(): Promise<{
  tempDir: string;
  cleanup: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "site-production-packet-"));
  await mkdir(path.join(tempDir, "references"), { recursive: true });
  await mkdir(path.join(tempDir, "assets"), { recursive: true });

  await writeFile(
    path.join(tempDir, "references", "swiss-banking-annual-report.png"),
    "mock-png-content-12345",
  );
  await writeFile(
    path.join(tempDir, "assets", "meridian-headquarters-exterior.jpg"),
    "mock-jpg-content-67890",
  );
  await writeFile(
    path.join(tempDir, "assets", "meridian-mark.svg"),
    "<svg>meridian</svg>",
  );

  return {
    tempDir,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

test("compilePageProductionPacket includes ONLY page-relevant references, assets, and evidence", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const blueprint = makeGenericBlueprint();
    const siteProfile = makeGenericSiteProfile();
    const { evidence, operatorFacts } = makeGenericEvidenceBundle();
    const spec = makeGenericProductionSpec(blueprint);

    // Expand reference library to 10 references (8 irrelevant)
    for (let i = 1; i <= 8; i++) {
      const extraRef: ReferenceEntry = {
        id: `ref-irrelevant-${i}`,
        role: "reference",
        kind: "website",
        sourceUrl: `https://example.com/irrelevant-${i}`,
        dimensions: ["typography"],
        learn: [`irrelevant lesson ${i}`],
        avoid: [],
      };
      spec.references.push(extraRef);
    }
    assert.equal(spec.references.length, 11);

    // Expand asset library to 20+ assets (17+ irrelevant)
    for (let i = 1; i <= 17; i++) {
      const extraAsset: AssetEntry = {
        id: `asset-irrelevant-${i}`,
        kind: "icon",
        localPath: `assets/icon-${i}.svg`,
        usageStatus: "approved",
        rightsStatus: "operator_owned",
      };
      spec.assets.push(extraAsset);
    }
    assert.ok(spec.assets.length >= 20);

    // Provide evidence index maps
    const evidenceMap = new Map(evidence.items.map((i) => [i.id, i]));
    const operatorFactsMap = new Map(operatorFacts.map((f) => [f.id, f]));

    const packet = await compilePageProductionPacket({
      productionSpec: spec,
      blueprint,
      siteProfile,
      evidenceIndex: { evidenceMap, operatorFactsMap },
      pageSlug: "/",
      inputRoot: tempDir,
    });

    // 1. Target page blueprint truth is present
    assert.equal(packet.blueprintPage.slug, "/");
    assert.equal(packet.blueprintPage.type, "homepage");
    assert.equal(packet.site.siteId, "meridian-advisory");
    assert.equal(packet.site.siteName, "Meridian Advisory");

    // 2. Global creative direction is present
    assert.ok(packet.creativeDirection.qualityBar.mustFeelLike.length > 0);
    assert.ok(packet.creativeDirection.qualityBar.mustNotFeelLike.length > 0);

    // 3. Relevant references only: exactly the 3 assigned references, NOT the 8 extra
    assert.equal(packet.references.length, 3);
    const packetRefIds = packet.references.map((r) => r.id);
    assert.deepEqual(packetRefIds, ["ref-ft-lex", "ref-saas-anti", "ref-swiss-annual-report"]);
    for (let i = 1; i <= 8; i++) {
      assert.ok(!packetRefIds.includes(`ref-irrelevant-${i}`));
    }

    // Materialized reference includes digest and byteSize
    const swissRef = packet.references.find((r) => r.id === "ref-swiss-annual-report")!;
    assert.ok(swissRef.artifactDigest && swissRef.artifactDigest.length === 64);
    assert.equal(swissRef.artifactByteSize, 22);

    // 4. Relevant assets only: exactly the 2 assigned assets, NOT the 17 extra
    assert.equal(packet.assets.length, 2);
    const packetAssetIds = packet.assets.map((a) => a.id);
    assert.deepEqual(packetAssetIds, ["asset-hero-monochrome", "asset-logo-mark"]);
    for (let i = 1; i <= 17; i++) {
      assert.ok(!packetAssetIds.includes(`asset-irrelevant-${i}`));
    }

    // Materialized asset includes digest and byteSize
    const heroAsset = packet.assets.find((a) => a.id === "asset-hero-monochrome")!;
    assert.ok(heroAsset.fileDigest && heroAsset.fileDigest.length === 64);
    assert.equal(heroAsset.byteSize, 22);

    // 5. Relevant evidence only: exactly the 2 referenced items
    assert.equal(packet.evidence.length, 2);
    const packetEvidenceIds = packet.evidence.map((e) => e.id);
    assert.deepEqual(packetEvidenceIds, ["ev-debt-market-2026", "fact-meridian-founded"]);

    // 6. Does NOT contain other pages from blueprint
    assert.equal((packet as unknown as Record<string, unknown>).pages, undefined);
  } finally {
    await cleanup();
  }
});

test("packet compilation is strictly deterministic across repeated invocations", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const blueprint = makeGenericBlueprint();
    const siteProfile = makeGenericSiteProfile();
    const { evidence, operatorFacts } = makeGenericEvidenceBundle();
    const spec = makeGenericProductionSpec(blueprint);

    const evidenceMap = new Map(evidence.items.map((i) => [i.id, i]));
    const operatorFactsMap = new Map(operatorFacts.map((f) => [f.id, f]));

    const packet1 = await compilePageProductionPacket({
      productionSpec: spec,
      blueprint,
      siteProfile,
      evidenceIndex: { evidenceMap, operatorFactsMap },
      pageSlug: "/",
      inputRoot: tempDir,
    });

    const packet2 = await compilePageProductionPacket({
      productionSpec: spec,
      blueprint,
      siteProfile,
      evidenceIndex: { evidenceMap, operatorFactsMap },
      pageSlug: "/",
      inputRoot: tempDir,
    });

    assert.deepEqual(packet1, packet2);
  } finally {
    await cleanup();
  }
});

test("failure-mode fit test: contract structurally expresses explicit prevention of first-experiment failures", async () => {
  const { tempDir, cleanup } = await createMockInputRoot();
  try {
    const blueprint = makeGenericBlueprint();
    const siteProfile = makeGenericSiteProfile();
    const spec = makeGenericProductionSpec(blueprint);

    const packet = await compilePageProductionPacket({
      productionSpec: spec,
      blueprint,
      siteProfile,
      pageSlug: "/",
      inputRoot: tempDir,
    });

    // 1. DO NOT use generic card-grid landing-page composition
    assert.ok(
      packet.creativeDirection.layout.avoid.some((rule) =>
        rule.toLowerCase().includes("three-card") || rule.toLowerCase().includes("card grid"),
      ),
    );
    assert.ok(
      packet.pageProduction.qualityBar?.avoid.some((rule) =>
        rule.toLowerCase().includes("card"),
      ),
    );

    // 2. DO NOT produce unsupported promotional claims
    assert.ok(
      packet.creativeDirection.editorial.avoid.some((rule) =>
        rule.toLowerCase().includes("buzzwords") || rule.toLowerCase().includes("hyperbole"),
      ),
    );
    assert.ok(
      packet.blueprintPage.sections[0]!.prohibitedClaims.length > 0,
    );

    // 3. DO use specified page reference for first-viewport composition
    const firstSection = packet.pageProduction.orderedSections[0]!;
    assert.ok(firstSection.referenceIds.includes("ref-swiss-annual-report"));
    const assignedRef = packet.references.find((r) => r.id === "ref-swiss-annual-report")!;
    assert.ok(
      assignedRef.learn.some((item) => item.toLowerCase().includes("first viewport")),
    );

    // 4. DO use approved hero asset
    assert.ok(firstSection.assets.some((a) => a.assetId === "asset-hero-monochrome" && a.role === "hero"));
    const heroAsset = packet.assets.find((a) => a.id === "asset-hero-monochrome")!;
    assert.equal(heroAsset.usageStatus, "approved");
    assert.equal(heroAsset.rightsStatus, "operator_owned");

    // 5. DO target specified primary keyword
    assert.equal(packet.pageProduction.seo?.primaryKeyword, "independent debt advisory");
    assert.ok(packet.pageProduction.seo?.searchIntent.length > 0);

    // 6. DO implement specified conversion destination
    assert.equal(packet.pageProduction.primaryCta?.destination.kind, "internal");
    assert.equal(
      (packet.pageProduction.primaryCta?.destination as { kind: "internal"; targetSlug: string }).targetSlug,
      "/about",
    );

    // 7. DO follow page-specific section order
    assert.equal(packet.pageProduction.orderedSections.length, 2);
    assert.equal(packet.pageProduction.orderedSections[0]!.id, "hero-overview");
    assert.equal(packet.pageProduction.orderedSections[1]!.id, "market-landscape");
  } finally {
    await cleanup();
  }
});
