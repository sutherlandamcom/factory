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
  parseDesignCandidateAnyVersion,
  parseRenderManifestAnyVersion,
  isDesignCandidateV2,
  type AcceptedPageContentData,
  type DesignArchetypeKind,
  type DesignCandidateData,
  type DesignCandidateDataV2,
  type DesignSystemTokens,
  type ManifestDerivatives,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { createAssetStorage, type AssetStorage } from "../assets/storage.js";
import { requireProductionDerivativeSet } from "../derivatives/production-verifier.js";
import { ProductionStore } from "./store.js";
import { deriveDesignImplementationContract } from "./design-implementation.js";
import type { DesignImplementationContract } from "@factory/contracts";

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
  schemaVersion: "production-v1" | "production-v2" | "production-v3";
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
    /** production-v3 only: derived DIC evidence (digest + policy). */
    designImplementation?: { implementationContractDigest: string; policyVersion: string; schemaVersion: string };
    /** production-v3 only: governed semantic token projection. */
    semanticTokens?: Array<{ role: string; value: string }>;
    /** production-v3 only: deterministic font delivery. */
    fontDelivery?: Array<{ mode: "approved_system_stack" | "bundled_local_asset"; family: string; sourceToken: "typography.display" | "typography.heading" | "typography.body" }>;
    /** production-v3 only: ordered composition (the renderer's only layout authority). */
    composition?: Array<{
      componentId: string;
      variant: string;
      pattern: string;
      repetition: "once" | "per_section";
      sectionIndex?: number;
      assetSlot?: string;
    }>;
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
   * Run 10 derivative authority. Summary text is copied VERBATIM from the accepted
   * summary artifact at manifest compile time. Audio binds the exact accepted binary digest.
   * Disabled state is explicitly represented ({ state: "disabled" }).
   */
  derivatives?: ManifestDerivatives;
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
    const rawData =
      contentRow.data !== null && typeof contentRow.data === "object" && !("content" in contentRow.data)
        ? {
            schemaVersion: "writer-content-v1",
            proposalId: contentRow.proposalId,
            proposalVersion: contentRow.proposalVersion,
            proposalDigest: contentRow.proposalDigest,
            qaReportDigest: contentRow.qaReportDigest,
            slug: contentRow.slug,
            title: (contentRow.data as { title?: string }).title ?? "",
            content: contentRow.data,
          }
        : contentRow.data;
    const accepted = parseAcceptedPageContentData(rawData);
    const content = this.projectAcceptedContent(accepted);

    // Exact asset authority per accepted visual slot for this page.
    const bundle = await store.deriveAuthorityBundle({
      projectId: input.projectId,
      pageSlug: productionInput.pageIdentity,
    });
    const designData = parseDesignCandidateAnyVersion(bundle.design.data);
    const matches = designData.archetypes.filter((entry) => entry.kind === productionInput.pageType);
    if (matches.length !== 1) {
      throw renderError("production_build_rejected", `Accepted design must contain exactly one ${productionInput.pageType} archetype.`);
    }
    const archetype = matches[0]!;
    // Historical renderer-only compatibility. Governed v3 consumes exact DIC composition.
    const rendererPrimitives = isDesignCandidateV2(designData) ? [] : archetype.sectionPatterns.map((pattern) => {
      const primitive = SUPPORTED_PATTERNS.get(pattern);
      if (!primitive) throw renderError("production_build_rejected", `Unsupported accepted design pattern: ${pattern}`);
      return primitive;
    });
    validateDesignTokens(designData.tokens);
    // Required visual slots for THIS page. design-v1 designs bind page-exact
    // slots directly on the archetype (representative-page era semantics).
    // design-v2 designs define GENERIC per-archetype visual-role
    // requirements; the page-exact requirement is derived here as
    // genericRole x pageIdentity with the deterministic per-page slot
    // identity "<role-prefix>.<pageSlug>" — representative-page slots never
    // satisfy another page's requirement.
    const declaredSlotsList = isDesignCandidateV2(designData)
      ? deriveV2DeclaredSlots(designData, productionInput.pageType as DesignArchetypeKind, productionInput.pageIdentity)
      : archetype.assetSlots
          .filter((slot) => slot.pageSlug === productionInput.pageIdentity)
          .map((slot) => ({ slot: slot.slot, role: slot.role, requiredRole: slot.requiredRole, required: !slot.placeholder }));
    const requiredSlots = declaredSlotsList.filter((s) => s.required);
    const declaredSlotsMap = new Map(declaredSlotsList.map((slot) => [slot.slot, slot]));
    const actualSlots = new Set(bundle.visualSlots.map((slot) => slot.slot));
    for (const slot of requiredSlots) {
      if (!actualSlots.has(slot.slot)) throw renderError("production_build_rejected", `Accepted design slot ${slot.slot} has no accepted visual resolution.`);
    }
    for (const slot of bundle.visualSlots) {
      const declared = declaredSlotsMap.get(slot.slot);
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
    if (inputData.schemaVersion === "production-v2" || inputData.schemaVersion === "production-v3") {
      const bound = inputData.acceptedDerivativeSet;
      if (!bound) throw renderError("production_build_rejected", "production-v2 input is missing its acceptedDerivativeSet binding.");
      const verified = await requireProductionDerivativeSet({
        db: this.db,
        projectId: input.projectId,
        pageIdentity: productionInput.pageIdentity,
        setId: bound.id,
        setVersion: bound.version,
        setDigest: bound.digest,
        currentContent: {
          id: contentRow.id,
          version: contentRow.version,
          digest: contentRow.contentDigest,
        },
        storage: this.storage,
      });

      const audioMember = verified.audio.state === "accepted"
        ? await (async () => {
            const artifact = verified.audio as Extract<typeof verified.audio, { state: "accepted" }>;
            // Materialize the exact accepted binary at a content-addressed
            // public path (same bytes -> same path; no provider hotlinks).
            const bytes = artifact.bytes ?? (await this.storage.getObject(this.storage.derivativeKey(artifact.binaryDigest)));
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
              acceptedId: artifact.acceptedId,
              acceptedVersion: artifact.acceptedVersion,
              acceptedDigest: artifact.acceptedDigest,
              binaryDigest: artifact.binaryDigest,
              mimeType: artifact.mimeType,
              durationSeconds: artifact.durationSeconds,
              publicPath,
            };
          })()
        : ({ state: "disabled" } as const);

      derivatives = {
        setDigest: verified.set.setDigest,
        summary: verified.summary,
        audio: audioMember,
      };
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
    // Pre-Run-12: design-v2 designs derive the deterministic DIC and emit a
    // production-v3 manifest (semantic tokens + composition + DIC evidence).
    // design-v1 designs keep the historical v1/v2 manifest semantics.
    const isV2Design = isDesignCandidateV2(designData);
    let designImplementation: ProductionRenderManifest["design"]["designImplementation"];
    let semanticTokens: ProductionRenderManifest["design"]["semanticTokens"];
    let fontDelivery: ProductionRenderManifest["design"]["fontDelivery"];
    let composition: ProductionRenderManifest["design"]["composition"];
    let manifestVersion: "production-v1" | "production-v2" | "production-v3" =
      inputData.schemaVersion === "production-v2" || inputData.schemaVersion === "production-v3" ? "production-v2" : "production-v1";
    if (isV2Design) {
      const dic = deriveDesignImplementationContract({
        design: designData,
        acceptedDesign: { id: bundle.design.id, version: bundle.design.version, digest: bundle.design.candidateDigest },
        rendererPolicyVersion: productionInput.rendererPolicyVersion,
      });
      designImplementation = {
        implementationContractDigest: dic.implementationContractDigest,
        policyVersion: productionInput.rendererPolicyVersion,
        schemaVersion: dic.schemaVersion,
      };
      semanticTokens = Object.entries(dic.semanticTokens).map(([role, value]) => ({ role, value: String(value) }));
      fontDelivery = dic.fontDelivery.map((entry) => ({ mode: entry.mode, family: entry.family, sourceToken: entry.sourceToken }));
      composition = deriveManifestComposition(dic, content, requiredSlots, productionInput.pageType);
      manifestVersion = "production-v3";
    }
    const manifest: ProductionRenderManifest = {
      schemaVersion: manifestVersion,
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
        ...(designImplementation ? { designImplementation } : {}),
        ...(semanticTokens ? { semanticTokens } : {}),
        ...(fontDelivery ? { fontDelivery } : {}),
        ...(composition ? { composition } : {}),
      },
      links,
      breadcrumbs,
      assets,
      // production-v3 requires the derivatives block explicitly (disabled
      // state when absent; accepted when present).
      ...(manifestVersion === "production-v3" ? { derivatives: derivatives ?? { state: "disabled" as const } } : { ...(derivatives ? { derivatives } : {}) }),
      manifestDigest: "",
    };
    manifest.manifestDigest = computeRenderManifestDigest(manifest);
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

