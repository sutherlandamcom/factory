import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createOperatorApi } from "../../src/operator/api.js";
import { createOperatorServer } from "../../src/operator/server.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { DesignStore } from "../../src/design/design-store.js";
import { DesignService } from "../../src/design/service.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";
import { setupMigratedTestDatabase } from "../persistence/helpers.js";
import type { DesignProvider, DesignProviderPreflight, DesignGenerationResult } from "@factory/contracts";
import { parseDesignCandidateData, type DesignCandidateData } from "@factory/contracts";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";

/** Shared migrated DB for the file; truncated once at file start. */
let dbInst: FactoryDatabaseInstance | null = null;

/**
 * Run 6 Operator API suite — semantic endpoints, project isolation, and
 * direct-API bypass rejection (fail-closed governance), against a real
 * in-process server.
 */

class StubDesignProvider implements DesignProvider {
  readonly id = "google-stitch";
  readonly preflightResult: DesignProviderPreflight;
  generationCalls = 0;

  constructor(preflightResult: DesignProviderPreflight) {
    this.preflightResult = preflightResult;
  }

  async preflight(): Promise<DesignProviderPreflight> {
    return this.preflightResult;
  }

  async generateDesignSystem(): Promise<DesignGenerationResult> {
    this.generationCalls += 1;
    void this.preflightResult;
    // The stub's DESIGN.md bytes and their digest must be consistent: the
    // service layer verifies the candidate's designMdDigest against the
    // stored artifact bytes (content-addressed binding enforcement).
    const designMdBytes = new TextEncoder().encode(
      "---\nname: Stub\n\ncolors:\n  primary: \"#1A2E35\"\ntypography:\n  h1:\n    fontFamily: Source Serif 4\n    fontSize: 3rem\n---\n\n## Overview\nStub.\n",
    );
    const designMdDigest = createHash("sha256").update(designMdBytes).digest("hex");
    const candidate: DesignCandidateData = parseDesignCandidateData({
      schemaVersion: "design-v1",
      provider: "google-stitch",
      providerMode: "fixture",
      providerProjectName: "projects/stub",
      designMdDigest,
      designMdToolVersion: "factory-design-md-lint-v1",
      designMdLint: { errors: 0, warnings: 0, infos: 0 },
      designSeed: {
        colors: { primary: "#1A2E35" },
        typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
        rationale: "Seed rationale",
      },
      providerEvidence: {},
      tokens: {
        colors: { primary: "#1A2E35" },
        typography: { headingFont: "Source Serif 4", bodyFont: "Public Sans" },
        spacing: { md: "16px" },
        rounded: { md: "8px" },
      },
      screens: [
        {
          id: "screen-1",
          providerScreenName: "projects/stub/screens/abc",
          title: "Homepage",
          deviceType: "DESKTOP",
          archetype: "homepage",
        },
      ],
      archetypes: [
        {
          kind: "homepage",
          purpose: "Trust-first entry",
          providerScreenNames: ["projects/stub/screens/abc"],
          sectionPatterns: ["hero", "evidence", "cta"],
          contentRequirements: ["Primary CTA visible"],
          assetSlots: [
          {
            slot: "hero.primary",
            requirement: "Hero placeholder",
            pageSlug: "home",
            role: "hero",
            requiredRole: "hero",
            providerConsumed: false,
            placeholder: true,
            unresolvedReason: "No approved asset assignment for home/hero.",
          },
        ],
          primaryCta: "Request assessment",
          secondaryCta: "",
          responsiveBehavior: "Mobile-first stack",
          trustPresentation: "Author/date areas visible",
        },
      ],
      rationale: "Stub rationale",
    });
    return {
      candidate,
      rawArtifacts: [
        {
          kind: "design_md",
          bytes: designMdBytes,
          mediaType: "text/markdown",
          providerRef: null,
        },
        {
          kind: "provider_response",
          bytes: new TextEncoder().encode(JSON.stringify({ stub: true })),
          mediaType: "application/json",
          providerRef: "projects/stub",
        },
      ],
      providerProjectName: "projects/stub",
      providerSessionId: "stub-session",
    };
  }
}

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(provider: StubDesignProvider): Promise<TestServer> {
  // One migrated DB for the whole file (truncate-once semantics like the
  // assets API suite); per-test isolation comes from uniquely-keyed
  // projects, never from mid-suite truncation that would race sibling
  // suites sharing the dedicated test database.
  dbInst = dbInst ?? (await setupMigratedTestDatabase());
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const designStore = new DesignStore(dbInst.db);
  const design = await DesignService.create({ store: designStore, provider });
  const server = createOperatorServer({
    store,
    intake,
    design,
  } as never);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // The shared DB is closed once when the last server stops is not
      // trackable here; closing per server is safe (each server has its own
      // pool-free store view over the shared dbInst, which stays open).
    },
  };
}

