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
  parseDesignCandidateData,
  type AcceptedPageContentData,
  type DesignArchetypeKind,
  type DesignSystemTokens,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { createAssetStorage, type AssetStorage } from "../assets/storage.js";
import { acceptedDerivativeSets, acceptedSummaryArtifacts, acceptedAudioArtifacts } from "../persistence/schema.js";
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
  schemaVersion: "production-v1" | "production-v2";
  input: {
    id: string;
    version: number;
    digest: string;
    projectId: string;
    pageIdentity: string;
    pageType: string;
    route: string;
    siteIdentity: {
      siteId: string;
      siteName: string;
      canonicalOrigin: string;
      language: string;
      profileDigest: string;
    };
  };
  seo: {
    fullTitle: string;
    description: string;
    canonicalUrl: string;
    ogTitle: string;
    ogDescription: string;
    ogUrl: string;
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
  design: {
    acceptedId: string;
    acceptedVersion: number;
    acceptedDigest: string;
    tokens: DesignSystemTokens;
    archetype: {
      kind: DesignArchetypeKind;
      sectionPatterns: string[];
      contentRequirements: string[];
      assetSlots: Array<{ slot: string; role: string; requiredRole: string }>;
      primaryCta: string;
      secondaryCta: string;
      responsiveBehavior: string;
      trustPresentation: string;
      rendererPrimitives: string[];
    };
  };
  links: Array<{ href: string; title: string }>;
  breadcrumbs: Array<{ name: string; url: string }>;
  /** Exact asset authority per slot with alt semantics resolved upstream. */
  assets: Array<{
    slot: string;
    role: string;
    truthClass: string;
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
  /**
   * Run 10 derivative authority (production-v2 manifests only). Summary
   * text is copied VERBATIM from the accepted summary artifact at manifest
   * compile time; the Astro renderer never queries the database. Audio
   * binds the exact accepted binary digest + deterministic delivery path.
   */
  derivatives?: {
    setDigest: string;
    summary:
      | { state: "disabled" }
      | {
          state: "accepted";
          acceptedId: string;
          acceptedVersion: number;
          acceptedDigest: string;
          language: string;
          summaryText: string;
        };
    audio:
      | { state: "disabled" }
      | {
          state: "accepted";
          acceptedId: string;
          acceptedVersion: number;
          acceptedDigest: string;
          binaryDigest: string;
          mimeType: string;
          durationSeconds: number | null;
          /** Public path of the materialized audio delivery artifact. */
          publicPath: string;
        };
  };
  /** Deterministic manifest digest (binds the whole render surface). */
  manifestDigest: string;
}

const SUPPORTED_PATTERNS = new Map<string, string>([
  ["hero", "hero"], ["page-header", "page-header"], ["article-header", "article-header"],
  ["value-statement", "narrative"], ["service-overview", "narrative"], ["location-intro", "narrative"],
  ["article-body", "article-body"], ["approach", "narrative"], ["evidence", "evidence"],
  ["local-evidence", "evidence"], ["trust-signals", "trust"], ["methodology", "trust"],
  ["sources", "trust"], ["assumptions", "trust"], ["disclaimer", "trust"],
  ["services-overview", "structured"], ["process", "structured"], ["faq", "structured"],
  ["coverage", "structured"], ["byline", "structured"], ["related", "structured"],
  ["scenarios", "structured"], ["contact", "structured"], ["cta", "cta"],
]);

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
   * candidate asset staging directory (deterministic, content-addressed filenames).
   */
  async compileManifest(input: {
    projectId: string;
    productionInputId: string;
    assetSnapshotDir: string;
    registry?: Array<{ route: string; title: string }>;
  }): Promise<ProductionRenderManifest> {
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
    const designData = parseDesignCandidateData(bundle.design.data);
    const matches = designData.archetypes.filter((entry) => entry.kind === productionInput.pageType);
    if (matches.length !== 1) {
      throw renderError("production_build_rejected", `Accepted design must contain exactly one ${productionInput.pageType} archetype.`);
    }
    const archetype = matches[0]!;
    const rendererPrimitives = archetype.sectionPatterns.map((pattern) => {
      const primitive = SUPPORTED_PATTERNS.get(pattern);
      if (!primitive) throw renderError("production_build_rejected", `Unsupported accepted design pattern: ${pattern}`);
      return primitive;
    });
    validateDesignTokens(designData.tokens);
    const requiredSlots = archetype.assetSlots.filter((slot) => slot.pageSlug === productionInput.pageIdentity);
    const actualSlots = new Set(bundle.visualSlots.map((slot) => slot.slot));
    for (const slot of requiredSlots) {
      if (!actualSlots.has(slot.slot)) throw renderError("production_build_rejected", `Accepted design slot ${slot.slot} has no accepted visual resolution.`);
    }
    const declaredSlots = new Map(requiredSlots.map((slot) => [slot.slot, slot]));
    for (const slot of bundle.visualSlots) {
      const declared = declaredSlots.get(slot.slot);
      if (!declared || declared.requiredRole !== slot.role) throw renderError("production_build_rejected", `Accepted visual slot ${slot.slot} cannot be placed by the selected archetype.`);
    }
    if (rendererPrimitives.some((primitive) => ["narrative", "article-body", "evidence", "trust", "structured"].includes(primitive)) && content.sections.length === 0) {
      throw renderError("production_build_rejected", "Accepted design requires structured body content that is absent from AcceptedPageContent.");
    }

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
      const webDerivative = await this.materializeWebDerivative(version.storageKey, input.assetSnapshotDir);
      const meaningful = slot.truthClass !== "decorative";
      const altAuthorityComplete = meaningful ? Boolean(version.altIntent && version.altIntent.trim() !== "") : true;
      assets.push({
        slot: slot.slot,
        role: slot.role,
        truthClass: slot.truthClass,
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

    // Run 10: for production-v2 inputs, bind the exact accepted derivative
    // set and materialize the audio delivery artifact deterministically.
    let derivatives: ProductionRenderManifest["derivatives"];
    const inputData = productionInput.data as { schemaVersion?: string; acceptedDerivativeSet?: { id: string; version: number; digest: string } };
    if (inputData.schemaVersion === "production-v2") {
      const bound = inputData.acceptedDerivativeSet;
      if (!bound) throw renderError("production_build_rejected", "production-v2 input is missing its acceptedDerivativeSet binding.");
      const [setRow] = await this.db
        .select()
        .from(acceptedDerivativeSets)
        .where(and(eq(acceptedDerivativeSets.id, bound.id), eq(acceptedDerivativeSets.projectId, input.projectId)));
      if (!setRow || setRow.version !== bound.version || setRow.setDigest !== bound.digest) {
        throw renderError("production_authority_digest_mismatch", "Bound AcceptedDerivativeSet digest drifted from the production input.");
      }
      const summaryMember = setRow.summaryState === "accepted"
        ? await (async () => {
            const [artifact] = await this.db
              .select()
              .from(acceptedSummaryArtifacts)
              .where(and(eq(acceptedSummaryArtifacts.id, setRow.summaryArtifactId!), eq(acceptedSummaryArtifacts.projectId, input.projectId)));
            if (!artifact || artifact.version !== setRow.summaryVersion || artifact.artifactDigest !== setRow.summaryDigest) {
              throw renderError("production_authority_digest_mismatch", "Bound accepted summary drifted from the derivative set.");
            }
            return {
              state: "accepted" as const,
              acceptedId: artifact.id,
              acceptedVersion: artifact.version,
              acceptedDigest: artifact.artifactDigest,
              language: artifact.language,
              summaryText: artifact.summaryText,
            };
          })()
        : ({ state: "disabled" } as const);
      const audioMember = setRow.audioState === "accepted"
        ? await (async () => {
            const [artifact] = await this.db
              .select()
              .from(acceptedAudioArtifacts)
              .where(and(eq(acceptedAudioArtifacts.id, setRow.audioArtifactId!), eq(acceptedAudioArtifacts.projectId, input.projectId)));
            if (!artifact || artifact.version !== setRow.audioVersion || artifact.artifactDigest !== setRow.audioDigest || artifact.binaryDigest !== setRow.audioBinaryDigest) {
              throw renderError("production_authority_digest_mismatch", "Bound accepted audio drifted from the derivative set.");
            }
            // Materialize the exact accepted binary at a content-addressed
            // public path (same bytes -> same path; no provider hotlinks).
            const bytes = await this.storage.getObject(this.storage.derivativeKey(artifact.binaryDigest));
            const digest = sha256Bytes(bytes);
            if (digest !== artifact.binaryDigest) {
              throw renderError("derivative_binary_digest_mismatch", "Stored audio bytes do not match the accepted binary digest.");
            }
            const extension = artifact.mimeType === "audio/mpeg" ? "mp3" : artifact.mimeType === "audio/ogg" ? "ogg" : artifact.mimeType === "audio/mp4" ? "m4a" : "wav";
            const publicPath = `/production-assets/${digest}.${extension}`;
            await mkdir(input.assetSnapshotDir, { recursive: true });
            await writeFile(path.join(input.assetSnapshotDir, `${digest}.${extension}`), bytes, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
              if (error.code !== "EEXIST") throw error;
              const existing = await readFile(path.join(input.assetSnapshotDir, `${digest}.${extension}`));
              if (sha256Bytes(existing) !== digest) throw renderError("production_build_rejected", "Content-addressed audio collision.");
            });
            return {
              state: "accepted" as const,
              acceptedId: artifact.id,
              acceptedVersion: artifact.version,
              acceptedDigest: artifact.artifactDigest,
              binaryDigest: artifact.binaryDigest,
              mimeType: artifact.mimeType,
              durationSeconds: artifact.durationSeconds,
              publicPath,
            };
          })()
        : ({ state: "disabled" } as const);
      derivatives = { setDigest: setRow.setDigest, summary: summaryMember, audio: audioMember };
    }

    if (!productionInput.siteId || !productionInput.siteName || !productionInput.siteLanguage || !productionInput.siteProfileDigest) {
      throw renderError("production_build_rejected", "Production input has no immutable site identity.");
    }
    const registry = input.registry ?? [{ route: productionInput.route, title: content.title }];
    const titleByRoute = new Map(registry.map((entry) => [entry.route, entry.title]));
    const links = content.internalLinks.map((href) => {
      const route = normalizeInternalRoute(href);
      const title = route ? titleByRoute.get(route) : undefined;
      if (!route || !title) throw renderError("production_build_rejected", `Accepted internal link ${href} has no production target.`);
      return { href: route, title };
    });
    const breadcrumbs = deriveManifestBreadcrumbs(productionInput.route, productionInput.canonicalOrigin, titleByRoute);
    const canonicalUrl = `${productionInput.canonicalOrigin.replace(/\/$/, "")}${productionInput.route === "/" ? "/" : productionInput.route}`;
    const fullTitle = `${content.title} | ${productionInput.siteName}`;
    const manifest: ProductionRenderManifest = {
      schemaVersion: inputData.schemaVersion === "production-v2" ? "production-v2" : "production-v1",
      input: {
        id: productionInput.id,
        version: productionInput.version,
        digest: productionInput.inputDigest,
        projectId: input.projectId,
        pageIdentity: productionInput.pageIdentity,
        pageType: productionInput.pageType,
        route: productionInput.route,
        siteIdentity: {
          siteId: productionInput.siteId,
          siteName: productionInput.siteName,
          canonicalOrigin: productionInput.canonicalOrigin,
          language: productionInput.siteLanguage,
          profileDigest: productionInput.siteProfileDigest,
        },
      },
      seo: { fullTitle, description: content.metaDescription, canonicalUrl, ogTitle: fullTitle, ogDescription: content.metaDescription, ogUrl: canonicalUrl },
      content,
      design: {
        acceptedId: bundle.design.id,
        acceptedVersion: bundle.design.version,
        acceptedDigest: bundle.design.candidateDigest,
        tokens: designData.tokens,
        archetype: {
          kind: archetype.kind,
          sectionPatterns: [...archetype.sectionPatterns],
          contentRequirements: [...archetype.contentRequirements],
          assetSlots: requiredSlots.map((slot) => ({ slot: slot.slot, role: slot.role, requiredRole: slot.requiredRole })),
          primaryCta: archetype.primaryCta,
          secondaryCta: archetype.secondaryCta,
          responsiveBehavior: archetype.responsiveBehavior,
          trustPresentation: archetype.trustPresentation,
          rendererPrimitives,
        },
      },
      links,
      breadcrumbs,
      assets,
      ...(derivatives ? { derivatives } : {}),
      manifestDigest: "",
    };
    manifest.manifestDigest = deterministicDigest({
      input: manifest.input,
      seo: manifest.seo,
      content: manifest.content,
      design: manifest.design,
      links: manifest.links,
      breadcrumbs: manifest.breadcrumbs,
      assets: manifest.assets.map((asset) => ({
        slot: asset.slot,
        role: asset.role,
        truthClass: asset.truthClass,
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
      ...(manifest.derivatives ? { derivatives: manifest.derivatives } : {}),
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
    assetSnapshotDir: string,
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
    await mkdir(assetSnapshotDir, { recursive: true });
    await writeFile(path.join(assetSnapshotDir, `${digest}.jpg`), webBytes, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      const existing = await readFile(path.join(assetSnapshotDir, `${digest}.jpg`));
      if (sha256Bytes(existing) !== digest) throw renderError("production_build_rejected", "Content-addressed derivative collision.");
    });
    return {
      publicPath,
      width: webMeta.width ?? targetWidth,
      height: webMeta.height ?? targetHeight,
    };
  }

  /** Write the manifest JSON for the Astro build and return its path. */
  async writeManifest(manifest: ProductionRenderManifest, dir: string): Promise<string> {
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${manifest.input.id}.json`);
    await writeFile(filePath, JSON.stringify(manifest, null, 2), { encoding: "utf8", flag: "wx" });
    return filePath;
  }

  /** Read all manifests from a directory (site-wide QA/sitemap surface). */
  async readAllManifests(manifestDir: string): Promise<ProductionRenderManifest[]> {
    const entries = await readdir(manifestDir);
    const manifests: ProductionRenderManifest[] = [];
    for (const entry of entries.filter((name: string) => name.endsWith(".json")).sort()) {
      const raw = await readFile(path.join(manifestDir, entry), "utf8");
      manifests.push(assertManifest(JSON.parse(raw)));
    }
    assertUniqueManifests(manifests);
    return manifests.sort((a, b) => a.input.route.localeCompare(b.input.route));
  }

  async readManifest(filePath: string): Promise<ProductionRenderManifest> {
    const raw = await readFile(filePath, "utf8");
    return assertManifest(JSON.parse(raw));
  }
}

function validateDesignTokens(tokens: DesignSystemTokens): void {
  const colorValues = Object.values(tokens.colors).filter((value): value is string => typeof value === "string" && value !== "");
  const safeColor = /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.% ,/-]+\)|[a-z]+)$/i;
  if (colorValues.some((value) => !safeColor.test(value))) {
    throw renderError("production_build_rejected", "Accepted design contains an unsafe or unsupported color token.");
  }
  const safeFont = /^[a-z0-9 ',.-]+$/i;
  if (!safeFont.test(tokens.typography.headingFont) || !safeFont.test(tokens.typography.bodyFont)) {
    throw renderError("production_build_rejected", "Accepted design contains an unsafe font token.");
  }
  const safeLength = /^(0|\d+(?:\.\d+)?(?:px|rem|em))$/;
  if ([...Object.values(tokens.spacing), ...Object.values(tokens.rounded)].some((value) => !safeLength.test(value))) {
    throw renderError("production_build_rejected", "Accepted design spacing/radius tokens must be deterministic CSS lengths.");
  }
}

function normalizeInternalRoute(href: string): string | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  const route = href.split(/[?#]/, 1)[0]!.replace(/\/+$/, "");
  return route === "" ? "/" : route;
}

function deriveManifestBreadcrumbs(route: string, origin: string, titles: Map<string, string>) {
  if (route === "/") return [];
  if (!titles.has("/")) throw renderError("production_build_rejected", "Non-root production pages require a real homepage breadcrumb target.");
  const entries: Array<{ name: string; url: string }> = [{ name: titles.get("/")!, url: `${origin.replace(/\/$/, "")}/` }];
  const segments = route.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    const title = titles.get(current);
    if (!title) throw renderError("production_build_rejected", `Breadcrumb route ${current} is not in the candidate snapshot.`);
    entries.push({ name: title, url: current === route ? "" : `${origin.replace(/\/$/, "")}${current}` });
  }
  return entries;
}

function assertManifest(value: unknown): ProductionRenderManifest {
  const manifest = value as ProductionRenderManifest;
  const validVersion = manifest?.schemaVersion === "production-v1" || manifest?.schemaVersion === "production-v2";
  if (!manifest || !validVersion || !manifest.input || !manifest.content || !manifest.design || !manifest.seo || !Array.isArray(manifest.assets)) {
    throw renderError("production_build_rejected", "Production manifest schema is invalid.");
  }
  if (manifest.schemaVersion === "production-v2" && !manifest.derivatives) {
    throw renderError("production_build_rejected", "production-v2 manifest is missing its derivatives authority.");
  }
  if (manifest.schemaVersion === "production-v1" && manifest.derivatives) {
    throw renderError("production_build_rejected", "production-v1 manifest must not carry derivatives authority.");
  }
  const expected = deterministicDigest({
    input: manifest.input,
    seo: manifest.seo,
    content: manifest.content,
    design: manifest.design,
    links: manifest.links,
    breadcrumbs: manifest.breadcrumbs,
    assets: manifest.assets,
  });
  if (manifest.manifestDigest !== expected) throw renderError("production_authority_digest_mismatch", "Production manifest digest mismatch.");
  return manifest;
}

function assertUniqueManifests(manifests: ProductionRenderManifest[]): void {
  for (const key of ["id", "pageIdentity", "route"] as const) {
    const seen = new Set<string>();
    for (const manifest of manifests) {
      const value = manifest.input[key];
      if (seen.has(value)) throw renderError("production_route_conflict", `Duplicate production manifest ${key}: ${value}`);
      seen.add(value);
    }
  }
  const canonicals = new Set<string>();
  for (const manifest of manifests) {
    if (canonicals.has(manifest.seo.canonicalUrl)) throw renderError("production_route_conflict", `Duplicate canonical URL: ${manifest.seo.canonicalUrl}`);
    canonicals.add(manifest.seo.canonicalUrl);
  }
}

function deterministicDigestOfBytes(bytes: Uint8Array): string {
  // Binary content addressing: sha256 over exact derivative bytes.
  return sha256Bytes(bytes);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function renderError(code: string, message: string): FactoryError {
  return new FactoryError(code, message);
}
