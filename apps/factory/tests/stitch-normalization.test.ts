import assert from "node:assert/strict";
import test from "node:test";
import { parseDesignInputSnapshotAnyVersion, type DesignInputSnapshotDataV2, type DesignCandidateDataV2 } from "@factory/contracts";
import { normalizeStitchDesign } from "../src/design/stitch-normalizer.js";
import { providerHtml } from "./fixtures/stitch-evidence.js";
import { FixtureDesignProvider } from "../src/design/fixture-provider.js";
import { deterministicDigest } from "../src/intelligence/digest.js";
import { deriveDesignImplementationContract } from "../src/production/design-implementation.js";
import { deriveManifestComposition } from "../src/production/render-manifest.js";

const page = { slug: "offer-x92", title: "Advisory", introduction: "Introduction", sections: [
  { heading: "Overview", body: "Overview copy" }, { heading: "Process", body: "Process copy" }, { heading: "Evidence", body: "Evidence copy" },
], conclusion: "Conclusion", cta: "Contact" };
const a = [{ pattern: "service-overview", variant: "plain" }, { pattern: "process", variant: "structured" }, { pattern: "evidence", variant: "evidence" }];
const b = [{ pattern: "service-overview", variant: "plain" }, { pattern: "evidence", variant: "evidence" }, { pattern: "faq", variant: "structured" }];
const normalize = (html: string) => normalizeStitchDesign({ screenName: "projects/test/screens/service", html: new TextEncoder().encode(html) }, "service", page);

test("same Factory inputs, different provider HTML -> different normalized semantics and exact evidence lineage", () => {
  const htmlA = providerHtml("service", page, a);
  const htmlB = providerHtml("service", page, b);
  const first = normalize(htmlA);
  assert.deepEqual(normalize(htmlA), first);
  assert.notDeepEqual(first.bindings, normalize(htmlB).bindings);
  assert.notEqual(deterministicDigest(first), deterministicDigest(normalize(htmlB)));
  const evidenceOnly = normalize(htmlA + "<!-- provider revision -->");
  assert.deepEqual(evidenceOnly.bindings, first.bindings);
  assert.notEqual(deterministicDigest(evidenceOnly), deterministicDigest(first));
  assert.deepEqual(first.bindings.filter(binding => binding.repetition === "per_section").map(binding => [binding.sectionIndex, binding.pattern, binding.componentId, binding.variant]), [
    [0, "service-overview", "content-section", "plain"], [1, "process", "content-section", "structured"], [2, "evidence", "content-section", "evidence"],
  ]);
});

test("unsupported provider output and missing/duplicate section identities fail closed", () => {
  const html = providerHtml("service", page, a);
  for (const bad of [
    html.replace('data-factory-component="content-section"', 'data-factory-component="carousel"'),
    html.replace('data-factory-variant="split"', 'data-factory-variant="overlapping-masonry"'),
    html.replace('data-factory-section-index="1"', 'data-factory-section-index="0"'),
    html.replace('data-factory-section-index="1"', ''),
    html.replace('data-factory-responsive="split-at-md"', 'data-factory-responsive="mobile-carousel"'),
    html.replace('data-factory-visual-role="hero-primary"', 'data-factory-visual-role="floating-overlay"'),
    html.replace('data-factory-pattern="process"', 'data-factory-pattern="unbounded-carousel"'),
  ]) assert.throws(() => normalize(bad), (error: unknown) => (error as { code: string }).code === "design_provider_output_invalid");
});

test("provider HTML copy alterations and unbound claims fail closed", () => {
  const html = providerHtml("service", page, a);
  // rewrite title -> FAIL
  assert.throws(
    () => normalize(html.replace(`<h1>${page.title}</h1>`, `<h1>Rewritten Title</h1>`)),
    (err: any) => err.code === "design_provider_output_invalid",
  );
  // shorten introduction -> FAIL
  assert.throws(
    () => normalize(html.replace(`<p>${page.introduction}</p>`, `<p>Intro</p>`)),
    (err: any) => err.code === "design_provider_output_invalid",
  );
  // change section heading -> FAIL
  assert.throws(
    () => normalize(html.replace(`<h2>${page.sections[0]!.heading}</h2>`, `<h2>Altered Heading</h2>`)),
    (err: any) => err.code === "design_provider_output_invalid",
  );
  // rewrite section body -> FAIL
  assert.throws(
    () => normalize(html.replace(`<p>${page.sections[0]!.body}</p>`, `<p>Altered section body copy.</p>`)),
    (err: any) => err.code === "design_provider_output_invalid",
  );
  // drop paragraph -> FAIL
  assert.throws(
    () => normalize(html.replace(`<p>${page.sections[0]!.body}</p>`, ``)),
    (err: any) => err.code === "design_provider_output_invalid",
  );
  // change conclusion -> FAIL
  assert.throws(
    () => normalize(html.replace(page.conclusion, "Altered conclusion text")),
    (err: any) => err.code === "design_provider_output_invalid",
  );
  // change CTA -> FAIL
  assert.throws(
    () => normalize(html.replace(page.cta, "Altered CTA text")),
    (err: any) => err.code === "design_provider_output_invalid",
  );
  // append unbound marketing claim -> FAIL
  assert.throws(
    () => normalize(html.replace(`<p>${page.sections[0]!.body}</p>`, `<p>${page.sections[0]!.body}</p><p>Industry-leading guaranteed returns</p>`)),
    (err: any) => err.code === "design_provider_output_invalid",
  );
  // append unbound marketing claim in hero -> FAIL
  assert.throws(
    () => normalize(html.replace(`<p>${page.introduction}</p>`, `<p>${page.introduction}</p><span>Industry-leading guaranteed returns</span>`)),
    (err: any) => err.code === "design_provider_output_invalid",
  );
});

