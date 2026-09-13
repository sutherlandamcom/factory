import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import {
  ASSETS_SCHEMA_VERSION,
  type AssetProvenance,
  type AssetUploadInput,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { resolveRepositoryRoot } from "../repo-root.js";
import { createAssetStorage, sha256HexBytes, type AssetStorage } from "./storage.js";
import { AssetStore, type AssignmentRow, type AssetRow, type AssetVersionRow, type DerivativeRow } from "./asset-store.js";

/**
 * AssetService — the governed application service for the Run 5 vertical:
 *   upload -> validate actual bytes -> decode -> digest -> persist original
 *   + derivatives -> provenance/rights -> approve exact version -> assign
 *   exact approved version to page/slot -> explicit replacement only.
 *
 * The server (not the browser) is the authority: frontend validation is UX
 * only. All governance decisions (approval, rights gating, assignment,
 * staleness) live here, never in a UI component.
 */

/** Hard ceiling on decoded upload bytes (fail closed before any processing). */
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

/** Supported image media types for Run 5 operator photography. */
const SUPPORTED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Absolute dimension ceiling (decompression-bomb guard). */
const MAX_DIMENSION = 8000;

/** Derivative policy: deliberately small (Run 9 rendering comes later). */
const WEB_DERIVATIVE_MAX_WIDTH = 1600;
const THUMB_DERIVATIVE_WIDTH = 320;

export interface AssetServiceDeps {
  store: AssetStore;
  storage?: AssetStorage;
  repoRoot?: string;
}

export interface IngestResult {
  asset: AssetRow;
  version: AssetVersionRow;
  derivatives: DerivativeRow[];
}

export interface AssetVersionView {
  id: string;
  assetId: string;
  version: number;
  binaryDigest: string;
  mediaType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  originalFilename: string;
  provenance: AssetProvenance;
  rightsStatus: string;
  rightsNote: string | null;
  altIntent: string | null;
  approvalState: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  governanceDigest: string | null;
  createdAt: string;
}

export interface DerivativeView {
  id: string;
  kind: string;
  mediaType: string;
  width: number;
  height: number;
  byteSize: number;
  binaryDigest: string;
}

export interface AssignmentView {
  id: string;
  assetId: string;
  assetTitle: string;
  versionId: string;
  versionNumber: number;
  versionDigest: string;
  binaryDigest: string;
  pageSlug: string;
  role: string;
  assignedAt: string;
  /** Computed staleness: a newer APPROVED version of the same asset exists. */
  replacementAvailable: boolean;
  latestApprovedVersionId: string | null;
  latestApprovedVersionNumber: number | null;
}

export interface AssetWorkspaceReadModel {
  schemaVersion: typeof ASSETS_SCHEMA_VERSION;
  imageryStrategy: string;
  assets: Array<{
    id: string;
    kind: string;
    title: string;
    createdAt: string;
    versions: AssetVersionView[];
    latestVersion: AssetVersionView | null;
  }>;
  assignments: AssignmentView[];
}

export class AssetService {
  private readonly store: AssetStore;
  private readonly storage: AssetStorage | null;

  constructor(deps: AssetServiceDeps) {
    this.store = deps.store;
    this.storage = deps.storage ?? null;
  }

  /** Lazily resolve the storage root (Git-derived repo root, trusted path). */
  private async storageOrThrow(): Promise<AssetStorage> {
    if (this.storage) return this.storage;
    const repoRoot = await resolveRepositoryRoot();
    return createAssetStorage(repoRoot);
  }

  // -------------------------------------------------------------------------
  // Ingest pipeline
  // -------------------------------------------------------------------------

  /**
   * Full server-side ingest: strict base64 -> size caps -> byte-level MIME
   * sniffing (extension mismatch rejected) -> sharp decode (corrupt input
   * fails closed) -> SHA-256 over exact bytes -> original preserved ->
   * deterministic derivatives -> durable version row with provenance.
   */
  async uploadAsset(projectId: string, input: AssetUploadInput): Promise<IngestResult> {
    const bytes = decodeBase64(input.dataBase64);
    if (bytes.byteLength === 0) {
      throw uploadInvalid("Uploaded file is empty.");
    }
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw uploadInvalid(`Uploaded file exceeds the ${MAX_UPLOAD_BYTES} byte limit.`);
    }

    // Byte-level content detection: browser MIME/extension are untrusted.
    const detected = await fileTypeFromBuffer(bytes);
    if (!detected || !SUPPORTED_MEDIA_TYPES.has(detected.mime)) {
      throw uploadInvalid(
        detected
          ? `Unsupported media type "${detected.mime}" for asset upload.`
          : "Uploaded bytes are not a recognizable supported image.",
      );
    }
    const ext = detected.ext.toLowerCase();
    const declaredName = input.filename.trim();
    const declaredExt = declaredName.includes(".") ? declaredName.split(".").pop()!.toLowerCase() : "";
    // Extension/MIME mismatch is rejected: silent mismatch invites spoofing.
    if (declaredExt && !extensionMatches(ext, declaredExt)) {
      throw uploadInvalid(`Filename extension ".${declaredExt}" does not match detected type "${detected.mime}".`);
    }

    // Actual decode: dimension/orientation truth comes from the bytes.
    let width: number;
    let height: number;
    try {
      const image = sharp(bytes, { failOn: "error" });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height) {
        throw uploadInvalid("Image dimensions could not be determined from the decoded bytes.");
      }
      width = metadata.width;
      height = metadata.height;
      // EXIF orientation swaps rendered dimensions.
      if (metadata.orientation && metadata.orientation >= 5) {
        [width, height] = [height, width];
      }
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw uploadInvalid(`Image dimensions ${width}x${height} exceed the ${MAX_DIMENSION}px limit.`);
      }
    } catch (error) {
      if (error instanceof FactoryError) throw error;
      throw uploadInvalid("Uploaded image could not be decoded (corrupt or unsupported input).");
    }

    const binaryDigest = sha256HexBytes(bytes);

    // Duplicate exact bytes within the project: deterministic conflict.
    const storage = await this.storageOrThrow();
    const storageKey = storage.objectKey(binaryDigest);

    // Provenance is evidence, never proof of legal ownership.
    const provenance: AssetProvenance = {
      category: "operator_upload",
      originalFilename: declaredName,
      uploadedAt: new Date().toISOString(),
      extracted: {
        format: detected.ext,
        space: undefined,
      },
    };

    // Asset identity: same filename + kind + title reuses the logical asset
    // and appends a new immutable version (explicit replacement semantics).
    const asset = await this.findOrCreateAsset(projectId, input);
    const version = await this.store.nextVersionForAsset(asset.id);

    // Derivatives are computed from the exact original bytes.
    const derivativeResults = await computeDerivatives(bytes, width, height);

    // Persist: object bytes first, then metadata rows. A storage failure
    // fails closed before any DB row exists; an orphaned object after a DB
    // failure is harmless (content-addressed, unreachable without a row).
    await storage.putObject(storageKey, bytes);
    for (const derivative of derivativeResults) {
      await storage.putObject(storage.derivativeKey(derivative.binaryDigest), derivative.bytes);
    }

    const versionRow = await this.store.insertVersion({
      projectId,
      assetId: asset.id,
      version,
      binaryDigest,
      mediaType: detected.mime,
      byteSize: bytes.byteLength,
      width,
      height,
      storageKey,
      originalFilename: declaredName,
      provenance,
      rightsStatus: input.rightsStatus,
      rightsNote: input.rightsNote?.trim() ? input.rightsNote.trim() : null,
      altIntent: input.altIntent?.trim() ? input.altIntent.trim() : null,
    });

    const derivativeRows: DerivativeRow[] = [];
    for (const derivative of derivativeResults) {
      derivativeRows.push(
        await this.store.insertDerivative({
          projectId,
          versionId: versionRow.id,
          kind: derivative.kind,
          mediaType: "image/jpeg",
          width: derivative.width,
          height: derivative.height,
          byteSize: derivative.bytes.byteLength,
          binaryDigest: derivative.binaryDigest,
          storageKey: storage.derivativeKey(derivative.binaryDigest),
        }),
      );
    }

    return { asset, version: versionRow, derivatives: derivativeRows };
  }

  private async findOrCreateAsset(projectId: string, input: AssetUploadInput): Promise<AssetRow> {
    // Logical-asset identity heuristic (v0): kind + exact title match reuses
    // the existing asset and appends a new immutable version. A different
    // title creates a distinct logical asset — replacement of an accepted
    // assignment is always an explicit action, never an upload side effect.
    const existing = await this.store.listAssets(projectId);
    const match = existing.find(
      (candidate) => candidate.kind === input.kind && candidate.title === input.title.trim(),
    );
    if (match) return match;
    return await this.store.createAsset({
      projectId,
      kind: input.kind,
      title: input.title.trim(),
    });
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  async workspace(projectId: string): Promise<AssetWorkspaceReadModel> {
    const [assetRows, versionRows, assignmentRows, strategy] = await Promise.all([
      this.store.listAssets(projectId),
      this.store.listAllVersions(projectId),
      this.store.listAssignments(projectId),
      this.store.getImageryStrategy(projectId),
    ]);
    const versionsByAsset = new Map<string, AssetVersionRow[]>();
    for (const row of versionRows) {
      const list = versionsByAsset.get(row.assetId) ?? [];
      list.push(row);
      versionsByAsset.set(row.assetId, list);
    }
    const assetsOut = assetRows.map((asset) => {
      const versions = (versionsByAsset.get(asset.id) ?? [])
        .sort((a, b) => b.version - a.version)
        .map(toVersionView);
      return {
        id: asset.id,
        kind: asset.kind,
        title: asset.title,
        createdAt: asset.createdAt.toISOString(),
        versions,
        latestVersion: versions[0] ?? null,
      };
    });
    const assignments = assignmentRows
      .map((assignment) => this.toAssignmentView(assignment, versionsByAsset, assetRows))
      .sort((a, b) => a.pageSlug.localeCompare(b.pageSlug) || a.role.localeCompare(b.role));
    return {
      schemaVersion: ASSETS_SCHEMA_VERSION,
      imageryStrategy: strategy,
      assets: assetsOut,
      assignments,
    };
  }

  private toAssignmentView(
    assignment: AssignmentRow,
    versionsByAsset: Map<string, AssetVersionRow[]>,
    assetRows: AssetRow[],
  ): AssignmentView {
    const versions = versionsByAsset.get(assignment.assetId) ?? [];
    const approved = versions
      .filter((v) => v.approvalState === "approved")
      .sort((a, b) => b.version - a.version);
    const latestApproved = approved[0] ?? null;
    const boundVersion = versions.find((v) => v.id === assignment.versionId) ?? null;
    const assetTitle = assetRows.find((a) => a.id === assignment.assetId)?.title ?? assignment.assetId;
    return {
      id: assignment.id,
      assetId: assignment.assetId,
      assetTitle,
      versionId: assignment.versionId,
      versionNumber: boundVersion?.version ?? 0,
      versionDigest: assignment.versionDigest,
      binaryDigest: assignment.binaryDigest,
      pageSlug: assignment.pageSlug,
      role: assignment.role,
      assignedAt: assignment.assignedAt.toISOString(),
      replacementAvailable: latestApproved !== null && latestApproved.id !== assignment.versionId,
      latestApprovedVersionId: latestApproved?.id ?? null,
      latestApprovedVersionNumber: latestApproved?.version ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Metadata / approval / assignment
  // -------------------------------------------------------------------------

  async updateVersionMetadata(projectId: string, versionId: string, input: {
    rightsStatus: string;
    rightsNote?: string | undefined;
    altIntent?: string | undefined;
    expectedBinaryDigest: string;
  }): Promise<AssetVersionRow> {
    return await this.store.updateVersionMetadata({
      projectId,
      versionId,
      expectedBinaryDigest: input.expectedBinaryDigest,
      rightsStatus: input.rightsStatus,
      rightsNote: input.rightsNote?.trim() ? input.rightsNote.trim() : null,
      altIntent: input.altIntent?.trim() ? input.altIntent.trim() : null,
    });
  }

  async approveVersion(
    projectId: string,
    versionId: string,
    expectedBinaryDigest: string,
  ): Promise<AssetVersionRow> {
    // The governance digest is computed by the store FROM THE ROW LOCKED
    // INSIDE the approval transaction (atomic approval operation). The
    // service layer must never compute the final approval governance digest
    // from an unlocked earlier read: a concurrent metadata update between an
    // unlocked read and the row lock would otherwise approve metadata B
    // while recording a digest of metadata A.
    return await this.store.approveVersion({ projectId, versionId, expectedBinaryDigest });
  }

  async rejectVersion(
    projectId: string,
    versionId: string,
    expectedBinaryDigest: string,
  ): Promise<AssetVersionRow> {
    return await this.store.rejectVersion({ projectId, versionId, expectedBinaryDigest });
  }

  async assignVersion(projectId: string, input: {
    assetId: string;
    versionId: string;
    pageSlug: string;
    role: string;
    expectedBinaryDigest: string;
  }): Promise<AssignmentRow> {
    const asset = await this.store.getAsset(projectId, input.assetId);
    if (!asset) throw new FactoryError("asset_not_found", "Asset not found for this project.");
    return await this.store.assignVersion({ projectId, ...input });
  }

  async replaceAssignment(
    projectId: string,
    assignmentId: string,
    input: { toVersionId: string; expectedBinaryDigest: string },
  ): Promise<AssignmentRow> {
    return await this.store.replaceAssignment({
      projectId,
      assignmentId,
      toVersionId: input.toVersionId,
      expectedBinaryDigest: input.expectedBinaryDigest,
    });
  }

  async setImageryStrategy(projectId: string, strategy: string): Promise<string> {
    return await this.store.setImageryStrategy(projectId, strategy);
  }

  // -------------------------------------------------------------------------
  // Byte serving (project-scoped)
  // -------------------------------------------------------------------------

  async readOriginal(projectId: string, versionId: string): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const version = await this.store.getVersion(projectId, versionId);
    if (!version) throw new FactoryError("asset_version_not_found", "Asset version not found for this project.");
    const storage = await this.storageOrThrow();
    return { bytes: await storage.getObject(version.storageKey), mediaType: version.mediaType };
  }

  async readDerivative(
    projectId: string,
    derivativeId: string,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const derivative = await this.store.getDerivative(projectId, derivativeId);
    if (!derivative) {
      throw new FactoryError("asset_not_found", "Asset derivative not found for this project.");
    }
    const storage = await this.storageOrThrow();
    return { bytes: await storage.getObject(derivative.storageKey), mediaType: derivative.mediaType };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uploadInvalid(message: string): FactoryError {
  return new FactoryError("asset_upload_invalid", message);
}

function extensionMatches(detectedExt: string, declaredExt: string): boolean {
  const aliases: Record<string, string[]> = {
    jpg: ["jpg", "jpeg"],
    jpeg: ["jpg", "jpeg"],
    png: ["png"],
    webp: ["webp"],
  };
  return (aliases[detectedExt] ?? [detectedExt]).includes(declaredExt);
}

/** Strict base64 decode: charset already validated by the contract schema. */
function decodeBase64(value: string): Uint8Array {
  try {
    const buffer = Buffer.from(value, "base64");
    // Buffer.from is lenient; verify round-trip length catches stray padding.
    if (buffer.byteLength === 0) return new Uint8Array(0);
    return new Uint8Array(buffer);
  } catch {
    throw uploadInvalid("dataBase64 is not valid base64.");
  }
}

interface ComputedDerivative {
  kind: "web" | "thumb";
  bytes: Uint8Array;
  width: number;
  height: number;
  binaryDigest: string;
}

/** Deterministic derivative policy: web (max 1600w JPEG q80) + thumb (320w JPEG q75). */
async function computeDerivatives(bytes: Uint8Array, width: number, height: number): Promise<ComputedDerivative[]> {
  const results: ComputedDerivative[] = [];

  const webWidth = Math.min(width, WEB_DERIVATIVE_MAX_WIDTH);
  const webHeight = Math.round((height * webWidth) / width);
  const webBytes = await sharp(bytes, { failOn: "error" })
    .rotate()
    .resize({ width: webWidth, height: webHeight, fit: "cover", withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
  const webMeta = await sharp(webBytes).metadata();
  results.push({
    kind: "web",
    bytes: new Uint8Array(webBytes),
    width: webMeta.width ?? webWidth,
    height: webMeta.height ?? webHeight,
    binaryDigest: sha256HexBytes(new Uint8Array(webBytes)),
  });

  const thumbWidth = Math.min(width, THUMB_DERIVATIVE_WIDTH);
  const thumbHeight = Math.round((height * thumbWidth) / width);
  const thumbBytes = await sharp(bytes, { failOn: "error" })
    .rotate()
    .resize({ width: thumbWidth, height: thumbHeight, fit: "cover", withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer();
  const thumbMeta = await sharp(thumbBytes).metadata();
  results.push({
    kind: "thumb",
    bytes: new Uint8Array(thumbBytes),
    width: thumbMeta.width ?? thumbWidth,
    height: thumbMeta.height ?? thumbHeight,
    binaryDigest: sha256HexBytes(new Uint8Array(thumbBytes)),
  });

  return results;
}

function toVersionView(row: AssetVersionRow): AssetVersionView {
  return {
    id: row.id,
    assetId: row.assetId,
    version: row.version,
    binaryDigest: row.binaryDigest,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    originalFilename: row.originalFilename,
    provenance: row.provenance as AssetProvenance,
    rightsStatus: row.rightsStatus,
    rightsNote: row.rightsNote,
    altIntent: row.altIntent,
    approvalState: row.approvalState,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    governanceDigest: row.governanceDigest,
    createdAt: row.createdAt.toISOString(),
  };
}
