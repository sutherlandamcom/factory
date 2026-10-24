import { deterministicDigest } from "../src/intelligence/digest.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdtemp, rm, writeFile, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  DEPLOYMENT_APPROVE_PERMISSION,
  DEPLOYMENT_PUBLISH_PERMISSION,
  PRODUCTION_SCHEMA_VERSION,
  type ReleaseApproval,
} from "@factory/contracts";
import type {
  DeploymentRecord,
  ProductionCandidateRecord,
  ProductionCandidateInputRecord,
  ProductionQaRunRecord,
  ProductionPageInputRecord,
  ReleaseApprovalRecord,
  SiteRecord,
} from "../src/persistence/schema.js";
import { GovernedDeliveryService } from "../src/delivery/governed-service.js";
import {
  ReleaseApprovalBoundary,
  ReleaseIdentityProvider,
  AuditSealKeyring,
  InMemorySessionRevocationStore,
  type SessionRevocationStore,
} from "../src/trust/release-approval-boundary.js";
import {
  projects as projectsTable, sites as sitesTable, projectInputSnapshots,
  projectReviewerMemberships,
  productionCandidates,
  deployments as deploymentsTable,
  productionQaRuns,
  releaseApprovals as releaseApprovalsTable,
} from "../src/persistence/schema.js";
import type { WranglerOperations } from "../src/delivery/service.js";
import type { RemoteQaResult } from "../src/delivery/qa.js";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { loadProductionBuildIdentity } from "../src/production/identity.js";
import { computeArtifactDigest } from "../src/production/build-service.js";

const sourceRepoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

function makeToken(subject: string, roles: string[] = []): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://idp.factory.test",
      sub: subject,
      aud: "factory-release-governance",
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: `jti-${subject}-${randomUUID()}`,
      roles,
    }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

class FakeWrangler implements WranglerOperations {
  promoted: string[] = [];
  rolledBack: string[] = [];
  current: string | null;
  uploadedVersionId = "v-cf-preview-123";

  constructor(current: string | null) {
    this.current = current;
  }
  async assertTargetExists(): Promise<void> {}
  async upload() {
    return {
      versionId: this.uploadedVersionId,
      previewUrl: `https://${this.uploadedVersionId}.preview.workers.dev`,
      workerName: "test-worker",
    };
  }
  async currentProductionVersion() {
    return this.current;
  }
  async promote(_worker: string, version: string) {
    this.promoted.push(version);
    this.current = version;
  }
  async rollback(_worker: string, version: string) {
    this.rolledBack.push(version);
    this.current = version;
  }
}

