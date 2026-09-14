import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { buildIntakePayload } from "./intake-payloads.js";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import {
  acceptedContentGapSnapshots,
  type AcceptedContentGapSnapshotRecord,
} from "../../src/persistence/schema.js";
import { eq, desc } from "drizzle-orm";

/**
 * Shared seeding helper for writer pipeline persistence tests: a project with
 * an accepted ProjectInputSnapshot and an accepted ContentGap snapshot bound
 * to it. Keeps every writer test on the real accepted-lineage path.
 */

export interface SeededProject {
  projectId: string;
  acceptedInputSnapshotId: string;
  acceptedInputVersion: number;
  acceptedInputDigest: string;
  gapSnapshotId: string;
  gapSnapshotVersion: number;
  gapSnapshotDigest: string;
}

export async function seedProjectWithAcceptedInputs(
  dbInst: FactoryDatabaseInstance,
  key: string,
): Promise<SeededProject> {
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const project = await store.createProject({ key, name: `Project ${key}` });
  const payload = buildIntakePayload();
  await intake.saveDraft({ projectId: project.id, baseRevision: 0, payload });
  const accepted = await intake.accept({
    projectId: project.id,
    expectedRevision: 1,
    expectedDigest: deterministicDigest(payload),
  });

  // Minimal FK chain for the accepted gap snapshot: SERP -> intelligence ->
  // competitor run -> gap report -> accepted snapshot (mirrors the competitor
  // persistence test seeding pattern).
  const serpId = `serp-${randomUUID()}`;
  const searchRunId = `sr-${randomUUID()}`;
  const intelId = `intel-${randomUUID()}`;
  const runId = `crun-${randomUUID()}`;
  const reportId = `cgap-${randomUUID()}`;
  const intelData = JSON.stringify({
    primaryIntent: "commercial",
    intentRationale: "fixture",
    secondaryIntents: [],
    queryClusters: [],
    longTailOpportunities: [],
    entities: [],
    topics: [],
    questions: [],
    modifiers: [],
    searchVocabulary: [],
    relatedConcepts: [],
    semanticCoverageRequirements: [],
    userNeeds: [],
  });
  await dbInst.db.execute(sql`
    INSERT INTO search_runs (id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, query, device, provider, request_digest, status)
    VALUES (${searchRunId}, ${project.id}, ${accepted.id}, ${accepted.version}, ${accepted.digest}, 'fixture query', 'desktop', 'fixture', ${"rd-" + randomUUID()}, 'succeeded')
  `);
  await dbInst.db.execute(sql`
    INSERT INTO serp_snapshots (id, run_id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, query, device, provider, observed_at, request_digest, snapshot_digest, organic, raw_digest)
    VALUES (${serpId}, ${searchRunId}, ${project.id}, ${accepted.id}, ${accepted.version}, ${accepted.digest}, 'fixture query', 'desktop', 'fixture', now(), ${"rd-" + randomUUID()}, ${"a".repeat(64)}, '[]'::jsonb, ${"b".repeat(64)})
  `);
  await dbInst.db.execute(sql`
    INSERT INTO search_intelligence_snapshots (id, run_id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, query, model, provider, prompt_version, prompt_digest, serp_snapshot_id, evidence_digests, data, snapshot_digest)
    VALUES (${intelId}, ${searchRunId}, ${project.id}, ${accepted.id}, ${accepted.version}, ${accepted.digest}, 'fixture query', 'fixture-analyst', 'fixture', 'search-analyst-v1', ${"c".repeat(64)}, ${serpId}, '[]'::jsonb, ${intelData}::jsonb, ${"d".repeat(64)})
  `);
  await dbInst.db.execute(sql`
    INSERT INTO competitor_runs (id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, serp_snapshot_id, serp_snapshot_digest, intelligence_snapshot_id, intelligence_snapshot_digest, pipeline_version, status)
    VALUES (${runId}, ${project.id}, ${accepted.id}, ${accepted.version}, ${accepted.digest}, ${serpId}, ${"a".repeat(64)}, ${intelId}, ${"d".repeat(64)}, 'fixture-v1', 'succeeded')
  `);
  const reportData = JSON.stringify({
    serpSnapshotId: serpId,
    serpSnapshotDigest: "a".repeat(64),
    intelligenceSnapshotId: intelId,
    intelligenceSnapshotDigest: "d".repeat(64),
    searchSemantics: {
      intelligenceSnapshotId: intelId,
      intelligenceSnapshotDigest: "d".repeat(64),
      primaryIntent: "commercial",
      semanticCoverageRequirements: [
        "What a full roof replacement includes",
        "Typical timeline and process steps",
        "Warranty and workmanship guarantees",
      ],
      userNeeds: [
        "Understand cost drivers before requesting a quote",
        "Trust signals: licensing, insurance, reviews",
      ],
    },
    pageSnapshotRefs: [],
    analysisRefs: [],
    acceptedInputSnapshotId: accepted.id,
    acceptedInputSnapshotVersion: accepted.version,
    acceptedInputDigest: accepted.digest,
    coverageMatrix: { policyVersion: "fixture-v1", rows: [] },
    gaps: [],
    differentiationRequirements: { items: [] },
    model: "fixture",
    provider: "fixture",
    promptVersion: "fixture-v1",
    reviewState: "operator_reviewed",
  });
  const reportDigest = deterministicDigest(JSON.parse(reportData));
  await dbInst.db.execute(sql`
    INSERT INTO content_gap_reports (id, run_id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, serp_snapshot_id, serp_snapshot_digest, intelligence_snapshot_id, intelligence_snapshot_digest, model, provider, prompt_version, data, snapshot_digest, review_state, review_revision, decisions_digest)
    VALUES (${reportId}, ${runId}, ${project.id}, ${accepted.id}, ${accepted.version}, ${accepted.digest}, ${serpId}, ${"a".repeat(64)}, ${intelId}, ${"d".repeat(64)}, 'fixture', 'fixture', 'fixture-v1', ${reportData}::jsonb, ${reportDigest}, 'operator_reviewed', 1, ${"e".repeat(64)})
  `);

  const gapData = JSON.parse(reportData);
  gapData.reviewState = "accepted";
  gapData.decisions = [];
  const gapSnapshotDigest = deterministicDigest({
    projectId: project.id,
    version: 1,
    reportId,
    reportDigest,
    decisionsDigest: "e".repeat(64),
    data: gapData,
  });
  const [gapRow] = await dbInst.db
    .insert(acceptedContentGapSnapshots)
    .values({
      id: `gsnap-${randomUUID()}`,
      projectId: project.id,
      version: 1,
      reportId,
      reportDigest,
      decisionsDigest: "e".repeat(64),
      acceptedInputSnapshotId: accepted.id,
      acceptedInputVersion: accepted.version,
      acceptedInputDigest: accepted.digest,
      serpSnapshotId: serpId,
      serpSnapshotDigest: "a".repeat(64),
      intelligenceSnapshotId: intelId,
      intelligenceSnapshotDigest: "d".repeat(64),
      pageSnapshotRefs: [],
      analysisRefs: [],
      data: gapData,
      snapshotDigest: gapSnapshotDigest,
    })
    .returning();

  return {
    projectId: project.id,
    acceptedInputSnapshotId: accepted.id,
    acceptedInputVersion: accepted.version,
    acceptedInputDigest: accepted.digest,
    gapSnapshotId: gapRow!.id,
    gapSnapshotVersion: gapRow!.version,
    gapSnapshotDigest: gapSnapshotDigest,
  };
}

export async function latestGapSnapshot(
  dbInst: FactoryDatabaseInstance,
  projectId: string,
): Promise<AcceptedContentGapSnapshotRecord | null> {
  const [row] = await dbInst.db
    .select()
    .from(acceptedContentGapSnapshots)
    .where(eq(acceptedContentGapSnapshots.projectId, projectId))
    .orderBy(desc(acceptedContentGapSnapshots.version))
    .limit(1);
  return row ?? null;
}

export const samplePageTarget = {
  slug: "roof-replacement-denver",
  title: "Roof Replacement in Denver",
  objective: "Convert homeowners researching replacement into inspection requests.",
  audience: "Denver homeowners 30-60 comparing local roofers",
  structureGuidance: ["Open with storm-damage context", "Process timeline section", "Warranty section"],
  internalLinkIntent: ["Link to storm damage repair page"],
  ctaIntent: "Book a free roof inspection",
};
