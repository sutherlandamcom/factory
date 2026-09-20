import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ProductionQaCheckResult } from "./types.js";
import type { ProductionRenderManifest } from "../render-manifest.js";
import { bindQaCheck } from "./registry.js";

/**
 * DESIGN-DRIFT QA — Pre-Run-12 hardening.
 *
 * Deterministic checks that the governed production implementation layer
 * faithfully implements the accepted design authority through the derived
 * DesignImplementationContract. Severity model (design policy §29):
 *
 * BLOCKING (FAIL): unknown token/component/variant, ambiguous composition,
 * unauthorized color/font literal in governed production source, project
 * fixture leakage, authority mismatch, unbound asset, silent visual
 * fallback (modulo cycling / fallback defaults).
 *
 * REVIEW (REVIEW): explicitly justified one-off (allowlisted), reviewed
 * arbitrary value where policy permits.
 *
 * INFO (PASS with informational detail): component reuse counts, variant
 * reuse, archetype coverage.
 */

export interface DesignDriftInput {
  manifests: ProductionRenderManifest[];
  /** Absolute path to sites/starter/src (governed production source). */
  starterSrcDir: string;
  /** Exact manifest set digest (site-scope QA subject binding). */
  manifestSetDigest: string;
}

/** Patterns that indicate design invention in governed production source. */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = Object.freeze([
  { pattern: /bg-\[#[0-9a-fA-F]{3,8}\]/, label: "arbitrary hex background class" },
  { pattern: /text-\[#[0-9a-fA-F]{3,8}\]/, label: "arbitrary hex text class" },
  { pattern: /border-\[#[0-9a-fA-F]{3,8}\]/, label: "arbitrary hex border class" },
  { pattern: /bodyPrimitives\s*\[\s*index\s*%\s*/, label: "modulo primitive cycling" },
  { pattern: /\|\|\s*["']#/, label: "silent color fallback" },
  { pattern: /\|\|\s*["'][0-9.]+(rem|px)["']/, label: "silent spacing fallback" },
  { pattern: /bodyPrimitives\[index % bodyPrimitives\.length\]/, label: "modulo primitive assignment" },
]);

/** Governed production files that must stay free of design invention. */
const GOVERNED_FILES = [
  "components/production/ProductionPageRenderer.astro",
  "components/production/PageHero.astro",
  "components/production/ContentSection.astro",
  "components/production/PageConclusion.astro",
  "components/production/PageCta.astro",
  "components/production/RelatedLinks.astro",
  "layouts/ProductionLayout.astro",
];

/** Registry families (must stay in sync with the DIC compiler registry). */
const REGISTERED_COMPONENTS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  "page-hero": ["split", "stacked"],
  "content-section": ["plain", "evidence", "structured"],
  "page-conclusion": ["surface"],
  "page-cta": ["text"],
  "related-links": ["list"],
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function runDesignDriftQa(input: DesignDriftInput): Promise<ProductionQaCheckResult[]> {
  const checks: ProductionQaCheckResult[] = [];

  // 1. Registry integrity: registered families must exist as implementations.
  const missingImplementations: string[] = [];
  for (const componentId of Object.keys(REGISTERED_COMPONENTS)) {
    const pascal = componentId.replace(/(^|-)([a-z])/g, (_, sep: string, char: string) => char.toUpperCase());
    const filePath = path.join(input.starterSrcDir, "components", "production", `${pascal}.astro`);
    if (!(await fileExists(filePath))) missingImplementations.push(componentId);
  }
  checks.push(bindQaCheck(
    {
      checkId: "design.registry_integrity",
      group: "design",
      verdict: missingImplementations.length === 0 ? "PASS" : "FAIL",
      detail: missingImplementations.length === 0
        ? `All ${Object.keys(REGISTERED_COMPONENTS).length} registered component families have governed implementations.`
        : `Registered families without implementations: ${missingImplementations.join(", ")}.`,
      evidence: missingImplementations.map((componentId) => ({ kind: "check" as const, ref: componentId })),
    },
    { scope: "site", subject: input.manifestSetDigest, tool: "factory-design-drift", toolVersion: "pre-run12-v1" },
  ));

  // 2. Governed-source drift scan: forbidden invention patterns.
  const driftFindings: string[] = [];
  for (const relative of GOVERNED_FILES) {
    const filePath = path.join(input.starterSrcDir, relative);
    if (!(await fileExists(filePath))) {
      driftFindings.push(`${relative}: missing governed implementation`);
      continue;
    }
    const source = await readFile(filePath, "utf8");
    for (const { pattern, label } of FORBIDDEN_PATTERNS) {
      if (pattern.test(source)) driftFindings.push(`${relative}: ${label}`);
    }
  }
  checks.push(bindQaCheck(
    {
      checkId: "design.drift_source_scan",
      group: "design",
      verdict: driftFindings.length === 0 ? "PASS" : "FAIL",
      detail: driftFindings.length === 0
        ? `No design-invention patterns in ${GOVERNED_FILES.length} governed production files.`
        : `Design invention detected: ${driftFindings.join("; ")}.`,
      evidence: driftFindings.map((finding) => ({ kind: "check" as const, ref: finding })),
    },
    { scope: "site", subject: input.manifestSetDigest, tool: "factory-design-drift", toolVersion: "pre-run12-v1" },
  ));

  // 3. Token governance + composition validity per manifest (v3 only).
  const tokenFailures: string[] = [];
  const compositionFailures: string[] = [];
  const componentUsage = new Map<string, number>();
  for (const manifest of input.manifests) {
    if (manifest.schemaVersion !== "production-v3") continue;
    const tokens = new Set((manifest.design.semanticTokens ?? []).map((token) => token.role));
    for (const entry of manifest.design.composition ?? []) {
      const variants = REGISTERED_COMPONENTS[entry.componentId];
      if (!variants) {
        compositionFailures.push(`${manifest.input.route}: unknown component ${entry.componentId}`);
        continue;
      }
      if (!variants.includes(entry.variant)) {
        compositionFailures.push(`${manifest.input.route}: unknown variant ${entry.componentId}/${entry.variant}`);
        continue;
      }
      componentUsage.set(entry.componentId, (componentUsage.get(entry.componentId) ?? 0) + 1);
    }
    // Every manifest font delivery family must be non-empty and explicitly
    // resolved (no silent browser fallback).
    for (const font of manifest.design.fontDelivery ?? []) {
      if (!font.family || font.family.trim() === "") {
        tokenFailures.push(`${manifest.input.route}: unresolved font delivery for ${font.sourceToken}`);
      }
    }
    if ((manifest.design.semanticTokens ?? []).length === 0) {
      tokenFailures.push(`${manifest.input.route}: no semantic tokens projected`);
    }
  }
  checks.push(bindQaCheck(
    {
      checkId: "design.token_governance",
      group: "design",
      verdict: tokenFailures.length === 0 ? "PASS" : "FAIL",
      detail: tokenFailures.length === 0
        ? "All v3 manifests carry complete governed semantic token projections and resolved font delivery."
        : `Token governance failures: ${tokenFailures.join("; ")}.`,
      evidence: tokenFailures.map((finding) => ({ kind: "check" as const, ref: finding })),
    },
    { scope: "site", subject: input.manifestSetDigest, tool: "factory-design-drift", toolVersion: "pre-run12-v1" },
  ));
  checks.push(bindQaCheck(
    {
      checkId: "design.composition_valid",
      group: "design",
      verdict: compositionFailures.length === 0 ? "PASS" : "FAIL",
      detail: compositionFailures.length === 0
        ? `All v3 manifest compositions reference registered components/variants (${[...componentUsage.entries()].map(([id, count]) => `${id}x${count}`).join(", ") || "none"}).`
        : `Composition failures: ${compositionFailures.join("; ")}.`,
      evidence: compositionFailures.map((finding) => ({ kind: "check" as const, ref: finding })),
    },
    { scope: "site", subject: input.manifestSetDigest, tool: "factory-design-drift", toolVersion: "pre-run12-v1" },
  ));

  return checks;
}

/** Count governed production component files (reuse-evidence helper). */
export async function countGovernedComponentImplementations(starterSrcDir: string): Promise<number> {
  const dir = path.join(starterSrcDir, "components", "production");
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith(".astro") && name !== "ProductionPageRenderer.astro").length;
  } catch {
    return 0;
  }
}
