import test from "node:test";
import assert from "node:assert/strict";
import { sql, eq } from "drizzle-orm";
import { setupMigratedTestDatabase } from "./helpers.js";
import { seedProjectWithAcceptedInputs } from "../fixtures/writer-seeds.js";
import { acceptFixturePage, prepareFixturePage, assignmentPage } from "../fixtures/accepted-page.js";
import { acquireAcceptedGap } from "../fixtures/search-gap.js";
import { PageAuthorityReader } from "../../src/writer/page-authority.js";
import { WriterStore, WriterSnapshotStore, WriterQaStore } from "../../src/writer/writer-store.js";
import { DesignStore } from "../../src/design/design-store.js";
import { ProjectIntakeStore } from "../../src/operator/intake-store.js";
import { SearchStore } from "../../src/search/search-store.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { searchBudgetReservations, projectInputSnapshots, serpSnapshots, searchRuns, acceptedContentGapSnapshots } from "../../src/persistence/schema.js";
import { deterministicDigest } from "../../src/intelligence/digest.js";
import { createDatabaseInstance } from "../../src/persistence/db.js";
import { resolveTestDatabaseUrl } from "./helpers.js";

test("P1-E/I: newer SERP stales brief, snapshot, proposal, content acceptance and Design", async () => {
  const db = await setupMigratedTestDatabase();
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "system-stale");
    const page = await acceptFixturePage(db, seed.projectId, "home");
    const writer = new WriterStore(db.db), snapshots = new WriterSnapshotStore(db.db);
    const brief = (await writer.latestBrief(seed.projectId))!, snapshot = (await snapshots.latestSnapshot(seed.projectId))!, proposal = (await snapshots.latestProposal(seed.projectId))!;
    const [oldSerp] = await db.db.select().from(serpSnapshots).where(eq(serpSnapshots.projectId, seed.projectId));
    const [oldRun] = await db.db.select().from(searchRuns).where(eq(searchRuns.id, oldSerp!.runId));
    await db.db.insert(searchRuns).values({ ...oldRun!, id: "newer-run" });
    await db.db.insert(serpSnapshots).values({ ...oldSerp!, id: "newer-serp", runId: "newer-run", observedAt: new Date(oldSerp!.observedAt.getTime() + 1000) });
    assert.equal((await writer.briefStaleness(seed.projectId, brief)).stale, true);
    assert.equal((await snapshots.snapshotStaleness(seed.projectId, snapshot)).stale, true);
    assert.equal((await snapshots.proposalStaleness(seed.projectId, proposal)).stale, true);
    await assert.rejects(new PageAuthorityReader(db.db).requireCurrent(seed.projectId, page), /SERP/);
    await assert.rejects(new DesignStore(db.db).deriveInputSnapshotDraft({ projectId: seed.projectId }), /SERP/);
  } finally { await db.close(); }
});

test("P1-G: same-slug acceptance versions are immutable and exact reacceptance stays historical", async () => {
  const db = await setupMigratedTestDatabase();
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "system-version");
    const first = await acceptFixturePage(db, seed.projectId, "home");
    const second = await acceptFixturePage(db, seed.projectId, "home");
    assert.ok(second.version > first.version);
    assert.deepEqual(await new PageAuthorityReader(db.db).historical(seed.projectId, first.id), first);
    assert.equal((await new PageAuthorityReader(db.db).currentPages(seed.projectId))[0]!.id, second.id);
    const replay = await new WriterQaStore(db.db).acceptContent({ projectId: seed.projectId, proposalId: first.proposalId, expectedProposalDigest: first.proposalDigest });
    assert.equal(replay.id, first.id);
    await assert.rejects(new PageAuthorityReader(db.db).requireCurrent(seed.projectId, first), /superseded/);
  } finally { await db.close(); }
});

