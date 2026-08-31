import {
  normalizeScalarText,
  parseSiteIntelligencePlan,
  type NormalizedResearchEvidenceBundle,
  type SiteIntelligencePlan,
  type SiteIntelligenceRequest,
} from "@factory/contracts";

/**
 * Deterministic semantic quality gates for a structurally valid
 * SiteIntelligencePlan. These gates are the authority boundary between the
 * model and the compiler: a plan that fails any gate never becomes tasks.
 */

export interface PlanValidationInput {
  request: SiteIntelligenceRequest;
  research: NormalizedResearchEvidenceBundle;
}

export type PlanValidationResult =
  | { ok: true; plan: SiteIntelligencePlan }
  | { ok: false; issues: string[] };

const MAX_VALIDATION_ISSUES = 30;
const MAX_ISSUE_LENGTH = 300;
const MIN_RATIONALE_LENGTH = 20;

/** Deterministic normalized containment either way (documented v0 semantics). */
function normalizedTopicsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeScalarText(left);
  const normalizedRight = normalizeScalarText(right);
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) return false;
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

/** Service topics must relate to service inputs via containment either way. */
function topicRelatesToServiceInputs(
  topic: string,
  serviceSeeds: readonly string[],
  mustCoverServices: readonly string[],
): boolean {
  return [...serviceSeeds, ...mustCoverServices].some((candidate) =>
    normalizedTopicsOverlap(topic, candidate),
  );
}

function topicTokens(normalizedTopic: string): string[] {
  return normalizedTopic
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
}

/** A topic is supported by free text when the text contains the topic or every significant topic token. */
function topicSupportedByText(topic: string, texts: readonly (string | undefined)[]): boolean {
  const normalizedTopic = normalizeScalarText(topic);
  if (normalizedTopic.length === 0) return false;
  const normalizedTexts = texts
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .map((text) => normalizeScalarText(text));
  if (normalizedTexts.length === 0) return false;
  if (normalizedTexts.some((text) => text.includes(normalizedTopic))) return true;
  const tokens = topicTokens(normalizedTopic);
  if (tokens.length === 0) return false;
  return normalizedTexts.some((text) => tokens.every((token) => text.includes(token)));
}

