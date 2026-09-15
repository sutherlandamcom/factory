import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalProductionJson } from "@factory/contracts";

/**
 * Production manifest loader for the Astro build (Run 9).
 *
 * The Astro build consumes ONLY manifests produced by the trusted Factory
 * compiler (`apps/factory/src/production/render-manifest.ts`). Each manifest
 * is a verbatim projection of exact accepted authority. Invalid or missing
 * manifests fail the build clearly — no silent fallback page, no placeholder
 * copy, no invented content.
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
    siteIdentity: { siteId: string; siteName: string; canonicalOrigin: string; language: string; profileDigest: string };
  };
  seo: { fullTitle: string; description: string; canonicalUrl: string; ogTitle: string; ogDescription: string; ogUrl: string };
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
    tokens: {
      colors: Record<string, string | undefined>;
      typography: { headingFont: string; bodyFont: string; scaleNotes: string };
      spacing: Record<string, string>;
      rounded: Record<string, string>;
      ctaHierarchy: string;
      navigationLanguage: string;
      imageryTreatment: string;
      sectionRhythm: string;
    };
    archetype: {
      kind: "homepage" | "service" | "location" | "editorial" | "investment_advisory";
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
  assets: Array<{
    slot: string;
    role: string;
    truthClass: string;
    versionId: string;
    binaryDigest: string;
    governanceDigest: string;
    publicPath: string;
    width: number;
    height: number;
    alt: string;
    altAuthorityComplete: boolean;
    isProbableLcp: boolean;
  }>;
  /** Run 10 derivative authority (production-v2 manifests only). */
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
          publicPath: string;
        };
  };
  manifestDigest: string;
}

/**
 * Manifest directory resolution: FACTORY_PRODUCTION_MANIFEST_DIR (trusted
 * build-time environment override) takes precedence; otherwise the
 * default `<site>/.factory-production` directory. A configured directory
 * that cannot be read FAILS THE BUILD (no silent empty-manifest fallback —
 * a silently empty production site would be worse than a failed build).
 */
function resolveManifestDir(): string | null {
  const configured = process.env.FACTORY_PRODUCTION_MANIFEST_DIR?.trim();
  return configured !== undefined && configured !== "" ? configured : null;
}

const DEFAULT_MANIFEST_DIR = path.resolve(import.meta.dirname, "../../.factory-production");

function assertManifestShape(value: unknown): ProductionRenderManifest {
  const manifest = value as ProductionRenderManifest;
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Production manifest is not an object.");
  }
  const validVersion = manifest.schemaVersion === "production-v1" || manifest.schemaVersion === "production-v2";
  if (!validVersion) {
    throw new Error(`Production manifest schemaVersion must be "production-v1" or "production-v2" (got ${String((manifest as { schemaVersion?: unknown }).schemaVersion)}).`);
  }
  if (manifest.schemaVersion === "production-v2" && manifest.derivatives === undefined) {
    throw new Error('production-v2 manifest is missing its derivatives authority.');
  }
  if (manifest.schemaVersion === "production-v1" && manifest.derivatives !== undefined) {
    throw new Error('production-v1 manifest must not carry derivatives authority.');
  }
  for (const key of ["input", "seo", "content", "design", "links", "breadcrumbs", "assets", "manifestDigest"] as const) {
    if (manifest[key] === undefined) {
      throw new Error(`Production manifest is missing "${key}".`);
    }
  }
  const content = manifest.content;
  for (const key of ["title", "metaDescription", "introduction", "conclusion", "cta"] as const) {
    if (typeof content[key] !== "string") {
      throw new Error(`Production manifest content.${key} must be a string.`);
    }
  }
  if (!Array.isArray(content.sections) || !Array.isArray(content.internalLinks)) {
    throw new Error("Production manifest content.sections/internalLinks must be arrays.");
  }
  if (!Array.isArray(manifest.assets)) {
    throw new Error("Production manifest assets must be an array.");
  }
  const expectedDigest = createHash("sha256").update(canonicalProductionJson({
    input: manifest.input,
    seo: manifest.seo,
    content: manifest.content,
    design: manifest.design,
    links: manifest.links,
    breadcrumbs: manifest.breadcrumbs,
    assets: manifest.assets,
    ...(manifest.derivatives ? { derivatives: manifest.derivatives } : {}),
  })).digest("hex");
  if (manifest.manifestDigest !== expectedDigest) throw new Error("Production manifest digest mismatch.");
  return manifest;
}

/** Load every valid production manifest, sorted by route for determinism. */
export async function loadProductionManifests(): Promise<ProductionRenderManifest[]> {
  const manifestDir = resolveManifestDir() ?? DEFAULT_MANIFEST_DIR;
  let files: string[];
  try {
    files = await readdir(manifestDir);
  } catch (error) {
    const configured = resolveManifestDir();
    if (configured) {
      // A configured manifest directory MUST be readable — fail the build.
      throw new Error(`Production manifest directory "${configured}" is not readable: ${(error as Error).message}`);
    }
    // No manifests present: the build renders only the static fixture pages.
    return [];
  }
  const manifests: ProductionRenderManifest[] = [];
  for (const file of files.filter((name) => name.endsWith(".json")).sort()) {
    const raw = await readFile(path.join(manifestDir, file), "utf8");
    manifests.push(assertManifestShape(JSON.parse(raw)));
  }
  for (const key of ["id", "pageIdentity", "route"] as const) {
    const values = manifests.map((manifest) => manifest.input[key]);
    if (new Set(values).size !== values.length) throw new Error(`Duplicate production manifest ${key}.`);
  }
  const canonicals = manifests.map((manifest) => manifest.seo.canonicalUrl);
  if (new Set(canonicals).size !== canonicals.length) throw new Error("Duplicate production canonical URL.");
  return manifests.sort((a, b) => (a.input.route < b.input.route ? -1 : a.input.route > b.input.route ? 1 : 0));
}

/** Load one manifest by route; missing manifests fail the page build. */
export async function loadManifestForRoute(route: string): Promise<ProductionRenderManifest | undefined> {
  const manifests = await loadProductionManifests();
  return manifests.find((manifest) => manifest.input.route === route);
}