test("governed delivery lifecycle: preview -> approval -> publish -> rollback", async (t) => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "e2e01-delivery-unit-"));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await mkdir(path.join(repoRoot, "sites/starter"), { recursive: true });
  for (const relative of [".git", "pnpm-lock.yaml", "sites/starter/package.json", "sites/starter/node_modules"]) {
    await symlink(path.join(sourceRepoRoot, relative), path.join(repoRoot, relative));
  }
  const profile = JSON.parse(await readFile(path.join(sourceRepoRoot, "sites/starter/site-profile.json"), "utf8"));
  await writeFile(path.join(repoRoot, "sites/starter/site-profile.json"), JSON.stringify(profile));
  const acceptedIdentity = { siteName: profile.siteName, candidateDomain: "sutherlandam.com", language: profile.language, locale: "en-GB" };
  const acceptedPayload = { siteIdentity: acceptedIdentity };
  const acceptedSnapshot = { id: "intake-unit", version: 1, digest: deterministicDigest(acceptedPayload), payload: acceptedPayload, acceptanceState: "human_accepted" };
  const binding = { version: "project-site-binding-v1", projectKey: "delivery-unit", siteKey: "main", profileDigest: deterministicDigest(profile), acceptedSiteIdentityDigest: deterministicDigest(acceptedIdentity), delivery: { workerName: "test-worker", productionUrl: profile.canonicalOrigin } };
  await writeFile(path.join(repoRoot, "sites/starter/project-site-binding.json"), JSON.stringify(binding));
  const buildIdentity = await loadProductionBuildIdentity(repoRoot, { projectKey: binding.projectKey, siteKey: binding.siteKey, acceptedSiteIdentity: acceptedIdentity });
  const projectId = "proj-gov-1";
  const siteId = "site-gov-1";
  const candidateId = "cand-1";
  const qaRunId = "qa-run-1";
  const candidateArtifactDir = path.join(
    repoRoot,
    ".factory",
    "production",
    "projects",
    projectId,
    "candidates",
    candidateId,
    "dist",
  );
  await mkdir(candidateArtifactDir, { recursive: true });
  t.after(async () => {
    await rm(path.join(repoRoot, ".factory", "production", "projects", projectId), {
      recursive: true,
      force: true,
    });
  });

  await writeFile(path.join(candidateArtifactDir, "index.html"), "<html><body>Home</body></html>", "utf-8");
  await writeFile(path.join(candidateArtifactDir, "about.html"), "<html><body>About</body></html>", "utf-8");

  const artifactDigest = await computeArtifactDigest(candidateArtifactDir);

  // In-memory data
  const site: SiteRecord = {
    id: siteId,
    projectId,
    key: "main",
    name: "Main Site",
    cloudflareWorkerName: "test-worker",
    productionUrl: buildIdentity.siteIdentity.canonicalOrigin,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const candidate: ProductionCandidateRecord = {
    id: candidateId,
    projectId,
    productionInputId: "input-1",
    productionInputVersion: 1,
    productionInputDigest: "p".repeat(64),
    pageIdentity: "home",
    route: "/",
    canonicalUrl: `${buildIdentity.siteIdentity.canonicalOrigin}/`,
    artifactDigest,
    artifactRef: candidateArtifactDir,
    assetReferences: null,
    manifestSetDigest: "1".repeat(64),
    redirectSnapshotDigest: "2".repeat(64),
    siteProfileDigest: buildIdentity.siteIdentity.profileDigest,
    rendererVersion: buildIdentity.rendererVersion,
    repositorySha: buildIdentity.repositorySha,
    lockfileDigest: buildIdentity.lockfileDigest,
    state: "qa_passed",
    createdAt: new Date(),
  };

  const qaRun: ProductionQaRunRecord = {
    id: qaRunId,
    projectId,
    candidateId,
    candidateArtifactDigest: artifactDigest,
    overall: "PASS",
    data: {
      schemaVersion: PRODUCTION_SCHEMA_VERSION,
      candidateId,
      checks: [],
      overall: "PASS",
      provenance: {
        trustMode: "STRICT_PRODUCTION",
        publicationEligible: true,
        reviewAuthorityMode: "VERIFIED_HUMAN",
      },
    },
    createdAt: new Date(),
  };

  const candidateInputs: ProductionCandidateInputRecord[] = [
    {
      candidateId,
      projectId,
      productionInputId: "input-1",
      productionInputVersion: 1,
      productionInputDigest: "p".repeat(64),
      pageIdentity: "home",
      route: "/",
      manifestDigest: "m".repeat(64),
    },
  ];

  const currentInputs: ProductionPageInputRecord[] = [
    {
      id: "input-1",
      projectId,
      version: 1,
      pageIdentity: "home",
      pageType: "standard",
      route: "/",
      canonicalOrigin: buildIdentity.siteIdentity.canonicalOrigin,
      siteId: site.id,
      siteName: site.name,
      siteLanguage: "en",
      siteProfileDigest: buildIdentity.siteIdentity.profileDigest,
      acceptedContentId: "c-1",
      acceptedContentVersion: 1,
      acceptedContentDigest: "c".repeat(64),
      acceptedDesignId: "d-1",
      acceptedDesignVersion: 1,
      acceptedDesignDigest: "d".repeat(64),
      acceptedVisualSetId: "v-1",
      acceptedVisualSetVersion: 1,
      acceptedVisualSetDigest: "v".repeat(64),
      rendererId: "astro",
      rendererVersion: buildIdentity.rendererVersion,
      rendererPolicyVersion: "production-policy-v3",
      data: {} as any,
      inputDigest: "p".repeat(64),
      createdAt: new Date(),
    },
  ];

  let deployments: DeploymentRecord[] = [];
  let releaseApprovals: ReleaseApprovalRecord[] = [];

  const store: any = {
    async getProjectById(pId: string) { return pId === projectId ? { id: projectId, key: binding.projectKey } : null; },
    async getSiteByKey(projectKey: string, siteKey: string) { return projectKey === binding.projectKey && siteKey === site.key ? site : null; },
    async findSiteByProjectId(pId: string) {
      return pId === projectId ? site : null;
    },
    async getSiteById(sId: string) {
      return sId === siteId ? site : null;
    },
    async findLatestUnverifiedDeployment(sId: string) {
      return (
        deployments.find(
          (d) => d.siteId === sId && !d.productionVerified && d.status !== "failed" && d.status !== "verified",
        ) ?? null
      );
    },
    async createDeployment(d: any) {
      const rec: DeploymentRecord = {
        status: "preparing",
        versionId: null,
        previewUrl: null,
        previousVersionId: null,
        artifactDigest: null,
        previewVerified: false,
        productionVerified: false,
        rolledBack: false,
        errorCode: null,
        errorMessage: null,
        promotedAt: null,
        verifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...d,
      };
      deployments.push(rec);
      return rec;
    },
    async updateDeployment(d: any) {
      const idx = deployments.findIndex((x) => x.id === d.id);
      if (idx === -1) throw new Error("not found");
      deployments[idx] = { ...deployments[idx], ...d, updatedAt: new Date() };
      return deployments[idx];
    },
    async getDeployment(dId: string) {
      return deployments.find((d) => d.id === dId) ?? null;
    },
    async findLatestKnownGoodDeployment(
      sId: string,
      workerName?: string,
      productionUrl?: string,
      excludeDeploymentId?: string,
    ) {
      return (
        deployments
          .filter(
            (d) =>
              d.siteId === sId &&
              d.productionVerified &&
              d.status === "verified" &&
              !d.rolledBack &&
              (!excludeDeploymentId || d.id !== excludeDeploymentId),
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
      );
    },
    async listDeployments(sId: string, limit: number) {
      return deployments.filter((d) => d.siteId === sId).slice(-limit).reverse();
    },
    async listCanonicalVerifiedDeployments(sId: string, workerName?: string, productionUrl?: string) {
      return deployments
        .filter(
          (d) =>
            d.siteId === sId &&
            d.status === "verified" &&
            d.productionVerified &&
            d.versionId &&
            d.artifactDigest &&
            (!workerName || d.workerName === workerName) &&
            (!productionUrl || d.productionUrl === productionUrl),
        )
        .reverse();
    },
    async findLatestDeploymentByCandidate(sId: string, cId: string) {
      return deployments.filter((d) => d.siteId === sId && d.candidateId === cId).slice(-1)[0] ?? null;
    },
    async insertReleaseApproval(a: any) {
      const rec: ReleaseApprovalRecord = { ...a, createdAt: new Date() };
      releaseApprovals.push(rec);
      return rec;
    },
    async findReleaseApproval(cId: string, qId: string) {
      return (
        releaseApprovals
          .filter((r) => r.candidateId === cId && r.qaRunId === qId && !r.revoked)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
      );
    },
    async getReleaseApproval(aId: string) {
      return releaseApprovals.find((r) => r.id === aId) ?? null;
    },
    async revokeReleaseApproval(aId: string) {
      const rec = releaseApprovals.find((r) => r.id === aId);
      if (rec) {
        rec.revoked = true;
      }
    },
    transitions: [] as any[],
    async insertEffectiveTransition(t: any) {
      const rec = { ...t, createdAt: new Date(), effectiveAt: t.effectiveAt ? new Date(t.effectiveAt) : new Date() };
      this.transitions.unshift(rec);
      return rec;
    },
    async getEffectiveTransitionAsOf(sId: string, asOf: Date) {
      return this.transitions
        .filter((t: any) => t.siteId === sId && t.effectiveAt.getTime() <= asOf.getTime())
        .sort((a: any, b: any) => b.effectiveAt.getTime() - a.effectiveAt.getTime())[0] ?? null;
    },
    async getCurrentEffectiveTransition(sId: string) {
      return this.transitions.filter((t: any) => t.siteId === sId)[0] ?? null;
    },
    async finalizeDeploymentAndTransitionAtomic(params: any) {
      const dep = await this.updateDeployment({
        id: params.deploymentId,
        status: params.status ?? "verified",
        productionVerified: true,
        verifiedAt: new Date(),
        executionOrigin: params.executionOrigin,
        operationId: params.operationId,
      });
      const transition = await this.insertEffectiveTransition({
        ...params.transition,
        executionOrigin: params.executionOrigin,
        operationId: params.operationId,
      });
      return {
        deployment: dep,
        transition,
        alreadyFinalized: false,
      };
    },
  };

  const productionStore: any = {
    async getCandidate(pId: string, cId: string) {
      return pId === projectId && cId === candidateId ? candidate : null;
    },
    async latestQaRun(pId: string, cId: string) {
      return pId === projectId && cId === candidateId ? qaRun : null;
    },
    async getQaRun(id: string) {
      return id === qaRun.id ? qaRun : null;
    },
    async listCandidateInputs(pId: string, cId: string) {
      return pId === projectId && cId === candidateId ? candidateInputs : [];
    },
    async listProductionInputs(pId: string) {
      return pId === projectId ? currentInputs : [];
    },
    async listCandidateRedirects() {
      return [];
    },
  };

  // Auth & Keyring setup
  const { idp, signAssertion } = ReleaseIdentityProvider.createTestHarness("test-idp");
  const revocationStore = new InMemorySessionRevocationStore();
  const keyring = new AuditSealKeyring({
    activeKeyId: "v1",
    keys: { v1: "0123456789abcdef0123456789abcdef" },
  });

  const mockDb: any = {
    async transaction(fn: any) {
      return fn(mockDb);
    },
    async execute() {},
    select() {
      return {
        from(table: any) {
          let queriedActor: string | null = null;
          const resolveData = () => {
            if (table === projectsTable) return [{ id: projectId, key: binding.projectKey }];
            if (table === sitesTable) return [site];
            if (table === projectInputSnapshots) return [acceptedSnapshot];
            if (table === projectReviewerMemberships) {
              if (queriedActor === "bob") {
                return [
                  {
                    id: "mem-bob",
                    projectId,
                    actorId: "bob",
                    permissions: [],
                    revokedAt: null,
                  },
                ];
              }
              return [
                {
                  id: "mem-alice",
                  projectId,
                  actorId: "alice",
                  permissions: [DEPLOYMENT_APPROVE_PERMISSION, DEPLOYMENT_PUBLISH_PERMISSION],
                  revokedAt: null,
                },
              ];
            }
            if (table === productionCandidates) {
              return [candidate];
            }
            if (table === deploymentsTable) {
              return deployments.slice().reverse();
            }
            if (table === productionQaRuns) {
              return [qaRun];
            }
            if (table === releaseApprovalsTable) {
              return releaseApprovals;
            }
            return [];
          };

          const createQuery = () => ({
            where(pred: any) {
              const str = inspect(pred, { depth: null });
              if (str.includes("bob")) queriedActor = "bob";
              else if (str.includes("alice")) queriedActor = "alice";
              return createQuery();
            },
            orderBy(_order: any) {
              return createQuery();
            },
            limit(_n: number) {
              return createQuery();
            },
            then(resolve: any, reject: any) {
              try {
                return resolve(resolveData());
              } catch (e) {
                return reject(e);
              }
            },
          });

          return createQuery();
        },
      };
    },
    update(table: any) {
      return {
        set(v: any) {
          return {
            where(_pred: any) {
              return {
                then(resolve: any) {
                  return resolve([]);
                },
              };
            },
          };
        },
      };
    },
    insert(table: any) {
      return {
        values(v: any) {
          return {
            returning() {
              const rec: ReleaseApprovalRecord = {
                id: v.id ?? `rel-appr-${randomUUID()}`,
                projectId: v.projectId,
                siteId: v.siteId,
                candidateId: v.candidateId,
                qaRunId: v.qaRunId,
                artifactDigest: v.artifactDigest,
                previewVersionId: v.previewVersionId,
                targetWorkerName: v.targetWorkerName,
                targetProductionUrl: v.targetProductionUrl,
                actorId: v.actorId,
                actorName: v.actorName,
                actorRole: v.actorRole,
                sessionId: v.sessionId,
                isSynthetic: v.isSynthetic ?? false,
                verificationSeal: v.verificationSeal,
                sealKeyId: v.sealKeyId,
                sealStatus: v.sealStatus ?? "SEALED",
                revoked: v.revoked ?? false,
                createdAt: new Date(),
              };
              releaseApprovals.push(rec);
              return [rec];
            },
          };
        },
      };
    },
  };

  const boundary = new ReleaseApprovalBoundary(mockDb, {
    idp,
    revocationStore,
    keyring,
  });

  const fakeWrangler = new FakeWrangler(null);
  let preparedWorktrees: string[] = [];
  let removedWorktrees: string[] = [];

  const fakeWorktreeProvider = {
    async prepare(root: string, commit: string, id: string) {
      const wtDir = path.join(tmpdir(), `wt-${id}-${randomUUID()}`);
      await mkdir(path.join(wtDir, "sites", "starter"), { recursive: true });
      preparedWorktrees.push(wtDir);
      return wtDir;
    },
    async remove(root: string, wt: string) {
      removedWorktrees.push(wt);
      await rm(wt, { recursive: true, force: true });
    },
  };

  let remoteQaCalls: any[] = [];
  const fakeQaRunner = async (input: any): Promise<RemoteQaResult> => {
    remoteQaCalls.push(input);
    return { passed: true, exitCode: 0, timedOut: false };
  };

  const service = new GovernedDeliveryService({
    db: mockDb,
    repoRoot,
    store,
    productionStore,
    releaseBoundary: boundary,
    wranglerFactory: () => fakeWrangler,
    worktreeProvider: fakeWorktreeProvider,
    qaRunner: fakeQaRunner,
  });

  // Seed initial known-good deployment
  await store.createDeployment({
    id: "deployment-known-good-0",
    siteId,
    sourceCommit: "0".repeat(40),
    workerName: site.cloudflareWorkerName!,
    productionUrl: site.productionUrl!,
    versionId: "v-cf-v0",
    candidateRoutes: ["/"],
    executionOrigin: "REAL_CLOUDFLARE",
    status: "verified",
    previewVerified: true,
    productionVerified: true,
  });
  fakeWrangler.current = "v-cf-v0";

  // Operator session tokens (P1-A verification)
  const aliceToken = signAssertion({
    actorId: "alice",
    actorName: "Alice Lead",
    actorRole: "LEAD",
    audience: "factory-release-governance",
  });
  const bobToken = signAssertion({
    actorId: "bob",
    actorName: "Bob Viewer",
    actorRole: "VIEWER",
    audience: "factory-release-governance",
  });

  // 1a. Negative Test: Missing session token throws actor_unauthenticated
  await assert.rejects(
    () => service.prepareCandidatePreview({ projectId, candidateId }),
    (err: any) => err.code === "actor_unauthenticated",
  );

  // 1b. Negative Test: Bob lacks preview permission throws permission_denied
  await assert.rejects(
    () => service.prepareCandidatePreview({ projectId, candidateId, sessionToken: bobToken }),
    (err: any) => err.code === "permission_denied",
  );

  // 1c. Authorized Operator (Alice) prepares candidate preview
  const preview = await service.prepareCandidatePreview({
    projectId,
    candidateId,
    sessionToken: aliceToken,
  });

  assert.equal(preview.status, "preview_verified");
  assert.equal(preview.previewVerified, true);
  assert.equal(preview.versionId, "v-cf-preview-123");
  assert.ok(preview.previewUrl?.includes("preview.workers.dev"));
  assert.equal(remoteQaCalls.length, 1);
  assert.equal(remoteQaCalls[0].candidateRoutes.length, 1);
  assert.equal(removedWorktrees.length, 1);

  // 2. Human Release Approval (Alice has DEPLOYMENT:APPROVE)
  const approval = await service.approveRelease({
    projectId,
    candidateId,
    previewVersionId: preview.versionId!,
    sessionToken: aliceToken,
  });

  assert.equal(approval.projectId, projectId);
  assert.equal(approval.candidateId, candidateId);
  assert.equal(approval.previewVersionId, "v-cf-preview-123");
  assert.equal(approval.actorId, "alice");
  assert.ok(approval.verificationSeal!.length > 20);

  // 2b. Attempt approval with Bob (lacks DEPLOYMENT:APPROVE) -> denied
  await assert.rejects(
    () =>
      service.approveRelease({
        projectId,
        candidateId,
        previewVersionId: preview.versionId!,
        sessionToken: bobToken,
      }),
    (err: any) => err.code === "permission_denied",
  );

  // 3. Provider drift check before publish
  fakeWrangler.current = "unexpected-manual-override-v999";
  const driftResult = await service.publishApprovedRelease({
    projectId,
    candidateId,
    previewVersionId: preview.versionId!,
    approvalId: approval.id,
    sessionToken: aliceToken,
  });
  assert.equal(driftResult.status, "failed");
  assert.equal(driftResult.errorCode, "deployment_drift");

  // Reset wrangler current to known-good
  fakeWrangler.current = "v-cf-v0";

  // 4. Governed Publish (Alice publishes)
  // Re-verify preview deployment is ready for publish after drift attempt
  deployments[deployments.length - 1]!.status = "preview_verified";
  const published = await service.publishApprovedRelease({
    projectId,
    candidateId,
    previewVersionId: preview.versionId!,
    approvalId: approval.id,
    sessionToken: aliceToken,
  });

  assert.equal(published.status, "verified");
  assert.equal(published.productionVerified, true);
  assert.equal(published.versionId, "v-cf-preview-123");
  assert.deepEqual(fakeWrangler.promoted, ["v-cf-preview-123"]);
  assert.equal(remoteQaCalls.length, 2); // 1 preview QA + 1 production QA

  // 5. Explicit Rollback
  const rollback = await service.rollbackExplicit({
    projectId,
    sessionToken: aliceToken,
  });

  if (rollback.status === "needs_review") {
    console.log("ROLLBACK ERROR:", rollback.errorCode, rollback.errorMessage);
  }

  assert.equal(rollback.status, "rolled_back");
  assert.equal(rollback.rolledBack, true);
  assert.deepEqual(fakeWrangler.rolledBack, ["v-cf-v0"]);

  // P0-D: Verify past published deployment was NOT mutated in-place
  assert.equal(published.status, "verified");
  assert.equal(published.productionVerified, true);

  // P0-D & P0-E: Verify transition history and lineage
  assert.equal(store.transitions.length, 2);
  assert.equal(store.transitions[0].eventType, "ROLLBACK");
  assert.equal(store.transitions[0].toVersionId, "v-cf-v0");
  assert.equal(store.transitions[1].eventType, "PUBLISH");
  assert.equal(store.transitions[1].toVersionId, "v-cf-preview-123");

  const effectiveNow = await service.getEffectiveReleaseAsOf({
    siteId,
    route: "/",
    asOf: new Date(),
  });
  assert.equal(effectiveNow.effectiveDeployment?.versionId, "v-cf-v0");
});
