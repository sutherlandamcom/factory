import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { ASSETS_SCHEMA_VERSION, type AssetProvenance } from "@factory/contracts";
import type { FactoryDb } from "../persistence/db.js";
import {
  assetDerivatives,
  assetPageAssignments,
  assetVersions,
  assets,
  projectAssetSettings,
} from "../persistence/schema.js";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";

/**
 * Asset persistence (Macro Run 5).
 *
 * Project scoping is enforced at every query: rows always carry project_id
 * and every lookup predicates on it, so cross-project references fail closed
 * as not-found. Version/approval/assignment transitions are serialized in
 * transactions with row locks, mirroring the writer-store approval pattern.
 */

export interface AssetVersionRow {
  id: string;
  assetId: string;
  projectId: string;
  version: number;
  binaryDigest: string;
  mediaType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  storageKey: string;
  originalFilename: string;
  /** JSONB round-trip: validated at the service boundary, stored as-is. */
  provenance: unknown;  rightsStatus: string;
  rightsNote: string | null;
  altIntent: string | null;
  approvalState: string;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  governanceDigest: string | null;
  createdAt: Date;
}

export interface AssetRow {
  id: string;
  projectId: string;
  kind: string;
  title: string;
  createdAt: Date;
}

export interface DerivativeRow {
  id: string;
  versionId: string;
  projectId: string;
  kind: string;
  mediaType: string;
  width: number;
  height: number;
  byteSize: number;
  binaryDigest: string;
  storageKey: string;
}

export interface AssignmentRow {
  id: string;
  projectId: string;
  assetId: string;
  versionId: string;
  versionDigest: string;
  binaryDigest: string;
  pageSlug: string;
  role: string;
  assignedAt: Date;
}

function assetNotFound(): FactoryError {
  return new FactoryError("asset_not_found", "Asset not found for this project.");
}
function versionNotFound(): FactoryError {
  return new FactoryError("asset_version_not_found", "Asset version not found for this project.");
}
function approvalError(message: string): FactoryError {
  return new FactoryError("asset_approval_failed", message);
}
function conflictError(message: string): FactoryError {
  return new FactoryError("asset_assignment_conflict", message);
}

export class AssetStore {
  constructor(private readonly db: FactoryDb) {}

  /**
   * One relational authority operation after CAS publication. Serialize
   * uploads for a project before resolving a logical identity (including
   * its first insert), then allocate the immutable version under that lock.
   * The unique binary/version constraints remain the final conflict guard.
   * Any failure rolls back the asset, version and all derivative metadata;
   * unreferenced CAS objects confer no authority and may remain on disk.
   */
  async insertUpload(input: {
    asset: { projectId: string; kind: string; title: string };
    version: Omit<Parameters<AssetStore["insertVersion"]>[0], "projectId" | "assetId" | "version">;
    derivatives: Array<Omit<Parameters<AssetStore["insertDerivative"]>[0], "projectId" | "versionId">>;
  }): Promise<{ asset: AssetRow; version: AssetVersionRow; derivatives: DerivativeRow[] }> {
    try {
      return await this.db.transaction(async (tx) => {
        // A namespaced transaction lock also covers the absent-row case.
        // Hash collisions merely serialize unrelated projects; never bypass.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(1428570005, hashtext(${input.asset.projectId}))`);
        const store = new AssetStore(tx);
        const [existing] = await tx.select().from(assets).where(and(
          eq(assets.projectId, input.asset.projectId),
          eq(assets.kind, input.asset.kind),
          eq(assets.title, input.asset.title),
        )).orderBy(assets.createdAt, assets.id).limit(1);
        const asset = existing ?? await store.createAsset(input.asset);
        const version = await store.insertVersion({
          ...input.version,
          projectId: asset.projectId,
          assetId: asset.id,
          version: await store.nextVersionForAsset(asset.id),
        });
        const derivatives: DerivativeRow[] = [];
        for (const derivative of input.derivatives) {
          derivatives.push(await store.insertDerivative({
            ...derivative, projectId: asset.projectId, versionId: version.id,
          }));
        }
        return { asset, version, derivatives };
      });
    } catch (error) {
      const code = (error as { code?: string; cause?: { code?: string } } | null);
      if (code?.code === "23505" || code?.cause?.code === "23505") {
        throw conflictError("Upload metadata conflicts with an existing immutable version or derivative.");
      }
      throw error;
    }
  }

