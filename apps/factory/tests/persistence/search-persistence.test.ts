import assert from "node:assert/strict";
import test from "node:test";
import { setupMigratedTestDatabase } from "./helpers.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { SearchStore } from "../../src/search/search-store.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { buildIntakePayload } from "../fixtures/intake-payloads.js";
import { parseSearchIntelligenceData, type SearchIntelligenceData } from "@factory/contracts";

/** Deterministic search fixture data shared across persistence tests. */
const serpData = {
  organic: [
    { position: 1, url: "https://a.example.com/x", domain: "a.example.com", title: "A", snippet: "s1" },
    { position: 2, url: "https://b.example.com", domain: "b.example.com", title: "B", snippet: "s2" },
  ],
  features: null,
  peopleAlsoAsk: null,
  relatedSearches: null,
};

const groundedData = {
  webSearchQueries: ["roof repair austin permits"],
  sources: [{ title: "City of Austin", uri: "https://austin.example.gov/permits" }],
  citations: null,
  structuredOutput: { summary: "Permits may be required for structural work." },
};

const intelligenceData: SearchIntelligenceData = {
  primaryIntent: "commercial",
  intentRationale: "SERP shows service pages.",
  secondaryIntents: ["informational"],
  queryClusters: [
    {
      id: "c1",
      label: "Repair",
      queries: ["roof repair austin"],
      intent: "commercial",
      primaryQuery: "roof repair austin",
      secondaryQueries: [],
      confidence: 0.8,
    },
  ],
  longTailOpportunities: [],
  entities: [{ name: "Austin", kind: "location" }],
  topics: [{ topic: "Roofing", subtopics: ["Repair"] }],
  questions: ["How much does roof repair cost?"],
  modifiers: ["cost"],
  searchVocabulary: ["shingle"],
  relatedConcepts: ["gutters"],
  semanticCoverageRequirements: ["Cover pricing factors."],
  userNeeds: ["Find a local roofer."],
  evidenceRefs: [{ kind: "serp_snapshot", id: "placeholder", digest: "d".repeat(64) }],
  reviewState: "model_proposed",
};

const RUN_INPUT = {
  query: "roof repair austin",
  location: "Austin, TX",
  language: "en",
  device: "desktop",
  provider: "fixture",
} as const;

async function setup() {
  const dbInst = await setupMigratedTestDatabase();
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const search = new SearchStore(dbInst.db);
  const project = await store.createProject({ key: "search-p1", name: "Search P1" });
  await intake.saveDraft({ projectId: project.id, baseRevision: 0, payload: buildIntakePayload() });
  const snapshot = await intake.accept({
    projectId: project.id,
    expectedRevision: 1,
    expectedDigest: deterministicDigest(buildIntakePayload()),
  });
  const requestDigest = deterministicDigest({
    provider: RUN_INPUT.provider,
    query: RUN_INPUT.query,
    location: RUN_INPUT.location,
    language: RUN_INPUT.language,
    device: RUN_INPUT.device,
    acceptedInputDigest: snapshot.digest,
    requestVersion: "search-request-v1",
  });
  return { dbInst, store, intake, search, project, snapshot, requestDigest };
}

test("search persistence: run + snapshots persist with lineage and re-parse on read", async () => {
  const { dbInst, search, project, snapshot, requestDigest } = await setup();
  try {
    const run = await search.createRun({
      projectId: project.id,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      provider: RUN_INPUT.provider,
      requestDigest,
      refreshRequested: false,
      location: RUN_INPUT.location,
      language: RUN_INPUT.language,
      device: RUN_INPUT.device,
      query: RUN_INPUT.query,
    });

    const serp = await search.insertSerpSnapshot({
      runId: run.id,
      projectId: project.id,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      query: RUN_INPUT.query,
      location: RUN_INPUT.location,
      language: RUN_INPUT.language,
      device: RUN_INPUT.device,
      provider: RUN_INPUT.provider,
      providerRequestId: "prov-123",
      observedAt: new Date(),
      requestDigest,
      data: serpData,
      rawPayload: { test: true },
      usage: { costMicros: 1500, currency: "USD" },
    });
    assert.equal(serp.snapshotDigest.length, 64);
    assert.equal(serp.rawDigest.length, 64);

    const intel = await search.insertIntelligenceSnapshot({
      runId: run.id,
      projectId: project.id,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      query: RUN_INPUT.query,
      model: "fixture-analyst",
      provider: "fixture",
      promptVersion: "search-analyst-v1",
      promptDigest: "p".repeat(64),
      serpSnapshotId: serp.id,
      groundedSnapshotId: null,
      evidenceDigests: { serp: serp.snapshotDigest },
      data: {
        ...intelligenceData,
        evidenceRefs: [{ kind: "serp_snapshot", id: serp.id, digest: serp.snapshotDigest }],
      },
    });
    assert.equal(intel.snapshotDigest.length, 64);

    await search.finishRun(run.id, "succeeded", null, null);

    // Restart simulation: fresh store instance over the same DB reads everything.
    const reread = await search.getRun(project.id, run.id);
    assert.equal(reread?.status, "succeeded");
    assert.equal(reread?.acceptedInputSnapshotId, snapshot.id);
    const serpBack = await search.getSerpSnapshot(project.id, run.id);
    assert.equal(serpBack?.snapshotDigest, serp.snapshotDigest);
    assert.equal((serpBack?.organic as unknown[]).length, 2);
    const intelBack = await search.getIntelligenceSnapshot(project.id, run.id);
    assert.equal(intelBack?.snapshotDigest, intel.snapshotDigest);
    parseSearchIntelligenceData(intelBack!.data);
  } finally {
    await dbInst.close();
  }
});

