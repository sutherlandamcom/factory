import assert from "node:assert/strict";
import test from "node:test";
import { createOperatorApi, type OperatorApiDeps } from "../../src/operator/api.js";
import type { GovernedDeliveryService } from "../../src/delivery/governed-service.js";
import { FactoryError } from "../../src/executor/errors.js";
import type { GovernedDeploymentView } from "@factory/contracts";

async function callApi(
  deps: OperatorApiDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const handle = createOperatorApi(deps);
  const res = {
    headersSent: false,
    statusCode: 0,
    headers: {} as Record<string, string>,
    end(chunk?: string) {
      (this as { body?: string }).body = chunk ?? "";
    },
    writeHead(status: number, headers: Record<string, string>) {
      (this as { statusCode?: number }).statusCode = status;
      (this as { headers?: Record<string, string> }).headers = headers;
    },
    body: "" as string,
  } as unknown as import("node:http").ServerResponse & {
    body: string;
    statusCode: number;
    headers: Record<string, string>;
  };

  const parsedUrl = new URL(path, "http://localhost");
  await handle(
    { method, url: path, headers: {} } as unknown as import("node:http").IncomingMessage,
    res,
    parsedUrl.pathname,
    body === undefined ? "" : JSON.stringify(body),
  );
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") as any };
}

