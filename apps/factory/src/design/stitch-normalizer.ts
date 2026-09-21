import { createHash } from "node:crypto";
import { parse } from "node-html-parser";
import type { ArchetypeGrammar, DesignArchetypeKind, DesignGenerationRequest } from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { patternToBinding, responsiveProfileFor } from "./archetype-grammar.js";

export interface RawStitchProviderPackage {
  screenName: string;
  html: Uint8Array;
  screenshotDigest?: string;
}

const invalid = (message: string): never => {
  throw new FactoryError("design_provider_output_invalid", `Stitch normalization: ${message}`);
};

/**
 * Provider-produced semantic DOM protocol. These attributes are requested in
 * the generation prompt and read ONLY from the returned HTML bytes. They are
 * not a claimed native Stitch MCP API. Unannotated output fails closed.
 * Factory maps declared semantics to reviewed capabilities; it never infers
 * section meaning from position, headings, screenshots or its prompt template.
 */
export function normalizeStitchDesign(
  evidence: RawStitchProviderPackage,
  archetype: DesignArchetypeKind,
  page: NonNullable<DesignGenerationRequest["acceptedCopyByArchetype"]["homepage"]>,
): ArchetypeGrammar {
  const dom = parse(new TextDecoder().decode(evidence.html));
  const mains = dom.querySelectorAll("main");
  if (mains.length !== 1) invalid("expected exactly one main composition landmark");
  const main = mains[0]!;
  if (main.getAttribute("data-factory-design") !== "stitch-dom-v1") invalid("missing supported semantic DOM protocol");
  if (main.childNodes.some(node => node.nodeType === 3 && node.textContent.trim())) invalid("unbound content outside composition");
  if (!main.children.length) invalid("empty composition");
  let nextSection = 0;
  const bindings = main.children.map(node => {
    const pattern = node.getAttribute("data-factory-pattern");
    if (!pattern) return invalid(`unbound provider component ${node.tagName}`);
    const base = patternToBinding(archetype, pattern);
    const componentId = node.getAttribute("data-factory-component");
    const variant = node.getAttribute("data-factory-variant");
    if (componentId !== base.componentId || !variant) return invalid(`unsupported component ${componentId}/${variant}`);
    const responsiveProfile = responsiveProfileFor(componentId, variant);
    if (node.getAttribute("data-factory-responsive") !== responsiveProfile) invalid(`unsupported responsive layout for ${componentId}/${variant}`);
    if (node.querySelector("[data-factory-component]")) invalid("nested composition components are unsupported");
    if (node.querySelector("iframe,canvas,video,script,form,button")) invalid("interactive/custom component requires Component API Review");
    const visualRole = node.getAttribute("data-factory-visual-role");
    if (visualRole && (componentId !== "page-hero" || visualRole !== "hero-primary")) invalid(`unsupported visual-role placement ${visualRole}/${componentId}`);
    if (node.querySelector("img") && visualRole !== "hero-primary") invalid("unbound visual in provider composition");
    const binding = { ...base, variant, responsiveProfile, ...(visualRole ? { visualRole: "hero-primary" as const } : {}) };
    if (base.repetition === "per_section") {
      if (node.getAttribute("data-factory-section-index") !== String(nextSection)) invalid("section binding missing, duplicated or out of accepted order");
      const section = page.sections[nextSection];
      if (!section) return invalid("provider binds a nonexistent accepted section");
      const headings = node.querySelectorAll("h2");
      if (headings.length !== 1 || headings[0]!.textContent.trim() !== section.heading.trim()) invalid("section heading differs from its explicit accepted identity");
      return { ...binding, sectionIndex: nextSection++ };
    }
    if (node.hasAttribute("data-factory-section-index")) invalid("non-body component claims a section index");
    return binding;
  });
  if (nextSection !== page.sections.length) invalid("provider omitted accepted sections");
  for (const id of ["page-hero", "page-conclusion", "page-cta"]) {
    if (bindings.filter(binding => binding.componentId === id).length !== 1) invalid(`expected exactly one ${id}`);
  }
  if (bindings[0]?.componentId !== "page-hero" || bindings.at(-1)?.componentId !== "page-cta") invalid("unsupported hero/CTA ordering");
  if (dom.querySelectorAll("h1").length !== 1) invalid("expected exactly one provider H1");
  return {
    archetype,
    bindings,
    providerEvidence: {
      normalizerVersion: "stitch-dom-v1",
      screens: [{
        screenName: evidence.screenName,
        htmlDigest: createHash("sha256").update(evidence.html).digest("hex"),
        ...(evidence.screenshotDigest ? { screenshotDigest: evidence.screenshotDigest } : {}),
      }],
    },
  };
}

export const STITCH_SEMANTIC_DOM_INSTRUCTIONS = `
Return your chosen design semantics in the generated HTML, using this bounded protocol.
The single main element must have data-factory-design="stitch-dom-v1".
Its direct children are the ordered composition. Annotate every child with:
data-factory-component, data-factory-variant, data-factory-pattern, data-factory-responsive.
Approved capabilities: page-hero split (split-at-md) or stacked (stack);
content-section plain/evidence (readable) or structured (split-at-md);
page-conclusion surface (readable); page-cta text (readable); related-links list (stack).
Body sections must carry data-factory-section-index equal to the exact zero-based accepted copy section identity.
Preserve accepted section order and include each exactly once. Choose each section's semantic pattern explicitly.
Use only patterns in the supplied archetype vocabulary. Do not add custom/interactive components.
Place hero imagery only inside page-hero and annotate data-factory-visual-role="hero-primary".
Include exactly one opening hero, closing conclusion and final CTA, and exactly one h1.
The annotations describe YOUR returned design, not a copy of a requested template. Desktop/mobile must express the same semantic composition and bounded responsive profiles.
Factory will reject missing, unsupported or conflicting semantics rather than approximate your design.
`;
