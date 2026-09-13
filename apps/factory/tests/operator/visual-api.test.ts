import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createOperatorApi } from "../../src/operator/api.js";
import { createOperatorServer } from "../../src/operator/server.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { DesignStore } from "../../src/design/design-store.js";
import { DesignService } from "../../src/design/service.js";
import { AssetStore } from "../../src/assets/asset-store.js";
import { AssetService } from "../../src/assets/service.js";
import { createAssetStorage } from "../../src/assets/storage.js";
import { VisualStore } from "../../src/visual/store.js";
import { VisualService } from "../../src/visual/service.js";
import { VisualBudgetStore } from "../../src/visual/budget.js";
import { FixtureVisualAssetProvider } from "../../src/visual/fixture-adapter.js";
import { createVisualCandidateStorage } from "../../src/visual/candidate-storage.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";
import { setupMigratedTestDatabase } from "../persistence/helpers.js";
import { parseDesignCandidateData, type DesignCandidateData } from "@factory/contracts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";

/**
 * Run 7 Operator API suite — semantic endpoints, project isolation, and
 * direct-API bypass rejection (fail-closed governance), against a real
 * in-process server. Fixture visual provider only: zero paid calls.
 */

let dbInst: Awaited<ReturnType<typeof setupMigratedTestDatabase>> | null = null;
let storageRoot: string | null = null;

function candidateData(designMdDigest: string): DesignCandidateData {
  return parseDesignCandidateData({
    schemaVersion: "design-v1",
    provider: "google-stitch",
    providerMode: "fixture",
    providerProjectName: "projects/fixture",
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
        providerScreenName: "projects/fixture/screens/abc",
        title: "Homepage",
        deviceType: "DESKTOP",
        archetype: "homepage",
      },
    ],
    archetypes: [
      {
        kind: "homepage",
        purpose: "Trust-first entry",
        providerScreenNames: ["projects/fixture/screens/abc"],
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
    rationale: "Fixture rationale",
  });
}

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  dbInst = dbInst ?? (await setupMigratedTestDatabase());
  storageRoot = storageRoot ?? (await mkdtemp(`${tmpdir()}/visual-api-`));
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const designStore = new DesignStore(dbInst.db);
  const design = await DesignService.create({ store: designStore, provider: {
    id: "google-stitch",
    async preflight() {
      return { configured: true, provider: "google-stitch", reachable: true };
    },
    async generateDesignSystem() {
      // The stub's DESIGN.md bytes and their digest must be consistent: the
      // service layer verifies the candidate's designMdDigest against the
      // stored artifact bytes (content-addressed binding enforcement).
      const designMdBytes = new TextEncoder().encode(
        "---\nname: Stub\n\ncolors:\n  primary: \"#1A2E35\"\ntypography:\n  h1:\n    fontFamily: Source Serif 4\n    fontSize: 3rem\n---\n\n## Overview\nStub.\n",
      );
      const designMdDigest = createHash("sha256").update(designMdBytes).digest("hex");
      const candidate = candidateData(designMdDigest);
      return {
        candidate,
        rawArtifacts: [
          { kind: "design_md" as const, bytes: designMdBytes, mediaType: "text/markdown", providerRef: null },
          { kind: "provider_response" as const, bytes: new TextEncoder().encode("{}"), mediaType: "application/json", providerRef: "stub" },
        ],
        providerProjectName: "projects/stub",
        providerSessionId: "stub-session",
      };
    },
  } });
  const assets = new AssetService({
    store: new AssetStore(dbInst.db),
    storage: createAssetStorage(storageRoot),
  });
  const visual = new VisualService({
    store: new VisualStore(dbInst.db),
    designStore,
    assets,
    budget: new VisualBudgetStore(dbInst.db),
    provider: new FixtureVisualAssetProvider(),
    repoRoot: storageRoot,
    storage: createVisualCandidateStorage(storageRoot),
  });
  const server = createOperatorServer({ store, intake, design, assets, visual } as never);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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

