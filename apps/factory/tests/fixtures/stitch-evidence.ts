import type { DesignArchetypeKind, DesignGenerationRequest } from "@factory/contracts";
import { StitchDesignProvider } from "../../src/design/stitch-provider.js";

type Copy = NonNullable<DesignGenerationRequest["acceptedCopyByArchetype"]["homepage"]>;
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

/** Mock provider output choices, deliberately independent of archetypeFor(). */
export function providerHtml(kind: DesignArchetypeKind, page: Copy, choices?: Array<{ pattern: string; variant: string }>): string {
  const intro = { homepage: "value-statement", service: "service-overview", location: "location-intro", editorial: "article-body", investment_advisory: "approach" }[kind];
  const heroPattern = kind === "homepage" ? "hero" : kind === "editorial" ? "article-header" : "page-header";
  const heroVariant = kind === "editorial" || kind === "investment_advisory" ? "stacked" : "split";
  const block = (component: string, variant: string, pattern: string, body: string, extra = "") => {
    const profile = variant === "split" || variant === "structured" ? "split-at-md" : variant === "stacked" || component === "related-links" ? "stack" : "readable";
    return `<section data-factory-component="${component}" data-factory-variant="${variant}" data-factory-pattern="${pattern}" data-factory-responsive="${profile}" ${extra}>${body}</section>`;
  };
  return `<!doctype html><html><body><main data-factory-design="stitch-dom-v1">${
    block("page-hero", heroVariant, heroPattern, `<h1>${escape(page.title)}</h1><p>${escape(page.introduction)}</p>`, 'data-factory-visual-role="hero-primary"')
  }${page.sections.map((section, index) => {
    const choice = choices?.[index] ?? { pattern: intro, variant: "plain" };
    return block("content-section", choice.variant, choice.pattern, `<h2>${escape(section.heading)}</h2><p>${escape(section.body)}</p>`, `data-factory-section-index="${index}"`);
  }).join("")}${block("page-conclusion", "surface", "conclusion", escape(page.conclusion))}${block("page-cta", "text", "cta", escape(page.cta))}</main></body></html>`;
}

/** Only artifact transport is mocked; normalization and the MCP provider path are real. */
export class EvidenceStitchProvider extends StitchDesignProvider {
  private request?: DesignGenerationRequest;
  override async generateDesignSystem(request: DesignGenerationRequest) {
    this.request = request;
    return super.generateDesignSystem(request);
  }
  protected override async downloadArtifact(url: string): Promise<Uint8Array> {
    const name = new URL(url).pathname.split("/").at(-1)!;
    const kind: DesignArchetypeKind = name.startsWith("home") ? "homepage" : name as DesignArchetypeKind;
    const page = this.request?.acceptedCopyByArchetype[kind];
    if (!page) throw new Error(`Missing mock provider copy ${kind}`);
    return new TextEncoder().encode(providerHtml(kind, page));
  }
}
