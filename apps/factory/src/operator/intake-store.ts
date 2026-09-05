import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { parseProjectIntakePayload, type ProjectIntakePayload } from "@factory/contracts";
import type { FactoryDb } from "../persistence/db.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { evaluateIntakeReadiness } from "./readiness.js";
import {
  projectInputDrafts,
  projectInputSnapshots,
  type ProjectInputSnapshotRecord,
} from "../persistence/schema.js";

export interface SavedDraft {
  projectId: string;
  revision: number;
  digest: string;
}

export interface AcceptedSnapshot extends ProjectInputSnapshotRecord {
  alreadyAccepted: boolean;
}

/**
 * ProjectIntakeStore — owns all persistence for Project Intake v0:
 * draft revisioning (optimistic concurrency) and immutable accepted
 * ProjectInputSnapshot creation. All mutations are transactional.
 */
export class ProjectIntakeStore {
  constructor(private readonly db: FactoryDb) {}

  async getDraft(projectId: string): Promise<{
    projectId: string;
    revision: number;
    payload: ProjectIntakePayload | null;
    digest: string | null;
    updatedAt: Date;
  } | null> {
    const [row] = await this.db
      .select()
      .from(projectInputDrafts)
      .where(eq(projectInputDrafts.projectId, projectId));
    if (!row) return null;
    return {
      projectId: row.projectId,
      revision: row.revision,
      payload: (row.payload as ProjectIntakePayload | null) ?? null,
      digest: row.digest ?? null,
      updatedAt: row.updatedAt,
    };
  }