/** Accept a fixture design via the API (fixture declaration in review notes). */
async function acceptFixtureDesign(baseUrl: string, projectId: string): Promise<{ candidateDigest: string }> {
  const deriveRes = await fetch(`${baseUrl}/api/projects/${projectId}/design/input-snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(deriveRes.status, 201);
  const genRes = await fetch(`${baseUrl}/api/projects/${projectId}/design/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(genRes.status, 201);
  const gen = (await genRes.json()) as { id: string; candidateDigest: string };
  const acceptRes = await fetch(`${baseUrl}/api/projects/${projectId}/design/candidates/${gen.id}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateId: gen.id, expectedCandidateDigest: gen.candidateDigest, reviewNotes: "fixture acceptance" }),
  });
  assert.equal(acceptRes.status, 200);
  return { candidateDigest: gen.candidateDigest };
}

async function uploadApprovedAsset(baseUrl: string, projectId: string, seed: number): Promise<{ versionId: string; binaryDigest: string }> {
  const bytes = await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: seed, g: 70, b: 90 } } }).jpeg().toBuffer();
  const uploadRes = await fetch(`${baseUrl}/api/projects/${projectId}/assets/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dataBase64: bytes.toString("base64"),
      filename: "source.jpg",
      kind: "photo",
      title: "Visual API source",
      rightsStatus: "operator_owned",
    }),
  });
  assert.equal(uploadRes.status, 201);
  const upload = (await uploadRes.json()) as { versionId: string; binaryDigest: string };
  const approveRes = await fetch(`${baseUrl}/api/projects/${projectId}/assets/versions/${upload.versionId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedBinaryDigest: upload.binaryDigest }),
  });
  assert.equal(approveRes.status, 200);
  return { versionId: upload.versionId, binaryDigest: upload.binaryDigest };
}

interface FullFixtureJourney {
  planId: string;
  promptSnapshotId: string;
  promptDigest: string;
  candidateId: string;
  candidateDigest: string;
}

async function runThroughGeneration(baseUrl: string, projectId: string, truthClass: string): Promise<FullFixtureJourney> {
  const planRes = await fetch(`${baseUrl}/api/projects/${projectId}/visual/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(planRes.status, 201);
  const plan = (await planRes.json()) as { id: string };

  const classifyRes = await fetch(`${baseUrl}/api/projects/${projectId}/visual/plans/${plan.id}/slots/hero.primary/classification`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ truthClass, acknowledged: true }),
  });
  assert.equal(classifyRes.status, 200);

  const compileRes = await fetch(`${baseUrl}/api/projects/${projectId}/visual/plans/${plan.id}/slots/hero.primary/prompt-snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation: "generate" }),
  });
  assert.equal(compileRes.status, 201);
  const snapshot = (await compileRes.json()) as { id: string; promptDigest: string };

  const approveRes = await fetch(`${baseUrl}/api/projects/${projectId}/visual/prompt-snapshots/${snapshot.id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ promptDigest: snapshot.promptDigest }),
  });
  assert.equal(approveRes.status, 200);

  const genRes = await fetch(`${baseUrl}/api/projects/${projectId}/visual/plans/${plan.id}/slots/hero.primary/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(genRes.status, 201);
  const gen = (await genRes.json()) as { candidates: Array<{ id: string; binaryDigest: string }>; reused: boolean };
  assert.equal(gen.reused, false);
  return { planId: plan.id, promptSnapshotId: snapshot.id, promptDigest: snapshot.promptDigest, candidateId: gen.candidates[0]!.id, candidateDigest: gen.candidates[0]!.binaryDigest };
}

test("visual API: workspace reflects fixture preflight and empty state", async () => {
  const server = await startTestServer();
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "vap1");
    const res = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/workspace`);
    assert.equal(res.status, 200);
    const ws = (await res.json()) as { provider: { providerMode: string }; plan: unknown; slots: unknown[]; acceptedSet: unknown };
    assert.equal(ws.provider.providerMode, "fixture");
    assert.equal(ws.plan, null);
    assert.deepEqual(ws.slots, []);
    assert.equal(ws.acceptedSet, null);
  } finally {
    await server.close();
  }
});