export function validateSiteIntelligencePlan(
  rawPlan: unknown,
  input: PlanValidationInput,
): PlanValidationResult {
  const issues: string[] = [];
  const addIssue = (message: string): void => {
    if (issues.length < MAX_VALIDATION_ISSUES) {
      issues.push(message.slice(0, MAX_ISSUE_LENGTH));
    }
  };

  let plan: SiteIntelligencePlan;
  try {
    plan = parseSiteIntelligencePlan(rawPlan);
  } catch (error) {
    if (error instanceof Error && "issues" in error) {
      const zodIssues = (error as { issues?: { path?: (string | number)[]; message?: string }[] }).issues ?? [];
      for (const zodIssue of zodIssues.slice(0, MAX_VALIDATION_ISSUES)) {
        const path = (zodIssue.path ?? []).join(".");
        addIssue(`schema violation at ${path || "(root)"}: ${zodIssue.message ?? "invalid"}`);
      }
      if (zodIssues.length === 0) addIssue(`schema violation: ${error.message}`);
    } else {
      addIssue(`schema violation: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ok: false, issues };
  }

  const { request, research } = input;

  // --- Identity ---
  if (plan.siteId !== request.siteId) {
    addIssue(`plan.siteId "${plan.siteId}" must equal request siteId "${request.siteId}"`);
  }

  // --- Evidence / fact indexes ---
  const evidenceById = new Map(research.items.map((item) => [item.id, item]));
  const factIds = new Set((request.business.operatorFacts ?? []).map((fact) => fact.id));

  const checkEvidenceRefs = (refs: readonly string[] | undefined, where: string): void => {
    for (const id of refs ?? []) {
      if (!evidenceById.has(id)) addIssue(`${where}: unknown evidence id "${id}"`);
    }
  };
  const checkFactRefs = (refs: readonly string[] | undefined, where: string): void => {
    for (const id of refs ?? []) {
      if (!factIds.has(id)) addIssue(`${where}: unknown operator fact id "${id}"`);
    }
  };

  for (const audience of plan.audiences) {
    checkEvidenceRefs(audience.evidenceIds, `audience "${audience.name}"`);
  }
  for (const insight of plan.competitorInsights) {
    checkEvidenceRefs(insight.evidenceIds, `competitorInsight "${insight.id}"`);
  }
  for (const cluster of plan.keywordClusters) {
    checkEvidenceRefs(cluster.evidenceIds, `keywordCluster "${cluster.id}"`);
  }

  // --- Page budget ---
  if (plan.pages.length > request.planning.maxInitialPages) {
    addIssue(
      `page count ${plan.pages.length} exceeds request planning.maxInitialPages ${request.planning.maxInitialPages}`,
    );
  }

  // --- Homepage ---
  const homepages = plan.pages.filter((page) => page.type === "homepage");
  if (homepages.length !== 1) {
    addIssue(`plan must contain exactly one homepage (found ${homepages.length})`);
  }

  // --- Per-page checks ---
  const slugs = new Set<string>();
  const topicsBySlug = new Map<string, string>();
  const servicePages = plan.pages.filter((page) => page.type === "service");
  const articlePages = plan.pages.filter((page) => page.type === "article");

  for (const page of plan.pages) {
    const where = `page "${page.slug}"`;
    if (slugs.has(page.slug)) addIssue(`duplicate page slug "${page.slug}"`);
    slugs.add(page.slug);

    checkEvidenceRefs(page.evidenceIds, where);
    checkFactRefs(page.operatorFactIds, where);

    if ((page.evidenceIds.length ?? 0) === 0 && (page.operatorFactIds?.length ?? 0) === 0) {
      addIssue(`${where}: no provenance — at least one evidenceId or operatorFactId is required`);
    }

    if (page.rationale.trim().length < MIN_RATIONALE_LENGTH) {
      addIssue(`${where}: rationale must be a meaningful explanation of at least ${MIN_RATIONALE_LENGTH} characters`);
    }

    const normalizedTopic = normalizeScalarText(page.primaryTopic);
    const existingTopic = [...topicsBySlug.values()].find(
      (topic) => normalizeScalarText(topic) === normalizedTopic,
    );
    if (existingTopic !== undefined) {
      addIssue(
        `page "${page.slug}" duplicates primary topic "${existingTopic}" already used by another launch page`,
      );
    }
    topicsBySlug.set(page.slug, page.primaryTopic);
  }

  // --- Operator constraints: excludedTopics are deterministically enforced ---
  const excludedTopics = request.planning.excludedTopics ?? [];
  for (const page of plan.pages) {
    for (const excluded of excludedTopics) {
      if (normalizedTopicsOverlap(page.primaryTopic, excluded)) {
        addIssue(
          `page "${page.slug}" primary topic "${page.primaryTopic}" represents operator-excluded topic "${excluded}"`,
        );
      }
    }
  }
  for (const cluster of plan.keywordClusters) {
    for (const excluded of excludedTopics) {
      if (normalizedTopicsOverlap(cluster.primaryTopic, excluded)) {
        addIssue(
          `keywordCluster "${cluster.id}" primary topic "${cluster.primaryTopic}" represents operator-excluded topic "${excluded}"`,
        );
      }
    }
  }

  // --- Service coverage ---
  const serviceSeeds = request.business.serviceSeeds;
  const mustCoverServices = request.planning.mustCoverServices ?? [];
  if (serviceSeeds.length > 0 && servicePages.length === 0) {
    addIssue("request has serviceSeeds but the plan contains no service page");
  }
  for (const mustCover of mustCoverServices) {
    const covered = servicePages.some((page) => normalizedTopicsOverlap(page.primaryTopic, mustCover));
    if (!covered) {
      addIssue(`mustCoverServices value "${mustCover}" is not represented by any service page primary topic`);
    }
  }

  // --- Service topic support ---
  // Support may come ONLY from (A) serviceSeeds, (B) mustCoverServices,
  // (C) evidence records explicitly cited by THIS page.evidenceIds, or
  // (D) operator facts explicitly cited by THIS page.operatorFactIds.
  // Request-wide operator facts never support an unciting page.
  const factsById = new Map((request.business.operatorFacts ?? []).map((fact) => [fact.id, fact]));
  for (const page of servicePages) {
    if (topicRelatesToServiceInputs(page.primaryTopic, serviceSeeds, mustCoverServices)) continue;
    const referencedEvidence = page.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is NonNullable<typeof item> => item !== undefined);
    const evidenceTexts = referencedEvidence.flatMap((item) => [item.query, item.title, item.text]);
    if (topicSupportedByText(page.primaryTopic, evidenceTexts)) continue;
    const citedFactTexts = (page.operatorFactIds ?? []).flatMap((id) => {
      const fact = factsById.get(id);
      return fact === undefined ? [] : [fact.text];
    });
    if (topicSupportedByText(page.primaryTopic, citedFactTexts)) continue;
    addIssue(
      `service page "${page.slug}" primary topic "${page.primaryTopic}" is unsupported by serviceSeeds, mustCoverServices, cited operator facts, or referenced evidence`,
    );
  }

  // --- Article / service separation (distinctness is enforced globally; intent separation here) ---
  for (const article of articlePages) {
    const normalizedArticleTopic = normalizeScalarText(article.primaryTopic);
    const collidingService = servicePages.find(
      (page) => normalizeScalarText(page.primaryTopic) === normalizedArticleTopic,
    );
    if (collidingService !== undefined) {
      addIssue(
        `article page "${article.slug}" duplicates the service page "${collidingService.slug}" primary topic`,
      );
    }
  }

  // --- Fabricated metrics in clusters ---
  for (const cluster of plan.keywordClusters) {
    if (cluster.metrics === undefined) continue;
    for (const [metricKey, metricValue] of Object.entries(cluster.metrics)) {
      if (metricValue === undefined) continue;
      const observed = cluster.evidenceIds.some((id) => {
        const item = evidenceById.get(id);
        const metrics = item?.metrics as Record<string, number | undefined> | undefined;
        return metrics?.[metricKey] === metricValue;
      });
      if (!observed) {
        addIssue(
          `keywordCluster "${cluster.id}": metric ${metricKey}=${String(metricValue)} is not observed in any referenced evidence record`,
        );
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, plan };
}
