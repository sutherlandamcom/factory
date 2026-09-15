import type { FactoryDb } from "../persistence/db.js";
import { FactoryError } from "../executor/errors.js";
import { ProductionStore } from "./store.js";
import { computeArtifactDigest, ProductionBuildService } from "./build-service.js";
import { runSiteWideQa } from "./qa/site-wide.js";
import { deterministicDigest } from "../intelligence/digest.js";
import type { ProductionQaCheckResult } from "@factory/contracts";
import { loadProductionBuildIdentity } from "./identity.js";
import { assertCompleteProductionQa } from "./qa/registry.js";

/**
 * PRODUCTION API FACADE — Macro Run 9 operator surface.
 *
 * Thin facade over ProductionStore + ProductionBuildService + site-wide QA.
 * The Dashboard consumes these methods through the operator API; there is
 * NO Publish action (publication belongs to Run 13).
 */

export interface ProductionWorkspaceView {
  projectId: string;
  inputs: Array<{
    id: string;
    version: number;
    pageIdentity: string;
    pageType: string;
    route: string;
    canonicalOrigin: string;
    inputDigest: string;
    acceptedContent: { id: string; version: number };
    acceptedDesign: { id: string; version: number };
    acceptedVisualSet: { id: string; version: number };
    renderer: { id: string; version: string; policyVersion: string };
    stale: boolean;
    staleReason: string | null;
  }>;
  candidates: Array<{
    id: string;
    route: string;
    canonicalUrl: string;
    state: string;
    artifactDigest: string | null;
    productionInputVersion: number;
    createdAt: string;
  }>;
}

export class ProductionApiFacade {
  private readonly store: ProductionStore;
  private readonly build: ProductionBuildService;

  constructor(
    private readonly db: FactoryDb,
    private readonly repoRoot: string,
  ) {
    this.store = new ProductionStore(db);
    this.build = new ProductionBuildService(db, repoRoot);
  }

