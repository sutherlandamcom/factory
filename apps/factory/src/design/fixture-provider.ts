import { lintDesignMd } from "./design-md.js";
import type {
  DesignCandidateData,
  DesignCandidateDataV2,
  DesignGenerationRequest,
  DesignGenerationResult,
  DesignProvider,
  DesignProviderPreflight,
  DesignInputSnapshotData,
  DesignInputSnapshotDataV2,
} from "@factory/contracts";
import { parseDesignCandidateAnyVersion, parseDesignInputSnapshotAnyVersion, isDesignInputSnapshotV2 } from "@factory/contracts";
import { buildDesignMd, DESIGN_MD_TOOL_VERSION } from "./stitch-provider.js";
import { fixtureSectionGrammar } from "./archetype-grammar.js";

/**
 * FIXTURE DESIGN PROVIDER — dev/test provider-mode adapter (trusted server
 * config only: FACTORY_DESIGN_MODE=fixture). Produces a deterministic valid
 * candidate WITHOUT any paid provider call or network access.
 *
 * Evidence integrity (§19): the fixture records providerMode "fixture" in
 * the durable candidate payload — a machine-checkable dimension that
 * survives persistence/restart. It can never masquerade as live Stitch
 * output: candidate acceptance policy can reject fixture candidates from
 * production acceptance, and reports surface the mode explicitly.
 */
export const FIXTURE_PROVIDER_MODE = "fixture" as const;

export class FixtureDesignProvider implements DesignProvider {
  readonly id = "google-stitch-fixture";

  async preflight(): Promise<DesignProviderPreflight> {
    return { configured: true, provider: "google-stitch", reachable: true };
  }

