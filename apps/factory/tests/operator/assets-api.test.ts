import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import sharp from "sharp";
import { createOperatorServer } from "../../src/operator/server.js";
import type { OperatorApiDeps } from "../../src/operator/api.js";
import type { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import type { ProjectRecord } from "../../src/persistence/schema.js";
import { AssetService } from "../../src/assets/service.js";
import { AssetStore } from "../../src/assets/asset-store.js";
import { createAssetStorage } from "../../src/assets/storage.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { setupMigratedTestDatabase } from "../persistence/helpers.js";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Operator API asset acceptance (Macro Run 5): REAL HTTP server + REAL
 * PostgreSQL + REAL image bytes. Proves the full workflow through the API
 * boundary and the negative/security paths (bypass, cross-project, forged
 * digests, malformed input, caps).
 */

let dbInst: FactoryDatabaseInstance;

test.before(async () => {
  dbInst = await setupMigratedTestDatabase();
});

test.after(async () => {
  await dbInst.close();
});

const PROJECT: ProjectRecord = {
  id: "p-1",
  key: "acme",
  name: "Acme",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function makeDeps(realProjectId: string, assetService: AssetService): OperatorApiDeps {
  // The stub project record MUST carry the real DB project id: the API
  // passes project.id (from the stub) into the real asset service, which
  // enforces real foreign keys against PostgreSQL.
  const stubProject: ProjectRecord = { ...PROJECT, id: realProjectId };
  const store = {
    createProject: async () => ({ ...PROJECT, id: "new-1" }),
    listProjects: async () => [stubProject],
    getProjectById: async (id: string) => (id === realProjectId ? stubProject : null),
    getProjectByKey: async (key: string) => (key === stubProject.key ? stubProject : null),
  };
  const intake = {
    getDraft: async () => null,
    listSnapshots: async () => [],
    getSnapshot: async () => null,
  } as unknown as ProjectIntakeStore;
  return { store: store as unknown as OperatorApiDeps["store"], intake, assets: assetService };
}

interface ListenHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

async function listen(deps: OperatorApiDeps): Promise<ListenHandle> {
  const server = createOperatorServer(deps, { distDir: "/nonexistent-dist-for-tests" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function request(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers: { Host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function jsonPost(port: number, path: string, body: unknown, origin?: string) {
  return request(port, {
    method: "POST",
    path,
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function jpegBase64(width: number, height: number, seed: number): Promise<string> {
  const bytes = await sharp({
    create: { width, height, channels: 3, background: { r: seed % 256, g: (seed * 5) % 256, b: (seed * 11) % 256 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  return bytes.toString("base64");
}

const VALID_UPLOAD_BODY = {
  filename: "chamonix-hero.jpg",
  kind: "photo",
  title: "Chamonix homepage hero photograph",
  rightsStatus: "operator_owned",
};

let uniqueSuffix = Date.now();

async function makeRealService(): Promise<{ service: AssetService; projectId: string; cleanup: () => Promise<void> }> {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "asset-api-"));
  const service = new AssetService({
    store: new AssetStore(dbInst.db),
    storage: createAssetStorage(storageRoot),
    repoRoot: storageRoot,
  });
  const store = new FactoryStore(dbInst.db);
  const project = await store.createProject({ key: `api-assets-${uniqueSuffix++}`, name: "API Assets" });
  return { service, projectId: project.id, cleanup: () => rm(storageRoot, { recursive: true, force: true }) };
}

test("API: full asset workflow through the real HTTP boundary", async () => {
  const { service, projectId, cleanup } = await makeRealService();
  const h = await listen(makeDeps(projectId, service));
  try {
    // 1. Upload.
    const uploadRes = await jsonPost(h.port, `/api/projects/${projectId}/assets/uploads`, {
      ...VALID_UPLOAD_BODY,
      dataBase64: await jpegBase64(200, 140, 30),
    });
    assert.equal(uploadRes.status, 201);
    const upload = JSON.parse(uploadRes.body);
    assert.match(upload.binaryDigest, /^[0-9a-f]{64}$/);
    assert.equal(upload.version, 1);

    // 2. Workspace shows the version with provenance/rights.
    const wsRes = await request(h.port, { path: `/api/projects/${projectId}/assets/workspace` });
    assert.equal(wsRes.status, 200);
    const ws = JSON.parse(wsRes.body);
    assert.equal(ws.imageryStrategy, "none");
    assert.equal(ws.assets.length, 1);
    assert.equal(ws.assets[0]!.versions[0]!.provenance.category, "operator_upload");
    assert.equal(ws.assets[0]!.versions[0]!.rightsStatus, "operator_owned");
    assert.equal(ws.assets[0]!.versions[0]!.approvalState, "pending");

    // 3. Assignment of a PENDING version is blocked (bypass attempt).
    const bypassRes = await jsonPost(h.port, `/api/projects/${projectId}/assets/assignments`, {
      assetId: upload.assetId,
      versionId: upload.versionId,
      pageSlug: "homepage",
      role: "hero",
      expectedBinaryDigest: upload.binaryDigest,
    });
    assert.equal(bypassRes.status, 409);
    assert.equal(JSON.parse(bypassRes.body).error.code, "asset_rights_blocked");

    // 4. Approve exact digest.
    const approveRes = await jsonPost(h.port, `/api/projects/${projectId}/assets/versions/${upload.versionId}/approve`, {
      expectedBinaryDigest: upload.binaryDigest,
    });
    assert.equal(approveRes.status, 200);
    const approved = JSON.parse(approveRes.body);
    assert.equal(approved.approvalState, "approved");
    assert.match(approved.governanceDigest, /^[0-9a-f]{64}$/);

    // 5. Assign the approved version.
    const assignRes = await jsonPost(h.port, `/api/projects/${projectId}/assets/assignments`, {
      assetId: upload.assetId,
      versionId: upload.versionId,
      pageSlug: "homepage",
      role: "hero",
      expectedBinaryDigest: upload.binaryDigest,
    });
    assert.equal(assignRes.status, 201);
    const assignment = JSON.parse(assignRes.body);

    // 6. Workspace shows the assignment with exact digest binding.
    const ws2 = JSON.parse((await request(h.port, { path: `/api/projects/${projectId}/assets/workspace` })).body);
    assert.equal(ws2.assignments.length, 1);
    assert.equal(ws2.assignments[0]!.versionId, upload.versionId);
    assert.equal(ws2.assignments[0]!.binaryDigest, upload.binaryDigest);
    assert.equal(ws2.assignments[0]!.replacementAvailable, false);

    // 6b. Derivative bytes served through the client-shaped route.
    const webDerivative = upload.derivatives.find((d: { kind: string }) => d.kind === "web")!;
    const derivRes = await request(h.port, { path: `/api/projects/${projectId}/assets/derivatives/${webDerivative.id}` });
    assert.equal(derivRes.status, 200);
    assert.equal(derivRes.headers["content-type"], "image/jpeg");

    // 7. Original bytes served with the correct media type.
    const bytesRes = await request(h.port, { path: `/api/projects/${projectId}/assets/versions/${upload.versionId}/original` });
    assert.equal(bytesRes.status, 200);
    assert.equal(bytesRes.headers["content-type"], "image/jpeg");
    const { createHash } = await import("node:crypto");
    const servedBuf = Buffer.from(bytesRes.body, "utf8"); // binary round-trip via utf8-safe? no — use latin1 below
    void servedBuf;
    // Re-fetch as buffer for exact comparison:
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: h.port, path: `/api/projects/${projectId}/assets/versions/${upload.versionId}/original` }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.on("error", reject);
      req.end();
    });
    const sha256 = createHash("sha256").update(raw).digest("hex");
    assert.equal(sha256, upload.binaryDigest, "served bytes must be byte-identical to the stored original");

    // 8. Replacement version v2 -> approve -> assignment stays on v1 with staleness.
    const upload2Res = await jsonPost(h.port, `/api/projects/${projectId}/assets/uploads`, {
      ...VALID_UPLOAD_BODY,
      dataBase64: await jpegBase64(200, 140, 31),
    });
    assert.equal(upload2Res.status, 201);
    const upload2 = JSON.parse(upload2Res.body);
    assert.equal(upload2.version, 2);
    await jsonPost(h.port, `/api/projects/${projectId}/assets/versions/${upload2.versionId}/approve`, {
      expectedBinaryDigest: upload2.binaryDigest,
    });
    const ws3 = JSON.parse((await request(h.port, { path: `/api/projects/${projectId}/assets/workspace` })).body);
    const bound = ws3.assignments.find((a: { id: string }) => a.id === assignment.id)!;
    assert.equal(bound.versionId, upload.versionId, "assignment must NOT silently move to v2");
    assert.equal(bound.replacementAvailable, true);
    assert.equal(bound.latestApprovedVersionId, upload2.versionId);

    // 9. Explicit replace moves to v2.
    const replaceRes = await jsonPost(h.port, `/api/projects/${projectId}/assets/assignments/${assignment.id}/replace`, {
      toVersionId: upload2.versionId,
      expectedBinaryDigest: upload2.binaryDigest,
    });
    assert.equal(replaceRes.status, 200);
    const ws4 = JSON.parse((await request(h.port, { path: `/api/projects/${projectId}/assets/workspace` })).body);
    const boundAfter = ws4.assignments.find((a: { id: string }) => a.id === assignment.id)!;
    assert.equal(boundAfter.versionId, upload2.versionId);
    assert.equal(boundAfter.replacementAvailable, false);
  } finally {
    await h.close();
    await cleanup();
  }
});

test("API: cross-project asset access is rejected through the API", async () => {
  const { service, projectId, cleanup } = await makeRealService();
  const h = await listen(makeDeps(projectId, service));
  try {
    const uploadRes = await jsonPost(h.port, `/api/projects/${projectId}/assets/uploads`, {
      ...VALID_UPLOAD_BODY,
      dataBase64: await jpegBase64(60, 40, 32),
    });
    const upload = JSON.parse(uploadRes.body);

    // Unknown project id -> generic not_found (no project scoping leak).
    const unknownProject = await jsonPost(h.port, `/api/projects/other-project-id/assets/versions/${upload.versionId}/approve`, {
      expectedBinaryDigest: upload.binaryDigest,
    });
    assert.equal(unknownProject.status, 404);
    assert.equal(JSON.parse(unknownProject.body).error.code, "not_found");

    // Known project, forged version id -> typed version not-found.
    const forgedVersion = await jsonPost(h.port, `/api/projects/${projectId}/assets/versions/asv-00000000-0000-0000-0000-000000000000/approve`, {
      expectedBinaryDigest: upload.binaryDigest,
    });
    assert.equal(forgedVersion.status, 404);
    assert.equal(JSON.parse(forgedVersion.body).error.code, "asset_version_not_found");

    // Known project, REAL version id from a DIFFERENT project (cross-project
    // reference through the service layer) -> version not found, never a
    // successful approval.
    const otherProject = await makeRealService();
    try {
      const crossRes = await jsonPost(h.port, `/api/projects/${otherProject.projectId}/assets/versions/${upload.versionId}/approve`, {
        expectedBinaryDigest: upload.binaryDigest,
      });
      // The other project is unknown to THIS server's project stub, so the
      // project gate rejects first (fail closed either way).
      assert.equal(crossRes.status, 404);
    } finally {
      await otherProject.cleanup();
    }
  } finally {
    await h.close();
    await cleanup();
  }
});

test("API: malformed upload payloads are rejected with validation_error", async () => {
  const { service, projectId, cleanup } = await makeRealService();
  const h = await listen(makeDeps(projectId, service));
  try {
    const bad = await jsonPost(h.port, `/api/projects/${projectId}/assets/uploads`, {
      ...VALID_UPLOAD_BODY,
      dataBase64: "not-base64!!!",
    });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).error.code, "validation_error");

    const missing = await jsonPost(h.port, `/api/projects/${projectId}/assets/uploads`, {
      filename: "x.jpg",
    });
    assert.equal(missing.status, 400);

    const notJson = await request(h.port, {
      method: "POST",
      path: `/api/projects/${projectId}/assets/uploads`,
      headers: { "Content-Type": "application/json" },
      body: "{invalid",
    });
    assert.equal(notJson.status, 400);
    assert.equal(JSON.parse(notJson.body).error.code, "invalid_json");
  } finally {
    await h.close();
    await cleanup();
  }
});

test("API: cross-origin mutation is rejected for asset endpoints (same middleware)", async () => {
  const { service, projectId, cleanup } = await makeRealService();
  const h = await listen(makeDeps(projectId, service));
  try {
    const res = await jsonPost(h.port, `/api/projects/${projectId}/assets/uploads`, {
      ...VALID_UPLOAD_BODY,
      dataBase64: await jpegBase64(40, 30, 33),
    }, "http://evil.example.com");
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).error.code, "cross_origin_forbidden");
  } finally {
    await h.close();
    await cleanup();
  }
});

test("API: upload body above the raised asset cap is rejected with 413", async () => {
  const { service, projectId, cleanup } = await makeRealService();
  const h = await listen(makeDeps(projectId, service));
  try {
    // >34 MiB of JSON: the route-specific cap must fire before parsing.
    const huge = "A".repeat(34 * 1024 * 1024 + 10);
    const res = await jsonPost(h.port, `/api/projects/${projectId}/assets/uploads`, {
      ...VALID_UPLOAD_BODY,
      dataBase64: huge,
    });
    assert.equal(res.status, 413);
    assert.equal(JSON.parse(res.body).error.code, "payload_too_large");
  } finally {
    await h.close();
    await cleanup();
  }
});

test("API: spoofed bytes (text with .jpg filename) are rejected server-side", async () => {
  const { service, projectId, cleanup } = await makeRealService();
  const h = await listen(makeDeps(projectId, service));
  try {
    const res = await jsonPost(h.port, `/api/projects/${projectId}/assets/uploads`, {
      ...VALID_UPLOAD_BODY,
      dataBase64: Buffer.from("this is definitely not an image", "utf8").toString("base64"),
    });
    assert.equal(res.status, 422);
    assert.equal(JSON.parse(res.body).error.code, "asset_upload_invalid");
  } finally {
    await h.close();
    await cleanup();
  }
});

test("API: unknown asset endpoints 404; unknown project 404", async () => {
  const { service, projectId, cleanup } = await makeRealService();
  const h = await listen(makeDeps(projectId, service));
  try {
    const unknownEndpoint = await request(h.port, { path: `/api/projects/${projectId}/assets/nonsense` });
    assert.equal(unknownEndpoint.status, 404);

    const unknownProject = await request(h.port, { path: `/api/projects/nope/assets/workspace` });
    assert.equal(unknownProject.status, 404);

    // Forged version id: typed not-found.
    const forged = await request(h.port, { path: `/api/projects/${projectId}/assets/versions/asv-00000000-0000-0000-0000-000000000000/original` });
    assert.equal(forged.status, 404);
    assert.equal(JSON.parse(forged.body).error.code, "asset_version_not_found");
  } finally {
    await h.close();
    await cleanup();
  }
});

test("API: metadata update on approved version is rejected with asset_version_immutable", async () => {
  const { service, projectId, cleanup } = await makeRealService();
  const h = await listen(makeDeps(projectId, service));
  try {
    const uploadRes = await jsonPost(h.port, `/api/projects/${projectId}/assets/uploads`, {
      ...VALID_UPLOAD_BODY,
      dataBase64: await jpegBase64(60, 40, 34),
    });
    const upload = JSON.parse(uploadRes.body);
    await jsonPost(h.port, `/api/projects/${projectId}/assets/versions/${upload.versionId}/approve`, {
      expectedBinaryDigest: upload.binaryDigest,
    });
    const res = await request(h.port, {
      method: "PUT",
      path: `/api/projects/${projectId}/assets/versions/${upload.versionId}/metadata`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rightsStatus: "licensed", expectedBinaryDigest: upload.binaryDigest }),
    });
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.body).error.code, "asset_version_immutable");
  } finally {
    await h.close();
    await cleanup();
  }
});

test("API: settings round-trip through the API", async () => {
  const { service, projectId, cleanup } = await makeRealService();
  const h = await listen(makeDeps(projectId, service));
  try {
    const res = await request(h.port, {
      method: "PUT",
      path: `/api/projects/${projectId}/assets/settings`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageryStrategy: "operator" }),
    });
    assert.equal(res.status, 200);
    const ws = JSON.parse((await request(h.port, { path: `/api/projects/${projectId}/assets/workspace` })).body);
    assert.equal(ws.imageryStrategy, "operator");
  } finally {
    await h.close();
    await cleanup();
  }
});