  async workspace(projectId: string): Promise<ProductionWorkspaceView> {
    const inputs = await this.store.listProductionInputs(projectId);
    const candidates = await this.store.listCandidates(projectId);
    const inputViews = [];
    for (const input of inputs) {
      const staleness = await this.store.inputStaleness(input);
      inputViews.push({
        id: input.id,
        version: input.version,
        pageIdentity: input.pageIdentity,
        pageType: input.pageType,
        route: input.route,
        canonicalOrigin: input.canonicalOrigin,
        inputDigest: input.inputDigest,
        acceptedContent: { id: input.acceptedContentId, version: input.acceptedContentVersion },
        acceptedDesign: { id: input.acceptedDesignId, version: input.acceptedDesignVersion },
        acceptedVisualSet: { id: input.acceptedVisualSetId, version: input.acceptedVisualSetVersion },
        renderer: { id: input.rendererId, version: input.rendererVersion, policyVersion: input.rendererPolicyVersion },
        stale: staleness.stale,
        staleReason: staleness.reason,
      });
    }
    return {
      projectId,
      inputs: inputViews,
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        route: candidate.route,
        canonicalUrl: candidate.canonicalUrl,
        state: candidate.state,
        artifactDigest: candidate.artifactDigest,
        productionInputVersion: candidate.productionInputVersion,
        createdAt: candidate.createdAt.toISOString(),
      })),
    };
  }

  async deriveInput(input: { projectId: string; pageSlug: string }) {
    const identity = await loadProductionBuildIdentity(this.repoRoot);
    const productionInput = await this.store.deriveProductionInput({
      projectId: input.projectId,
      pageSlug: input.pageSlug,
      siteIdentity: identity.siteIdentity,
      rendererVersion: identity.rendererVersion,
      rendererPolicyVersion: identity.rendererPolicyVersion,
    });
    return {
      id: productionInput.id,
      version: productionInput.version,
      route: productionInput.route,
      inputDigest: productionInput.inputDigest,
    };
  }

  async buildCandidate(input: { projectId: string; candidateId: string }) {
    // A candidate must exist first; the API flow is derive -> prepare -> build.
    const existing = await this.store.getCandidate(input.projectId, input.candidateId);
    if (!existing) {
      throw new FactoryError("production_candidate_not_found", "Candidate not found.");
    }
    const result = await this.build.buildCandidate(input);
    return {
      candidateId: result.candidateId,
      artifactDigest: result.artifactDigest,
      routeCount: result.routeCount,
      buildDurationMs: result.buildDurationMs,
    };
  }

  /** Prepare (derive input + create candidate) in one operator action. */
  async prepareCandidate(input: { projectId: string; pageSlug: string }) {
    return this.build.prepareCandidate(input);
  }

  /**
   * Run deterministic site-wide QA for a built candidate and record the
   * typed evidence. The candidate's route set comes from the manifest.
   */
  async runCandidateQa(input: { projectId: string; candidateId: string }) {
    const candidate = await this.store.getCandidate(input.projectId, input.candidateId);
    if (!candidate) {
      throw new FactoryError("production_candidate_not_found", "Candidate not found.");
    }
    if (!candidate.artifactRef || candidate.state !== "built" && candidate.state !== "qa_passed" && candidate.state !== "qa_failed") {
      throw new FactoryError("production_qa_not_found", "Candidate has no completed build to QA.");
    }
    if (!candidate.artifactDigest || !candidate.manifestSetDigest || !candidate.redirectSnapshotDigest || !candidate.repositorySha || !candidate.lockfileDigest) {
      throw new FactoryError("production_qa_failed", "Candidate is missing immutable build identity.");
    }
    const currentIdentity = await loadProductionBuildIdentity(this.repoRoot);
    if (currentIdentity.siteIdentity.profileDigest !== candidate.siteProfileDigest || currentIdentity.rendererVersion !== candidate.rendererVersion || currentIdentity.repositorySha !== candidate.repositorySha || currentIdentity.lockfileDigest !== candidate.lockfileDigest) {
      throw new FactoryError("production_authority_stale", "Candidate repository, site profile, renderer, or lockfile identity is no longer current.");
    }
    const manifests = await this.build.loadManifests(input);
    const manifestSetDigest = deterministicDigest(manifests.map((manifest) => ({ inputId: manifest.input.id, route: manifest.input.route, manifestDigest: manifest.manifestDigest })));
    const artifactDigest = await computeArtifactDigest(candidate.artifactRef);
    const bindings = await this.store.listCandidateInputs(input.projectId, candidate.id);
    if (manifestSetDigest !== candidate.manifestSetDigest || artifactDigest !== candidate.artifactDigest || bindings.length !== manifests.length || manifests.some((manifest) => !bindings.some((binding) => binding.productionInputId === manifest.input.id && binding.manifestDigest === manifest.manifestDigest))) {
      throw new FactoryError("production_qa_failed", "Immutable candidate bytes or manifest bindings do not match persistence.");
    }
    const redirects = await this.store.listCandidateRedirects(input.projectId, candidate.id);
    const redirectRules = redirects.map(({ source, destination, kind }) => ({ source, destination, kind }));
    const redirectSnapshotDigest = deterministicDigest({ projectId: input.projectId, rules: redirectRules });
    if (redirectSnapshotDigest !== candidate.redirectSnapshotDigest) throw new FactoryError("production_qa_failed", "Redirect snapshot digest mismatch.");
    const trustedChecks = await this.store.listTrustedQaEvidence(input.projectId, candidate.id);
    const qa = await runSiteWideQa({
      distDir: candidate.artifactRef,
      manifests,
      redirectRules,
      siteName: manifests[0]!.input.siteIdentity.siteName,
      manifestSetDigest,
      repositorySha: candidate.repositorySha,
      trustedChecks,
    });
    const pageRoutes = manifests.map((manifest) => manifest.input.route);
    const complete = assertCompleteProductionQa({ checks: qa.checks, pageRoutes, manifestSetDigest, repositorySha: candidate.repositorySha });
    if (!complete.complete) throw new FactoryError("production_qa_failed", `Required QA evidence missing or duplicated: ${complete.missing.join(", ")}`);
    const run = await this.store.recordQaRun({
      projectId: input.projectId,
      candidateId: candidate.id,
      checks: qa.checks as ProductionQaCheckResult[],
      evaluatedArtifactDigest: artifactDigest,
      manifestSetDigest,
      redirectSnapshotDigest,
      repositorySha: candidate.repositorySha,
      lockfileDigest: candidate.lockfileDigest,
      pageRoutes,
    });
    return {
      qaRunId: run.id,
      overall: qa.overall,
      checks: qa.checks,
      digest: deterministicDigest({ overall: qa.overall, checks: qa.checks.map((check) => ({ checkId: check.checkId, verdict: check.verdict })) }),
    };
  }

  async candidateDetail(input: { projectId: string; candidateId: string }) {
    const candidate = await this.store.getCandidate(input.projectId, input.candidateId);
    if (!candidate) {
      throw new FactoryError("production_candidate_not_found", "Candidate not found.");
    }
    const qaRun = await this.store.latestQaRun(input.projectId, candidate.id);
    return {
      id: candidate.id,
      route: candidate.route,
      canonicalUrl: candidate.canonicalUrl,
      state: candidate.state,
      artifactDigest: candidate.artifactDigest,
      productionInputId: candidate.productionInputId,
      productionInputVersion: candidate.productionInputVersion,
      productionInputDigest: candidate.productionInputDigest,
      qa: qaRun
        ? {
            id: qaRun.id,
            overall: qaRun.overall,
            checks: (qaRun.data as { checks?: unknown }).checks ?? [],
            createdAt: qaRun.createdAt.toISOString(),
          }
        : null,
      createdAt: candidate.createdAt.toISOString(),
    };
  }
}