  async generateDesignSystem(request: DesignGenerationRequest): Promise<DesignGenerationResult> {
    const seed = request.designSeed;
    const designMd = buildDesignMd({
      colors: {
        primary: seed.colors.primary,
        secondary: seed.colors.secondary ?? "",
        accent: seed.colors.accent ?? "",
        neutral: seed.colors.neutral ?? "",
      },
      typography: { headingFont: seed.typography.headingFont, bodyFont: seed.typography.bodyFont },
      rationale: seed.rationale,
    });
    const lint = lintDesignMd(designMd);
    const designMdDigest = await sha256Of(designMd);

    const screens: DesignCandidateData["screens"] = [];
    const archetypeViews: DesignCandidateData["archetypes"] = [];
    const screenHtmlByRef = new Map<string, string>();
    let index = 1;
    for (const kind of request.inputSnapshot.archetypes) {
      const representative = request.inputSnapshot.representativePages.find((r) => r.archetype === kind);
      const screenName = `fixture/projects/e2e/screens/${kind}-${index}`;
      const slotRole =
        kind === "homepage" ? "hero" : kind === "service" ? "supporting" : kind === "location" ? "background" : "illustration";
      const bound = representative
        ? request.inputSnapshot.assetRefs.find((ref) => ref.pageSlug === representative.slug && ref.role === slotRole)
        : null;
      const desktopHtml = fixtureHtml(kind, "desktop", bound);
      screenHtmlByRef.set(screenName, desktopHtml);
      screens.push({
        id: `screen-${index}`,
        providerScreenName: screenName,
        title: `Fixture ${kind}`,
        deviceType: "DESKTOP",
        archetype: kind,
        htmlDigest: await sha256Of(desktopHtml),
        screenshotDigest: undefined,
      });
      // One MOBILE homepage screen (responsive review evidence parity with
      // the live adapter, at zero fixture cost).
      if (kind === "homepage") {
        const mobileHtml = fixtureHtml(kind, "mobile", bound);
        screenHtmlByRef.set(`${screenName}-mobile`, mobileHtml);
        screens.push({
          id: `screen-${screens.length + 1}`,
          providerScreenName: `${screenName}-mobile`,
          title: `Fixture ${kind} (mobile)`,
          deviceType: "MOBILE",
          archetype: kind,
          htmlDigest: await sha256Of(mobileHtml),
          screenshotDigest: undefined,
        });
      }
      // Page-exact asset slots: bind ONLY the assignment for the
      // representative page + matching role (never project-global lookup).
      const assetSlots: DesignCandidateData["archetypes"][number]["assetSlots"] = [];
      if (representative) {
        const slotRole =
          kind === "homepage" ? "hero" : kind === "service" ? "supporting" : kind === "location" ? "background" : "illustration";
        const slotName =
          kind === "homepage" ? "hero.primary" : kind === "service" ? "service.supporting" : kind === "location" ? "location.gallery" : "author.portrait";
        const bound = request.inputSnapshot.assetRefs.find(
          (ref) => ref.pageSlug === representative.slug && ref.role === slotRole,
        );
        assetSlots.push({
          slot: slotName,
          requirement: bound
            ? `Approved asset for ${representative.slug}/${slotRole}`
            : `Neutral ${slotName} placeholder`,
          pageSlug: representative.slug,
          role: slotRole,
          requiredRole: slotRole as "hero" | "supporting" | "background" | "illustration",
          ...(bound
            ? {
                boundAssetVersionId: bound.versionId,
                boundBinaryDigest: bound.binaryDigest,
                boundGovernanceDigest: bound.governanceDigest,
                providerConsumed: false,
                designProviderReferencedFinalAsset: true,
                designProviderConsumedFinalAsset: false,
                placeholder: false,
              }
            : {
                unresolvedReason: `No approved asset assignment for ${representative.slug}/${slotRole}.`,
                providerConsumed: false,
                designProviderReferencedFinalAsset: false,
                designProviderConsumedFinalAsset: false,
                placeholder: true,
              }),
        });
      }
      archetypeViews.push({
        kind,
        purpose: `Fixture ${kind} archetype`,
        providerScreenNames: screens.filter((s) => s.archetype === kind).map((s) => s.providerScreenName),
        sectionPatterns: ["hero", "evidence", "cta"],
        contentRequirements: ["Accepted copy presented verbatim"],
        assetSlots,
        primaryCta: "Primary action",
        secondaryCta: "",
        responsiveBehavior: "Mobile-first fixture behavior",
        trustPresentation: "Author/date/source areas visible",
      });
      index += 1;
    }

    const candidate = parseDesignCandidateAnyVersion(
      isDesignInputSnapshotV2(parseDesignInputSnapshotAnyVersion(request.inputSnapshot))
        ? this.buildCandidateV2(request, screens, archetypeViews, designMdDigest, lint)
        : this.buildCandidateV1({ seed, screens, archetypeViews, designMdDigest, lint }),
    );

    return {
      candidate,
      rawArtifacts: [
        {
          kind: "design_md",
          bytes: new TextEncoder().encode(designMd),
          mediaType: "text/markdown",
          providerRef: null,
        },
        ...screens.map((screen) => ({
          kind: "screen_html" as const,
          bytes: new TextEncoder().encode(screenHtmlByRef.get(screen.providerScreenName)!),
          mediaType: "text/html",
          providerRef: screen.providerScreenName,
        })),
        {
          kind: "provider_response",
          bytes: new TextEncoder().encode(JSON.stringify({ fixture: true, providerMode: "fixture", project: "fixture/projects/e2e" })),
          mediaType: "application/json",
          providerRef: "fixture/projects/e2e",
        },
      ],
      providerProjectName: "fixture/projects/e2e",
      providerSessionId: "fixture-session-1",
    };
  }