test("visual API: plan derivation fails closed without an accepted design", async () => {
  const server = await startTestServer();
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "vap2");
    const res = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "visual_design_not_eligible");
  } finally {
    await server.close();
  }
});

test("visual API: generation without approved prompt fails closed (zero spend)", async () => {
  const server = await startTestServer();
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "vap3");
    await acceptFixtureDesign(server.baseUrl, projectId);
    const planRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const plan = (await planRes.json()) as { id: string };
    const classifyRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plans/${plan.id}/slots/hero.primary/classification`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ truthClass: "illustrative", acknowledged: true }),
    });
    assert.equal(classifyRes.status, 200);
    // Generate without any prompt snapshot -> typed failure.
    const genRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plans/${plan.id}/slots/hero.primary/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(genRes.status, 409);
    const body = (await genRes.json()) as { error: { code: string } };
    assert.equal(body.error.code, "visual_prompt_not_approved");
  } finally {
    await server.close();
  }
});

test("visual API: full fixture journey — plan -> classify -> prompt -> approve -> generate -> accept -> set", async () => {
  const server = await startTestServer();
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "vap4");
    await acceptFixtureDesign(server.baseUrl, projectId);
    const journey = await runThroughGeneration(server.baseUrl, projectId, "illustrative");

    // Candidate bytes are servable and match the recorded digest.
    const bytesRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/candidates/${journey.candidateId}/bytes`);
    assert.equal(bytesRes.status, 200);
    const bytes = new Uint8Array(await bytesRes.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest, journey.candidateDigest);

    // Accept the candidate.
    const acceptRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plans/${journey.planId}/slots/hero.primary/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId: journey.candidateId, expectedBinaryDigest: journey.candidateDigest }),
    });
    assert.equal(acceptRes.status, 200);
    const accepted = (await acceptRes.json()) as { versionId: string; governanceDigest: string; assignmentId: string; truthClass: string };
    assert.ok(accepted.versionId.startsWith("asv-"));
    assert.ok(accepted.governanceDigest);
    assert.ok(accepted.assignmentId);
    assert.equal(accepted.truthClass, "illustrative");

    // The Run 5 workspace now shows the assignment.
    const assetsWs = await fetch(`${server.baseUrl}/api/projects/${projectId}/assets/workspace`);
    const assets = (await assetsWs.json()) as { assignments: Array<{ pageSlug: string; role: string }> };
    assert.ok(assets.assignments.some((a) => a.pageSlug === "home" && a.role === "hero"));

    // Accept the set.
    const setRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plans/${journey.planId}/accept-set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(setRes.status, 200);
    const set = (await setRes.json()) as { id: string; version: number; setDigest: string };
    assert.equal(set.version, 1);

    // Workspace reflects the accepted set.
    const wsRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/workspace`);
    const ws = (await wsRes.json()) as { acceptedSet: { id: string } | null };
    assert.equal(ws.acceptedSet?.id, set.id);
  } finally {
    await server.close();
  }
});

test("visual API: forged candidate digest acceptance fails closed", async () => {
  const server = await startTestServer();
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "vap5");
    await acceptFixtureDesign(server.baseUrl, projectId);
    const journey = await runThroughGeneration(server.baseUrl, projectId, "illustrative");
    const acceptRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plans/${journey.planId}/slots/hero.primary/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId: journey.candidateId, expectedBinaryDigest: "f".repeat(64) }),
    });
    assert.equal(acceptRes.status, 409);
    const body = (await acceptRes.json()) as { error: { code: string } };
    assert.equal(body.error.code, "visual_acceptance_failed");
  } finally {
    await server.close();
  }
});

test("visual API: unconfirmed classification blocks prompt compilation", async () => {
  const server = await startTestServer();
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "vap6");
    await acceptFixtureDesign(server.baseUrl, projectId);
    const planRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const plan = (await planRes.json()) as { id: string };
    const compileRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plans/${plan.id}/slots/hero.primary/prompt-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "generate" }),
    });
    assert.equal(compileRes.status, 409);
    const body = (await compileRes.json()) as { error: { code: string } };
    assert.equal(body.error.code, "visual_classification_required");
  } finally {
    await server.close();
  }
});

test("visual API: documentary slot rejects ai_generate with a typed truth-policy violation", async () => {
  const server = await startTestServer();
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "vap7");
    await acceptFixtureDesign(server.baseUrl, projectId);
    const planRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const plan = (await planRes.json()) as { id: string };
    const classifyRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plans/${plan.id}/slots/hero.primary/classification`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ truthClass: "documentary", acknowledged: true }),
    });
    assert.equal(classifyRes.status, 200);
    const compileRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plans/${plan.id}/slots/hero.primary/prompt-snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "generate" }),
    });
    assert.equal(compileRes.status, 422);
    const body = (await compileRes.json()) as { error: { code: string } };
    assert.equal(body.error.code, "visual_truth_policy_violation");
  } finally {
    await server.close();
  }
});

