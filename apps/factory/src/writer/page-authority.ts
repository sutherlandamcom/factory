import { parseContentBriefData, type DesignArchetypeKind } from "@factory/contracts";
import { and, desc, eq } from "drizzle-orm";
import type { FactoryDb } from "../persistence/db.js";
import { acceptedPageContent, pageContentProposals, writerPromptSnapshots, contentBriefs } from "../persistence/schema.js";
import { WriterStore, WriterSnapshotStore } from "./writer-store.js";
import { PageArchetypeStore } from "../page-authority/store.js";
import { FactoryError } from "../executor/errors.js";

export class PageAuthorityReader {
  constructor(private readonly db: FactoryDb) {}
  /** Durable typed page authority in PageArchetypeStore owns page classification. */
  async requireArchetype(projectId: string, pageIdOrSlug: string, supported?: readonly DesignArchetypeKind[]): Promise<DesignArchetypeKind> {
    const pageArchetypeStore = new PageArchetypeStore(this.db);
    const page = await this.historical(projectId, pageIdOrSlug);
    const pageSlug = page ? page.slug : pageIdOrSlug;
    if (page) {
      await this.requireCurrent(projectId, page);
    }
    const archetype = await pageArchetypeStore.getArchetype(projectId, pageSlug);
    if (archetype) {
      if (supported && !supported.includes(archetype)) {
        throw new FactoryError("page_archetype_unsupported", `Accepted design does not support approved archetype ${archetype}.`);
      }
      return archetype;
    }
    // Backward compatibility fallback for historical briefs before page_archetype_authorities table
    if (page) {
      const [row] = await this.db.select({ data: contentBriefs.data, state: contentBriefs.state }).from(pageContentProposals)
        .innerJoin(writerPromptSnapshots, eq(pageContentProposals.snapshotId, writerPromptSnapshots.id))
        .innerJoin(contentBriefs, eq(writerPromptSnapshots.briefId, contentBriefs.id))
        .where(and(eq(pageContentProposals.id, page.proposalId), eq(pageContentProposals.projectId, projectId), eq(contentBriefs.projectId, projectId)));
      const briefArchetype = row?.state === "approved" ? parseContentBriefData(row.data).pageTarget.designBinding?.archetype : undefined;
      if (briefArchetype) {
        if (supported && !supported.includes(briefArchetype)) {
          throw new FactoryError("page_archetype_unsupported", `Accepted design does not support approved archetype ${briefArchetype}.`);
        }
        return briefArchetype;
      }
    }
    throw new FactoryError("page_archetype_unclassified", `Page "${pageSlug}" has no durable accepted archetype authority; register page archetype first.`);
  }

  async currentPages(projectId: string) {
    const rows = await this.db.select().from(acceptedPageContent).where(eq(acceptedPageContent.projectId, projectId)).orderBy(desc(acceptedPageContent.version));
    return rows.filter((row, i) => rows.findIndex(other => other.slug === row.slug) === i);
  }
  async historical(projectId: string, id: string) {
    const [row] = await this.db.select().from(acceptedPageContent).where(and(eq(acceptedPageContent.projectId, projectId), eq(acceptedPageContent.id, id)));
    return row ?? null;
  }
  async requireCurrent(projectId: string, ref: { id: string; version: number; contentDigest: string; slug: string }, fullLineage = true) {
    const page = (await this.currentPages(projectId)).find(row => row.slug === ref.slug);
    const fail = (reason: string): never => { throw new FactoryError("writer_artifact_stale", reason); };
    if (!page || page.id !== ref.id || page.version !== ref.version || page.contentDigest !== ref.contentDigest) return fail("Accepted page is missing, mismatched or superseded.");
    const [proposal] = await this.db.select().from(pageContentProposals).where(and(eq(pageContentProposals.projectId, projectId), eq(pageContentProposals.id, page.proposalId)));
    if (!proposal || proposal.proposalDigest !== page.proposalDigest) return fail("Accepted page proposal lineage changed.");
    const stale = await new WriterSnapshotStore(this.db).proposalStaleness(projectId, proposal);
    if (stale.stale) return fail(stale.reason!);
    const [snapshot] = await this.db.select().from(writerPromptSnapshots).where(and(eq(writerPromptSnapshots.projectId, projectId), eq(writerPromptSnapshots.id, proposal.snapshotId)));
    if (!snapshot) return fail("Writer snapshot is missing.");
    const [brief] = await this.db.select().from(contentBriefs).where(and(eq(contentBriefs.projectId, projectId), eq(contentBriefs.id, snapshot.briefId)));
    if (!brief) return fail("Writer brief is missing.");
    const upstream = await new WriterStore(this.db).briefStaleness(projectId, brief);
    if (upstream.stale) return fail(upstream.reason!);
    if (fullLineage && (!brief.gapSnapshotId || brief.noGapLineageAcknowledged)) return fail("Incomplete no-gap lineage cannot qualify as full production authority.");
    return page;
  }
}
