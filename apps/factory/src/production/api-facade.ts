import type { FactoryDb } from "../persistence/db.js";
import { FactoryError } from "../executor/errors.js";
import { ProductionStore } from "./store.js";
import { ProductionBuildService } from "./build-service.js";
import { runSiteWideQa } from "./qa/site-wide.js";
import { ProductionRenderCompiler } from "./render-manifest.js";
import { deterministicDigest } from "../intelligence/digest.js";
import type { ProductionQaCheckResult } from "@factory/contracts";

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
  private readonly compiler: ProductionRenderCompiler;

  constructor(
    private readonly db: FactoryDb,
    private readonly repoRoot: string,
  ) {
    this.store = new ProductionStore(db);
    this.build = new ProductionBuildService(db, repoRoot);
    this.compiler = new ProductionRenderCompiler(db, repoRoot);
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

  async deriveInput(input: { projectId: string; pageSlug: string; canonicalOrigin: string }) {
    const productionInput = await this.store.deriveProductionInput({
      projectId: input.projectId,
      pageSlug: input.pageSlug,
      canonicalOrigin: input.canonicalOrigin,
      rendererVersion: "astro-7.2.9",
      rendererPolicyVersion: "production-policy-v1",
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
  async prepareCandidate(input: { projectId: string; pageSlug: string; canonicalOrigin: string }) {
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
    const manifest = await this.compiler.compileManifest({
      projectId: input.projectId,
      productionInputId: candidate.productionInputId,
    });
    const qa = await runSiteWideQa({
      distDir: candidate.artifactRef,
      manifests: [manifest],
      redirectRules: [],
      siteName: "Factory Production Site",
    });
    const run = await this.store.recordQaRun({
      projectId: input.projectId,
      candidateId: candidate.id,
      checks: qa.checks as ProductionQaCheckResult[],
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