test("visual API: cross-project visual access fails closed", async () => {
  const server = await startTestServer();
  try {
    const projectIdA = await createProjectWithAcceptedInputs(server.baseUrl, "vap8a");
    const projectIdB = await createProjectWithAcceptedInputs(server.baseUrl, "vap8b");
    await acceptFixtureDesign(server.baseUrl, projectIdA);
    const planRes = await fetch(`${server.baseUrl}/api/projects/${projectIdA}/visual/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const plan = (await planRes.json()) as { id: string };
    // Project B cannot read project A's workspace plan details (empty) nor
    // accept against A's plan id.
    const acceptRes = await fetch(`${server.baseUrl}/api/projects/${projectIdB}/visual/plans/${plan.id}/slots/hero.primary/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId: "vac-00000000-0000-0000-0000-000000000000", expectedBinaryDigest: "f".repeat(64) }),
    });
    assert.equal(acceptRes.status, 404);
  } finally {
    await server.close();
  }
});

test("visual API: deterministic transform resolves with exact lineage and no provider requests", async () => {
  const server = await startTestServer();
  try {
    const projectId = await createProjectWithAcceptedInputs(server.baseUrl, "vap9");
    await acceptFixtureDesign(server.baseUrl, projectId);
    const asset = await uploadApprovedAsset(server.baseUrl, projectId, 41);
    const planRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const plan = (await planRes.json()) as { id: string };
    const classifyRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plans/${plan.id}/slots/hero.primary/classification`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ truthClass: "documentary", acknowledged: true }),
    });
    assert.equal(classifyRes.status, 200);
    const transformRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/plans/${plan.id}/slots/hero.primary/resolve-transform`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceVersionId: asset.versionId, maxWidth: 200, aspectRatioCrop: "16:9" }),
    });
    assert.equal(transformRes.status, 200);
    const resolved = (await transformRes.json()) as { versionId: string; binaryDigest: string; governanceDigest: string | null; transformation: string | null };
    assert.notEqual(resolved.versionId, asset.versionId);
    assert.match(resolved.transformation ?? "", /crop 16:9/);
    // No generation requests exist for this path.
    const wsRes = await fetch(`${server.baseUrl}/api/projects/${projectId}/visual/workspace`);
    const ws = (await wsRes.json()) as { slots: Array<{ candidates: unknown[] }> };
    for (const slot of ws.slots) assert.deepEqual(slot.candidates, []);
  } finally {
    await server.close();
  }
});
