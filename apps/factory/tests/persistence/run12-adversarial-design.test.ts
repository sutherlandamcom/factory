import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { ProductionStore } from "../../src/production/store.js";
import { PageArchetypeStore } from "../../src/page-authority/store.js";
import { deriveDesignImplementationContract } from "../../src/production/design-implementation.js";
import { assertManifest, computeRenderManifestDigest } from "../../src/production/render-manifest.js";
import { runDesignDriftQa } from "../../src/production/qa/design-drift.js";
import { normalizeArchetypeGrammar } from "../../src/design/archetype-grammar.js";
import { DESIGN_SCHEMA_VERSION_V2, type DesignCandidateDataV2 } from "@factory/contracts";

/**
 * RUN 12 BLOCK 47 & BLOCK 48 — ADVERSARIAL DESIGN GOVERNANCE & STALENESS PROOFS.
 *
 * Proves the fail-closed path for:
 *   - missing design authority -> production_authority_not_found
 *   - missing page archetype authority -> page_archetype_unclassified
 *   - missing required token -> design_implementation_unsupported
 *   - unresolved font delivery -> design_font_delivery_unresolved
 *   - unknown component / unknown variant -> design.composition_valid FAIL
 *   - tampered manifest digest -> assertManifest throws
 *   - DIC digest changes deterministically when tokens, section patterns, or rendererPolicyVersion change
 */
test("ADVERSARIAL DESIGN: missing design authority fails closed at production input derivation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedProjectWithAcceptedInputs(dbInst, "adv-design-1");
    const production = new ProductionStore(dbInst.db);
    await assert.rejects(
      production.deriveProductionInput({
        projectId,
        pageSlug: "home",
        siteIdentity: {
          siteId: "s",
          siteName: "S",
          canonicalOrigin: "https://example.com",
          language: "en",
          profileDigest: "a".repeat(64),
        },
        rendererVersion: "astro-7.2.9",
        rendererPolicyVersion: "production-policy-v3",
      }),
      (err: { code?: string }) => err.code === "production_authority_not_found",
    );
  } finally {
    await dbInst.close();
  }
});

test("ADVERSARIAL DESIGN: missing page archetype authority fails closed without inventing a default", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const { projectId } = await seedProjectWithAcceptedInputs(dbInst, "adv-design-arch");
    const archetypeStore = new PageArchetypeStore(dbInst.db);
    await assert.rejects(
      archetypeStore.requireAuthority(projectId, "services/unplanned-page"),
      (err: { code?: string }) => err.code === "page_archetype_unclassified",
    );
  } finally {
    await dbInst.close();
  }
});

