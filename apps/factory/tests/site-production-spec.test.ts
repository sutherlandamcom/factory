import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PRODUCTION_SPEC_BYTES,
  SITE_PRODUCTION_SPEC_VERSION,
  parseSiteProductionSpec,
  type SiteProductionSpec,
} from "@factory/contracts";
import {
  makeGenericBlueprint,
  makeGenericProductionSpec,
} from "./fixtures/site-production-fixtures.js";

test("rich generic production spec fixture parses strictly", () => {
  const spec = makeGenericProductionSpec();
  const parsed = parseSiteProductionSpec(spec);

  assert.equal(parsed.version, SITE_PRODUCTION_SPEC_VERSION);
  assert.equal(parsed.siteId, "meridian-advisory");
  assert.equal(parsed.references.length, 3);
  assert.equal(parsed.assets.length, 4);
  assert.equal(parsed.pages.length, 1);
  assert.equal(parsed.pages[0]!.slug, "/");
  assert.equal(parsed.pages[0]!.primaryCta?.destination.kind, "internal");
});

test("minimal valid production spec parses strictly", () => {
  const minimal: SiteProductionSpec = {
    version: "v0",
    siteId: "minimal-site",
    sourceBlueprint: {
      runId: "20260903T100000Z-12345678",
    },
    creativeDirection: {
      qualityBar: {
        mustFeelLike: ["professional"],
        mustNotFeelLike: ["amateur"],
      },
      editorial: {
        rules: ["be concise"],
        avoid: ["marketing jargon"],
      },
      layout: {
        principles: ["clear rhythm"],
        avoid: ["unaligned grids"],
      },
      typography: {
        direction: "Clean modern sans-serif",
        avoid: [],
      },
      color: {
        direction: "Neutral monochrome",
        avoid: [],
      },
      imagery: {
        direction: "No imagery required",
        avoid: [],
      },
      density: {
        direction: "Comfortable",
      },
      motion: {
        direction: "None",
      },
    },
    references: [],
    assets: [],
    pages: [
      {
        slug: "/",
        blueprintPageType: "homepage",
        requirements: {
          seoTargetingRequired: false,
          primaryCtaRequired: false,
          localVisualReferenceRequired: false,
          approvedAssetRequired: false,
        },
        sections: [
          {
            id: "hero",
            purpose: "Greet the visitor",
            referenceIds: [],
            assets: [],
            evidenceRefs: [],
            sourceBlueprintSectionIds: [],
          },
        ],
        referenceIds: [],
        assets: [],
        evidenceRefs: [],
      },
    ],
  };

  const parsed = parseSiteProductionSpec(minimal);
  assert.equal(parsed.siteId, "minimal-site");
});

test("unknown top-level field fails closed (.strict())", () => {
  const invalid = {
    ...makeGenericProductionSpec(),
    unauthorizedField: "hacker_payload",
  };
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /unrecognized_keys/,
  );
});

test("unknown nested field in creativeDirection fails closed", () => {
  const invalid = makeGenericProductionSpec();
  (invalid.creativeDirection as Record<string, unknown>).themeEngine = "tailwind-v4";
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /unrecognized_keys/,
  );
});

test("invalid version is rejected", () => {
  const invalid = {
    ...makeGenericProductionSpec(),
    version: "v1",
  };
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /invalid_value|invalid_type/,
  );
});

test("invalid siteId syntax is rejected", () => {
  const invalid = {
    ...makeGenericProductionSpec(),
    siteId: "INVALID_SITE_ID!",
  };
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /siteId must be lowercase alphanumeric/,
  );
});

test("duplicate reference ids in library reject", () => {
  const invalid = makeGenericProductionSpec();
  invalid.references.push({
    ...invalid.references[0]!,
    learn: ["another learn"],
  });
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /duplicate reference ids in references library/,
  );
});

test("duplicate asset ids in library reject", () => {
  const invalid = makeGenericProductionSpec();
  invalid.assets.push({
    ...invalid.assets[0]!,
    altIntent: "duplicate asset",
  });
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /duplicate asset ids in assets library/,
  );
});

test("duplicate page slugs in spec reject", () => {
  const invalid = makeGenericProductionSpec();
  invalid.pages.push({
    ...invalid.pages[0]!,
  });
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /duplicate page slugs/,
  );
});

test("duplicate section ids within a page reject", () => {
  const invalid = makeGenericProductionSpec();
  invalid.pages[0]!.sections.push({
    ...invalid.pages[0]!.sections[0]!,
  });
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /duplicate section ids are forbidden/,
  );
});

test("reference requires at least one of sourceUrl or localArtifactPath", () => {
  const invalid = makeGenericProductionSpec();
  invalid.references = [
    {
      id: "ref-ghost",
      role: "reference",
      kind: "website",
      dimensions: ["layout"],
      learn: [],
      avoid: [],
    },
  ];
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /requires at least one of sourceUrl or localArtifactPath/,
  );
});

test("reference with duplicate dimensions is rejected", () => {
  const invalid = makeGenericProductionSpec();
  invalid.references[0]!.dimensions = ["layout", "layout"];
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /duplicate dimensions/,
  );
});

test("CTA destinations: internal, external, and email are strictly validated", () => {
  const spec = makeGenericProductionSpec();

  // Valid external
  spec.pages[0]!.primaryCta = {
    label: "External Link",
    destination: {
      kind: "external",
      url: "https://example.com/briefing",
    },
  };
  assert.ok(parseSiteProductionSpec(spec));

  // Valid email
  spec.pages[0]!.primaryCta = {
    label: "Email Us",
    destination: {
      kind: "email",
      address: "advisory@meridian.com",
    },
  };
  assert.ok(parseSiteProductionSpec(spec));

  // Invalid email
  spec.pages[0]!.primaryCta = {
    label: "Email Us",
    destination: {
      kind: "email",
      address: "not-an-email",
    },
  };
  assert.throws(() => parseSiteProductionSpec(spec), /valid email address/);

  // Invalid external URL (relative or javascript:)
  spec.pages[0]!.primaryCta = {
    label: "Bad Link",
    destination: {
      kind: "external",
      url: "javascript:alert(1)",
    },
  };
  assert.throws(() => parseSiteProductionSpec(spec), /absolute http:\/\/ or https:\/\/ URL/);
});

test("unsafe path: absolute path is rejected", () => {
  const invalid = makeGenericProductionSpec();
  invalid.assets[0]!.localPath = "/etc/passwd";
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /must be relative, not absolute/,
  );
});

test("unsafe path: traversal is rejected", () => {
  const invalid = makeGenericProductionSpec();
  invalid.assets[0]!.localPath = "assets/../../secret.txt";
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /traversal/,
  );
});

test("unsafe path: backslashes are rejected", () => {
  const invalid = makeGenericProductionSpec();
  invalid.assets[0]!.localPath = "assets\\logo.png";
  assert.throws(
    () => parseSiteProductionSpec(invalid),
    /path must use forward slashes only/,
  );
});

test("oversized spec payload exceeds byte ceiling", () => {
  const oversized = JSON.stringify({
    ...makeGenericProductionSpec(),
    padding: "x".repeat(MAX_PRODUCTION_SPEC_BYTES + 100),
  });
  assert.throws(
    () => parseSiteProductionSpec(oversized),
    /payload size .* exceeds maximum allowed/,
  );
});
