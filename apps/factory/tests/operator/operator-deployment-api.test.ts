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
): Promise<{ status: number; body: Record<string, unknown> }> {
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

  await handle(
    { method, url: path, headers: {} } as unknown as import("node:http").IncomingMessage,
    res,
    path,
    body === undefined ? "" : JSON.stringify(body),
  );
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
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
  } as unknown as GovernedDeliveryService;
}

function makeDeps(governedDelivery?: GovernedDeliveryService): OperatorApiDeps {
  return {
    store: {
      getProjectById: async (id: string) => (id === PROJECT.id ? PROJECT : null),
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
