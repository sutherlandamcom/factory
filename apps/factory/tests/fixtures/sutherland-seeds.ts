import { sql } from "drizzle-orm";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { acceptedContentGapSnapshots } from "../../src/persistence/schema.js";
import { sutherlandIntakePayload } from "./sutherland-intake.js";
import { FactoryStore } from "../../src/persistence/store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { randomUUID } from "node:crypto";

/**
 * RUN 12 SUTHERLAND SEARCH / GAP AUTHORITY SEED.
 *
 * Seeds a real project with the Sutherland intake (accepted operator facts)
 * plus a search-intelligence → competitor-run → gap-report → accepted gap
 * snapshot chain grounded in the accepted Sutherland search strategy
 * (docs/handoffs/2026-09-04-sutherland-one-page-workflow.md §F):
 *
 *   primary keyword: independent property advisory French Alps
 *   secondary: brand; property decision support Chamonix / Megève;
 *              buyer-side property advisory France; evidence-led analysis
 *
 * The query clusters below are the accepted strategy's clusters — NOT
 * invented SERPs. They mirror the accepted positioning evidence; a live
 * SERP acquisition is not required for the Run 12 page-strategy proof
 * (the accepted handoff IS the acquired evidence of record).
 */

export interface SutherlandSeededProject {
  projectId: string;
  acceptedInputSnapshotId: string;
  acceptedInputVersion: number;
  acceptedInputDigest: string;
  gapSnapshotId: string;
  gapSnapshotVersion: number;
  gapSnapshotDigest: string;
}

