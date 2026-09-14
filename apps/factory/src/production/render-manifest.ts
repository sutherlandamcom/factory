import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { FactoryDb } from "../persistence/db.js";
import {
  acceptedPageContent,
  assetVersions,
  productionPageInputs,
} from "../persistence/schema.js";
import type { ProductionPageInputRecord } from "../persistence/schema.js";
import {
  parseAcceptedPageContentData,
  type AcceptedPageContentData,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { createAssetStorage, type AssetStorage } from "../assets/storage.js";
import { ProductionStore } from "./store.js";

/**
 * PRODUCTION RENDER MANIFEST — Macro Run 9 (Phase 2).
 *
 * The trusted compiler between accepted authority and the Astro static
 * build. For a validated ProductionPageInput this module:
 *
 *  1. re-verifies the exact accepted authority (fail closed on staleness);
 *  2. projects the accepted content VERBATIM into a typed render manifest
 *     (no rewriting, paraphrasing, shortening, expanding, SEO optimization
 *     or coder-authored connective prose — ever);
 *  3. binds exact Run 5/7 asset authority per slot (binary digest +
 *     governance digest + alt authority), materializing delivery
 *     derivatives via the existing deterministic sharp pipeline;
 *  4. writes a manifest JSON the Astro build consumes at build time.
 *
 * The manifest is a projection, not a second source of truth: its digest is
 * recorded on the ProductionCandidate and any authority change makes the
 * candidate stale.
 */

export interface ProductionRenderManifest {
  schemaVersion: "production-v1";
  input: {
    id: string;
    version: number;
    digest: string;
    projectId: string;
    pageIdentity: string;
    pageType: string;
    route: string;
    canonicalOrigin: string;
  };
  /** Accepted copy VERBATIM (title/meta/intro/sections/conclusion/cta/links). */
  content: {
    acceptedId: string;
    acceptedVersion: number;
    acceptedDigest: string;
    title: string;
    metaDescription: string;
    introduction: string;
    sections: Array<{ heading: string; body: string }>;
    conclusion: string;
    cta: string;
    internalLinks: string[];
  };
  /** Exact asset authority per slot with alt semantics resolved upstream. */
  assets: Array<{
    slot: string;
    role: string;
    versionId: string;
    binaryDigest: string;
    governanceDigest: string;
    /** Public path of the materialized delivery derivative. */
    publicPath: string;
    width: number;
    height: number;
    /** Resolved alt authority: accepted text, or "" for decorative. */
    alt: string;
    /** false when alt authority is missing for a meaningful image (QA FAIL). */
    altAuthorityComplete: boolean;
    /** Probable LCP image: eager loading, no lazy attribute. */
    isProbableLcp: boolean;
  }>;
  /** Deterministic manifest digest (binds the whole render surface). */
  manifestDigest: string;
}

const MEANINGFUL_ROLES = new Set(["hero", "inline", "chart", "illustration"]);

/** Roles that plausibly carry the largest above-fold visual. */
const LCP_CANDIDATE_ROLES = new Set(["hero", "background"]);

export class ProductionRenderCompiler {
  private readonly storage: AssetStorage;

  constructor(
    private readonly db: FactoryDb,
    private readonly repoRoot: string,
  ) {
    this.storage = createAssetStorage(repoRoot);
  }

  /**
   * Build the render manifest for one ProductionPageInput. Fails closed on
   * stale authority. Materializes delivery derivatives into the site's
   * public asset directory (deterministic, content-addressed filenames).
   */
  async compileManifest(input: { projectId: string; productionInputId: string }): Promise<ProductionRenderManifest> {
    const store = new ProductionStore(this.db);
    const [productionInput] = await this.db
      .select()
      .from(productionPageInputs)
      .where(
        and(
          eq(productionPageInputs.projectId, input.projectId),
          eq(productionPageInputs.id, input.productionInputId),
        ),
      );
    if (!productionInput) {
      throw renderError("production_input_immutable", "ProductionPageInput not found.");
    }
    const staleness = await store.inputStaleness(productionInput);
    if (staleness.stale) {
      throw renderError("production_authority_stale", staleness.reason ?? "Production input is stale.");
    }

    // Accepted content: exact id/version/digest re-read from authority.
    const [contentRow] = await this.db
      .select()
      .from(acceptedPageContent)
      .where(
        and(
          eq(acceptedPageContent.projectId, input.projectId),
          eq(acceptedPageContent.id, productionInput.acceptedContentId),
        ),
      );
    if (!contentRow || contentRow.version !== productionInput.acceptedContentVersion || contentRow.contentDigest !== productionInput.acceptedContentDigest) {
      throw renderError("production_authority_digest_mismatch", "Accepted content digest drifted from the production input.");
    }
    const accepted = parseAcceptedPageContentData(contentRow.data);
    const content = this.projectAcceptedContent(accepted);

    // Exact asset authority per accepted visual slot for this page.
    const bundle = await store.deriveAuthorityBundle({
      projectId: input.projectId,
      pageSlug: productionInput.pageIdentity,
    });

    const assets: ProductionRenderManifest["assets"] = [];
    for (const slot of bundle.visualSlots) {
      const [version] = await this.db
        .select()
        .from(assetVersions)
        .where(and(eq(assetVersions.projectId, input.projectId), eq(assetVersions.id, slot.resolvedVersionId)));
      if (!version || version.binaryDigest !== slot.binaryDigest || version.governanceDigest !== slot.governanceDigest) {
        throw renderError(
          "production_authority_digest_mismatch",
          `Visual slot ${slot.slot} no longer matches its bound asset version.`,
        );
      }
      if (version.approvalState !== "approved") {
        throw renderError("production_authority_stale", `Visual slot ${slot.slot} asset version is not approved.`);
      }

      // Materialize the deterministic web derivative into the site public
      // assets (content-addressed filename: same bytes -> same path).
      const webDerivative = await this.materializeWebDerivative(version.storageKey, version.mediaType);
      const meaningful = MEANINGFUL_ROLES.has(slot.role);
      const altAuthorityComplete = meaningful ? Boolean(version.altIntent && version.altIntent.trim() !== "") : true;
      assets.push({
        slot: slot.slot,
        role: slot.role,
        versionId: version.id,
        binaryDigest: version.binaryDigest,
        governanceDigest: slot.governanceDigest,
        publicPath: webDerivative.publicPath,
        width: webDerivative.width,
        height: webDerivative.height,
        alt: meaningful ? (version.altIntent ?? "").trim() : "",
        altAuthorityComplete,
        isProbableLcp: LCP_CANDIDATE_ROLES.has(slot.role),
      });
    }

    const manifest: ProductionRenderManifest = {
      schemaVersion: "production-v1",
      input: {
        id: productionInput.id,
        version: productionInput.version,
        digest: productionInput.inputDigest,
        projectId: input.projectId,
        pageIdentity: productionInput.pageIdentity,
        pageType: productionInput.pageType,
        route: productionInput.route,
        canonicalOrigin: productionInput.canonicalOrigin,
      },
      content,
      assets,
      manifestDigest: "",
    };
    manifest.manifestDigest = deterministicDigest({
      input: manifest.input,
      content: manifest.content,
      assets: manifest.assets.map((asset) => ({
        slot: asset.slot,
        role: asset.role,
        versionId: asset.versionId,
        binaryDigest: asset.binaryDigest,
        governanceDigest: asset.governanceDigest,
        publicPath: asset.publicPath,
        width: asset.width,
        height: asset.height,
        alt: asset.alt,
        altAuthorityComplete: asset.altAuthorityComplete,
        isProbableLcp: asset.isProbableLcp,
      })),
    });
    return manifest;
  }

  /**
   * VERBATIM projection of AcceptedPageContent. Any normalization beyond
   * whitespace-only would be a content-integrity violation; this function
   * copies fields exactly as accepted (trim of leading/trailing whitespace
   * is the only allowed transformation and is applied by the contract
   * schemas themselves at acceptance time).
   */
  private projectAcceptedContent(accepted: AcceptedPageContentData): ProductionRenderManifest["content"] {
    return {
      acceptedId: accepted.proposalId,
      acceptedVersion: accepted.proposalVersion,
      acceptedDigest: accepted.proposalDigest,
      title: accepted.content.title,
      metaDescription: accepted.content.metaDescription,
      introduction: accepted.content.introduction,
      sections: accepted.content.sections.map((section) => ({
        heading: section.heading,
        body: section.body,
      })),
      conclusion: accepted.content.conclusion,
      cta: accepted.content.cta,
      internalLinks: [...accepted.content.internalLinks],
    };
  }

  /**
   * Deterministic delivery derivative via the existing sharp pipeline:
   * web JPEG max 1600w q80 (no upscaling), content-addressed public path.
   * The derivative is NOT a new visual authority — the parent binary/governance
   * digests remain the identity recorded in the manifest.
   */
  private async materializeWebDerivative(
    storageKey: string,
    mediaType: string,
  ): Promise<{ publicPath: string; width: number; height: number }> {
    const bytes = await this.storage.getObject(storageKey);
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default;
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    if (!metadata.width || !metadata.height) {
      throw renderError("production_build_rejected", "Asset version has no decodable dimensions.");
    }
    const targetWidth = Math.min(metadata.width, 1600);
    const targetHeight = Math.round((metadata.height * targetWidth) / metadata.width);
    const webBytes = await sharp(bytes, { failOn: "error" })
      .rotate()
      .resize({ width: targetWidth, height: targetHeight, fit: "cover", withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    const webMeta = await sharp(webBytes).metadata();
    const digest = deterministicDigestOfBytes(webBytes);
    const publicPath = `/production-assets/${digest}.jpg`;
    const outDir = path.join(this.repoRoot, "sites", "starter", "public", "production-assets");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, `${digest}.jpg`), webBytes);
    return {
      publicPath,
      width: webMeta.width ?? targetWidth,
      height: webMeta.height ?? targetHeight,
    };
  }

  /** Write the manifest JSON for the Astro build and return its path. */
  async writeManifest(manifest: ProductionRenderManifest): Promise<string> {
    const dir = path.join(this.repoRoot, "sites", "starter", ".factory-production");
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${sanitize(manifest.input.pageIdentity)}.json`);
    await writeFile(filePath, JSON.stringify(manifest, null, 2), "utf8");
    return filePath;
  }

  /** Read all manifests from a directory (site-wide QA/sitemap surface). */
  async readAllManifests(manifestDir: string): Promise<ProductionRenderManifest[]> {
    const entries = await readdir(manifestDir);
    const manifests: ProductionRenderManifest[] = [];
    for (const entry of entries.filter((name: string) => name.endsWith(".json")).sort()) {
      const raw = await readFile(path.join(manifestDir, entry), "utf8");
      manifests.push(JSON.parse(raw) as ProductionRenderManifest);
    }
    return manifests;
  }

  async readManifest(filePath: string): Promise<ProductionRenderManifest> {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as ProductionRenderManifest;
  }
}

function deterministicDigestOfBytes(bytes: Uint8Array): string {
  // Binary content addressing: sha256 over exact derivative bytes.
  return sha256Bytes(bytes);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sanitize(pageSlug: string): string {
  return pageSlug.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "index";
}

function renderError(code: string, message: string): FactoryError {
  return new FactoryError(code, message);
}
