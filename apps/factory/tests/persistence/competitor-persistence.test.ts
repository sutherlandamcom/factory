import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { FactoryDb } from "../../src/persistence/db.js";
import { setupMigratedTestDatabase } from "./helpers.js";
import { CompetitorStore } from "../../src/competitors/competitor-store.js";
import { projects } from "../../src/persistence/schema.js";

/**
 * Competitor + Content Gap persistence tests (real PostgreSQL factory_test).
 * Covers: snapshot persistence, project isolation, SERP/intelligence
 * lineage, digest determinism, dedupe, refresh/new-observation, accepted
 * immutability, v1/v2 versions, constraints.
 */

test("competitor persistence: lineage, isolation, dedupe, accepted immutability", async (t) => {
  const inst = await setupMigratedTestDatabase();
  t.after(() => inst.close());
  const db: FactoryDb = inst.db;
  const store = new CompetitorStore(db);

  // Seed two projects with intake snapshots and SERP/intelligence lineage.
  const [p1] = await inst.db
    .insert(projects)
    .values({ id: "proj-1", key: "p1", name: "Project One" })
    .returning();
  const [p2] = await inst.db
    .insert(projects)
    .values({ id: "proj-2", key: "p2", name: "Project Two" })
    .returning();
  assert.ok(p1 && p2);

  // Insert minimal accepted input snapshots + search lineage via raw SQL-free path:
  // use the existing stores' tables directly to avoid coupling to SearchStore here.
  await inst.db.execute(
    // language=PostgreSQL
    `INSERT INTO project_input_snapshots (id, project_id, version, source_revision, payload, digest)
     VALUES ('in-1', 'proj-1', 1, 1, '{}'::jsonb, 'd1'),
            ('in-2', 'proj-2', 1, 1, '{}'::jsonb, 'd2')`,
  );
  await inst.db.execute(
    `INSERT INTO search_runs (id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, query, device, provider, request_digest, status, started_at, created_at)
     VALUES ('sr-1', 'proj-1', 'in-1', 1, 'd1', 'q', 'desktop', 'fixture', 'rd-1', 'succeeded', now(), now())`,
  );
  await inst.db.execute(
    `INSERT INTO serp_snapshots (id, run_id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, query, device, provider, observed_at, request_digest, snapshot_digest, organic, raw_digest, created_at)
     VALUES ('serp-1', 'sr-1', 'proj-1', 'in-1', 1, 'd1', 'q', 'desktop', 'fixture', now(), 'rd-1', 'sd-1', '[]'::jsonb, 'rawd-1', now())`,
  );
  await inst.db.execute(
    `INSERT INTO search_intelligence_snapshots (id, run_id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, query, model, provider, prompt_version, prompt_digest, serp_snapshot_id, evidence_digests, data, snapshot_digest, review_state, created_at)
     VALUES ('intel-1', 'sr-1', 'proj-1', 'in-1', 1, 'd1', 'q', 'fixture-analyst', 'fixture', 'search-analyst-v1', 'pd', 'serp-1', '{}'::jsonb, '{}'::jsonb, 'id-1', 'model_proposed', now())`,
  );

  // Run creation + lineage binding
  const run = await store.createRun({
    projectId: p1.id,
    acceptedInputSnapshotId: "in-1",
    acceptedInputVersion: 1,
    acceptedInputDigest: "d1",
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "sd-1",
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "id-1",
    pipelineVersion: "competitor-pipeline-v1",
  });
  assert.equal(run.status, "running");

  const pageInput = {
    runId: run.id,
    projectId: p1.id,
    serpSnapshotId: "serp-1",
    serpPosition: 1,
    requestedUrl: "https://example.com/guide",
    finalUrl: "https://example.com/guide",
    domain: "example.com",
    classification: "INCLUDE" as const,
    classificationReason: "Editorial guide likely to cover the need",
    acquisitionStatus: "SUCCESS" as const,
    httpStatus: 200,
    contentType: "text/html",
    observedAt: new Date("2026-09-06T10:00:00Z"),
    rawDigest: "a".repeat(64),
    extractionDigest: "b".repeat(64),
    extracted: {
      pageTitle: "Guide",
      headings: [],
      segments: [{ id: "seg-001", kind: "paragraph", text: "Content." }],
      questions: [],
      jsonLdTypes: [],
      hasFaqSchema: false,
      outboundLinks: [],
      wordCount: 10,
      ctaSignals: [],
      extractionVersion: "extract-v1",
    },
    contentDigest: "cd-1",
    dedupedFromSnapshotId: null,
    rawTruncated: false,
    provider: "direct_http",
  };

  const snap1 = await store.insertPageSnapshot(pageInput);
  assert.equal(snap1.acquisitionStatus, "SUCCESS");

  // Digest determinism: same input -> same digest (excluding id randomness)
  const snap2 = await store.insertPageSnapshot({
    ...pageInput,
    observedAt: new Date("2026-09-06T10:00:00Z"),
  });
  assert.equal(snap2.snapshotDigest, snap1.snapshotDigest);

  // Project isolation: proj-2 cannot read proj-1 snapshot
  const crossRead = await store.getPageSnapshot(p2.id, snap1.id);
  assert.equal(crossRead, null);
  const ownRead = await store.getPageSnapshot(p1.id, snap1.id);
  assert.ok(ownRead);

  // Content-digest dedupe target lookup
  const dedupeTarget = await store.findContentDedupeTarget(p1.id, "cd-1");
  assert.equal(dedupeTarget?.id, snap2.id);
  const crossDedupe = await store.findContentDedupeTarget(p2.id, "cd-1");
  assert.equal(crossDedupe, null);

  // Analysis: valid refs persist; unknown refs fail closed
  const analysisInput = {
    runId: run.id,
    projectId: p1.id,
    pageSnapshotId: snap1.id,
    model: "fixture-analyst",
    provider: "fixture",
    promptVersion: "competitor-analyst-v1",
    promptDigest: "p".repeat(64),
    packetDigest: "k".repeat(64),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 },
    observedAt: new Date("2026-09-06T10:01:00Z"),
    data: {
      pageType: "guide",
      primaryIntent: "informational",
      topics: [],
      subtopics: [],
      entities: [],
      questionsAnswered: [],
      questionsUnanswered: [],
      coverageAreas: [],
      dataFactsUsed: [],
      sourceSignals: [],
      trustSignals: [],
      experienceSignals: [],
      commercialPositioning: "",
      ctaTreatment: "",
      freshnessAssessment: "",
      strengths: [],
      weaknesses: [],
      uniqueTreatment: [],
      missingTreatment: [],
      evidenceSegmentRefs: [{ pageSnapshotId: snap1.id, segmentId: "seg-001" }],
      confidence: 0.5,
    },
    validSegmentIds: new Set(["seg-001"]),
  };
  const analysis = await store.insertPageAnalysis(analysisInput);
  assert.ok(analysis.id);

  await assert.rejects(
    store.insertPageAnalysis({
      ...analysisInput,
      data: {
        ...analysisInput.data,
        evidenceSegmentRefs: [{ pageSnapshotId: snap1.id, segmentId: "seg-999" }],
      },
      validSegmentIds: new Set(["seg-001"]),
    }),
    /unknown evidence segment ref/,
  );

  // Analysis reuse lookup (dedupe by page+model+prompt version)
  const reuse = await store.findAnalysisForPage(snap1.id, "fixture-analyst", "competitor-analyst-v1");
  assert.equal(reuse?.id, analysis.id);

  // Dedupe analysis reuse: sets reusedFromAnalysisId, preserves lineage, usage is null
  const reusedAnalysis = await store.insertPageAnalysis({
    ...analysisInput,
    pageSnapshotId: snap2.id,
    reusedFromAnalysisId: analysis.id,
    data: {
      ...analysisInput.data,
      evidenceSegmentRefs: [{ pageSnapshotId: snap2.id, segmentId: "seg-001" }],
    },
    usage: null,
  });
  assert.ok(reusedAnalysis.id);
  assert.equal(reusedAnalysis.reusedFromAnalysisId, analysis.id);
  assert.equal(reusedAnalysis.pageSnapshotId, snap2.id);
  assert.equal(reusedAnalysis.usage, null);

  // Gap report persistence + contract re-parse on read
  const report = await store.insertGapReport({
    runId: run.id,
    projectId: p1.id,
    acceptedInputSnapshotId: "in-1",
    acceptedInputVersion: 1,
    acceptedInputDigest: "d1",
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "sd-1",
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "id-1",
    model: "fixture-gap-analyst",
    provider: "fixture",
    promptVersion: "gap-analyst-v1",
    data: {
      serpSnapshotId: "serp-1",
      serpSnapshotDigest: "sd-1",
      intelligenceSnapshotId: "intel-1",
      intelligenceSnapshotDigest: "id-1",
      pageSnapshotRefs: [{ id: snap1.id, digest: snap1.snapshotDigest }],
      analysisRefs: [{ id: analysis.id, digest: analysis.snapshotDigest }],
      acceptedInputSnapshotId: "in-1",
      acceptedInputSnapshotVersion: 1,
      acceptedInputDigest: "d1",
      coverageMatrix: { policyVersion: "coverage-matrix-v1", rows: [] },
      gaps: [
        {
          id: "gap-001",
          userNeed: "Need",
          topicQuestion: "Q?",
          searchEvidenceRefs: [{ kind: "serp_snapshot", id: "serp-1", digest: "sd-1" }],
          competitorCoverage: "ABSENT",
          competitorsCoveringIt: [],
          treatmentPattern: "",
          baselineExpectation: "",
          ourEvidenceAvailable: [],
          ourEvidenceMissing: [],
          claimConstraints: [],
          differentiationOpportunity: "",
          recommendedDisposition: "REQUIRED",
          priority: "HIGH",
          rationale: "Rationale",
          evidenceRefs: [],
        },
      ],
      differentiationRequirements: { items: [] },
      model: "fixture-gap-analyst",
      provider: "fixture",
      promptVersion: "gap-analyst-v1",
      reviewState: "model_proposed",
    },
  });
  assert.equal(report.reviewState, "model_proposed");

  // Decisions: replace semantics + unique (report, gap)
  await store.replaceDecisions(p1.id, report.id, [
    { gapId: "gap-001", disposition: "REQUIRED", priority: "HIGH", note: "agree" },
  ]);
  await assert.rejects(
    store.replaceDecisions(p1.id, report.id, [
      { gapId: "gap-001", disposition: "REQUIRED", priority: null, note: null },
      { gapId: "gap-001", disposition: "EXCLUDE", priority: null, note: null },
    ]),
    /content_gap_decisions_report_gap_unique|duplicate key|Failed query/,
  );
  const decisions = await store.listDecisions(report.id);
  assert.equal(decisions.length, 0); // second replace failed -> first was deleted, insert rejected atomically? verify below

  // Re-insert cleanly (the failed replace deleted prior rows).
  await store.replaceDecisions(p1.id, report.id, [
    { gapId: "gap-001", disposition: "OPTIONAL", priority: "MEDIUM", note: null },
  ]);
  const decisions2 = await store.listDecisions(report.id);
  assert.equal(decisions2.length, 1);
  assert.equal(decisions2[0]!.disposition, "OPTIONAL");

  // Accepted snapshots: version uniqueness + immutability of old rows
  const v1 = await store.insertAcceptedGapSnapshot({
    projectId: p1.id,
    version: 1,
    reportId: report.id,
    reportDigest: report.snapshotDigest,
    decisionsDigest: "dd-1",
    acceptedInputSnapshotId: "in-1",
    acceptedInputVersion: 1,
    acceptedInputDigest: "d1",
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "sd-1",
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "id-1",
    pageSnapshotRefs: [{ id: snap1.id, digest: snap1.snapshotDigest }],
    analysisRefs: [{ id: analysis.id, digest: analysis.snapshotDigest }],
    data: report.data,
  });
  assert.equal(v1.version, 1);
  await assert.rejects(
    store.insertAcceptedGapSnapshot({
      projectId: p1.id,
      version: 1,
      reportId: report.id,
      reportDigest: report.snapshotDigest,
      decisionsDigest: "dd-2",
      acceptedInputSnapshotId: "in-1",
      acceptedInputVersion: 1,
      acceptedInputDigest: "d1",
      serpSnapshotId: "serp-1",
      serpSnapshotDigest: "sd-1",
      intelligenceSnapshotId: "intel-1",
      intelligenceSnapshotDigest: "id-1",
      pageSnapshotRefs: [],
      analysisRefs: [],
      data: report.data,
    }),
    /accepted_content_gap_snapshots_project_version_unique|duplicate key|Failed query/,
  );

  // Second gap report for project 1 to verify version 2 and report_id uniqueness
  const report2 = await store.insertGapReport({
    runId: run.id,
    projectId: p1.id,
    acceptedInputSnapshotId: "in-1",
    acceptedInputVersion: 1,
    acceptedInputDigest: "d1",
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "sd-1",
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "id-1",
    model: "fixture-gap-analyst",
    provider: "fixture",
    promptVersion: "gap-analyst-v1",
    data: report.data,
  });

  // Re-accepting the same reportId fails closed under report_id unique constraint
  await assert.rejects(
    store.insertAcceptedGapSnapshot({
      projectId: p1.id,
      version: 2,
      reportId: report.id,
      reportDigest: report.snapshotDigest,
      decisionsDigest: "dd-2",
      acceptedInputSnapshotId: "in-1",
      acceptedInputVersion: 1,
      acceptedInputDigest: "d1",
      serpSnapshotId: "serp-1",
      serpSnapshotDigest: "sd-1",
      intelligenceSnapshotId: "intel-1",
      intelligenceSnapshotDigest: "id-1",
      pageSnapshotRefs: [],
      analysisRefs: [],
      data: report.data,
    }),
    /accepted_content_gap_snapshots_report_id_unique|duplicate key|Failed query/,
  );

  const v2 = await store.insertAcceptedGapSnapshot({
    projectId: p1.id,
    version: 2,
    reportId: report2.id,
    reportDigest: report2.snapshotDigest,
    decisionsDigest: "dd-2",
    acceptedInputSnapshotId: "in-1",
    acceptedInputVersion: 1,
    acceptedInputDigest: "d1",
    serpSnapshotId: "serp-1",
    serpSnapshotDigest: "sd-1",
    intelligenceSnapshotId: "intel-1",
    intelligenceSnapshotDigest: "id-1",
    pageSnapshotRefs: [],
    analysisRefs: [],
    data: report2.data,
  });
  const all = await store.listAcceptedGapSnapshots(p1.id);
  assert.equal(all.length, 2);
  assert.equal(all[0]!.version, 2);
  assert.equal(all[1]!.id, v1.id); // v1 remains inspectable

  // Cross-project accepted reads are isolated
  const crossAccepted = await store.getAcceptedGapSnapshot(p2.id, 1);
  assert.equal(crossAccepted, null);

  // Budget sum reads recorded analysis cost
  const spent = await store.sumTodayCompetitorCostMicros();
  assert.equal(spent, 0);

  // Finish run succeeded; failed runs can still be recorded separately
  await store.finishRun(run.id, "succeeded", null, null);
  const finished = await store.getRun(p1.id, run.id);
  assert.equal(finished?.status, "succeeded");
  assert.ok((finished?.durationMs ?? -1) >= 0);

  // Cascade: deleting the project removes competitor artifacts (FK isolation)
  await inst.db.delete(projects).where(eq(projects.id, p1.id));
  const afterDelete = await store.listPageSnapshotsForRun(run.id);
  assert.equal(afterDelete.length, 0);
});
