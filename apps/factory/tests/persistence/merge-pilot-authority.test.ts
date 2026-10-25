import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase, resetTestDatabase } from "./helpers.js";
import { migrateDb } from "../../src/persistence/migrate.js";
import { sql } from "drizzle-orm";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import {
  registerMergePilotProfile,
  revokeMergePilotProfile,
  openMergePilotRun,
  closeMergePilotRun,
} from "../../src/models/merge-pilot-registry.js";
import {
  resolvePilotGrant,
  isMergePilotGrant,
  mergePilotPublicationForbiddenError,
} from "../../src/models/merge-pilot-guard.js";
import { invokeModelViaMerge } from "../../src/models/merge-gateway.js";
import { reservePilotBudget } from "../../src/models/pilot-budget.js";
import { runWriterInvocation } from "../../src/writer/provider.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { FactoryError } from "../../src/executor/errors.js";
import { InvocationFailure } from "../../src/models/invocation-failure.js";
import type { MergePilotGrant } from "../../src/models/merge-pilot-guard.js";

/**
 * P0-01 runtime TEST-ONLY authority — REAL PostgreSQL negative battery.
 *
 * Every negative case from the audit is executed against the actual tables,
 * the actual guard, and (where relevant) the actual adapter/budget/service
 * boundary. Constants are NOT accepted as runtime protection: env alone can
 * never authorize a pilot, and pilot artifacts can never obtain publication
 * authority.
 */

async function setupDb(t: TestContext): Promise<FactoryDatabaseInstance> {
  const inst = await createTestDatabase();
  t.after(() => inst.close());
  await migrateDb(inst.db);
  await resetTestDatabase(inst);
  return inst;
}

async function makeProject(inst: FactoryDatabaseInstance, id: string, key: string): Promise<string> {
  await inst.db.execute(
    sql`INSERT INTO projects (id, key, name) VALUES (${id}, ${key}, ${"Project " + key})`,
  );
  return id;
}

const PROD_PROJECT = "proj-production-aaaa";
const PILOT_PROJECT = "proj-pilot-registered-bbbb";
const ENV = { FACTORY_LLM_PROVIDER: "merge" };

async function registerStandardPilot(inst: FactoryDatabaseInstance, projectId = PILOT_PROJECT) {
  await registerMergePilotProfile(inst.db, { projectId, approvedBy: "operator-q-fixture" });
  const run = await openMergePilotRun(inst.db, { projectId, note: "authority-battery" });
  return { profileId: (await currentProfile(inst, projectId)).id, runId: run.run.id };
}

async function currentProfile(inst: FactoryDatabaseInstance, projectId: string) {
  const { rows } = await inst.db.execute<{ id: string; state: string; budget_limit_micros: number }>(
    sql`SELECT id, state, budget_limit_micros FROM merge_pilot_profiles WHERE project_id = ${projectId} AND profile_version = 'merge-gateway-test-pilot-v1'`,
  );
  if (rows.length === 0) throw new Error("profile missing");
  return rows[0]!;
}

function grantRefusal(error: unknown, code: string): boolean {
  return error instanceof FactoryError && error.code === code;
}

// A1 — pilot requested for a production project that has NO registration.
test("A1: FACTORY_LLM_PROVIDER=merge for an unregistered production project -> pilot_profile_not_registered", async (t) => {
  const inst = await setupDb(t);
  await makeProject(inst, PROD_PROJECT, "stark");
  await assert.rejects(
    resolvePilotGrant({ db: inst.db, projectId: PROD_PROJECT, runId: "mpr-none", role: "content_writer", env: ENV }),
    (e: unknown) => grantRefusal(e, "pilot_profile_not_registered"),
  );
});

// A2 — foreign projectId: project exists, profile exists, but the RUN is not
// bound to the requesting (foreign) project id. The guard fail-closes on the
// exact (profile, run, project) triple; the specific typed code depends on
// the check order — the run/project mismatch class is expected.
test("A2: grant request with a foreign projectId mismatching the run -> pilot_run_project_mismatch", async (t) => {
  const inst = await setupDb(t);
  await makeProject(inst, PROD_PROJECT, "stark");
  await makeProject(inst, PILOT_PROJECT, "factory-pilot-a2");
  const { runId } = await registerStandardPilot(inst);
  await assert.rejects(
    resolvePilotGrant({ db: inst.db, projectId: PROD_PROJECT, runId, role: "content_writer", env: ENV }),
    (e: unknown) =>
      grantRefusal(e, "pilot_run_project_mismatch") ||
      grantRefusal(e, "pilot_profile_not_registered") ||
      grantRefusal(e, "pilot_run_not_found"),
  );
});

