import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createOperatorApi, type OperatorApiDeps } from "../../src/operator/api.js";
import { deriveProjectWorkflow } from "../../src/operator/workflow.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { setupMigratedTestDatabase } from "../persistence/helpers.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";

/**
 * Macro Run 11 — direct-API workflow endpoint tests.
 *
 * Proves the read endpoints through the REAL operator API handler:
 * project isolation (foreign project → 404), read-only semantics
 * (no write actions exist on workflow routes), and correct payload shape.
 */

interface ListenHandle {
  port: number;
  close: () => Promise<void>;
}

async function listen(deps: OperatorApiDeps): Promise<ListenHandle> {
  const handler = createOperatorApi(deps);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handler(req, res, url.pathname, "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("workflow API: read routes expose the derived read model with project isolation", async () => {
  const dbInst = await setupMigratedTestDatabase();
  try {
    const store = new FactoryStore(dbInst.db);
    const intake = new ProjectIntakeStore(dbInst.db);
    const deps: OperatorApiDeps = { store, intake } as unknown as OperatorApiDeps;
    const handle = await listen(deps);
    try {
      const pA = await store.createProject({ key: "wfapi-a", name: "A" });
      const pB = await store.createProject({ key: "wfapi-b", name: "B" });

      // Give project A real accepted authority project B must never see.
      const payload = buildIntakePayload();
      await intake.saveDraft({ projectId: pA.id, baseRevision: 0, payload });
      await intake.accept({ projectId: pA.id, expectedRevision: 1, expectedDigest: deterministicDigest(payload) });

      const wfA = await get(handle.port, `/api/projects/${pA.id}/workflow`);
      assert.equal(wfA.status, 200);
      const wfBody = wfA.body as { projectId: string; overall: string; areas: Array<{ area: string; state: string }>; nextAction: { actionId: string } | null; deployment: { state: string } };
      assert.equal(wfBody.projectId, pA.id);
      assert.ok(Array.isArray(wfBody.areas));
      assert.ok(wfBody.areas.some((a) => a.area === "intake" && a.state === "ACCEPTED"));

      // Project B sees no project-A authority.
      const wfB = await get(handle.port, `/api/projects/${pB.id}/workflow`);
      assert.equal(wfB.status, 200);
      const wfBBody = wfB.body as { projectId: string; areas: Array<{ area: string; state: string }> };
      assert.equal(wfBBody.projectId, pB.id);
      assert.equal(wfBBody.areas.find((a) => a.area === "intake")?.state, "NOT_STARTED");

      // Unknown project → 404 typed error.
      const missing = await get(handle.port, "/api/projects/nonexistent/workflow");
      assert.equal(missing.status, 404);
      assert.equal((missing.body as { error?: { code?: string } }).error?.code, "not_found");

      // Versions + costs routes respond with correct shapes.
      const versions = await get(handle.port, `/api/projects/${pA.id}/workflow-versions`);
      assert.equal(versions.status, 200);
      assert.ok(Array.isArray((versions.body as { artifacts: unknown[] }).artifacts));

      const costs = await get(handle.port, `/api/projects/${pA.id}/workflow-costs`);
      assert.equal(costs.status, 200);
      assert.ok(Array.isArray((costs.body as { rows: unknown[] }).rows));

      // Workflow routes are read-only: a POST to the same path is not found.
      const postRes = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: handle.port, method: "POST", path: `/api/projects/${pA.id}/workflow` },
          (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(postRes.status, 404);

      // Direct derivation agrees with the API payload for the same project.
      const direct = await deriveProjectWorkflow({ db: dbInst.db, intake }, pA.id);
      assert.equal(direct!.projectId, wfBody.projectId);
      assert.equal(direct!.overall, wfBody.overall);
    } finally {
      await handle.close();
    }
  } finally {
    await dbInst.close();
  }
});
