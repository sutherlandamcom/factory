import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FactoryDb } from "../persistence/db.js";
import { FactoryError } from "../executor/errors.js";
import { runProcess } from "../executor/process.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { ProductionStore } from "./store.js";
import {
  ProductionRenderCompiler,
  type ProductionRenderManifest,
} from "./render-manifest.js";
import { emitSitemapAndRobots } from "./seo-engine.js";

/**
 * PRODUCTION BUILD SERVICE — Macro Run 9 (Phase 2).
 *
 * Orchestrates the deterministic production build:
 *
 *   ProductionPageInput (validated, current)
 *     -> ProductionCandidate (immutable, pending)
 *     -> ProductionRenderManifest (verbatim authority projection)
 *     -> `astro build` (static renderer; the ONLY ordinary renderer per Run 8)
 *     -> normalized artifact digest + cache-policy metadata
 *     -> candidate marked built
 *
 * No LLM/provider call happens anywhere in this path. The build is a pure
 * deterministic function of the accepted authority + renderer version.
 */

export interface ProductionBuildResult {
  candidateId: string;
  artifactDigest: string;
  routeCount: number;
  htmlRoutes: string[];
  buildDurationMs: number;
}

const RENDERER_VERSION = "astro-7.2.9";
const RENDERER_POLICY_VERSION = "production-policy-v1";

export class ProductionBuildService {
  private readonly compiler: ProductionRenderCompiler;

  constructor(
    private readonly db: FactoryDb,
    private readonly repoRoot: string,
  ) {
    this.compiler = new ProductionRenderCompiler(db, repoRoot);
  }

  /**
   * Derive (or reuse) the ProductionPageInput for a page and create its
   * candidate. Stale upstream authority fails closed — never silently
   * rebuilds under new authority while preserving candidate identity.
   */
  async prepareCandidate(input: {
    projectId: string;
    pageSlug: string;
    canonicalOrigin: string;
  }): Promise<{ candidateId: string; inputId: string; inputVersion: number; stale: boolean }> {
    const store = new ProductionStore(this.db);
    const productionInput = await store.deriveProductionInput({
      projectId: input.projectId,
      pageSlug: input.pageSlug,
      canonicalOrigin: input.canonicalOrigin,
      rendererVersion: RENDERER_VERSION,
      rendererPolicyVersion: RENDERER_POLICY_VERSION,
    });
    const staleness = await store.inputStaleness(productionInput);
    if (staleness.stale) {
      throw buildError("production_authority_stale", staleness.reason ?? "Production input is stale.");
    }
    const candidate = await store.createCandidate({
      projectId: input.projectId,
      productionInputId: productionInput.id,
    });
    return {
      candidateId: candidate.id,
      inputId: productionInput.id,
      inputVersion: productionInput.version,
      stale: false,
    };
  }

  /**
   * Build one candidate: compile the render manifest, run the Astro build,
   * compute the normalized artifact digest, and mark the candidate built.
   */
  async buildCandidate(input: { projectId: string; candidateId: string }): Promise<ProductionBuildResult> {
    const store = new ProductionStore(this.db);
    const candidate = await store.getCandidate(input.projectId, input.candidateId);
    if (!candidate) {
      throw buildError("production_candidate_not_found", "Candidate not found.");
    }
    if (candidate.state !== "pending") {
      throw buildError(
        "production_build_rejected",
        `Candidate ${candidate.id} is ${candidate.state}; only pending candidates can build.`,
      );
    }

    const startedAt = Date.now();
    const manifest = await this.compiler.compileManifest({
      projectId: input.projectId,
      productionInputId: candidate.productionInputId,
    });
    await this.compiler.writeManifest(manifest);

    // Deterministic Astro static build (Run 8 renderer authority). The
    // manifest directory is passed explicitly: the renderer consumes ONLY
    // manifests produced by the trusted compiler.
    const siteDir = path.join(this.repoRoot, "sites", "starter");
    const manifestDir = path.join(siteDir, ".factory-production");
    const result = await runProcess("pnpm", ["run", "build"], {
      cwd: siteDir,
      env: {
        ...process.env,
        FACTORY_PRODUCTION_MANIFEST_DIR: manifestDir,
      },
      timeoutMs: 300_000,
    });
    if (result.exitCode !== 0) {
      throw buildError(
        "production_build_rejected",
        `Astro build failed (exit ${result.exitCode}): ${result.stderr.slice(-2000)}`,
      );
    }

    const distDir = path.join(siteDir, "dist");
    const htmlRoutes = await collectHtmlRoutes(distDir);

    // Authority-derived sitemap/robots: regenerate from ALL manifests the
    // build consumed (route authority), never from filesystem routes. This
    // overwrites the generic Astro-integration output for production builds.
    const allManifests = await this.compiler.readAllManifests(manifestDir);
    await emitSitemapAndRobots({
      manifests: allManifests,
      distDir,
      siteName: "Factory Production Site",
    });

    const artifactDigest = await computeArtifactDigest(distDir);
    const assetReferences = manifest.assets.map((asset) => ({
      slot: asset.slot,
      role: asset.role,
      versionId: asset.versionId,
      binaryDigest: asset.binaryDigest,
      governanceDigest: asset.governanceDigest,
      publicPath: asset.publicPath,
    }));

    await store.recordBuild({
      projectId: input.projectId,
      candidateId: candidate.id,
      artifactDigest,
      artifactRef: distDir,
      assetReferences,
    });

    await writeCachePolicyMetadata(this.repoRoot, {
      projectId: input.projectId,
      routes: htmlRoutes,
    });

    return {
      candidateId: candidate.id,
      artifactDigest,
      routeCount: htmlRoutes.length,
      htmlRoutes,
      buildDurationMs: Date.now() - startedAt,
    };
  }