export async function seedSutherlandProject(
  dbInst: FactoryDatabaseInstance,
  key: string,
): Promise<SutherlandSeededProject> {
  const store = new FactoryStore(dbInst.db);
  const intake = new ProjectIntakeStore(dbInst.db);
  const project = await store.createProject({ key, name: `Sutherland Run 12 ${key}` });
  await intake.saveDraft({ projectId: project.id, baseRevision: 0, payload: sutherlandIntakePayload });
  const accepted = await intake.accept({
    projectId: project.id,
    expectedRevision: 1,
    expectedDigest: deterministicDigest(sutherlandIntakePayload),
  });

  // SERP -> intelligence -> competitor run -> gap report -> accepted snapshot.
  const serpId = `serp-${randomUUID()}`;
  const searchRunId = `sr-${randomUUID()}`;
  const intelId = `intel-${randomUUID()}`;
  const runId = `crun-${randomUUID()}`;
  const reportId = `cgap-${randomUUID()}`;

  const intelData = {
    evidenceRefs: [{ kind: "serp_snapshot", id: serpId, digest: "a".repeat(64) }],
    primaryIntent: "commercial",
    intentRationale: "International buyer evaluating who should support a consequential French Alps property decision.",
    secondaryIntents: ["informational"],
    queryClusters: [
      {
        label: "Independent buyer-side advisory (French Alps)",
        queries: ["independent property advisory french alps", "buyer-side property advisory france"],
        intent: "commercial",
        primaryQuery: "independent property advisory french alps",
        secondaryQueries: ["buyer-side property advisory france"],
        rationale: "Accepted primary keyword cluster: independent advisory positioning.",
        confidence: "high",
      },
      {
        label: "Location market understanding (Chamonix / Megève)",
        queries: ["buying property in chamonix", "megeve property market"],
        intent: "informational",
        primaryQuery: "buying property in chamonix",
        secondaryQueries: ["megeve property market"],
        rationale: "Accepted secondary cluster: location decision support.",
        confidence: "high",
      },
      {
        label: "Decision methodology / evidence-led analysis",
        queries: ["evidence-led property analysis", "property decision framework alps"],
        intent: "informational",
        primaryQuery: "evidence-led property analysis",
        secondaryQueries: ["property decision framework alps"],
        rationale: "Accepted analytical cluster: methodology and research credibility.",
        confidence: "medium",
      },
      {
        label: "Brand / entity (Sutherland Private Office)",
        queries: ["sutherland private office", "sutherlandam"],
        intent: "navigational",
        primaryQuery: "sutherland private office",
        secondaryQueries: ["sutherlandam"],
        rationale: "Brand navigational cluster.",
        confidence: "high",
      },
    ],
    longTailOpportunities: [],
    entities: [
      { name: "Sutherland Private Office", kind: "organization" },
      { name: "Chamonix", kind: "location" },
      { name: "Megève", kind: "location" },
    ],
    topics: [
      { topic: "buyer-side property advisory", subtopics: ["engagement model", "independence"] },
      { topic: "alpine property markets", subtopics: ["Chamonix", "Megève"] },
    ],
    questions: [
      "Who advises a consequential alpine property purchase?",
      "How does an independent advisory engagement work?",
    ],
    modifiers: [],
    searchVocabulary: ["buyer-side", "evidence-led", "decision support", "advisory"],
    relatedConcepts: [],
    semanticCoverageRequirements: [],
    userNeeds: [],
  };
  await dbInst.db.execute(sql`
    INSERT INTO search_runs (id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, query, device, provider, request_digest, status)
    VALUES (${searchRunId}, ${project.id}, ${accepted.id}, ${accepted.version}, ${accepted.digest}, 'independent property advisory french alps', 'desktop', 'accepted-strategy', ${"rd-" + randomUUID()}, 'succeeded')
  `);
  await dbInst.db.execute(sql`
    INSERT INTO serp_snapshots (id, run_id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, query, device, provider, observed_at, request_digest, snapshot_digest, organic, raw_digest)
    VALUES (${serpId}, ${searchRunId}, ${project.id}, ${accepted.id}, ${accepted.version}, ${accepted.digest}, 'independent property advisory french alps', 'desktop', 'accepted-strategy', now(), ${"rd-" + randomUUID()}, ${"a".repeat(64)}, '[]'::jsonb, ${"b".repeat(64)})
  `);
  await dbInst.db.execute(sql`
    INSERT INTO search_intelligence_snapshots (id, run_id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, query, model, provider, prompt_version, prompt_digest, serp_snapshot_id, evidence_digests, data, snapshot_digest)
    VALUES (${intelId}, ${searchRunId}, ${project.id}, ${accepted.id}, ${accepted.version}, ${accepted.digest}, 'independent property advisory french alps', 'accepted-strategy-v1', 'accepted-strategy', 'search-analyst-v1', ${"c".repeat(64)}, ${serpId}, ${JSON.stringify({ serp: "a".repeat(64) })}::jsonb, ${JSON.stringify(intelData)}::jsonb, ${"d".repeat(64)})
  `);
  await dbInst.db.execute(sql`
    INSERT INTO competitor_runs (id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, serp_snapshot_id, serp_snapshot_digest, intelligence_snapshot_id, intelligence_snapshot_digest, pipeline_version, status)
    VALUES (${runId}, ${project.id}, ${accepted.id}, ${accepted.version}, ${accepted.digest}, ${serpId}, ${"a".repeat(64)}, ${intelId}, ${"d".repeat(64)}, 'accepted-strategy-v1', 'succeeded')
  `);

  const reportData = {
    serpSnapshotId: serpId,
    serpSnapshotDigest: "a".repeat(64),
    intelligenceSnapshotId: intelId,
    intelligenceSnapshotDigest: "d".repeat(64),
    searchSemantics: {
      intelligenceSnapshotId: intelId,
      intelligenceSnapshotDigest: "d".repeat(64),
      primaryIntent: "commercial",
      semanticCoverageRequirements: [
        "What buyer-side advisory covers and how an engagement works",
        "How the evidence-led analysis method produces conclusions",
        "Which location decisions the advisory supports (Chamonix, Megève)",
        "How an engagement begins without a sales funnel",
      ],
      userNeeds: [
        "Understand who is responsible for the analysis",
        "Distinguish independent advisory from listing intermediaries",
        "See how facts, assumptions and forecasts are separated",
      ],
    },
    pageSnapshotRefs: [],
    analysisRefs: [],
    acceptedInputSnapshotId: accepted.id,
    acceptedInputSnapshotVersion: accepted.version,
    acceptedInputDigest: accepted.digest,
    coverageMatrix: { policyVersion: "accepted-strategy-v1", rows: [] },
    gaps: [],
    differentiationRequirements: { items: [] },
    model: "accepted-strategy",
    provider: "accepted-strategy",
    promptVersion: "accepted-strategy-v1",
    reviewState: "operator_reviewed",
  };
  const reportDigest = deterministicDigest(reportData);
  await dbInst.db.execute(sql`
    INSERT INTO content_gap_reports (id, run_id, project_id, accepted_input_snapshot_id, accepted_input_version, accepted_input_digest, serp_snapshot_id, serp_snapshot_digest, intelligence_snapshot_id, intelligence_snapshot_digest, model, provider, prompt_version, data, snapshot_digest, review_state, review_revision, decisions_digest)
    VALUES (${reportId}, ${runId}, ${project.id}, ${accepted.id}, ${accepted.version}, ${accepted.digest}, ${serpId}, ${"a".repeat(64)}, ${intelId}, ${"d".repeat(64)}, 'accepted-strategy', 'accepted-strategy', 'accepted-strategy-v1', ${JSON.stringify(reportData)}::jsonb, ${reportDigest}, 'operator_reviewed', 1, ${"e".repeat(64)})
  `);

  const gapData = { ...reportData, reviewState: "accepted", decisions: [] };
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
