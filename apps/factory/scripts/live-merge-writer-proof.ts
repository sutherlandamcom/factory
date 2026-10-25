/**
 * P1-03 LIVE PROOF — real GLM (zai/glm-5.3-flash) Writer Proposal under the
 * full governed path (P0-01 authority guard + P0-02 unified budget).
 *
 * NOT part of CI. Executed manually with explicit authorization:
 *   FACTORY_TEST_DATABASE_URL=postgresql://factory:...@host:port/factory_test \
 *   npx tsx apps/factory/scripts/live-merge-writer-proof.ts
 *
 * Preconditions (all fail-closed, none simulated):
 *   - MERGE_GATEWAY_API_KEY present (gitignored .env);
 *   - FACTORY_TEST_DATABASE_URL present (dedicated factory_test database);
 *   - unified pilot budget ceiling $2 (env may lower, never raise).
 *
 * Steps:
 *   1. isolated PG factory_test, fresh project `factory-pilot-live-…`;
 *   2. register pilot profile + ACTIVE run via the REGISTRY service;
 *   3. run the GOVERNED writer journey (accepted intake + gap lineage from
 *      the committed Sutherland fixtures -> policy -> brief -> snapshot ->
 *      APPROVED snapshot through the existing approval command);
 *   4. ONE real generateProposal (Merge Gateway, real GLM);
 *   5. verify: HTTP 200 -> strict JSON -> Zod PASS -> PG row + digest
 *      verified by independent re-read -> view surfaces pilot authority;
 *   6. verify Writer Proposal saved ≠ Content Accepted ≠ Production Approved
 *      (no accepted page content, no release approval rows);
 *   7. emit a REDACTED evidence JSON to docs/evidence/artifacts/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import { performance } from "node:perf_hooks";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const factoryRoot = path.join(REPO_ROOT, "apps/factory");

// --- env preflight (fail closed) -------------------------------------------
const env = process.env;
const missing: string[] = [];
if (!(env["MERGE_GATEWAY_API_KEY"] ?? "").trim()) {
  try { process.loadEnvFile?.(path.join(REPO_ROOT, ".env")); } catch { /* absent */ }
  // tsx cwd-relative fallback:
  if (!(env["MERGE_GATEWAY_API_KEY"] ?? "").trim()) {
    try { process.loadEnvFile?.(); } catch { /* absent */ }
  }
}
if (!(env["MERGE_GATEWAY_API_KEY"] ?? "").trim()) missing.push("MERGE_GATEWAY_API_KEY");
if (!env["FACTORY_TEST_DATABASE_URL"]?.trim()) missing.push("FACTORY_TEST_DATABASE_URL");
if (missing.length > 0) {
  console.error(JSON.stringify({
    verdict: "BLOCKED",
    stage: "preflight",
    missingPrerequisites: missing,
    note: "P1-03 LIVE: BLOCKED — no paid call attempted.",
  }, null, 2));
  process.exit(2);
}

const { createTestDatabase, resetTestDatabase } = await import(path.join(factoryRoot, "tests/persistence/helpers.js") + "");
const { migrateDb } = await import(path.join(factoryRoot, "src/persistence/migrate.js") + "");
const { sql } = await import("drizzle-orm") as typeof import("drizzle-orm");
const { registerMergePilotProfile, openMergePilotRun } = await import(path.join(factoryRoot, "src/models/merge-pilot-registry.js") + "");
const { resolvePilotGrant } = await import(path.join(factoryRoot, "src/models/merge-pilot-guard.js") + "");
const { seedSutherlandProject } = await import(path.join(factoryRoot, "tests/fixtures/sutherland-seeds.js") + "");
const { WriterStore, WriterSnapshotStore, WriterQaStore } = await import(path.join(factoryRoot, "src/writer/writer-store.js") + "");
const { WriterService } = await import(path.join(factoryRoot, "src/writer/service.js") + "");
const { WriterBudgetStore } = await import(path.join(factoryRoot, "src/writer/budget.js") + "");
const { mergePilotSpendingReport } = await import(path.join(factoryRoot, "src/models/pilot-budget.js") + "");