  async loadManifest(input: { projectId: string; candidateId: string }): Promise<ProductionRenderManifest> {
    const store = new ProductionStore(this.db);
    const candidate = await store.getCandidate(input.projectId, input.candidateId);
    if (!candidate) throw buildError("production_candidate_not_found", "Candidate not found.");
    const manifest = await this.compiler.compileManifest({
      projectId: input.projectId,
      productionInputId: candidate.productionInputId,
    });
    return manifest;
  }
}

// ---------------------------------------------------------------------------
// Artifact digest (normalized deterministic surface)
// ---------------------------------------------------------------------------

async function collectHtmlRoutes(distDir: string): Promise<string[]> {
  const routes: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, `${prefix}/${entry.name}`);
      } else if (entry.name === "index.html") {
        // Astro directory format: <route>/index.html.
        routes.push(prefix === "" ? "/" : prefix);
      } else if (entry.name.endsWith(".html")) {
        const relative = `${prefix}/${entry.name}`.replace(/\.html$/, "");
        routes.push(relative === "/index" ? "/" : relative);
      }
    }
  }
  await walk(distDir, "");
  return routes.sort();
}

/**
 * Normalized deterministic artifact digest: sha256 over the canonical JSON
 * of { routes, per-route normalized HTML }. The HTML normalization strips
 * Astro/Vite incidental nondeterminism (module hashes in asset URLs) while
 * keeping the semantic surface (structure, text, metadata, asset refs).
 * Byte-level HTML determinism is verified separately in the determinism test.
 */
async function computeArtifactDigest(distDir: string): Promise<string> {
  const routes = await collectHtmlRoutes(distDir);
  const surface: Array<{ route: string; html: string }> = [];
  for (const route of routes) {
    const file = route === "/" ? path.join(distDir, "index.html") : path.join(distDir, route.slice(1) + ".html");
    const html = await readFile(file, "utf8");
    surface.push({ route, html: normalizeHtml(html) });
  }
  return deterministicDigest(surface);
}

function normalizeHtml(html: string): string {
  return html
    // Vite hashed asset references are incidental build data, not semantics.
    .replace(/\/_astro\/[^"']+\.([a-zA-Z0-9]+)\.(css|js|woff2?|jpg|png|webp|svg)/g, "/_astro/norm.$2")
    .replace(/production-assets\/[0-9a-f]{64}\.jpg/g, "production-assets/norm.jpg")
    .replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Cache-policy metadata artifact for Run 13 (no Publish action here)
// ---------------------------------------------------------------------------

async function writeCachePolicyMetadata(
  repoRoot: string,
  input: { projectId: string; routes: string[] },
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const entries = [
    ...input.routes.map((route) => ({
      target: route,
      kind: "html" as const,
      maxAgeSeconds: 0,
    })),
    {
      target: "/_astro/*",
      kind: "immutable_asset" as const,
      maxAgeSeconds: 31536000,
    },
    {
      target: "/production-assets/*",
      kind: "immutable_asset" as const,
      maxAgeSeconds: 31536000,
    },
  ];
  const payload = {
    schemaVersion: "production-v1" as const,
    projectId: input.projectId,
    entries,
  };
  const dir = path.join(repoRoot, ".factory", "production");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `cache-policy-${sanitize(input.projectId)}.json`),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
}

function sanitize(value: string): string {
  return value.replace(/[^a-z0-9-]+/gi, "-");
}

function buildError(code: string, message: string): FactoryError {
  return new FactoryError(code, message);
}

// Re-export for tests asserting exact digest semantics.
export { createHash };