async function design(): Promise<DesignCandidateDataV2> {
  const input = parseDesignInputSnapshotAnyVersion({
    schemaVersion: "design-v2", acceptedInputSnapshotId: "pis-test", acceptedInputSnapshotVersion: 1, acceptedInputDigest: "a".repeat(64),
    brand: { facts: [], positioning: "Advisory", tone: "Clear", visualIdentityNotes: "" }, audience: { segments: [], needs: [], decisionContext: "" },
    references: { referenceUrls: [], antiReferenceUrls: [], learn: [], avoid: [], preferredPerception: "" }, uxRequirements: [], contentRefs: [], assetRefs: [],
    archetypes: ["service"], representativePages: [{ archetype: "service", slug: page.slug, contentDigest: "b".repeat(64) }],
    pageArchetypeBindings: [{ archetype: "service", slug: page.slug, contentDigest: "b".repeat(64), pageArchetypeAuthority: { id: "paa-00000000-0000-4000-8000-000000000001", version: 1, digest: "b".repeat(64), pageIdentity: page.slug, archetype: "service" } }], pageArchetypeBindingPolicy: "page-archetype-policy-v1",
  }) as DesignInputSnapshotDataV2;
  const result = await new FixtureDesignProvider().generateDesignSystem({ inputSnapshot: input, inputSnapshotId: "dsi-test", projectId: "proj-test", acceptedCopyByArchetype: { service: page }, designSeed: {
    colors: { primary: "#1A2E35", secondary: "#4A5A62", accent: "#B8422E", neutral: "#F7F5F2" }, typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans", scaleNotes: "" }, rationale: "Fixture seed",
  } });
  return result.candidate as DesignCandidateDataV2;
}

test("DIC and manifest composition project three exact bindings; mutations change digests and gaps never cycle", async () => {
  const candidate = await design();
  candidate.archetypeGrammar = [normalize(providerHtml("service", page, a))];
  const dic = (value: DesignCandidateDataV2) => deriveDesignImplementationContract({ design: value, acceptedDesign: { id: "dsac-test", version: 1, digest: deterministicDigest(value) }, rendererPolicyVersion: "production-policy-v3" });
  const content = { ...page, acceptedId: "wacc-test", acceptedVersion: 1, acceptedDigest: "b".repeat(64), metaDescription: "Description", internalLinks: [] };
  const first = dic(candidate);
  const composition = deriveManifestComposition(first, content, [], "service");
  assert.deepEqual(composition.filter(entry => entry.repetition === "per_section").map(entry => entry.sectionIndex), [0, 1, 2]);
  const changed = structuredClone(candidate);
  changed.archetypeGrammar = [normalize(providerHtml("service", page, b))];
  assert.notEqual(first.implementationContractDigest, dic(changed).implementationContractDigest);
  assert.notEqual(deterministicDigest(composition), deterministicDigest(deriveManifestComposition(dic(changed), content, [], "service")));
  for (const indices of [[0, 1], [0, 0, 2], [0, 2, 1]]) {
    const bad = structuredClone(first);
    bad.archetypeGrammar[0]!.bindings = indices.map(sectionIndex => ({ ...first.archetypeGrammar[0]!.bindings[1]!, sectionIndex }));
    assert.throws(() => deriveManifestComposition(bad, content, [], "service"), /exactly once/);
  }
  const unsupported = structuredClone(candidate);
  unsupported.archetypeGrammar[0]!.bindings[1]!.componentId = "carousel";
  assert.throws(() => dic(unsupported), /unregistered component/);
});
