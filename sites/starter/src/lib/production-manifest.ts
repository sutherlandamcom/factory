import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseRenderManifestAnyVersion,
  type DesignArchetypeKind,
  type ManifestCompositionEntry,
  type ManifestDesignImplementation,
  type ManifestFontDelivery,
  type ManifestSemanticToken,
} from "@factory/contracts";

/**
 * Production manifest loader for the Astro build (Run 9 + Pre-Run-12).
 *
 * The Astro build consumes ONLY manifests produced by the trusted Factory
 * compiler (`apps/factory/src/production/render-manifest.ts`). There is a
 * SINGLE shared structural contract: both producer and consumer validate
 * against `parseRenderManifestAnyVersion` from @factory/contracts — no
 * duplicated structural truth, no divergent digest computation.
 *
 * Invalid or missing manifests fail the build clearly — no silent fallback
 * page, no placeholder copy, no invented content. production-v3 manifests
 * additionally require the DIC evidence block, semantic tokens, font
 * delivery and composition authority; unknown component/variant/missing
 * token failures surface at render time from the composition itself.
 */

/** The shared manifest type (single source of structural truth). */
export type ProductionRenderManifest = ReturnType<typeof parseRenderManifestAnyVersion>;
export type { DesignArchetypeKind, ManifestCompositionEntry, ManifestDesignImplementation, ManifestFontDelivery, ManifestSemanticToken };

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

/**
 * Load every valid production manifest, sorted by route for determinism.
 * Validation (schema shape, version invariants, digest) is delegated to the
 * shared contract parser — fail closed on any drift.
 */
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
    manifests.push(parseRenderManifestAnyVersion(JSON.parse(raw)) as ProductionRenderManifest);
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