async function createProjectWithAcceptedInputs(baseUrl: string, key: string): Promise<string> {
  const createRes = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, name: `Project ${key}` }),
  });
  assert.equal(createRes.status, 201);
  const project = (await createRes.json()) as { id: string };
  const payload = buildIntakePayload();
  const saveRes = await fetch(`${baseUrl}/api/projects/${project.id}/intake-draft`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseRevision: 0, payload }),
  });
  assert.equal(saveRes.status, 200);
  const acceptRes = await fetch(`${baseUrl}/api/projects/${project.id}/intake/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1, expectedDigest: deterministicDigest(payload) }),
  });
  assert.equal(acceptRes.status, 200);
  return project.id;
}

test("design API: workspace reflects provider preflight and empty state", async () => {
  const provider = new StubDesignProvider({ configured: false, provider: "google-stitch", reason: "not configured" });
  const server = await startTestServer(provider);
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "dap1");
    const res = await fetch(`${server.baseUrl}/api/projects/${projectId}/design/workspace`);
    assert.equal(res.status, 200);
    const ws = (await res.json()) as { provider: { preflight: DesignProviderPreflight }; candidates: unknown[]; accepted: unknown };
    assert.equal(ws.provider.preflight.configured, false);
    assert.deepEqual(ws.candidates, []);
    assert.equal(ws.accepted, null);
  } finally {
    await server.close();
  }
});

test("design API: generation fails closed when provider is not configured", async () => {
  const provider = new StubDesignProvider({ configured: false, provider: "google-stitch", reason: "not configured" });
  const server = await startTestServer(provider);
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "dap2");
    // Derive input snapshot first (no provider call needed).
    const deriveRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/design/input-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: "design-v1" }),
    });
    assert.equal(deriveRes.status, 201);
    const genRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/design/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(genRes.status, 409);
    const body = (await genRes.json()) as { error: { code: string } };
    assert.equal(body.error.code, "design_provider_not_configured");
    assert.equal(provider.generationCalls, 0, "no provider call may happen when preflight fails");
  } finally {
    await server.close();
  }
});

test("design API: generate -> accept happy path binds candidate digest; forged digest rejected", async () => {
  const provider = new StubDesignProvider({ configured: true, provider: "google-stitch", reachable: true });
  const server = await startTestServer(provider);
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "dap3");
    await fetch(`${server.baseUrl}/api/projects/${projectId}/design/input-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: "design-v1" }),
    });
    const genRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/design/generate`, { method: "POST", headers: { "Content-Type": "application/json" } });
    assert.equal(genRes.status, 201);
    const gen = (await genRes.json()) as { id: string; candidateDigest: string };

    // Forged digest fails closed.
    const forgedRes = await fetch(
      `${server.baseUrl}/api/projects/${projectId}/design/candidates/${gen.id}/accept`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: gen.id, expectedCandidateDigest: "f".repeat(64) }),
      },
    );
    assert.equal(forgedRes.status, 409);
    const forgedBody = (await forgedRes.json()) as { error: { code: string } };
    assert.equal(forgedBody.error.code, "design_approval_failed");

    // Correct digest accepts.
    const acceptRes = await fetch(
      `${server.baseUrl}/api/projects/${projectId}/design/candidates/${gen.id}/accept`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: gen.id, expectedCandidateDigest: gen.candidateDigest, reviewNotes: "fixture acceptance" }),
      },
    );
    assert.equal(acceptRes.status, 200);
    const accepted = (await acceptRes.json()) as { version: number; candidateDigest: string };
    assert.equal(accepted.version, 1);
    assert.equal(accepted.candidateDigest, gen.candidateDigest);

    // Workspace shows the accepted design.
    const wsRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/design/workspace`);
    const ws = (await wsRes.json()) as { accepted: { candidateDigest: string } | null };
    assert.equal(ws.accepted?.candidateDigest, gen.candidateDigest);
  } finally {
    await server.close();
  }
});