  async createAsset(input: { projectId: string; kind: string; title: string }): Promise<AssetRow> {
    const id = `asst-${randomUUID()}`;
    const [row] = await this.db
      .insert(assets)
      .values({ id, projectId: input.projectId, kind: input.kind, title: input.title })
      .returning();
    return row!;
  }

  async getAsset(projectId: string, assetId: string): Promise<AssetRow | null> {
    const [row] = await this.db
      .select()
      .from(assets)
      .where(and(eq(assets.projectId, projectId), eq(assets.id, assetId)));
    return row ?? null;
  }

  async listAssets(projectId: string): Promise<AssetRow[]> {
    return await this.db
      .select()
      .from(assets)
      .where(eq(assets.projectId, projectId))
      .orderBy(desc(assets.createdAt));
  }

  /** Insert an immutable version row. `projectId` must come from the parent asset. */
  async insertVersion(input: {
    projectId: string;
    assetId: string;
    version: number;
    binaryDigest: string;
    mediaType: string;
    byteSize: number;
    width: number | null;
    height: number | null;
    storageKey: string;
    originalFilename: string;
    provenance: AssetProvenance;
    rightsStatus: string;
    rightsNote: string | null;
    altIntent: string | null;
  }): Promise<AssetVersionRow> {
    const id = `asv-${randomUUID()}`;
    try {
      const [row] = await this.db
        .insert(assetVersions)
        .values({ id, ...input })
        .returning();
      return row!;
    } catch (error) {
      // Duplicate exact bytes within the same project (23505) is a typed
      // upload conflict, not a raw 500. drizzle-orm wraps driver errors in
      // DrizzleQueryError: the PostgreSQL code lives on error.cause.code.
      const pgCode =
        (error as { code?: string } | null)?.code ??
        (error as { cause?: { code?: string } | null } | null)?.cause?.code;
      if (pgCode === "23505") {
        throw conflictError(
          "Upload conflict: this project already contains a version with identical bytes, or a concurrent upload claimed the next version number; retry the upload.",
        );
      }
      throw error;
    }
  }

  async nextVersionForAsset(assetId: string): Promise<number> {
    const [row] = await this.db
      .select({ maxVersion: sql<number>`coalesce(max(${assetVersions.version}), 0)` })
      .from(assetVersions)
      .where(eq(assetVersions.assetId, assetId));
    return Number(row?.maxVersion ?? 0) + 1;
  }

  async getVersion(projectId: string, versionId: string): Promise<AssetVersionRow | null> {
    const [row] = await this.db
      .select()
      .from(assetVersions)
      .where(and(eq(assetVersions.projectId, projectId), eq(assetVersions.id, versionId)));
    return row ?? null;
  }

  async getLatestVersion(projectId: string, assetId: string): Promise<AssetVersionRow | null> {
    const [row] = await this.db
      .select()
      .from(assetVersions)
      .where(and(eq(assetVersions.projectId, projectId), eq(assetVersions.assetId, assetId)))
      .orderBy(desc(assetVersions.version))
      .limit(1);
    return row ?? null;
  }

  async listVersions(projectId: string, assetId: string): Promise<AssetVersionRow[]> {
    return await this.db
      .select()
      .from(assetVersions)
      .where(and(eq(assetVersions.projectId, projectId), eq(assetVersions.assetId, assetId)))
      .orderBy(desc(assetVersions.version));
  }