  /** design-v1 candidate payload (historical semantics, unchanged). */
  private buildCandidateV1(input: {
    seed: DesignGenerationRequest["designSeed"];
    screens: DesignCandidateData["screens"];
    archetypeViews: DesignCandidateData["archetypes"];
    designMdDigest: string;
    lint: ReturnType<typeof lintDesignMd>;
  }): DesignCandidateData {
    const seed = input.seed;
    return {
      schemaVersion: "design-v1",
      provider: "google-stitch",
      providerMode: FIXTURE_PROVIDER_MODE,
      providerProjectName: "fixture/projects/e2e",
      providerDesignSystemAsset: "",
      designMdDigest: input.designMdDigest,
      designMdToolVersion: DESIGN_MD_TOOL_VERSION,
      designMdLint: { errors: input.lint.errors, warnings: input.lint.warnings, infos: input.lint.infos },
      designSeed: {
        colors: seed.colors,
        typography: seed.typography,
        rationale: seed.rationale,
      },
      providerEvidence: { designSystemAsset: "" },
      tokens: {
        colors: {
          primary: seed.colors.primary,
          secondary: seed.colors.secondary,
          accent: seed.colors.accent,
          neutral: seed.colors.neutral,
          background: "#FFFFFF",
          surface: seed.colors.neutral,
          textPrimary: seed.colors.primary,
          textSecondary: seed.colors.secondary,
        },
        typography: {
          headingFont: seed.typography.headingFont,
          bodyFont: seed.typography.bodyFont,
          scaleNotes: "fixture scale",
        },
        spacing: { sm: "8px", md: "16px", lg: "32px" },
        rounded: { sm: "4px", md: "8px" },
        ctaHierarchy: "Primary solid accent; secondary outlined",
        navigationLanguage: "Fixture navigation language",
        imageryTreatment: "Placeholders explicitly labeled",
        sectionRhythm: "Fixture rhythm",
      },
      screens: input.screens,
      archetypes: input.archetypeViews,
      rationale: "Deterministic fixture candidate (FACTORY_DESIGN_MODE=fixture; providerMode=fixture).",
      providerSessionId: "fixture-session-1",
    };
  }

  /**
   * design-v2 candidate payload: adds generic per-archetype visual-role
   * requirements and explicit normalization provenance. The tokens remain
   * the Factory seed authority (recorded as such); archetype structure is
   * the deterministic Factory template; screens remain provider evidence.
   */
  private buildCandidateV2(
    request: DesignGenerationRequest,
    screens: DesignCandidateData["screens"],
    archetypeViews: DesignCandidateData["archetypes"],
    designMdDigest: string,
    lint: ReturnType<typeof lintDesignMd>,
  ): DesignCandidateDataV2 {
    const seed = request.designSeed;
    const snapshotV2 = request.inputSnapshot as DesignInputSnapshotDataV2;
    return {
      schemaVersion: "design-v2",
      provider: "google-stitch",
      providerMode: FIXTURE_PROVIDER_MODE,
      providerProjectName: "fixture/projects/e2e",
      providerDesignSystemAsset: "",
      designMdDigest,
      designMdToolVersion: DESIGN_MD_TOOL_VERSION,
      designMdLint: { errors: lint.errors, warnings: lint.warnings, infos: lint.infos },
      designSeed: {
        colors: seed.colors,
        typography: seed.typography,
        rationale: seed.rationale,
      },
      providerEvidence: { designSystemAsset: "" },
      tokens: {
        colors: {
          primary: seed.colors.primary,
          secondary: seed.colors.secondary,
          accent: seed.colors.accent,
          neutral: seed.colors.neutral,
          background: "#FFFFFF",
          surface: seed.colors.neutral,
          textPrimary: seed.colors.primary,
          textSecondary: seed.colors.secondary,
        },
        typography: {
          headingFont: seed.typography.headingFont,
          bodyFont: seed.typography.bodyFont,
          scaleNotes: "fixture scale",
        },
        spacing: { xs: "4px", sm: "8px", md: "16px", lg: "32px", xl: "64px", xxl: "128px" },
        rounded: { sm: "4px", md: "8px", lg: "16px" },
        ctaHierarchy: "Primary solid accent; secondary outlined",
        navigationLanguage: "Fixture navigation language",
        imageryTreatment: "Placeholders explicitly labeled",
        sectionRhythm: "Fixture rhythm",
      },
      screens,
      archetypes: archetypeViews,
      visualRoleRequirements: archetypeViews.map((archetype) => ({
        archetype: archetype.kind,
        roles: fixtureVisualRoleRequirements(archetype.kind),
      })),
      archetypeGrammar: fixtureSectionGrammar(archetypeViews, request.acceptedCopyByArchetype),
      normalization: {
        factoryAuthorityGroups: ["tokens", "typography", "spacing", "rounded", "ctaHierarchy", "navigationLanguage", "imageryTreatment", "sectionRhythm", "archetypeStructure"],
        providerDerivedGroups: [],
        note: "Fixture candidate: all structured values are Factory authority; provider screens are evidence only.",
      },
      rationale: `Deterministic fixture candidate (FACTORY_DESIGN_MODE=fixture; providerMode=fixture; snapshot bindings policy ${snapshotV2.pageArchetypeBindingPolicy}).`,
      providerSessionId: "fixture-session-1",
    };
  }
}