/**
 * Derive page-exact declared visual slots for a design-v2 archetype from
 * its GENERIC visual-role requirements. Slot identity is deterministic:
 * "<role>.<pageSlug>" so two pages of the same archetype get independent
 * slot identities and never share exact asset authority. Both required and
 * optional roles are declared; only REQUIRED roles gate production.
 */
function deriveV2DeclaredSlots(
  design: DesignCandidateDataV2,
  archetypeKind: DesignArchetypeKind,
  pageIdentity: string,
): Array<{ slot: string; role: string; requiredRole: string; required: boolean }> {
  const requirement = design.visualRoleRequirements.find((entry) => entry.archetype === archetypeKind);
  if (!requirement) {
    throw renderError("production_build_rejected", `Accepted design-v2 has no visual-role requirements for archetype ${archetypeKind}.`);
  }
  return requirement.roles.map((role) => ({
    slot: `${role.role}.${pageIdentity}`,
    role: role.requiredRole,
    requiredRole: role.requiredRole,
    required: role.required,
  }));
}

/**
 * Derive the page composition: the DIC archetype grammar instantiated with
 * the exact accepted content and this page's required visual slots. Every
 * binding comes from the DIC grammar (fail-closed lookup); per_section
 * bindings map accepted content section i to the i-th body section binding.
 * Exactly N accepted sections -> exactly N body section renders in exact accepted order.
 */