  async listAllVersions(projectId: string): Promise<AssetVersionRow[]> {
    return await this.db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.projectId, projectId))
      .orderBy(desc(assetVersions.createdAt));
  }

  /**
   * Metadata update (rights/alt) — pre-approval only; approved/rejected
   * versions are immutable. Caller must echo the current binary digest.
   */
  async updateVersionMetadata(input: {
    projectId: string;
    versionId: string;
    expectedBinaryDigest: string;
    rightsStatus: string;
    rightsNote: string | null;
    altIntent: string | null;
  }): Promise<AssetVersionRow> {
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(assetVersions)
        .where(and(eq(assetVersions.projectId, input.projectId), eq(assetVersions.id, input.versionId)))
        .for("update");
      if (!row) throw versionNotFound();
      if (row.binaryDigest !== input.expectedBinaryDigest) {
        throw approvalError("Metadata update rejected: expectedBinaryDigest does not match the stored version.");
      }
      if (row.approvalState !== "pending") {
        throw new FactoryError(
          "asset_version_immutable",
          "Approved/rejected asset versions are immutable; upload a new version instead.",
        );
      }
      const [updated] = await tx
        .update(assetVersions)
        .set({
          rightsStatus: input.rightsStatus,
          rightsNote: input.rightsNote,
          altIntent: input.altIntent,
        })
        .where(and(eq(assetVersions.id, row.id), eq(assetVersions.approvalState, "pending")))
        .returning();
      return updated!;
    });
  }

  /**
   * Record derivation provenance on a PENDING version (Run 7 seam). The
   * provenance category must be `derived` or `generated` (Run 7 outputs);
   * operator-upload rows are never touched. Approved/rejected versions are
   * immutable — this fails closed on any terminal state.
   */
  async recordDerivationProvenance(input: {
    projectId: string;
    versionId: string;
    expectedBinaryDigest: string;
    provenance: AssetProvenance;
  }): Promise<AssetVersionRow> {
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(assetVersions)
        .where(and(eq(assetVersions.projectId, input.projectId), eq(assetVersions.id, input.versionId)))
        .for("update");
      if (!row) throw versionNotFound();
      if (row.binaryDigest !== input.expectedBinaryDigest) {
        throw approvalError("Provenance record rejected: expectedBinaryDigest does not match the stored version.");
      }
      if (row.approvalState !== "pending") {
        throw new FactoryError(
          "asset_version_immutable",
          "Approved/rejected asset versions are immutable; provenance must be recorded before approval.",
        );
      }
      const category = (input.provenance as { category?: string }).category;
      if (category !== "derived" && category !== "generated") {
        throw new FactoryError(
          "asset_upload_invalid",
          "Derivation provenance recording requires category 'derived' or 'generated'.",
        );
      }
      const [updated] = await tx
        .update(assetVersions)
        .set({ provenance: input.provenance })
        .where(and(eq(assetVersions.id, row.id), eq(assetVersions.approvalState, "pending")))
        .returning();
      return updated!;
    });
  }

  /**
   * Terminal approval binding the exact binary digest. The governance
   * digest is computed FROM THE ROW LOCKED INSIDE THIS TRANSACTION, so the
   * recorded digest always describes the exact governance surface that was
   * approved (no TOCTOU window between a service-layer read and the row
   * lock). Atomic: an approved row always carries its governance digest
   * (DB CHECK enforces this). Idempotent when the stored digest already
   * matches; a digest mismatch on an approved version fails closed (never
   * re-approves different bytes).
   */
  async approveVersion(input: {
    projectId: string;
    versionId: string;
    expectedBinaryDigest: string;
  }): Promise<AssetVersionRow> {
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(assetVersions)
        .where(and(eq(assetVersions.projectId, input.projectId), eq(assetVersions.id, input.versionId)))
        .for("update");
      if (!row) throw versionNotFound();
      if (row.approvalState === "approved") {
        if (row.binaryDigest === input.expectedBinaryDigest) return row;
        throw approvalError("Version is already approved at a different digest.");
      }
      if (row.approvalState === "rejected") {
        throw approvalError("Rejected versions cannot be approved; upload a new version instead.");
      }
      if (row.binaryDigest !== input.expectedBinaryDigest) {
        throw approvalError("Approval rejected: expectedBinaryDigest does not match the stored version.");
      }
      // Governance digest: immutable snapshot of the approved governance
      // surface (identity + provenance + rights), computed from the LOCKED
      // row. Distinct from the binary digest; write-once afterwards.
      const governanceDigest = deterministicDigest({
        schemaVersion: ASSETS_SCHEMA_VERSION,
        versionId: row.id,
        binaryDigest: row.binaryDigest,
        mediaType: row.mediaType,
        byteSize: row.byteSize,
        width: row.width,
        height: row.height,
        provenance: row.provenance,
        rights: {
          status: row.rightsStatus,
          note: row.rightsNote,
          altIntent: row.altIntent,
        },
      });
      const [updated] = await tx
        .update(assetVersions)
        .set({ approvalState: "approved", approvedAt: new Date(), governanceDigest })
        .where(and(eq(assetVersions.id, row.id), eq(assetVersions.approvalState, "pending")))
        .returning();
      return updated!;
    });
  }

  async rejectVersion(input: {
    projectId: string;
    versionId: string;
    expectedBinaryDigest: string;
  }): Promise<AssetVersionRow> {
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(assetVersions)
        .where(and(eq(assetVersions.projectId, input.projectId), eq(assetVersions.id, input.versionId)))
        .for("update");
      if (!row) throw versionNotFound();
      if (row.approvalState === "approved") {
        throw approvalError("Approved versions cannot be rejected; assign a different version instead.");
      }
      if (row.approvalState === "rejected") return row;
      if (row.binaryDigest !== input.expectedBinaryDigest) {
        throw approvalError("Rejection rejected: expectedBinaryDigest does not match the stored version.");
      }
      const [updated] = await tx
        .update(assetVersions)
        .set({ approvalState: "rejected", rejectedAt: new Date() })
        .where(and(eq(assetVersions.id, row.id), eq(assetVersions.approvalState, "pending")))
        .returning();
      return updated!;
    });
  }

  async insertDerivative(input: {
    projectId: string;
    versionId: string;
    kind: string;
    mediaType: string;
    width: number;
    height: number;
    byteSize: number;
    binaryDigest: string;
    storageKey: string;
  }): Promise<DerivativeRow> {
    const id = `asd-${randomUUID()}`;
    const [row] = await this.db.insert(assetDerivatives).values({ id, ...input }).returning();
    return row!;
  }

  async listDerivatives(projectId: string, versionId: string): Promise<DerivativeRow[]> {
    return await this.db
      .select()
      .from(assetDerivatives)
      .where(and(eq(assetDerivatives.projectId, projectId), eq(assetDerivatives.versionId, versionId)));
  }

  async getDerivative(projectId: string, derivativeId: string): Promise<DerivativeRow | null> {
    const [row] = await this.db
      .select()
      .from(assetDerivatives)
      .where(and(eq(assetDerivatives.projectId, projectId), eq(assetDerivatives.id, derivativeId)));
    return row ?? null;
  }

  /**
   * Create an assignment binding the EXACT approved version. Re-assignment
   * of an occupied slot is a typed conflict; moving to a different version
   * goes through replaceAssignment (explicit operator action).
   */
  async assignVersion(input: {
    projectId: string;
    assetId: string;
    versionId: string;
    pageSlug: string;
    role: string;
    expectedBinaryDigest: string;
  }): Promise<AssignmentRow> {
    return await this.db.transaction(async (tx) => {
      const [version] = await tx
        .select()
        .from(assetVersions)
        .where(
          and(
            eq(assetVersions.projectId, input.projectId),
            eq(assetVersions.id, input.versionId),
            eq(assetVersions.assetId, input.assetId),
          ),
        )
        .for("update");
      if (!version) throw versionNotFound();
      if (version.binaryDigest !== input.expectedBinaryDigest) {
        throw approvalError("Assignment rejected: expectedBinaryDigest does not match the stored version.");
      }
      if (version.approvalState !== "approved") {
        throw new FactoryError(
          "asset_rights_blocked",
          "Only approved asset versions can be assigned to a page slot.",
        );
      }
      if (version.rightsStatus === "unknown") {
        throw new FactoryError(
          "asset_rights_blocked",
          "Asset version has unresolved rights (unknown); resolve rights before assignment.",
        );
      }
      // Fail closed: an approved version MUST carry its governance digest.
      // Binary and governance digests are distinct authorities and are never
      // silently substituted for one another.
      if (version.governanceDigest === null) {
        throw approvalError(
          "Assignment rejected: approved version has no governance digest (corrupt approval state); re-approve via a new version upload.",
        );
      }
      const [existing] = await tx
        .select()
        .from(assetPageAssignments)
        .where(
          and(
            eq(assetPageAssignments.projectId, input.projectId),
            eq(assetPageAssignments.pageSlug, input.pageSlug),
            eq(assetPageAssignments.role, input.role),
          ),
        )
        .for("update");
      if (existing) {
        throw conflictError(
          `Slot ${input.pageSlug}/${input.role} is already assigned; use explicit replacement to move it.`,
        );
      }
      try {
        const [row] = await tx
          .insert(assetPageAssignments)
          .values({
            id: `apa-${randomUUID()}`,
            projectId: input.projectId,
            assetId: input.assetId,
            versionId: version.id,
            versionDigest: version.governanceDigest,
            binaryDigest: version.binaryDigest,
            pageSlug: input.pageSlug,
            role: input.role,
          })
          .returning();
        return row!;
      } catch (error) {
        // Two concurrent assignments racing the same empty slot hit the
        // UNIQUE(project, page, role) constraint (23505): fail closed with
        // the typed slot conflict instead of a raw 500. drizzle-orm wraps
        // driver errors; the PostgreSQL code lives on error.cause.code.
        const pgCode =
          (error as { code?: string } | null)?.code ??
          (error as { cause?: { code?: string } | null } | null)?.cause?.code;
        if (pgCode === "23505") {
          throw conflictError(
            `Slot ${input.pageSlug}/${input.role} was just claimed by a concurrent assignment; use explicit replacement to move it.`,
          );
        }
        throw error;
      }
    });
  }

  /** Explicit replacement of an existing assignment to a new approved version. */
  async replaceAssignment(input: {
    projectId: string;
    assignmentId: string;
    toVersionId: string;
    expectedBinaryDigest: string;
  }): Promise<AssignmentRow> {
    return await this.db.transaction(async (tx) => {
      const [assignment] = await tx
        .select()
        .from(assetPageAssignments)
        .where(
          and(
            eq(assetPageAssignments.projectId, input.projectId),
            eq(assetPageAssignments.id, input.assignmentId),
          ),
        )
        .for("update");
      if (!assignment) {
        throw new FactoryError("asset_assignment_not_found", "Assignment not found for this project.");
      }
      const [version] = await tx
        .select()
        .from(assetVersions)
        .where(
          and(
            eq(assetVersions.projectId, input.projectId),
            eq(assetVersions.id, input.toVersionId),
            eq(assetVersions.assetId, assignment.assetId),
          ),
        )
        .for("update");
      if (!version) throw versionNotFound();
      if (version.binaryDigest !== input.expectedBinaryDigest) {
        throw approvalError("Replacement rejected: expectedBinaryDigest does not match the target version.");
      }
      if (version.approvalState !== "approved") {
        throw new FactoryError(
          "asset_rights_blocked",
          "Only approved asset versions can be assigned to a page slot.",
        );
      }
      if (version.rightsStatus === "unknown") {
        throw new FactoryError(
          "asset_rights_blocked",
          "Target version has unresolved rights (unknown); resolve rights before replacement.",
        );
      }
      // Fail closed: an approved version MUST carry its governance digest
      // (same authority rule as assignment; never substitute the binary
      // digest for the governance digest).
      if (version.governanceDigest === null) {
        throw approvalError(
          "Replacement rejected: approved version has no governance digest (corrupt approval state); re-approve via a new version upload.",
        );
      }
      if (version.id === assignment.versionId) {
        throw conflictError("Assignment already binds this exact version.");
      }
      const [updated] = await tx
        .update(assetPageAssignments)
        .set({
          versionId: version.id,
          versionDigest: version.governanceDigest,
          binaryDigest: version.binaryDigest,
          assignedAt: new Date(),
        })
        .where(eq(assetPageAssignments.id, assignment.id))
        .returning();
      return updated!;
    });
  }

  async listAssignments(projectId: string): Promise<AssignmentRow[]> {    return await this.db
      .select()
      .from(assetPageAssignments)
      .where(eq(assetPageAssignments.projectId, projectId))
      .orderBy(desc(assetPageAssignments.assignedAt));
  }

  async getAssignment(projectId: string, assignmentId: string): Promise<AssignmentRow | null> {
    const [row] = await this.db
      .select()
      .from(assetPageAssignments)
      .where(
        and(eq(assetPageAssignments.projectId, projectId), eq(assetPageAssignments.id, assignmentId)),
      );
    return row ?? null;
  }

  async getImageryStrategy(projectId: string): Promise<string> {
    const [row] = await this.db
      .select()
      .from(projectAssetSettings)
      .where(eq(projectAssetSettings.projectId, projectId));
    return row?.imageryStrategy ?? "none";
  }

  async setImageryStrategy(projectId: string, strategy: string): Promise<string> {
    await this.db
      .insert(projectAssetSettings)
      .values({ projectId, imageryStrategy: strategy })
      .onConflictDoUpdate({
        target: projectAssetSettings.projectId,
        set: { imageryStrategy: strategy, updatedAt: new Date() },
      });
    return strategy;
  }
}