test("design API: rejected candidate can never be accepted through direct API", async () => {
  const provider = new StubDesignProvider({ configured: true, provider: "google-stitch", reachable: true });
  const server = await startTestServer(provider);
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "dap4");
    await fetch(`${server.baseUrl}/api/projects/${projectId}/design/input-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: "design-v1" }),
    });
    const genRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/design/generate`, { method: "POST", headers: { "Content-Type": "application/json" } });
    const gen = (await genRes.json()) as { id: string; candidateDigest: string };

    const rejectRes = await fetch(
      `${server.baseUrl}/api/projects/${projectId}/design/candidates/${gen.id}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateId: gen.id,
          expectedCandidateDigest: gen.candidateDigest,
          reviewNotes: "Quality floor",
        }),
      },
    );
    assert.equal(rejectRes.status, 200);

    const acceptRes = await fetch(
      `${server.baseUrl}/api/projects/${projectId}/design/candidates/${gen.id}/accept`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: gen.id, expectedCandidateDigest: gen.candidateDigest }),
      },
    );
    assert.equal(acceptRes.status, 409);
  } finally {
    await server.close();
  }
});

test("design API: cross-project candidate access fails closed", async () => {
  const provider = new StubDesignProvider({ configured: true, provider: "google-stitch", reachable: true });
  const server = await startTestServer(provider);
  try {
    const projectA = await createProjectWithAcceptedInputs(server.baseUrl, "dap5a");
    const projectB = await createProjectWithAcceptedInputs(server.baseUrl, "dap5b");
    await fetch(`${server.baseUrl}/api/projects/${projectA}/design/input-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: "design-v1" }),
    });
    const genRes = await fetch(`${server.baseUrl}/api/projects/${projectA}/design/generate`, { method: "POST", headers: { "Content-Type": "application/json" } });
    const gen = (await genRes.json()) as { id: string; candidateDigest: string };

    const crossRes = await fetch(
      `${server.baseUrl}/api/projects/${projectB}/design/candidates/${gen.id}/accept`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: gen.id, expectedCandidateDigest: gen.candidateDigest }),
      },
    );
    assert.equal(crossRes.status, 404);
  } finally {
    await server.close();
  }
});

test("design API: artifact serving requires valid digest; unknown digest is 404", async () => {
  const provider = new StubDesignProvider({ configured: true, provider: "google-stitch", reachable: true });
  const server = await startTestServer(provider);
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "dap6");
    const badRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/design/artifacts/not-a-digest`);
    assert.equal(badRes.status, 400);
    const missingRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/design/artifacts/${"e".repeat(64)}`);
    assert.equal(missingRes.status, 404);
  } finally {
    await server.close();
  }
});

test("design API: fixture candidate CANNOT be accepted as production design authority without explicit fixture declaration", async () => {
  const provider = new StubDesignProvider({ configured: true, provider: "google-stitch", reachable: true });
  const server = await startTestServer(provider);
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "dap7");
    await fetch(`${server.baseUrl}/api/projects/${projectId}/design/input-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: "design-v1" }),
    });
    const genRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/design/generate`, { method: "POST", headers: { "Content-Type": "application/json" } });
    assert.equal(genRes.status, 201);
    const gen = (await genRes.json()) as { id: string; candidateDigest: string };

    // Acceptance WITHOUT the fixture declaration fails closed.
    const silentRes = await fetch(
      `${server.baseUrl}/api/projects/${projectId}/design/candidates/${gen.id}/accept`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: gen.id, expectedCandidateDigest: gen.candidateDigest }),
      },
    );
    assert.equal(silentRes.status, 409);
    const silentBody = (await silentRes.json()) as { error: { code: string; message: string } };
    assert.equal(silentBody.error.code, "design_approval_failed");
    assert.match(silentBody.error.message, /fixture/i);

    // Acceptance WITH the explicit fixture declaration succeeds.
    const declaredRes = await fetch(
      `${server.baseUrl}/api/projects/${projectId}/design/candidates/${gen.id}/accept`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateId: gen.id,
          expectedCandidateDigest: gen.candidateDigest,
          reviewNotes: "fixture acceptance — development journey only",
        }),
      },
    );
    assert.equal(declaredRes.status, 200);
  } finally {
    await server.close();
  }
});