const dbInst = await createTestDatabase();
const runStartedAt = performance.now();
const evidence: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  profileVersion: "merge-gateway-test-pilot-v1",
  model: "zai/glm-5.3-flash",
  provider: "merge",
  publicationAuthority: false,
};

try {
  await migrateDb(dbInst.db);
  await resetTestDatabase(dbInst);

  // 1. governed journey from committed fixtures FIRST (creates the project);
  // the pilot profile is registered on THIS exact project id.
  const key = `factory-pilot-live-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const seeded = await seedSutherlandProject(dbInst, key);
  const projectId = seeded.projectId;
  evidence.projectKey = key;
  evidence.projectId = projectId;

  // 2. registry-backed pilot authority ($2 ceiling hard-pinned by check).
  await registerMergePilotProfile(dbInst.db, { projectId, approvedBy: "operator-live-proof" });
  const run = await openMergePilotRun(dbInst.db, { projectId, note: "p1-03 live proof" });
  const grant = await resolvePilotGrant({
    db: dbInst.db,
    projectId,
    runId: run.run.id,
    role: "content_writer",
    env: { FACTORY_LLM_PROVIDER: "merge" },
  });
  evidence.pilotProfileId = grant.profileId;
  evidence.pilotProfileDigest = grant.profileDigest;
  evidence.pilotRunId = grant.runId;
  evidence.effectiveBudgetLimitMicros = grant.effectiveBudgetLimitMicros;

  // Expose the db to the writer service pilot path (trusted server seam).
  (globalThis as { __factoryWriterPilotDb?: unknown }).__factoryWriterPilotDb = dbInst.db;
  (globalThis as { __factoryWriterPilotRunId?: string }).__factoryWriterPilotRunId = grant.runId;
  process.env["FACTORY_LLM_PROVIDER"] = "merge";
  const writerStores = {
    store: new WriterStore(dbInst.db),
    snapshots: new WriterSnapshotStore(dbInst.db),
    budget: new WriterBudgetStore(dbInst.db),
    qa: new WriterQaStore(dbInst.db),
  };
  const writer = new WriterService(writerStores.store, writerStores.snapshots, writerStores.budget, writerStores.qa);
  const policy = await writerStores.store.deriveWriterPolicyDraft({ projectId });
  await writerStores.store.approveWriterPolicy({ projectId, policyId: policy.id, expectedVersion: policy.version, expectedDigest: policy.policyDigest });
  const brief = await writerStores.store.saveBriefDraft({
    projectId,
    pageTarget: {
      slug: "home",
      title: "Sutherland Private Office — independent property advisory (FICTION LIVE FIXTURE)",
      objective: "Explain the advisory positioning to prospective vendors and buyers in the French Alps (fixture data only).",
      audience: "Property owners and buyers (fictional fixture audience)",
      structureGuidance: ["positioning", "practical guidance"],
      internalLinkIntent: [],
      ctaIntent: "Discuss a valuation",
      designBinding: { schemaVersion: "page-design-binding-v1" as const, archetype: "service" as const },
    },
    contentBriefKeyPoints: [],
  });
  await writerStores.store.approveBrief({ projectId, briefId: brief.id, expectedVersion: brief.version, expectedDigest: brief.digest });
  const snapshot = await writer.compileSnapshot({ projectId });
  // The snapshot approval is the TEST-SCENARIO human gate inside the same
  // governed command surface — explicitly NOT a production approval.
  await writer.approveSnapshot({ projectId, snapshotId: snapshot.id, expectedVersion: snapshot.version, expectedDigest: snapshot.digest });
  evidence.snapshotId = snapshot.id;
  evidence.snapshotDigest = snapshot.digest;
  evidence.promptDigest = null; // snapshot digest binds the full compiled packet

  // 4. ONE real governed GLM invocation.
  const proposal = await writer.generateProposal({ projectId, snapshotId: snapshot.id }, { env: { FACTORY_LLM_PROVIDER: "merge" } });

  // 5. verify persistence + digest by independent re-read.
  const redesc = await dbInst.db.execute(sql`
    SELECT p.id, p.version, p.proposal_digest, p.provider, p.model, p.authority_status,
           p.pilot_profile_id, p.pilot_run_id, p.request_digest, p.response_digest,
           p.provider_reported_cost_micros, p.policy_estimated_cost_micros, p.accounted_cost_micros,
           p.data->>'title' AS title, p.data->>'metaDescription' AS metaDescription,
           CASE WHEN jsonb_typeof(p.data->'internalLinks') = 'array'
                AND (SELECT COUNT(*) FROM jsonb_array_elements_text(p.data->'internalLinks') el) 
                    = jsonb_array_length(p.data->'internalLinks')
                THEN 'strings' ELSE 'non-strings' END AS links_type
    FROM page_content_proposals p WHERE p.id = ${proposal.id} AND p.project_id = ${projectId}
  `);
  const reRead = redesc.rows[0] as Record<string, unknown> | undefined;
  if (!reRead) throw new Error("proposal row missing after save (digest verification failed)");
  assert.equal(reRead.proposal_digest, proposal.digest, "digest verified by independent re-read");
  assert.equal(reRead.authority_status, "pilot_no_publication");
  assert.equal(reRead.links_type, "strings", "internalLinks persisted as string array (the original defect fixed)");
  evidence.proposal = {
    id: proposal.id,
    version: proposal.version,
    digest: proposal.digest,
    provider: reRead.provider,
    model: reRead.model,
    authorityStatus: reRead.authority_status,
    requestDigest: reRead.request_digest,
    responseDigest: reRead.response_digest,
    providerReportedCostMicros: reRead.provider_reported_cost_micros,
    policyEstimatedCostMicros: reRead.policy_estimated_cost_micros,
    accountedCostMicros: reRead.accounted_cost_micros,
    title: reRead.title,
    metaDescription: reRead.metaDescription,
    internalLinksType: reRead.links_type,
  };

  // 6. saved ≠ accepted ≠ production-approved.
  const acceptance = await dbInst.db.execute(sql`
    SELECT
      (SELECT COUNT(*)::text FROM accepted_page_content WHERE project_id = ${projectId}) AS accepted,
      (SELECT COUNT(*)::text FROM production_page_inputs WHERE project_id = ${projectId}) AS ppi,
      (SELECT COUNT(*)::text FROM release_approvals) AS release_approvals
  `);
  const counts = acceptance.rows[0] as Record<string, string>;
  assert.equal(counts.accepted, "0", "Writer Proposal saved ≠ Content Accepted");
  assert.equal(counts.ppi, "0", "no production page input was created");
  assert.equal(counts.release_approvals, "0", "no production approval exists");
  evidence.separationChecks = counts;

  // Unified pilot spending report (all roles against the $2 ceiling).
  const spending = await mergePilotSpendingReport(dbInst.db);
  evidence.unifiedPilotSpending = {
    totalMicros: spending.totalMicros,
    perLedger: spending.perLedger,
    activeReservationMicros: spending.activeReservationMicros,
    ceilingMicros: grant.effectiveBudgetLimitMicros,
  };
  evidence.durationMs = Math.round(performance.now() - runStartedAt);
  evidence.verdict = "PASS";
  evidence.note = "Real GLM proposal saved under registry-backed TEST-ONLY authority; no acceptance/approval/publication.";
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.verdict = "BLOCKED";
  evidence.error = error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800);
  console.error(JSON.stringify(evidence, null, 2));
  const Spending = await mergePilotSpendingReport(dbInst.db).catch(() => null);
  if (Spending) evidence.unifiedPilotSpendingAtFailure = Spending;
  try {
    const artifacts = path.join(REPO_ROOT, "docs/evidence/artifacts");
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, "merge-writer-live-blocked.json"), JSON.stringify(evidence, null, 2));
  } catch { /* best-effort evidence write */ }
  process.exitCode = 3;
} finally {
  await dbInst.close();
}