  async saveDraft(input: {
    projectId: string;
    baseRevision: number;
    payload: unknown;
  }): Promise<SavedDraft> {
    // Validate against the current contract first (fail closed).
    let payload: ProjectIntakePayload;
    try {
      payload = parseProjectIntakePayload(input.payload);
    } catch (err) {
      throw new FactoryError(
        "intake_schema_invalid",
        `Project intake payload failed contract validation: ${zodMessage(err)}`,
      );
    }
    const digest = deterministicDigest(payload);

    return await this.db.transaction(async (tx) => {
      // First save on a brand-new project: no draft row exists yet, so insert
      // it at revision 1. If a row already exists (any revision), the insert
      // is a no-op and we fall through to the conditional update below, which
      // only succeeds when that row is still at the caller's base revision.
      if (input.baseRevision === 0) {
        const [inserted] = await tx
          .insert(projectInputDrafts)
          .values({
            projectId: input.projectId,
            revision: 1,
            payload,
            digest,
            updatedAt: new Date(),
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) {
          return {
            projectId: inserted.projectId,
            revision: inserted.revision,
            digest: inserted.digest!,
          };
        }
      }

      // Conditional update: only succeeds if the caller's base revision is
      // still current. Prevents stale-tab overwrites (no last-write-wins).
      const updated = await tx
        .update(projectInputDrafts)
        .set({
          revision: sql`${projectInputDrafts.revision} + 1`,
          payload,
          digest,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(projectInputDrafts.projectId, input.projectId),
            eq(projectInputDrafts.revision, input.baseRevision),
          ),
        )
        .returning();

      if (updated.length === 0) {
        throw new FactoryError(
          "intake_stale_revision",
          `Draft save rejected: expected revision ${input.baseRevision} is not current. Reload the draft and reapply changes.`,
        );
      }
      const row = updated[0]!;
      return { projectId: row.projectId, revision: row.revision, digest: row.digest! };
    });
  }

  async accept(input: {
    projectId: string;
    expectedRevision: number;
    expectedDigest: string;
  }): Promise<AcceptedSnapshot> {
    return await this.db.transaction(async (tx) => {
      // Lock the draft row so concurrent accepts serialize.
      const [draft] = await tx
        .select()
        .from(projectInputDrafts)
        .where(eq(projectInputDrafts.projectId, input.projectId))
        .for("update");

      if (!draft) {
        throw new FactoryError(
          "intake_draft_not_found",
          "No intake draft exists for this project.",
        );
      }

      // Idempotency: same revision + digest already accepted -> return it.
      const [existing] = await tx
        .select()
        .from(projectInputSnapshots)
        .where(
          and(
            eq(projectInputSnapshots.projectId, input.projectId),
            eq(projectInputSnapshots.sourceRevision, input.expectedRevision),
            eq(projectInputSnapshots.digest, input.expectedDigest),
          ),
        );
      if (existing) return deepFreeze({ ...existing, alreadyAccepted: true });

      if (draft.revision !== input.expectedRevision) {
        throw new FactoryError(
          "intake_revision_mismatch",
          `Acceptance rejected: expected revision ${input.expectedRevision} but draft is at revision ${draft.revision}.`,
        );
      }
      if (!draft.digest || draft.digest !== input.expectedDigest) {
        throw new FactoryError(
          "intake_digest_mismatch",
          "Acceptance rejected: expected digest does not match the stored draft digest.",
        );
      }
      if (draft.payload == null) {
        throw new FactoryError("intake_draft_not_found", "Draft payload is missing.");
      }

      // Re-validate the stored payload against the current contract.
      let payload: ProjectIntakePayload;
      try {
        payload = parseProjectIntakePayload(draft.payload);
      } catch (err) {
        throw new FactoryError(
          "intake_schema_invalid",
          `Stored draft failed contract validation: ${zodMessage(err)}`,
        );
      }

      // Readiness gate: blockers prevent acceptance.
      const readiness = evaluateIntakeReadiness(payload);
      if (readiness.blockers.length > 0) {
        throw new FactoryError(
          "intake_blocked",
          `Acceptance rejected: ${readiness.blockers.map((b) => b.code).join(", ")}`,
        );
      }

      // Recompute digest from stored payload — never trust caller digest.
      const digest = deterministicDigest(payload);
      if (digest !== input.expectedDigest) {
        throw new FactoryError(
          "intake_digest_mismatch",
          "Acceptance rejected: digest mismatch between caller and stored draft.",
        );
      }

      // Next version = max(existing) + 1.
      const rows = await tx
        .select({ maxVersion: sql<number>`coalesce(max(${projectInputSnapshots.version}), 0)` })
        .from(projectInputSnapshots)
        .where(eq(projectInputSnapshots.projectId, input.projectId));
      const nextVersion = Number(rows[0]?.maxVersion ?? 0) + 1;

      const [created] = await tx
        .insert(projectInputSnapshots)
        .values({
          id: randomUUID(),
          projectId: input.projectId,
          version: nextVersion,
          sourceRevision: draft.revision,
          payload: deepFreeze(structuredClone(payload)),
          digest,
          acceptedBy: "operator",
          acceptanceState: "human_accepted",
          provenance: {},
        })
        .returning();

      return deepFreeze({ ...(created as ProjectInputSnapshotRecord), alreadyAccepted: false });
    });
  }

  async listSnapshots(projectId: string): Promise<ProjectInputSnapshotRecord[]> {
    const rows = await this.db
      .select()
      .from(projectInputSnapshots)
      .where(eq(projectInputSnapshots.projectId, projectId))
      .orderBy(asc(projectInputSnapshots.version));
    return rows.map((row) => deepFreeze({ ...row }));
  }

  async getSnapshot(projectId: string, version: number): Promise<ProjectInputSnapshotRecord | null> {
    const [row] = await this.db
      .select()
      .from(projectInputSnapshots)
      .where(
        and(
          eq(projectInputSnapshots.projectId, projectId),
          eq(projectInputSnapshots.version, version),
        ),
      );
    return row ? deepFreeze({ ...row }) : null;
  }
}

function zodMessage(err: unknown): string {
  if (err && typeof err === "object" && "issues" in err) {
    const issues = (err as { issues: Array<{ message: string }> }).issues;
    return issues.map((i) => i.message).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}


/** Recursively freeze a payload so accepted snapshots cannot be mutated. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}