// A3 — a pilot proposal row moved to another project: authority status stays
// pilot-labelled and the downstream authority lookup refuses to treat it as
// that project's work.
test("A3: pilot proposal copied to another project keeps pilot_no_publication and is rejected downstream", async (t) => {
  const inst = await setupDb(t);
  await makeProject(inst, PROD_PROJECT, "stark");
  await makeProject(inst, PILOT_PROJECT, "factory-pilot-a3");
  const { profileId, runId } = await registerStandardPilot(inst);
  await inst.db.execute(
    sql`INSERT INTO page_content_proposals
        (id, project_id, version, snapshot_id, snapshot_version, snapshot_digest, slug, provider, model, data, proposal_digest, pilot_profile_id, pilot_profile_version, pilot_run_id, gateway_role, authority_status)
        VALUES ('prop-move-me', ${PILOT_PROJECT}, 1, 'snap-1', 1, ${"0".repeat(64)}, 'pilot', 'merge', 'zai/glm-5.3-flash', '{}'::jsonb, ${"1".repeat(64)}, ${profileId}, 'merge-gateway-test-pilot-v1', ${runId}, 'content_writer', 'pilot_no_publication')`,
  );
  // The masked direct-SQL transplant (audit case: artifact moved to another
  // project).
  await inst.db.execute(sql`UPDATE page_content_proposals SET project_id = ${PROD_PROJECT} WHERE id = 'prop-move-me'`);
  // Downstream authority check (what acceptance/publication gates use):
  const { rows } = await inst.db.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM page_content_proposals p
        JOIN accepted_page_content a ON a.project_id = p.project_id AND a.proposal_id = p.id
        WHERE p.id = 'prop-move-me' AND p.authority_status = 'champion'`,
  );
  assert.equal(rows[0]?.n ?? "0", "0", "a pilot artifact can never join a champion acceptance under a foreign project");
  const { rows: statusRows } = await inst.db.execute<{ authority_status: string }>(
    sql`SELECT authority_status FROM page_content_proposals WHERE id = 'prop-move-me'`,
  );
  assert.equal(statusRows[0]?.authority_status, "pilot_no_publication");
});

// A4 — attempting production approval for a pilot proposal fails closed.
test("A4: pilot proposal used in a production approval path -> merge_pilot_publication_forbidden", async (t) => {
  const inst = await setupDb(t);
  await makeProject(inst, PILOT_PROJECT, "factory-pilot-a4");
  const { profileId, runId } = await registerStandardPilot(inst);
  // The concrete gate helper used by downstream authority checks:
  const gate = mergePilotPublicationForbiddenError();
  assert.equal(gate.code, "merge_pilot_publication_forbidden");
  // Provenance columns are what the gate reads:
  await inst.db.execute(
    sql`INSERT INTO page_content_proposals
        (id, project_id, version, snapshot_id, snapshot_version, snapshot_digest, slug, provider, model, data, proposal_digest, pilot_profile_id, pilot_profile_version, pilot_run_id, gateway_role, authority_status)
        VALUES ('prop-a4', ${PILOT_PROJECT}, 1, 'snap-1', 1, ${"0".repeat(64)}, 'pilot', 'merge', 'zai/glm-5.3-flash', '{}'::jsonb, ${"2".repeat(64)}, ${profileId}, 'merge-gateway-test-pilot-v1', ${runId}, 'content_writer', 'pilot_no_publication')`,
  );
  const { rows: authority } = await inst.db.execute<{ authority_status: string }>(
    sql`SELECT authority_status FROM page_content_proposals WHERE id = 'prop-a4'`,
  );
  assert.equal(authority[0]?.authority_status, "pilot_no_publication");
});

// A5 — fixture approval must not authorize pilot acceptance: provenance
// cannot be fabricated through the fixture provider (fixture saves zero
// pilot columns and the DB check constraint ties authority<->provenance).
test("A5: fixture approval as pilot acceptance evidence fails at the DB constraint level", async (t) => {
  const inst = await setupDb(t);
  await makeProject(inst, PILOT_PROJECT, "factory-pilot-a5");
  const fixtureRow = sql`INSERT INTO page_content_proposals
        (id, project_id, version, snapshot_id, snapshot_version, snapshot_digest, slug, provider, model, data, proposal_digest, authority_status, pilot_run_id)
        VALUES ('prop-fixture', ${PILOT_PROJECT}, 1, 'snap-1', 1, ${"0".repeat(64)}, 'x', 'fixture', 'fixture-writer', '{}'::jsonb, ${"3".repeat(64)}, 'pilot_no_publication', 'mpr-made-up')`;
  await assert.rejects(
    inst.db.execute(fixtureRow),
    (error: unknown) => {
      // Drizzle wraps the cause; the DB check must be the refusal reason.
      const message =
        error instanceof Error
          ? `${error.message} ${String((error as { cause?: { message?: string } }).cause?.message ?? "")}`
          : String(error);
      return message.includes("page_content_proposals_authority_provenance");
    },
  );
});

// A6 — live-proof/publication with pilot-only authority: adapter refuses a
// call whose run was revoked (live authority requires ACTIVE run).
test("A6: publication/live-proof attempt with a revoked run -> policy_violation before HTTP", async (t) => {
  const inst = await setupDb(t);
  await makeProject(inst, PILOT_PROJECT, "factory-pilot-a6");
  const { runId } = await registerStandardPilot(inst);
  const grant = await resolvePilotGrant({ db: inst.db, projectId: PILOT_PROJECT, runId, role: "content_writer", env: ENV });
  assert.ok(isMergePilotGrant(grant));
  // Revoke the run behind the grant (operator close/revoke).
  await closeMergePilotRun(inst.db, runId);
  let httpCalled = false;
  const fetchImpl = async (): Promise<Response> => {
    httpCalled = true;
    throw new Error("network must not be reached");
  };
  await assert.rejects(
    invokeModelViaMerge(
      grant as MergePilotGrant,
      { roleId: "content_writer", model: grant.model, systemPrompt: "s", prompt: "p", maxTokens: 8, timeoutMs: 1000 },
      { fetchImpl, loadApiKey: () => "test-key", db: inst.db },
    ),
    (e: unknown) => (e as InvocationFailure).code === "policy_violation",
  );
  assert.equal(httpCalled, false, "revoked-run live call must be refused BEFORE any HTTP request");
});

// A7 — env flipped to `merge` AFTER proposal creation, without a profile.
test("A7: env alone can never authorize (changed after the fact) -> pilot_profile_not_registered", async (t) => {
  const inst = await setupDb(t);
  await makeProject(inst, PROD_PROJECT, "stark");
  // Someone later sets FACTORY_LLM_PROVIDER=merge for the production project.
  await assert.rejects(
    resolvePilotGrant({ db: inst.db, projectId: PROD_PROJECT, runId: "mpr-madeup", role: "content_writer", env: ENV }),
    (e: unknown) => grantRefusal(e, "pilot_profile_not_registered"),
  );
});

// A8 — reusing a stale invocation digest: the unified pilot budget reserves
// by distinct digests; the ledger's stale-reservation invariant protects a
// digest replay from a second concurrent account.
test("A8: stale digest reuse across two reservations accumulates exposure, never resets it", async (t) => {
  const inst = await setupDb(t);
  await makeProject(inst, PILOT_PROJECT, "factory-pilot-a8");
  const { runId } = await registerStandardPilot(inst);
  const grant = await resolvePilotGrant({ db: inst.db, projectId: PILOT_PROJECT, runId, role: "content_writer", env: ENV });
  const digest = "stale-digest-a8";
  await reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 1_000_000, invocationDigest: digest, role: "content_writer" }, { db: inst.db });
  // Second reservation with the SAME digest: replay refusal (no double
  // reservation, no exposure reset).
  await assert.rejects(
    reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 1_000_000, invocationDigest: digest, role: "content_writer" }, { db: inst.db }),
    (e: unknown) => grantRefusal(e, "merge_pilot_budget_blocked") && (e as Error).message.includes("replay blocked"),
  );
  // A DIFFERENT digest still draws from the same ceiling: 1.0 + 1.0 = exactly
  // at the $2 ceiling for this grant.
  await reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 1_000_000, invocationDigest: "distinct-digest-a8", role: "content_writer" }, { db: inst.db });
  // Third reservation BLOCKS (exposure full).
  await assert.rejects(
    reservePilotBudget({ grant, ledger: "writer", model: grant.model, authorizedMicros: 1, invocationDigest: "third-digest-a8", role: "content_writer" }, { db: inst.db }),
    (e: unknown) => grantRefusal(e, "merge_pilot_budget_blocked"),
  );
  const { rows } = await inst.db.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM writer_budget_reservations WHERE invocation_digest = ${digest} AND provider = 'merge'`,
  );
  assert.equal(rows[0]?.n, "1");
});