test("search persistence: failed run persists failed status and no evidence", async () => {
  const { dbInst, search, project, snapshot, requestDigest } = await setup();
  try {
    const run = await search.createRun({
      projectId: project.id,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      provider: RUN_INPUT.provider,
      requestDigest,
      refreshRequested: false,
      location: RUN_INPUT.location,
      language: RUN_INPUT.language,
      device: RUN_INPUT.device,
      query: RUN_INPUT.query,
    });
    await search.finishRun(run.id, "failed", "search_provider_unavailable", "provider down");
    const reread = await search.getRun(project.id, run.id);
    assert.equal(reread?.status, "failed");
    assert.equal(reread?.errorCode, "search_provider_unavailable");
    assert.equal(await search.getSerpSnapshot(project.id, run.id), null);
    assert.equal(await search.getIntelligenceSnapshot(project.id, run.id), null);
  } finally {
    await dbInst.close();
  }
});

test("search persistence: freshness cache finds fresh snapshot, misses stale one", async () => {
  const { dbInst, search, project, snapshot, requestDigest } = await setup();
  try {
    const run = await search.createRun({
      projectId: project.id,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      provider: RUN_INPUT.provider,
      requestDigest,
      refreshRequested: false,
      location: RUN_INPUT.location,
      language: RUN_INPUT.language,
      device: RUN_INPUT.device,
      query: RUN_INPUT.query,
    });
    await search.insertSerpSnapshot({
      runId: run.id,
      projectId: project.id,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      query: RUN_INPUT.query,
      location: RUN_INPUT.location,
      language: RUN_INPUT.language,
      device: RUN_INPUT.device,
      provider: RUN_INPUT.provider,
      providerRequestId: null,
      observedAt: new Date(),
      requestDigest,
      data: serpData,
      rawPayload: null,
      usage: null,
    });
    await search.finishRun(run.id, "succeeded", null, null);

    const fresh = await search.findFreshSerp(project.id, requestDigest, 24);
    assert.equal(fresh?.run.id, run.id);

    // Age the observation beyond the freshness window.
    await dbInst.db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("drizzle-orm")).sql`UPDATE serp_snapshots SET observed_at = now() - interval '48 hours'`,
    );
    const stale = await search.findFreshSerp(project.id, requestDigest, 24);
    assert.equal(stale, null);
  } finally {
    await dbInst.close();
  }
});

test("search persistence: refresh creates a NEW immutable observation (history intact)", async () => {
  const { dbInst, search, project, snapshot, requestDigest } = await setup();
  try {
    const mkRun = async () => {
      const run = await search.createRun({
        projectId: project.id,
        acceptedInputSnapshotId: snapshot.id,
        acceptedInputVersion: snapshot.version,
        acceptedInputDigest: snapshot.digest,
        provider: RUN_INPUT.provider,
        requestDigest,
        refreshRequested: true,
        location: RUN_INPUT.location,
        language: RUN_INPUT.language,
        device: RUN_INPUT.device,
        query: RUN_INPUT.query,
      });
      const serp = await search.insertSerpSnapshot({
        runId: run.id,
        projectId: project.id,
        acceptedInputSnapshotId: snapshot.id,
        acceptedInputVersion: snapshot.version,
        acceptedInputDigest: snapshot.digest,
        query: RUN_INPUT.query,
        location: RUN_INPUT.location,
        language: RUN_INPUT.language,
        device: RUN_INPUT.device,
        provider: RUN_INPUT.provider,
        providerRequestId: null,
        observedAt: new Date(),
        requestDigest,
        data: serpData,
        rawPayload: null,
        usage: null,
      });
      await search.finishRun(run.id, "succeeded", null, null);
      return { run, serp };
    };

    const first = await mkRun();
    const second = await mkRun();
    assert.notEqual(first.run.id, second.run.id);
    assert.notEqual(first.serp.id, second.serp.id);
    assert.notEqual(first.serp.snapshotDigest, second.serp.snapshotDigest);
    assert.equal((await search.listRuns(project.id)).length, 2);
  } finally {
    await dbInst.close();
  }
});