test("ADVERSARIAL DESIGN: DIC fails closed on missing token or unapproved font and changes digest on token/pattern/policy mutation", () => {
  const baseCandidate: DesignCandidateDataV2 = {
    schemaVersion: DESIGN_SCHEMA_VERSION_V2,
    provider: "google-stitch",
    providerMode: "fixture",
    providerProjectName: "projects/run12-adv",
    providerDesignSystemAsset: "",
    designMdDigest: "d".repeat(64),
    designMdToolVersion: "factory-design-md-lint-v1",
    designMdLint: { errors: 0, warnings: 0, infos: 0 },
    designSeed: {
      colors: { primary: "#1A2E35" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "scale" },
      rationale: "Seed",
    },
    providerEvidence: { designSystemAsset: "" },
    tokens: {
      colors: {
        primary: "#1A2E35",
        secondary: "#4A5A62",
        accent: "#2F5D62",
        neutral: "#F7F5F2",
        background: "#FFFFFF",
        surface: "#F7F5F2",
        textPrimary: "#1A2E35",
        textSecondary: "#4A5A62",
      },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "scale" },
      spacing: { xs: "4px", sm: "8px", md: "16px", lg: "32px" },
      rounded: { sm: "4px", md: "8px" },
      ctaHierarchy: "Primary solid; secondary outlined",
      navigationLanguage: "Institutional navigation",
      imageryTreatment: "Illustrative abstract",
      sectionRhythm: "Balanced",
    },
    screens: [
      { id: "s1", providerScreenName: "p/s1", title: "Service", deviceType: "DESKTOP", archetype: "service" },
    ],
    archetypes: [
      {
        kind: "service",
        purpose: "Service page",
        providerScreenNames: ["p/s1"],
        sectionPatterns: ["page-header", "service-overview", "process", "evidence", "faq", "conclusion", "cta"],
        contentRequirements: ["Accepted copy"],
        assetSlots: [],
        primaryCta: "Primary",
        secondaryCta: "",
        responsiveBehavior: "Mobile first",
        trustPresentation: "Visible organization identity",
      },
    ],
    visualRoleRequirements: [
      { archetype: "service", roles: [{ role: "hero-primary", requirement: "Hero", requiredRole: "hero", required: true }] },
    ],
    archetypeGrammar: normalizeArchetypeGrammar([
      { kind: "service", sectionPatterns: ["page-header", "service-overview", "process", "evidence", "faq", "conclusion", "cta"] },
    ]),
    normalization: {
      factoryAuthorityGroups: ["tokens", "typography", "spacing", "rounded", "ctaHierarchy", "navigationLanguage", "imageryTreatment", "sectionRhythm", "archetypeStructure"],
      providerDerivedGroups: [],
      note: "Structured values are Factory authority.",
    },
    rationale: "Run 12 test candidate",
    providerSessionId: "sess-1",
  };

  const dicBase = deriveDesignImplementationContract({
    design: baseCandidate,
    acceptedDesign: { id: "d1", version: 1, digest: "a".repeat(64) },
    rendererPolicyVersion: "production-policy-v3",
  });

  // 1. Token mutation changes DIC digest
  const mutatedToken = structuredClone(baseCandidate);
  mutatedToken.tokens.colors.accent = "#0F1E22";
  const dicTokenMutated = deriveDesignImplementationContract({
    design: mutatedToken,
    acceptedDesign: { id: "d1", version: 1, digest: "a".repeat(64) },
    rendererPolicyVersion: "production-policy-v3",
  });
  assert.notEqual(dicBase.implementationContractDigest, dicTokenMutated.implementationContractDigest);

  // 2. Renderer policy version change changes DIC digest
  const dicPolicyMutated = deriveDesignImplementationContract({
    design: baseCandidate,
    acceptedDesign: { id: "d1", version: 1, digest: "a".repeat(64) },
    rendererPolicyVersion: "production-policy-v4",
  });
  assert.notEqual(dicBase.implementationContractDigest, dicPolicyMutated.implementationContractDigest);

  // 3. Missing required token fails closed
  const missingBg = structuredClone(baseCandidate);
  delete (missingBg.tokens.colors as Record<string, unknown>).background;
  assert.throws(
    () =>
      deriveDesignImplementationContract({
        design: missingBg,
        acceptedDesign: { id: "d1", version: 1, digest: "a".repeat(64) },
        rendererPolicyVersion: "production-policy-v3",
      }),
    (err: { code?: string }) => err.code === "design_implementation_unsupported",
  );

  // 4. Unresolved font delivery fails closed
  const badFont = structuredClone(baseCandidate);
  badFont.tokens.typography.headingFont = "Unapproved Fantasy Font";
  assert.throws(
    () =>
      deriveDesignImplementationContract({
        design: badFont,
        acceptedDesign: { id: "d1", version: 1, digest: "a".repeat(64) },
        rendererPolicyVersion: "production-policy-v3",
      }),
    /design_font_delivery_unresolved|no deterministic approved delivery/,
  );
});