const PROJECT = {
  id: "p-deploy-test",
  key: "test-site",
  name: "Test Site",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const MOCK_VIEW: GovernedDeploymentView = {
  projectId: PROJECT.id,
  siteId: "site-1",
  siteKey: PROJECT.key,
  targetWorkerName: "worker-sutherland",
  targetProductionUrl: "https://example.com",
  readinessState: "READY_FOR_DEPLOYMENT",
  candidate: {
    id: "cand-1",
    route: "/blog/post-1",
    canonicalUrl: "https://example.com/blog/post-1",
    state: "qa_passed",
    artifactDigest: "a".repeat(64),
    repositorySha: "23d14beabd1001a5199458270aa3862ca07623fe",
    createdAt: new Date().toISOString(),
    routes: ["/blog/post-1"],
  },
  latestQa: {
    id: "qa-1",
    overall: "PASS",
    publicationEligible: true,
    createdAt: new Date().toISOString(),
  },
  activePreview: {
    deploymentId: "dep-prev-1",
    versionId: "ver-prev-1",
    previewUrl: "https://preview.example.com",
    previewVerified: true,
    createdAt: new Date().toISOString(),
  },
  activeApproval: {
    id: "appr-1",
    projectId: PROJECT.id,
    siteId: "site-1",
    candidateId: "cand-1",
    qaRunId: "qa-1",
    artifactDigest: "a".repeat(64),
    previewVersionId: "ver-prev-1",
    targetWorkerName: "worker-sutherland",
    targetProductionUrl: "https://example.com",
    actorId: "usr-alice",
    actorName: "Alice Release Lead",
    actorRole: "ReleaseManager",
    sessionId: "sess-1",
    isSynthetic: false,
    verificationSeal: "b".repeat(64),
    sealKeyId: "seal-k1",
    sealStatus: "SEALED",
    revoked: false,
    createdAt: new Date().toISOString(),
  },
  currentProduction: {
    activeVersionId: "ver-prod-0",
    knownGoodVersionId: "ver-prod-0",
    lastVerifiedAt: new Date().toISOString(),
  },
  history: [],
  blockers: [],
};

function makeGovernedDeliveryStub(): GovernedDeliveryService {
  return {
    getGovernedDeploymentView: async (projectId: string) => {
      if (projectId !== PROJECT.id) {
        throw new FactoryError("not_found", `Project ${projectId} not found.`);
      }
      return MOCK_VIEW;
    },
    prepareCandidatePreview: async (projectId: string, candidateId: string) => {
      if (candidateId === "cand-stale") {
        throw new FactoryError("delivery_stale_identity", "Candidate is stale.");
      }
      return {
        id: "dep-new-prev",
        status: "preview_verified",
        versionId: "ver-new-prev",
        previewUrl: "https://preview.example.com/new",
      };
    },
    approveRelease: async (input: {
      projectId: string;
      candidateId: string;
      previewVersionId: string;
      sessionToken: string;
    }) => {
      if (input.sessionToken === "token-denied") {
        throw new FactoryError("operator_permission_denied", "Missing DEPLOYMENT:APPROVE permission.");
      }
      return {
        id: "appr-new-1",
        projectId: input.projectId,
        siteId: "site-1",
        candidateId: input.candidateId,
        qaRunId: "qa-1",
        artifactDigest: "a".repeat(64),
        previewVersionId: input.previewVersionId,
        targetWorkerName: "worker-sutherland",
        targetProductionUrl: "https://example.com",
        actorId: "usr-alice",
        actorName: "Alice",
        actorRole: "ReleaseManager",
        sessionId: "sess-1",
        isSynthetic: false,
        verificationSeal: "c".repeat(64),
        sealKeyId: "seal-k1",
        sealStatus: "SEALED",
        revoked: false,
        createdAt: new Date().toISOString(),
      };
    },
    publishApprovedRelease: async (input: {
      projectId: string;
      candidateId: string;
      previewVersionId: string;
      approvalId: string;
      sessionToken: string;
    }) => {
      if (input.sessionToken === "token-stale") {
        throw new FactoryError("delivery_stale_identity", "Production drift detected.");
      }
      return {
        id: "dep-pub-1",
        status: "verified",
        versionId: input.previewVersionId,
        productionUrl: "https://example.com",
        rolledBack: false,
      };
    },
    rollbackExplicit: async (input: {
      projectId: string;
      sessionToken: string;
      targetVersionId?: string;
    }) => {
      if (input.sessionToken === "token-no-target") {
        throw new FactoryError("delivery_no_known_good_deployment", "No known good version.");
      }
      return {
        id: "dep-rb-1",
        status: "verified",
        versionId: "ver-restored",
        productionUrl: "https://example.com",
        rolledBack: true,
      };
    },
    getEffectiveReleaseAsOf: async (input: { siteId: string; route: string; asOf: Date }) => {
      return {
        siteId: input.siteId,
        route: input.route,
        asOfTimestamp: input.asOf.toISOString(),
        effectiveDeployment: {
          id: "dep-pub-1",
          versionId: "ver-current-prod",
          workerName: "worker-sutherland",
          productionUrl: "https://example.com",
          sourceCommit: "a".repeat(40),
          artifactDigest: "b".repeat(64),
          promotedAt: new Date(0).toISOString(),
          verifiedAt: new Date(0).toISOString(),
          status: "verified",
        },
        releaseApproval: {
          id: "appr-1",
          actorId: "usr-alice",
          actorName: "Alice",
          actorRole: "ReleaseManager",
          sealedAt: new Date(0).toISOString(),
          sealStatus: "SEALED",
          verificationSeal: "c".repeat(64),
        },
        qaEvidence: {
          qaRunId: "qa-1",
          overall: "PASS",
          publicationEligible: true,
          checkCount: 1,
          checks: [{ checkId: "html.valid_structure", group: "html", verdict: "PASS" }],
        },
        candidate: {
          id: "cand-1",
          artifactDigest: "b".repeat(64),
          manifestSetDigest: "m".repeat(64),
          repositorySha: "a".repeat(40),
          lockfileDigest: "l".repeat(64),
          rendererVersion: "astro-v5",
          siteProfileDigest: "s".repeat(64),
        },
        pageAuthority: {
          pageIdentity: "blog/post-1",
          productionInputId: "input-1",
          productionInputVersion: 1,
          productionInputDigest: "p".repeat(64),
          acceptedContent: { id: "c-1", version: 1, digest: "c".repeat(64) },
          acceptedDesign: { id: "d-1", version: 1, digest: "d".repeat(64) },
          acceptedVisualSet: { id: "v-1", version: 1, digest: "v".repeat(64) },
          pageArchetype: "article",
          renderer: { id: "astro", version: "astro-v5", policyVersion: "policy-v1" },
        },
      };
    },
    getMonitoringSummary: async (projectId: string) => {
      return {
        projectId,
        siteId: "site-1",
        targetProductionUrl: "https://example.com",
        activeVersionId: "ver-current-prod",
        technicalVerification: { status: "PASS", checkedAt: new Date(0).toISOString(), summary: "Passed" },
        lastOperationalCheck: { status: "PASS", checkedAt: new Date(0).toISOString(), summary: "HTTP 200 OK" },
        searchConsole: { status: "PASS", checkedAt: new Date(0).toISOString(), indexCoverage: "INDEXED", issues: [], property: "sutherland" },
        lighthouse: { status: "PASS", checkedAt: new Date(0).toISOString(), score: 98, p75LcpMs: 1200, p75Cls: 0.01 },
        fieldCwv: { status: "INSUFFICIENT_DATA", checkedAt: new Date(0).toISOString(), p75LcpMs: null, p75InpMs: null, p75Cls: null },
        observations: [],
      };
    },
    runMonitoringCheck: async (projectId: string) => {
      return {
        projectId,
        siteId: "site-1",
        targetProductionUrl: "https://example.com",
        activeVersionId: "ver-current-prod",
        technicalVerification: { status: "PASS", checkedAt: new Date().toISOString(), summary: "Passed" },
        lastOperationalCheck: { status: "PASS", checkedAt: new Date().toISOString(), summary: "HTTP 200 OK" },
        searchConsole: { status: "NOT_CONFIGURED", checkedAt: new Date().toISOString(), indexCoverage: null, issues: [], property: "sutherland" },
        lighthouse: { status: "PASS", checkedAt: new Date().toISOString(), score: 98, p75LcpMs: 1200, p75Cls: 0.01 },
        fieldCwv: { status: "INSUFFICIENT_DATA", checkedAt: new Date().toISOString(), p75LcpMs: null, p75InpMs: null, p75Cls: null },
        observations: [],
      };
    },
  } as unknown as GovernedDeliveryService;
}

function makeDeps(governedDelivery?: GovernedDeliveryService): OperatorApiDeps {
  return {
    store: {
      getProjectById: async (id: string) => (id === PROJECT.id ? PROJECT : null),
      findSiteByProjectId: async (id: string) => (id === PROJECT.id ? { id: "site-1", projectId: id } : null),
    } as unknown as OperatorApiDeps["store"],
    intake: {} as unknown as OperatorApiDeps["intake"],
    governedDelivery,
  };
}

test("Operator API - GET /api/projects/:id/deployment returns 200 with GovernedDeploymentView", async () => {
  const deps = makeDeps(makeGovernedDeliveryStub());
  const res = await callApi(deps, "GET", `/api/projects/${PROJECT.id}/deployment`);
  assert.equal(res.status, 200);
  assert.equal(res.body.projectId, PROJECT.id);
  assert.equal(res.body.targetWorkerName, "worker-sutherland");
  assert.equal(res.body.readinessState, "READY_FOR_DEPLOYMENT");
});

test("Operator API - GET /api/projects/:id/deployment fails 501 when governed delivery is not configured", async () => {
  const deps = makeDeps(undefined);
  const res = await callApi(deps, "GET", `/api/projects/${PROJECT.id}/deployment`);
  assert.equal(res.status, 501);
  assert.equal((res.body.error as { code: string }).code, "delivery_service_unavailable");
});

test("Operator API - POST /api/projects/:id/deployment/preview prepares preview successfully", async () => {
  const deps = makeDeps(makeGovernedDeliveryStub());
  const res = await callApi(deps, "POST", `/api/projects/${PROJECT.id}/deployment/preview`, {
    candidateId: "cand-1",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "preview_verified");
  assert.equal(res.body.versionId, "ver-new-prev");
});

test("Operator API - POST /api/projects/:id/deployment/preview fails 400 on missing candidateId", async () => {
  const deps = makeDeps(makeGovernedDeliveryStub());
  const res = await callApi(deps, "POST", `/api/projects/${PROJECT.id}/deployment/preview`, {});
  assert.equal(res.status, 400);
  assert.equal((res.body.error as { code: string }).code, "validation_error");
});

test("Operator API - POST /api/projects/:id/deployment/approve succeeds with valid session token", async () => {
  const deps = makeDeps(makeGovernedDeliveryStub());
  const res = await callApi(deps, "POST", `/api/projects/${PROJECT.id}/deployment/approve`, {
    candidateId: "cand-1",
    previewVersionId: "ver-prev-1",
    sessionToken: "token-valid",
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, "appr-new-1");
  assert.equal(res.body.verificationSeal, "c".repeat(64));
});

test("GET /projects/:id/deployment/lineage returns full 6-month historical authority record", async () => {
  const deps = makeDeps(makeGovernedDeliveryStub());
  const res = await callApi(
    deps,
    "GET",
    `/api/projects/${PROJECT.id}/deployment/lineage?route=/blog/post-1&asOf=2026-10-01T00:00:00.000Z`,
  );
  assert.equal(res.status, 200);
  assert.equal((res.body as any).effectiveDeployment.versionId, "ver-current-prod");
  assert.equal((res.body as any).pageAuthority.acceptedContent.id, "c-1");
  assert.equal((res.body as any).releaseApproval.actorId, "usr-alice");
  assert.equal((res.body as any).qaEvidence.overall, "PASS");
});

test("Operator API - POST /api/projects/:id/deployment/approve fails 403 when permission denied", async () => {
  const deps = makeDeps(makeGovernedDeliveryStub());
  const res = await callApi(deps, "POST", `/api/projects/${PROJECT.id}/deployment/approve`, {
    candidateId: "cand-1",
    previewVersionId: "ver-prev-1",
    sessionToken: "token-denied",
  });
  assert.equal(res.status, 403);
  assert.equal((res.body.error as { code: string }).code, "operator_permission_denied");
});

test("Operator API - POST /api/projects/:id/deployment/publish succeeds and returns verified", async () => {
  const deps = makeDeps(makeGovernedDeliveryStub());
  const res = await callApi(deps, "POST", `/api/projects/${PROJECT.id}/deployment/publish`, {
    candidateId: "cand-1",
    previewVersionId: "ver-prev-1",
    approvalId: "appr-1",
    sessionToken: "token-valid",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "verified");
  assert.equal(res.body.rolledBack, false);
});

test("Operator API - POST /api/projects/:id/deployment/publish fails 409 on stale identity drift", async () => {
  const deps = makeDeps(makeGovernedDeliveryStub());
  const res = await callApi(deps, "POST", `/api/projects/${PROJECT.id}/deployment/publish`, {
    candidateId: "cand-1",
    previewVersionId: "ver-prev-1",
    approvalId: "appr-1",
    sessionToken: "token-stale",
  });
  assert.equal(res.status, 409);
  assert.equal((res.body.error as { code: string }).code, "delivery_stale_identity");
});

test("Operator API - POST /api/projects/:id/deployment/rollback succeeds and returns rolled back", async () => {
  const deps = makeDeps(makeGovernedDeliveryStub());
  const res = await callApi(deps, "POST", `/api/projects/${PROJECT.id}/deployment/rollback`, {
    sessionToken: "token-valid",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "verified");
  assert.equal(res.body.rolledBack, true);
});

test("Operator API - POST /api/projects/:id/deployment/rollback fails 404 when no known good target", async () => {
  const deps = makeDeps(makeGovernedDeliveryStub());
  const res = await callApi(deps, "POST", `/api/projects/${PROJECT.id}/deployment/rollback`, {
    sessionToken: "token-no-target",
  });
  assert.equal(res.status, 404);
  assert.equal((res.body.error as { code: string }).code, "delivery_no_known_good_deployment");
});

test("Operator API - GET /api/projects/:id/deployment/monitoring returns 200 with MonitoringSummary", async () => {
  const deps = makeDeps(makeGovernedDeliveryStub());
  const res = await callApi(deps, "GET", `/api/projects/${PROJECT.id}/deployment/monitoring`);
  assert.equal(res.status, 200);
  assert.equal(res.body.projectId, PROJECT.id);
  assert.equal(res.body.technicalVerification.status, "PASS");
  assert.equal(res.body.searchConsole.status, "PASS");
  assert.equal(res.body.fieldCwv.status, "INSUFFICIENT_DATA");
});

test("Operator API - POST /api/projects/:id/deployment/monitoring/check runs operational check", async () => {
  const deps = makeDeps(makeGovernedDeliveryStub());
  const res = await callApi(deps, "POST", `/api/projects/${PROJECT.id}/deployment/monitoring/check`);
  assert.equal(res.status, 200);
  assert.equal(res.body.projectId, PROJECT.id);
  assert.equal(res.body.technicalVerification.status, "PASS");
  assert.equal(res.body.searchConsole.status, "NOT_CONFIGURED");
});