/**
 * Generic visual-role requirements per archetype for the fixture provider.
 * These are archetype-level requirements — page-exact resolution happens
 * downstream per page (VisualAssetPlan -> AcceptedVisualAssetSet).
 */
function fixtureVisualRoleRequirements(kind: DesignCandidateData["archetypes"][number]["kind"]): Array<{
  role: string;
  requirement: string;
  requiredRole: "hero" | "background" | "inline" | "chart" | "illustration" | "logo" | "supporting";
  required: boolean;
}> {
  switch (kind) {
    case "homepage":
      return [{ role: "hero-primary", requirement: "Homepage hero visual", requiredRole: "hero", required: true }];
    case "service":
      return [
        { role: "hero-primary", requirement: "Service hero visual", requiredRole: "hero", required: true },
        { role: "supporting", requirement: "Service supporting imagery", requiredRole: "supporting", required: false },
      ];
    case "location":
      return [{ role: "hero-primary", requirement: "Location hero visual", requiredRole: "background", required: true }];
    case "editorial":
      return [{ role: "author-portrait", requirement: "Author portrait", requiredRole: "illustration", required: false }];
    case "investment_advisory":
      return [{ role: "chart-primary", requirement: "Advisory chart/illustration", requiredRole: "chart", required: false }];
  }
}

/** Deterministic, script-free fixture HTML for sandboxed preview rendering. */
function fixtureHtml(
  kind: string,
  device: "desktop" | "mobile" = "desktop",
  boundAsset?: { versionId: string; binaryDigest: string } | null,
): string {
  const maxWidth = device === "mobile" ? "420px" : "720px";
  const visualMarkup = boundAsset
    ? `<div class="asset-slot" style="margin: 16px 0;"><img src="/api/projects/e2e/assets/versions/${boundAsset.versionId}/bytes" alt="${kind} asset" data-digest="${boundAsset.binaryDigest}" style="max-width: 100%; height: auto; border-radius: 4px;" /></div>`
    : `<div class="placeholder">hero.primary — placeholder (Run 7 resolves)</div>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture ${kind} (${device})</title>
<style>
  body { font-family: sans-serif; margin: 0; color: #1A2E35; background: #F7F5F2; }
  header { background: #1A2E35; color: #fff; padding: 16px; }
  main { padding: 24px; max-width: ${maxWidth}; margin: 0 auto; }
  .cta { background: #B8422E; color: #fff; padding: 10px 16px; border-radius: 4px; display: inline-block; }
  .placeholder { border: 2px dashed #4A5A62; padding: 24px; text-align: center; color: #4A5A62; }
</style></head>
<body>
<header><strong>Fixture ${kind} (${device})</strong></header>
<main>
  <h1>Fixture ${kind} archetype</h1>
  ${visualMarkup}
  <p>Accepted copy would be presented verbatim here.</p>
  <a class="cta" href="#">Primary action</a>
</main>
</body></html>`;
}

async function sha256Of(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
}