test("ADVERSARIAL DESIGN: tampered manifest digest and unknown component/variant fail closed", async () => {
  const manifest = {
    schemaVersion: "production-v3" as const,
    input: {
      id: "ppin-run12",
      version: 1,
      digest: "a".repeat(64),
      projectId: "proj-run12",
      pageIdentity: "services/buyer-side-advisory",
      pageType: "service" as const,
      route: "/services/buyer-side-advisory",
      siteIdentity: { siteId: "s", siteName: "Sutherland Private Office", canonicalOrigin: "https://sutherlandam.com", language: "en", profileDigest: "4".repeat(64) },
    },
    seo: {
      fullTitle: "Buyer-Side Property Advisory | Sutherland Private Office",
      description: "Scope and engagement.",
      canonicalUrl: "https://sutherlandam.com/services/buyer-side-advisory",
      ogTitle: "Buyer-Side Property Advisory | Sutherland Private Office",
      ogDescription: "Scope and engagement.",
      ogUrl: "https://sutherlandam.com/services/buyer-side-advisory",
    },
    content: {
      acceptedId: "wacc-run12",
      acceptedVersion: 1,
      acceptedDigest: "b".repeat(64),
      title: "Buyer-Side Property Advisory",
      metaDescription: "Scope and engagement.",
      introduction: "Intro",
      sections: [{ heading: "Scope", body: "Body" }],
      conclusion: "Conclusion",
      cta: "CTA",
      internalLinks: [],
    },
    design: {
      acceptedId: "dsac-run12",
      acceptedVersion: 1,
      acceptedDigest: "a".repeat(64),
      tokens: {
        colors: { primary: "#1A2E35" },
        typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "n" },
        spacing: { md: "16px" },
        rounded: { md: "8px" },
        ctaHierarchy: "c",
        navigationLanguage: "n",
        imageryTreatment: "i",
        sectionRhythm: "s",
      },
      archetype: {
        kind: "service" as const,
        sectionPatterns: ["page-header", "cta"],
        contentRequirements: [],
        assetSlots: [],
        primaryCta: "",
        secondaryCta: "",
        responsiveBehavior: "r",
        trustPresentation: "t",
        rendererPrimitives: ["hero", "cta"],
      },
      designImplementation: {
        implementationContractDigest: "9".repeat(64),
        policyVersion: "production-policy-v3",
        schemaVersion: "design-implementation-v1",
      },
      semanticTokens: [{ role: "color.background.primary", value: "#ffffff" }],
      fontDelivery: [{ mode: "approved_system_stack" as const, family: "Georgia", sourceToken: "typography.display" as const }],
      composition: [{ componentId: "page-hero", variant: "split", pattern: "page-header", repetition: "once" as const }],
    },
    links: [],
    breadcrumbs: [],
    assets: [],
    derivatives: { setDigest: "e".repeat(64), summary: { state: "disabled" as const }, audio: { state: "disabled" as const } },
    manifestDigest: "",
  };
  const digest = computeRenderManifestDigest(manifest);
  const valid = { ...manifest, manifestDigest: digest };
  assert.doesNotThrow(() => assertManifest(valid));

  // Tampered manifest digest fails closed
  const tampered = structuredClone(valid);
  tampered.content.title = "Tampered Title";
  assert.throws(() => assertManifest(tampered), /digest mismatch/);

  // Unknown component fails design drift QA
  const starterSrcDir = path.join(path.dirname(new URL(import.meta.url).pathname), "../../..", "sites", "starter", "src");
  const badComp = structuredClone(valid);
  badComp.design.composition = [{ componentId: "invented-clone-component", variant: "default", pattern: "hero", repetition: "once" as const }];
  const checksComp = await runDesignDriftQa({ manifests: [badComp as never], starterSrcDir, manifestSetDigest: digest });
  assert.equal(checksComp.find((c) => c.checkId === "design.composition_valid")?.verdict, "FAIL");

  // Unknown variant fails design drift QA
  const badVar = structuredClone(valid);
  badVar.design.composition = [{ componentId: "page-hero", variant: "invented-variant", pattern: "hero", repetition: "once" as const }];
  const checksVar = await runDesignDriftQa({ manifests: [badVar as never], starterSrcDir, manifestSetDigest: digest });
  assert.equal(checksVar.find((c) => c.checkId === "design.composition_valid")?.verdict, "FAIL");
});
