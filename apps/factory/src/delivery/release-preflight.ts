import { qaRunPublicationEligible } from "@factory/contracts";
import type {
  ProductionCandidateRecord,
  ProductionCandidateInputRecord,
  ProductionQaRunRecord,
} from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import { candidateBuildStaleness } from "../production/store.js";

/**
 * Candidate/QA/route identity checks for a governed release.
 *
 * All arguments MUST be read on the trusted backend, within the same
 * project-serialized critical section as the eventual provider mutation.
 * This is NOT a human approval and not, alone, permission to publish.
 *
 * Callers must additionally verify current upstream authority for each
 * bound input, genuine release-specific human approval, target ownership,
 * exact staged bytes and Cloudflare state immediately before promotion.
 */
export interface CandidateReleaseProof {
  projectId: string;
  candidate: ProductionCandidateRecord;
  latestQa: ProductionQaRunRecord | null;
  candidateInputs: readonly ProductionCandidateInputRecord[];
  currentPageInputIds: readonly string[];
  canonicalOrigin: string;
  buildIdentity: {
    repositorySha: string;
    lockfileDigest: string;
    rendererVersion: string;
    siteIdentity: { profileDigest: string };
  };
}

function reject(reason: string): never {
  throw new FactoryError("production_authority_stale", reason);
}

/**
 * Reject a non-current, synthetic, structurally incomplete or mismatched
 * candidate before starting preview/upload or before release approval.
 */
export function assertCandidateReleaseQaProof(p: CandidateReleaseProof): void {
  const { candidate: c, latestQa: q } = p;
  if (c.projectId !== p.projectId || p.candidateInputs.some(b => b.projectId !== p.projectId)) {
    reject("Candidate or route binding belongs to another project.");
  }
  if (c.state !== "qa_passed" || !c.artifactDigest || !c.artifactRef ||
      !c.manifestSetDigest || !c.redirectSnapshotDigest ||
      !c.repositorySha || !c.lockfileDigest || !c.siteProfileDigest || !c.rendererVersion) {
    reject("Candidate is not a complete immutable QA-passed build.");
  }
  if (!/^[a-f0-9]{64}$/.test(c.artifactDigest)) reject("Invalid candidate artifact digest.");
  const stale = candidateBuildStaleness(c, p.buildIdentity);
  if (stale.stale) reject(stale.reason ?? "Candidate build identity is stale.");

  if (!q || q.projectId !== p.projectId || q.candidateId !== c.id ||
      q.candidateArtifactDigest !== c.artifactDigest || q.overall !== "PASS" ||
      !qaRunPublicationEligible(q.data)) {
    reject("No current publication-eligible QA run bound to this exact candidate.");
  }
  const qaData = q.data as { candidateId?: string };
  if (qaData.candidateId !== c.id) reject("QA report references a different candidate.");

  const normalized = p.canonicalOrigin.replace(/\/$/, "");
  if (!normalized.startsWith("https://") || c.canonicalUrl !== normalized + (c.route === "/" ? "/" : c.route)) {
    reject("Candidate canonical origin is inconsistent with the configured production target.");
  }
  const actualBindings = p.candidateInputs;
  if (!actualBindings.length || actualBindings.some(b => b.candidateId !== c.id || !b.manifestDigest ||
      !b.productionInputDigest || b.productionInputVersion < 1)) {
    reject("Candidate site route bindings are missing or malformed.");
  }
  const boundIds = actualBindings.map(b => b.productionInputId).sort();
  const currentIds = [...p.currentPageInputIds].sort();
  if (boundIds.length !== currentIds.length ||
      new Set(boundIds).size !== boundIds.length ||
      boundIds.join("\0") !== currentIds.join("\0") ||
      new Set(actualBindings.map(b => b.route)).size !== actualBindings.length) {
    reject("Candidate is not the exact current site input/route set.");
  }
}