test("P1-I: Intake v2 cannot combine with unchanged accepted content v1", async () => {
  const db = await setupMigratedTestDatabase();
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "system-intake");
    await acceptFixturePage(db, seed.projectId, "home");
    const store = new DesignStore(db.db);
    const design = await store.deriveInputSnapshotDraft({ projectId: seed.projectId });
    const intake = new ProjectIntakeStore(db.db), draft = (await intake.getDraft(seed.projectId))!;
    const payload = structuredClone(draft.payload) as any;
    payload.business.description += " Updated accepted input.";
    const saved = await intake.saveDraft({ projectId: seed.projectId, baseRevision: draft.revision, payload });
    await intake.accept({ projectId: seed.projectId, expectedRevision: saved.revision, expectedDigest: deterministicDigest(payload) });
    await assert.rejects(store.deriveInputSnapshotDraft({ projectId: seed.projectId }), /ProjectInput|project input/);
    assert.equal((await store.inputSnapshotStaleness(seed.projectId, design)).stale, true);
  } finally { await db.close(); }
});

test("P1-C/D: cross-project cache and real concurrent UNKNOWN-cost ceiling", async () => {
  const db = await setupMigratedTestDatabase(), other = createDatabaseInstance(resolveTestDatabaseUrl());
  try {
    const a = await seedProjectWithAcceptedInputs(db, "system-a"), b = await seedProjectWithAcceptedInputs(db, "system-b");
    const search = new SearchStore(db.db);
    const run = (await search.listRuns(a.projectId))[0]!;
    assert.equal(await search.findFreshSerp(b.projectId, run.requestDigest, 1000), null);
    const budget = new WriterBudgetStore(db.db, searchBudgetReservations), competing = new WriterBudgetStore(other.db, searchBudgetReservations);
    const input = { provider: "test", model: "test", authorizedMicros: 600000, invocationDigest: "a".repeat(64) };
    const outcomes = await Promise.allSettled([budget.reserveWriterBudget(input, 1), competing.reserveWriterBudget(input, 1)]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    const winner = outcomes.find(r => r.status === "fulfilled")!;
    assert.equal(winner.status, "fulfilled");
    await winner.value.account(null);
    assert.equal((await budget.getWriterBudgetSummary()).accountedTodayMicros, 600000);
    await assert.rejects(competing.reserveWriterBudget(input, 1), /budget/);
  } finally { await other.close(); await db.close(); }
});

test("P1-J: real Search to accepted Gap to Writer page carries exact acquired lineage", async () => {
  const db = await setupMigratedTestDatabase();
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "system-golden");
    const gap = await acquireAcceptedGap(db, seed.projectId);
    const page = await acceptFixturePage(db, seed.projectId, "home");
    const brief = (await new WriterStore(db.db).latestBrief(seed.projectId))!;
    assert.equal(brief.gapSnapshotId, gap.accepted.snapshotId);
    assert.equal(brief.noGapLineageAcknowledged, false);
    const design = await new DesignStore(db.db).deriveInputSnapshotDraft({ projectId: seed.projectId });
    assert.equal((design.data as any).contentRefs[0].id, page.id);
  } finally { await db.close(); }
});

test("P1-F: durable no-gap acceptance cannot qualify for Design authority", async () => {
  const db = await setupMigratedTestDatabase();
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "system-waiver");
    await db.db.delete(acceptedContentGapSnapshots).where(eq(acceptedContentGapSnapshots.projectId, seed.projectId));
    const page = await acceptFixturePage(db, seed.projectId, "home", true);
    const brief = (await new WriterStore(db.db).latestBrief(seed.projectId))!;
    assert.equal(brief.noGapLineageAcknowledged, true);
    await assert.rejects(new DesignStore(db.db).deriveInputSnapshotDraft({ projectId: seed.projectId }), /Incomplete no-gap/);
    assert.equal((await new PageAuthorityReader(db.db).historical(seed.projectId, page.id))!.id, page.id);
  } finally { await db.close(); }
});

test("P1-G: concurrent same-proposal acceptance is idempotent; different slugs serialize versions", async () => {
  const db = await setupMigratedTestDatabase();
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "system-accept-race");
    const first = await prepareFixturePage(db, seed.projectId, "home");
    const second = await prepareFixturePage(db, seed.projectId, "services");
    const accept = (p: typeof first) => p.service.acceptContent({ projectId: seed.projectId, proposalId: p.proposal.id, expectedProposalDigest: p.proposal.digest });
    const [a, replay, b] = await Promise.all([accept(first), accept(first), accept(second)]);
    assert.equal(a.id, replay.id);
    assert.notEqual(a.version, b.version);
    assert.equal((await new PageAuthorityReader(db.db).currentPages(seed.projectId)).length, 2);
  } finally { await db.close(); }
});