test("design API: providerMode survives persistence and restart; artifact reads are project-scoped", async () => {
  const provider = new StubDesignProvider({ configured: true, provider: "google-stitch", reachable: true });
  const server = await startTestServer(provider);
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "dap8");
    await fetch(`${server.baseUrl}/api/projects/${projectId}/design/input-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: "design-v1" }),
    });
    const genRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/design/generate`, { method: "POST", headers: { "Content-Type": "application/json" } });
    assert.equal(genRes.status, 201);
    const gen = (await genRes.json()) as { id: string; candidateDigest: string };
    await fetch(`${server.baseUrl}/api/projects/${projectId}/design/candidates/${gen.id}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidateId: gen.id,
        expectedCandidateDigest: gen.candidateDigest,
        reviewNotes: "fixture acceptance",
      }),
    });

    // providerMode is durable in the candidate and accepted artifact rows
    // (fresh DB read, not the in-memory stub).
    const wsRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/design/workspace`);
    const ws = (await wsRes.json()) as { accepted: { providerProjectName: string } | null };
    assert.ok(ws.accepted, "accepted design present");

    // The accepted artifact's providerMode is carried from the candidate.
    const modeRows = await dbInst!.db.execute<{ provider_mode: string }>(
      sql`SELECT provider_mode FROM accepted_design_artifacts WHERE project_id = ${projectId}`,
    );
    assert.equal(modeRows.rows[0]?.provider_mode, "fixture", "accepted artifact durably records providerMode=fixture");
  } finally {
    await server.close();
  }
});

test("design API: cross-project artifact digest read fails closed (project-scoped authorization)", async () => {
  const provider = new StubDesignProvider({ configured: true, provider: "google-stitch", reachable: true });
  const server = await startTestServer(provider);
  try {
    const projectA = await createProjectWithAcceptedInputs(server.baseUrl, "dap9a");
    const projectB = await createProjectWithAcceptedInputs(server.baseUrl, "dap9b");
    await fetch(`${server.baseUrl}/api/projects/${projectA}/design/input-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: "design-v1" }),
    });
    const genRes = await fetch(`${server.baseUrl}/api/projects/${projectA}/design/generate`, { method: "POST", headers: { "Content-Type": "application/json" } });
    assert.equal(genRes.status, 201);
    const gen = (await genRes.json()) as { id: string; candidateDigest: string };

    // The DESIGN.md artifact digest belongs to project A.
    const refRows = await dbInst!.db.execute<{ artifact_digest: string }>(
      sql`SELECT artifact_digest FROM design_artifact_refs WHERE project_id = ${projectA} LIMIT 1`,
    );
    const refRow = refRows.rows[0];
    assert.ok(refRow, "project A has artifact refs recorded");

    // Project A CAN read its own artifact.
    const ownRes = await fetch(`${server.baseUrl}/api/projects/${projectA}/design/artifacts/${refRow.artifact_digest}`);
    assert.equal(ownRes.status, 200);

    // Project B CANNOT read project A's artifact digest — the digest is not
    // an authorization mechanism; authorization is project-scoped.
    const crossRes = await fetch(`${server.baseUrl}/api/projects/${projectB}/design/artifacts/${refRow.artifact_digest}`);
    assert.equal(crossRes.status, 404, "cross-project artifact read must fail closed");
  } finally {
    await server.close();
  }
});