export function deriveManifestComposition(
  dic: DesignImplementationContract,
  content: ProductionRenderManifest["content"],
  requiredSlots: Array<{ slot: string; role: string; requiredRole: string }>,
  pageType: string,
): NonNullable<ProductionRenderManifest["design"]["composition"]> {
  const archetypeGrammar = dic.archetypeGrammar.find((entry) => entry.archetype === pageType);
  if (!archetypeGrammar) {
    throw renderError("production_build_rejected", `DIC has no grammar bindings for archetype '${pageType}'.`);
  }
  const composition: NonNullable<ProductionRenderManifest["design"]["composition"]> = [];
  const sectionCount = content.sections.length;
  const bodyBindings = archetypeGrammar.bindings.filter((b) => b.repetition === "per_section");
  if (bodyBindings.length !== sectionCount || bodyBindings.some((binding, index) => binding.sectionIndex !== index)) {
    throw renderError("production_build_rejected", "Accepted design must bind every content section exactly once in accepted order; missing or duplicate bindings require new authority.");
  }
  for (const binding of archetypeGrammar.bindings) {
    if (binding.repetition === "per_section") {
      composition.push({ componentId: binding.componentId, variant: binding.variant, pattern: binding.pattern, repetition: binding.repetition, sectionIndex: binding.sectionIndex! });
      continue;
    }

    // "once" bindings: bind the page's matching visual asset slot when the
    // binding's component carries a visual role this page requires.
    const boundSlot = binding.visualRole
      ? requiredSlots.find(slot => slot.slot.startsWith(`${binding.visualRole}.`))
      : undefined;
    composition.push({
      componentId: binding.componentId,
      variant: binding.variant,
      pattern: binding.pattern,
      repetition: binding.repetition,
      ...(boundSlot ? { assetSlot: boundSlot.slot } : {}),
    });
  }
  return composition;
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
  if (!titles.has("/")) return [];
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

export function computeRenderManifestDigest(manifest: ProductionRenderManifest): string {
  // Digest formula note: schemaVersion is structurally validated by the
  // shared contract parser and is NOT part of the digest body (historical
  // manifest compatibility). The production-v3 design authority fields
  // (designImplementation/semanticTokens/fontDelivery/composition) live
  // inside `design` and ARE digest-bound.
  return deterministicDigest({
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
}

export function assertManifest(value: unknown): ProductionRenderManifest {
  let parsed: ProductionRenderManifest;
  try {
    parsed = parseRenderManifestAnyVersion(value) as ProductionRenderManifest;
  } catch (error) {
    if (error instanceof FactoryError) throw error;
    throw renderError("production_build_rejected", error instanceof Error ? error.message : "Production manifest schema is invalid.");
  }
  const expected = computeRenderManifestDigest(parsed);
  if (parsed.manifestDigest !== expected) {
    throw renderError("production_authority_digest_mismatch", "Production manifest digest mismatch.");
  }
  return parsed;
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
