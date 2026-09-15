import { deterministicDigest } from "../../intelligence/digest.js";
import type { ProductionQaCheckId, ProductionQaCheckResult } from "@factory/contracts";

export type ProductionQaScope = "page" | "site" | "repository";
const PAGE_GATES: ProductionQaCheckId[] = [
  "content.accepted_authority", "content.sections_complete", "content.sections_unique", "content.section_order", "content.h1_intent", "content.cta_intent", "content.factual_copy", "content.no_placeholder_copy", "content.no_truncation",
  "html.main_landmark", "html.h1_count", "html.heading_hierarchy", "html.landmarks", "html.crawlable_links", "html.valid_structure", "html.no_duplicate_ids", "html.metadata_valid",
  "seo.title_present", "seo.description_present", "seo.canonical", "seo.breadcrumb", "seo.structured_data", "seo.structured_data_urls", "seo.internal_links", "seo.images",
  "images.accepted_authority", "images.dimensions", "images.alt_authority", "images.lcp_priority", "accessibility.axe", "accessibility.keyboard", "links.internal_resolvable", "links.external", "performance.resource_budget", "performance.js_budget",
];
const SITE_GATES: ProductionQaCheckId[] = ["content.no_duplicate_pages", "seo.title_unique", "seo.description_unique", "seo.robots", "seo.sitemap", "links.canonical_destination", "performance.lighthouse", "security.public_output"];
const REPOSITORY_GATES: ProductionQaCheckId[] = ["security.gitleaks", "security.osv"];

export const TRUSTED_PRODUCTION_QA_GATES = Object.freeze([
  { checkId: "accessibility.axe" as const, scope: "page" as const },
  { checkId: "accessibility.keyboard" as const, scope: "page" as const },
  { checkId: "performance.lighthouse" as const, scope: "site" as const },
  { checkId: "security.gitleaks" as const, scope: "repository" as const },
  { checkId: "security.osv" as const, scope: "repository" as const },
]);

export const REQUIRED_PRODUCTION_QA_GATES = Object.freeze([
  ...PAGE_GATES.map((checkId) => ({ checkId, scope: "page" as const, blocking: true as const })),
  ...SITE_GATES.map((checkId) => ({ checkId, scope: "site" as const, blocking: true as const })),
  ...REPOSITORY_GATES.map((checkId) => ({ checkId, scope: "repository" as const, blocking: true as const })),
]);

export function bindQaCheck(result: ProductionQaCheckResult, input: { scope: ProductionQaScope; subject: string; tool: string; toolVersion: string }): ProductionQaCheckResult {
  const material = { checkId: result.checkId, group: result.group, verdict: result.verdict, detail: result.detail, evidence: result.evidence, ...input };
  return { ...result, ...input, executionDigest: deterministicDigest(material) };
}

export function hasValidQaExecutionDigest(result: ProductionQaCheckResult): result is ProductionQaCheckResult & Required<Pick<ProductionQaCheckResult, "scope" | "subject" | "tool" | "toolVersion" | "executionDigest">> {
  if (!result.scope || !result.subject || !result.tool || !result.toolVersion || !result.executionDigest) return false;
  const { executionDigest, ...material } = result;
  return executionDigest === deterministicDigest(material);
}

export function assertCompleteProductionQa(input: { checks: ProductionQaCheckResult[]; pageRoutes: string[]; manifestSetDigest: string; repositorySha: string }) {
  const missing: string[] = [];
  for (const gate of REQUIRED_PRODUCTION_QA_GATES) {
    const subjects = gate.scope === "page" ? input.pageRoutes : [gate.scope === "site" ? input.manifestSetDigest : input.repositorySha];
    for (const subject of subjects) {
      const matches = input.checks.filter((check) => check.checkId === gate.checkId && check.scope === gate.scope && check.subject === subject);
      if (matches.length !== 1 || !matches[0]?.executionDigest || !matches[0]?.tool || !matches[0]?.toolVersion) missing.push(`${gate.checkId}@${subject}`);
    }
  }
  return { complete: missing.length === 0, missing };
}