test("search persistence: project isolation — another project cannot read run/snapshots", async () => {
  const { dbInst, search, project, snapshot, requestDigest, store, intake } = await setup();
  try {
    const other = await store.createProject({ key: "search-p2", name: "Search P2" });
    await intake.saveDraft({
      projectId: other.id,
      baseRevision: 0,
      payload: buildIntakePayload(),
    });
    await intake.accept({
      projectId: other.id,
      expectedRevision: 1,
      expectedDigest: deterministicDigest(buildIntakePayload()),
    });

    const run = await search.createRun({
      projectId: project.id,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      provider: RUN_INPUT.provider,
      requestDigest,
      refreshRequested: false,
      location: RUN_INPUT.location,
      language: RUN_INPUT.language,
      device: RUN_INPUT.device,
      query: RUN_INPUT.query,
    });
    await search.insertSerpSnapshot({
      runId: run.id,
      projectId: project.id,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      query: RUN_INPUT.query,
      location: RUN_INPUT.location,
      language: RUN_INPUT.language,
      device: RUN_INPUT.device,
      provider: RUN_INPUT.provider,
      providerRequestId: null,
      observedAt: new Date(),
      requestDigest,
      data: serpData,
      rawPayload: null,
      usage: null,
    });
    await search.finishRun(run.id, "succeeded", null, null);

    assert.equal(await search.getRun(other.id, run.id), null);
    assert.equal(await search.getSerpSnapshot(other.id, run.id), null);
    assert.equal(await search.getIntelligenceSnapshot(other.id, run.id), null);
    assert.equal((await search.listRuns(other.id)).length, 0);
  } finally {
    await dbInst.close();
  }
});

test("search persistence: invalid intelligence data fails closed at persistence boundary", async () => {
  const { dbInst, search, project, snapshot, requestDigest } = await setup();
  try {
    const run = await search.createRun({
      projectId: project.id,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      provider: RUN_INPUT.provider,
      requestDigest,
      refreshRequested: false,
      location: RUN_INPUT.location,
      language: RUN_INPUT.language,
      device: RUN_INPUT.device,
      query: RUN_INPUT.query,
    });
    await assert.rejects(
      () =>
        search.insertIntelligenceSnapshot({
          runId: run.id,
          projectId: project.id,
          acceptedInputSnapshotId: snapshot.id,
          acceptedInputVersion: snapshot.version,
          acceptedInputDigest: snapshot.digest,
          query: RUN_INPUT.query,
          model: "fixture-analyst",
          provider: "fixture",
          promptVersion: "search-analyst-v1",
          promptDigest: "p".repeat(64),
          serpSnapshotId: "none",
          groundedSnapshotId: null,
          evidenceDigests: {},
          // Invalid: missing required fields.
          data: { primaryIntent: "commercial" },
        }),
      (e: unknown) => e instanceof Error,
    );
  } finally {
    await dbInst.close();
  }
});

test("search persistence: budget sum counts recorded costMicros for today", async () => {
  const { dbInst, search, project, snapshot, requestDigest } = await setup();
  try {
    assert.equal(await search.sumTodaySearchCostMicros(), 0);
    const run = await search.createRun({
      projectId: project.id,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      provider: RUN_INPUT.provider,
      requestDigest,
      refreshRequested: false,
      location: RUN_INPUT.location,
      language: RUN_INPUT.language,
      device: RUN_INPUT.device,
      query: RUN_INPUT.query,
    });
    await search.insertSerpSnapshot({
      runId: run.id,
      projectId: project.id,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      query: RUN_INPUT.query,
      location: RUN_INPUT.location,
      language: RUN_INPUT.language,
      device: RUN_INPUT.device,
      provider: RUN_INPUT.provider,
      providerRequestId: null,
      observedAt: new Date(),
      requestDigest,
      data: serpData,
      rawPayload: null,
      usage: { costMicros: 2500, currency: "USD" },
    });
    assert.equal(await search.sumTodaySearchCostMicros(), 2500);
  } finally {
    await dbInst.close();
  }
});

test("search persistence: accepted-input lineage distinguishes old accepted versions", async () => {
  const { dbInst, search, project, snapshot, requestDigest, intake } = await setup();
  try {
    // Accept a v2 with changed inputs.
    const pay2 = buildIntakePayload({ business: { name: "Acme Roofing Co", description: "Updated description." } });
    await intake.saveDraft({ projectId: project.id, baseRevision: 1, payload: pay2 });
    const v2 = await intake.accept({
      projectId: project.id,
      expectedRevision: 2,
      expectedDigest: deterministicDigest(pay2),
    });
    assert.equal(v2.version, 2);

    // A run bound to v1 keeps pointing at v1 (history is not rewritten).
    const run = await search.createRun({
      projectId: project.id,
      acceptedInputSnapshotId: snapshot.id,
      acceptedInputVersion: snapshot.version,
      acceptedInputDigest: snapshot.digest,
      provider: RUN_INPUT.provider,
      requestDigest,
      refreshRequested: false,
      location: RUN_INPUT.location,
      language: RUN_INPUT.language,
      device: RUN_INPUT.device,
      query: RUN_INPUT.query,
    });
    const reread = await search.getRun(project.id, run.id);
    assert.equal(reread?.acceptedInputVersion, 1);
    assert.equal(reread?.acceptedInputDigest, snapshot.digest);
    assert.notEqual(reread?.acceptedInputDigest, v2.digest);
  } finally {
    await dbInst.close();
  }
});
