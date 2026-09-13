import type {
  DesignCandidateData,
  DesignGenerationRequest,
  DesignGenerationResult,
  DesignProvider,
  DesignProviderPreflight,
} from "@factory/contracts";
import { parseDesignCandidateData } from "@factory/contracts";
import { buildDesignMd } from "./stitch-provider.js";

/**
 * FIXTURE DESIGN PROVIDER — dev/test provider-mode adapter (trusted server
 * config only: FACTORY_DESIGN_MODE=fixture). Produces a deterministic valid
 * candidate WITHOUT any paid provider call or network access. It cannot
 * masquerade as Stitch output: the candidate records provider
 * "google-stitch" ONLY in production mode; the fixture records its provider
 * identity through the providerProjectName "fixture/" prefix so evidence is
 * always distinguishable.
 */

export class FixtureDesignProvider implements DesignProvider {
  readonly id = "google-stitch-fixture";

  async preflight(): Promise<DesignProviderPreflight> {
    return { configured: true, provider: "google-stitch", reachable: true };
  }

  async generateDesignSystem(request: DesignGenerationRequest): Promise<DesignGenerationResult> {
    const archetypes = request.inputSnapshot.archetypes;
    const designMd = buildDesignMd({
      colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#B8422E", neutral: "#F7F5F2" },
      typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
      rationale: "Fixture design system for deterministic E2E journeys (no paid provider call).",
    });
    const designMdDigest = await sha256Of(designMd);

    const screens: DesignCandidateData["screens"] = [];
    const archetypeViews: DesignCandidateData["archetypes"] = [];
    let index = 1;
    for (const kind of archetypes) {
      const screenName = `fixture/projects/e2e/screens/${kind}-${index}`;
      screens.push({
        id: `screen-${index}`,
        providerScreenName: screenName,
        title: `Fixture ${kind}`,
        deviceType: "DESKTOP",
        archetype: kind,
        htmlDigest: await sha256Of(fixtureHtml(kind)),
        screenshotDigest: undefined,
      });
      archetypeViews.push({
        kind,
        purpose: `Fixture ${kind} archetype`,
        providerScreenNames: [screenName],
        sectionPatterns: ["hero", "evidence", "cta"],
        contentRequirements: ["Accepted copy presented verbatim"],
        assetSlots: [{ slot: "hero.primary", requirement: "Hero placeholder", placeholder: true }],
        primaryCta: "Primary action",
        secondaryCta: "",
        responsiveBehavior: "Mobile-first fixture behavior",
        trustPresentation: "Author/date/source areas visible",
      });
      index += 1;
    }

    const candidate = parseDesignCandidateData({
      schemaVersion: "design-v1",
      provider: "google-stitch",
      providerProjectName: "fixture/projects/e2e",
      designMdDigest,
      designMdToolVersion: "fixture @google/design.md 0.4.0",
      designMdLint: { errors: 0, warnings: 0, infos: 0 },
      tokens: {
        colors: {
          primary: "#1A2E35",
          secondary: "#4A5A62",
          accent: "#B8422E",
          neutral: "#F7F5F2",
          background: "#FFFFFF",
          surface: "#F7F5F2",
          textPrimary: "#1A2E35",
          textSecondary: "#4A5A62",
        },
        typography: {
          headingFont: "Source Serif 4",
          bodyFont: "Public Sans",
          scaleNotes: "fixture scale",
        },
        spacing: { sm: "8px", md: "16px", lg: "32px" },
        rounded: { sm: "4px", md: "8px" },
        ctaHierarchy: "Primary solid accent; secondary outlined",
        navigationLanguage: "Fixture navigation language",
        imageryTreatment: "Placeholders explicitly labeled",
        sectionRhythm: "Fixture rhythm",
      },
      screens,
      archetypes: archetypeViews,
      rationale: "Deterministic fixture candidate (FACTORY_DESIGN_MODE=fixture).",
      providerSessionId: "fixture-session-1",
    });

    return {
      candidate,
      rawArtifacts: [
        {
          kind: "design_md",
          bytes: new TextEncoder().encode(designMd),
          mediaType: "text/markdown",
          providerRef: null,
        },
        ...archetypes.map((kind, i) => ({
          kind: "screen_html" as const,
          bytes: new TextEncoder().encode(fixtureHtml(kind)),
          mediaType: "text/html",
          providerRef: `fixture/projects/e2e/screens/${kind}-${i + 1}`,
        })),
        {
          kind: "provider_response",
          bytes: new TextEncoder().encode(JSON.stringify({ fixture: true, project: "fixture/projects/e2e" })),
          mediaType: "application/json",
          providerRef: "fixture/projects/e2e",
        },
      ],
      providerProjectName: "fixture/projects/e2e",
      providerSessionId: "fixture-session-1",
    };
  }
}

/** Deterministic, script-free fixture HTML for sandboxed preview rendering. */
function fixtureHtml(kind: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture ${kind}</title>
<style>
  body { font-family: sans-serif; margin: 0; color: #1A2E35; background: #F7F5F2; }
  header { background: #1A2E35; color: #fff; padding: 16px; }
  main { padding: 24px; max-width: 720px; margin: 0 auto; }
  .cta { background: #B8422E; color: #fff; padding: 10px 16px; border-radius: 4px; display: inline-block; }
  .placeholder { border: 2px dashed #4A5A62; padding: 24px; text-align: center; color: #4A5A62; }
</style></head>
<body>
<header><strong>Fixture ${kind}</strong></header>
<main>
  <h1>Fixture ${kind} archetype</h1>
  <div class="placeholder">hero.primary — placeholder (Run 7 resolves)</div>
  <p>Accepted copy would be presented verbatim here.</p>
  <a class="cta" href="#">Primary action</a>
</main>
</body></html>`;
}

async function sha256Of(text: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text, "utf8").digest("hex");
}