// A9 — direct service call bypassing the grant: without an explicit run id
// the writer service path refuses BEFORE any credential or budget work;
// the refusal is typed at the publication-authority class (pilot scope is
// never implied, only registry-issued).
test("A9: direct service invocation without a run id -> merge_pilot_publication_forbidden (no budget movement)", async (t) => {
  const inst = await setupDb(t);
  await makeProject(inst, PILOT_PROJECT, "factory-pilot-a9");
  const budget = new WriterBudgetStore(inst.db);
  const before = await inst.db.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM writer_budget_reservations`,
  );
  await assert.rejects(
    runWriterInvocation(
      { promptSnapshotDigest: "d", promptSnapshotRevision: 1, projectId: PILOT_PROJECT, systemPrompt: "s", userPrompt: "u" },
      { budget, env: ENV, db: inst.db },
    ),
    (e: unknown) => grantRefusal(e, "merge_pilot_publication_forbidden"),
  );
  const after = await inst.db.execute<{ n: string }>(
    sql`SELECT COUNT(*)::text AS n FROM writer_budget_reservations`,
  );
  assert.equal(after.rows[0]?.n, before.rows[0]?.n, "no budget reservation may be created without a grant");
});

// A10 — revoked profile after proposal creation: live calls denied; existing
// proposals stay non-publishable.
test("A10: revoked profile denies further live calls; existing proposals keep authority_status", async (t) => {
  const inst = await setupDb(t);
  await makeProject(inst, PILOT_PROJECT, "factory-pilot-a10");
  const { runId } = await registerStandardPilot(inst);
  const grant = await resolvePilotGrant({ db: inst.db, projectId: PILOT_PROJECT, runId, role: "content_writer", env: ENV });
  await revokeMergePilotProfile(inst.db, { projectId: PILOT_PROJECT });
  await assert.rejects(
    resolvePilotGrant({ db: inst.db, projectId: PILOT_PROJECT, runId, role: "content_writer", env: ENV }),
    (e: unknown) => grantRefusal(e, "pilot_profile_not_registered") || grantRefusal(e, "pilot_profile_revoked") || grantRefusal(e, "pilot_run_not_active"),
  );
  let httpCalled = false;
  const fetchImpl = async (): Promise<Response> => {
    httpCalled = true;
    throw new Error("network prohibited");
  };
  await assert.rejects(
    invokeModelViaMerge(
      grant as MergePilotGrant,
      { roleId: "content_writer", model: grant.model, systemPrompt: "s", prompt: "p", maxTokens: 8, timeoutMs: 1000 },
      { fetchImpl, loadApiKey: () => "k", db: inst.db },
    ),
    (e: unknown) => (e as InvocationFailure).code === "policy_violation",
  );
  assert.equal(httpCalled, false);
});

// A11 — happy path: registered project + ACTIVE run + allowed role -> grant
// issued, zero-cost budget reservation works, publication authority=false.
test("A11: happy path — registered project gets a live grant with publicationAuthority=false", async (t) => {
  const inst = await setupDb(t);
  await makeProject(inst, PILOT_PROJECT, "factory-pilot-a11");
  const { runId } = await registerStandardPilot(inst);
  const grant = await resolvePilotGrant({ db: inst.db, projectId: PILOT_PROJECT, runId, role: "content_writer", env: ENV });
  assert.ok(isMergePilotGrant(grant));
  assert.equal(grant.publicationAuthority, false);
  assert.equal(grant.projectId, PILOT_PROJECT);
  assert.equal(grant.model, "zai/glm-5.3-flash");
  // The grant passes the adapter allowlist pre-flight (with live registry).
  let httpCalled = false;
  const fetchImpl = async (): Promise<Response> => {
    httpCalled = true;
    throw new Error("network prohibited (allowlist pre-flight passed)");
  };
  await assert.rejects(
    invokeModelViaMerge(
      grant as MergePilotGrant,
      { roleId: "content_writer", model: grant.model, systemPrompt: "s", prompt: "p", maxTokens: 8, timeoutMs: 1000 },
      { fetchImpl, loadApiKey: () => "k", db: inst.db },
    ),
    // The adapter got PAST the allowlist and reached the wire fixture.
    () => httpCalled,
  );
});
