import { WriterStore, WriterSnapshotStore, WriterQaStore } from "../../src/writer/writer-store.js";
import { WriterService } from "../../src/writer/service.js";
import { WriterBudgetStore } from "../../src/writer/budget.js";
import { FixtureWriterProvider } from "../../src/writer/fixture-writer.js";
import type { FactoryDatabaseInstance } from "../../src/persistence/db.js";
import { samplePageTarget } from "./writer-seeds.js";
import { acceptedPageContent } from "../../src/persistence/schema.js";
import { and, desc, eq } from "drizzle-orm";

/** Governed writer acceptance over the test project's acquired Search/Gap authority. */
export async function prepareFixturePage(db: FactoryDatabaseInstance, projectId: string, slug: string, waiver = false) {
  const store = new WriterStore(db.db);
  const service = new WriterService(store, new WriterSnapshotStore(db.db), new WriterBudgetStore(db.db), new WriterQaStore(db.db), new FixtureWriterProvider());
  const currentPolicy = await store.latestWriterPolicy(projectId);
  if (!currentPolicy || (await store.writerPolicyStaleness(projectId, currentPolicy)).stale || currentPolicy.state !== "approved") {
    const policy = await store.deriveWriterPolicyDraft({ projectId });
    await store.approveWriterPolicy({ projectId, policyId: policy.id, expectedVersion: policy.version, expectedDigest: policy.policyDigest });
  }
  const brief = await store.saveBriefDraft({ projectId, pageTarget: { ...samplePageTarget, slug }, contentBriefKeyPoints: [], noGapLineageAcknowledged: waiver });
  await store.approveBrief({ projectId, briefId: brief.id, expectedVersion: brief.version, expectedDigest: brief.digest, noGapLineageAcknowledged: waiver });
  const snapshot = await service.compileSnapshot({ projectId });
  await service.approveSnapshot({ projectId, snapshotId: snapshot.id, expectedVersion: snapshot.version, expectedDigest: snapshot.digest });
  const proposal = await service.generateProposal({ projectId, snapshotId: snapshot.id });
  await service.runQa({ projectId });
  return { service, proposal };
}

export async function acceptFixturePage(db: FactoryDatabaseInstance, projectId: string, slug: string, waiver = false) {
  const { service, proposal } = await prepareFixturePage(db, projectId, slug, waiver);
  const accepted = await service.acceptContent({ projectId, proposalId: proposal.id, expectedProposalDigest: proposal.digest });
  return (await db.db.select().from(acceptedPageContent).where(and(eq(acceptedPageContent.projectId, projectId), eq(acceptedPageContent.id, accepted.id))))[0]!;
}

export async function assignmentPage(db: FactoryDatabaseInstance, projectId: string, slug: string, governanceDigest: string) {
  const page = (await db.db.select().from(acceptedPageContent).where(and(eq(acceptedPageContent.projectId, projectId), eq(acceptedPageContent.slug, slug))).orderBy(desc(acceptedPageContent.version)))[0] ?? await acceptFixturePage(db, projectId, slug);
  return { acceptedPageContentId: page.id, acceptedPageContentVersion: page.version, acceptedPageContentDigest: page.contentDigest, expectedGovernanceDigest: governanceDigest };
}