test("P1-H/J: exact asset assignment rejects missing, wrong, cross-project and superseded pages", async () => {
  const db = await setupMigratedTestDatabase();
  const { AssetStore } = await import("../../src/assets/asset-store.js");
  const { AssetService } = await import("../../src/assets/service.js");
  const { createAssetStorage } = await import("../../src/assets/storage.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const sharp = (await import("sharp")).default;
  const root = await mkdtemp(`${tmpdir()}/system-assets-`);
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "system-assignment");
    const page = await acceptFixturePage(db, seed.projectId, "home");
    const assets = new AssetService({ store: new AssetStore(db.db), storage: createAssetStorage(root) });
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#669988" } }).jpeg().toBuffer();
    const upload = await assets.uploadAsset(seed.projectId, { filename: "test.jpg", kind: "photo", title: "Test pixels", rightsStatus: "operator_owned", dataBase64: bytes.toString("base64") });
    const approved = await assets.approveVersion(seed.projectId, upload.version.id, upload.version.binaryDigest);
    const input = { ...await assignmentPage(db, seed.projectId, "home", approved.governanceDigest!), assetId: upload.asset.id, versionId: approved.id, expectedBinaryDigest: approved.binaryDigest, pageSlug: "home", role: "hero" };
    for (const mutation of [{ acceptedPageContentId: "missing" }, { acceptedPageContentVersion: page.version + 1 }, { acceptedPageContentDigest: "0".repeat(64) }, { pageSlug: "other" }]) {
      await assert.rejects(assets.assignVersion(seed.projectId, { ...input, ...mutation }), /page/i);
    }
    const other = await seedProjectWithAcceptedInputs(db, "system-assignment-other");
    const foreign = await acceptFixturePage(db, other.projectId, "home");
    await assert.rejects(assets.assignVersion(seed.projectId, { ...input, acceptedPageContentId: foreign.id }), /page/i);
    const bound = await assets.assignVersion(seed.projectId, input);
    await assert.rejects(db.pool.query("UPDATE asset_page_assignments SET accepted_page_content_version = NULL WHERE id = $1", [bound.id]), /assignment_page_lineage_complete/);
    const newer = await acceptFixturePage(db, seed.projectId, "home");
    await assert.rejects(assets.assignVersion(seed.projectId, { ...input, role: "supporting" }), /superseded/);
    await assert.rejects(new DesignStore(db.db).deriveInputSnapshotDraft({ projectId: seed.projectId }), /assignment/i);
    await assets.replaceAssignment(seed.projectId, bound.id, { toVersionId: approved.id, expectedBinaryDigest: approved.binaryDigest, pageAuthority: newer });
    const history = await new AssetStore(db.db).assignmentHistory(seed.projectId);
    assert.equal(history.length, 1);
    assert.equal((history[0]!.binding as any).acceptedPageContentId, page.id);
    await assert.rejects(db.pool.query("UPDATE asset_assignment_history SET binding = '{}' WHERE id = $1", [history[0]!.id]), /immutable/);
    const design = await new DesignStore(db.db).deriveInputSnapshotDraft({ projectId: seed.projectId });
    assert.equal((design.data as any).assetRefs[0].acceptedPageContentId, newer.id);
  } finally { await rm(root, { recursive: true, force: true }); await db.close(); }
});

test("P1-E/G: upstream commit while acceptance waits is rechecked under the project authority lock", async () => {
  const db = await setupMigratedTestDatabase();
  const client = await db.pool.connect();
  try {
    const seed = await seedProjectWithAcceptedInputs(db, "system-upstream-race");
    const pending = await prepareFixturePage(db, seed.projectId, "home");
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 104))", [seed.projectId]);
    const rejection = assert.rejects(pending.service.acceptContent({ projectId: seed.projectId, proposalId: pending.proposal.id, expectedProposalDigest: pending.proposal.digest }), /SERP/);
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      waiting = (await client.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory' AND pid <> pg_backend_pid() LIMIT 1")).rowCount! > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, "acceptance must wait on the shared authority lock");
    await client.query("UPDATE serp_snapshots SET snapshot_digest = $1 WHERE project_id = $2", ["f".repeat(64), seed.projectId]);
    await client.query("COMMIT");
    await rejection;
  } finally { await client.query("ROLLBACK"); client.release(); await db.close(); }
});
