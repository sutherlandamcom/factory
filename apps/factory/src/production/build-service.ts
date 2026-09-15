import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FactoryDb } from "../persistence/db.js";
import { FactoryError } from "../executor/errors.js";
import { runProcess } from "../executor/process.js";
import { deterministicDigest } from "../intelligence/digest.js";
import { parseAcceptedPageContentData } from "@factory/contracts";
import { ProductionStore, candidateBuildStaleness } from "./store.js";
import { ProductionRenderCompiler, type ProductionRenderManifest } from "./render-manifest.js";
import { emitSitemapAndRobots } from "./seo-engine.js";
import { loadProductionBuildIdentity } from "./identity.js";
import { PageAuthorityReader } from "../writer/page-authority.js";

export interface ProductionBuildResult {
  candidateId: string;
  artifactDigest: string;
  manifestSetDigest: string;
  routeCount: number;
  htmlRoutes: string[];
  buildDurationMs: number;
}

export class ProductionBuildService {
  private readonly compiler: ProductionRenderCompiler;

  constructor(
    private readonly db: FactoryDb,
    private readonly repoRoot: string,
  ) {
    this.compiler = new ProductionRenderCompiler(db, repoRoot);
  }

  async prepareCandidate(input: { projectId: string; pageSlug: string }) {
    const identity = await loadProductionBuildIdentity(this.repoRoot);
    const store = new ProductionStore(this.db);
    const productionInput = await store.deriveProductionInput({
      projectId: input.projectId,
      pageSlug: input.pageSlug,
      siteIdentity: identity.siteIdentity,
      rendererVersion: identity.rendererVersion,
      rendererPolicyVersion: identity.rendererPolicyVersion,
    });
    const staleness = await store.inputStaleness(productionInput, {
      siteProfileDigest: identity.siteIdentity.profileDigest,
      rendererVersion: identity.rendererVersion,
      rendererPolicyVersion: identity.rendererPolicyVersion,
    });
    if (staleness.stale) throw buildError("production_authority_stale", staleness.reason ?? "Production input is stale.");
    const candidate = await store.createCandidate({
      projectId: input.projectId,
      productionInputId: productionInput.id,
      repositorySha: identity.repositorySha,
      lockfileDigest: identity.lockfileDigest,
    });
    return { candidateId: candidate.id, inputId: productionInput.id, inputVersion: productionInput.version, stale: false };
  }

  async buildCandidate(input: { projectId: string; candidateId: string }): Promise<ProductionBuildResult> {
    const startedAt = Date.now();
    const store = new ProductionStore(this.db);
    const candidate = await store.getCandidate(input.projectId, input.candidateId);
    if (!candidate) throw buildError("production_candidate_not_found", "Candidate not found.");
    if (candidate.state !== "pending") throw buildError("production_build_rejected", `Candidate ${candidate.id} is ${candidate.state}; only pending candidates can build.`);
    if (!candidate.siteProfileDigest || !candidate.rendererVersion || !candidate.repositorySha || !candidate.lockfileDigest) {
      throw buildError("production_build_rejected", "Candidate predates immutable build identity.");
    }
    const currentIdentity = await loadProductionBuildIdentity(this.repoRoot);
    const buildStaleness = candidateBuildStaleness(candidate, currentIdentity);
    if (buildStaleness.stale) {
      throw buildError("production_authority_stale", buildStaleness.reason ?? "Repository, site profile, renderer, or lockfile identity changed after candidate preparation.");
    }

    const candidatesDir = path.join(this.repoRoot, ".factory", "production", "projects", safeSegment(input.projectId), "candidates");
    const finalDir = path.join(candidatesDir, safeSegment(candidate.id));
    const stagingDir = path.join(candidatesDir, `.${safeSegment(candidate.id)}.staging-${randomUUID()}`);
    if (await exists(finalDir)) throw buildError("production_build_rejected", `Immutable candidate directory already exists: ${candidate.id}`);
    const manifestDir = path.join(stagingDir, "manifests");
    const assetDir = path.join(stagingDir, "assets");
    const distDir = path.join(stagingDir, "dist");
    await mkdir(manifestDir, { recursive: true });
    try {
      const allInputs = await store.listProductionInputs(input.projectId);
      const latestByPage = new Map<string, typeof allInputs[number]>();
      for (const row of allInputs) if (!latestByPage.has(row.pageIdentity)) latestByPage.set(row.pageIdentity, row);
      const siteInputs = [...latestByPage.values()].sort((a, b) => a.route.localeCompare(b.route));
      const currentPages = await new PageAuthorityReader(this.db).currentPages(input.projectId);
      const currentPageIdentities = [...currentPages.map((page) => page.slug)].sort();
      const inputPageIdentities = [...siteInputs.map((row) => row.pageIdentity)].sort();
      if (currentPageIdentities.join("\0") !== inputPageIdentities.join("\0")) {
        throw buildError("production_authority_stale", "Current accepted pages and current production inputs do not form one complete site snapshot.");
      }
      if (!siteInputs.some((row) => row.id === candidate.productionInputId)) {
        throw buildError("production_authority_stale", "Candidate target is no longer in the current site input set.");
      }
      const registry: Array<{ route: string; title: string }> = [];
      for (const row of siteInputs) {
        if (row.siteProfileDigest !== candidate.siteProfileDigest || row.rendererVersion !== candidate.rendererVersion) {
          throw buildError("production_authority_stale", `Site input ${row.id} uses a different site or renderer identity.`);
        }
        const bundle = await store.deriveAuthorityBundle({ projectId: input.projectId, pageSlug: row.pageIdentity });
        registry.push({ route: row.route, title: parseAcceptedPageContentData(bundle.content.data).content.title });
      }
      const manifests: ProductionRenderManifest[] = [];
      for (const row of siteInputs) {
        const manifest = await this.compiler.compileManifest({
          projectId: input.projectId,
          productionInputId: row.id,
          assetSnapshotDir: assetDir,
          registry,
        });
        await this.compiler.writeManifest(manifest, manifestDir);
        manifests.push(manifest);
      }
      const manifestSetDigest = deterministicDigest(manifests.map((manifest) => ({ inputId: manifest.input.id, route: manifest.input.route, manifestDigest: manifest.manifestDigest })));
      const redirectRules: Array<{ source: string; destination: string; kind: "permanent" | "temporary" }> = [];
      const redirectSnapshotDigest = deterministicDigest({ projectId: input.projectId, rules: redirectRules });

      const siteDir = path.join(this.repoRoot, "sites", "starter");
      const result = await runProcess("pnpm", ["run", "build"], {
        cwd: siteDir,
        env: {
          ...process.env,
          FACTORY_PRODUCTION_MANIFEST_DIR: manifestDir,
          FACTORY_PRODUCTION_OUT_DIR: distDir,
          FACTORY_PRODUCTION_SITE_PROFILE_DIGEST: candidate.siteProfileDigest,
          PUBLIC_SITE_URL: manifests[0]!.input.siteIdentity.canonicalOrigin,
        },
        timeoutMs: 300_000,
      });
      if (result.exitCode !== 0) throw buildError("production_build_rejected", `Astro build failed (exit ${result.exitCode}): ${result.stderr.slice(-2000)}`);
      if (await exists(assetDir)) await cp(assetDir, path.join(distDir, "production-assets"), { recursive: true, errorOnExist: true, force: false });
      await emitSitemapAndRobots({ manifests, distDir, siteName: manifests[0]!.input.siteIdentity.siteName });
      const htmlRoutes = await collectHtmlRoutes(distDir);
      const expectedRoutes = manifests.map((manifest) => manifest.input.route).sort();
      if (htmlRoutes.filter((route) => route !== "/404").join("\0") !== expectedRoutes.join("\0")) {
        throw buildError("production_build_rejected", `Astro route set differs from candidate snapshot: ${htmlRoutes.join(", ")}`);
      }
      const artifactDigest = await computeArtifactDigest(distDir);
      const finalIdentity = await loadProductionBuildIdentity(this.repoRoot);
      const finalStaleness = candidateBuildStaleness(candidate, finalIdentity);
      if (finalStaleness.stale) {
        throw buildError("production_authority_stale", finalStaleness.reason ?? "Repository, site profile, renderer, or lockfile identity changed during candidate build.");
      }
      await writeFile(path.join(stagingDir, "build-metadata.json"), JSON.stringify({ candidateId: candidate.id, projectId: input.projectId, repositorySha: candidate.repositorySha, lockfileDigest: candidate.lockfileDigest, rendererVersion: candidate.rendererVersion, siteProfileDigest: candidate.siteProfileDigest, manifestSetDigest, redirectSnapshotDigest, artifactDigest }, null, 2), { encoding: "utf8", flag: "wx" });
      await mkdir(candidatesDir, { recursive: true });
      await rename(stagingDir, finalDir);
      const finalDistDir = path.join(finalDir, "dist");
      await store.recordBuild({
        projectId: input.projectId,
        candidateId: candidate.id,
        artifactDigest,
        artifactRef: finalDistDir,
        assetReferences: manifests.flatMap((manifest) => manifest.assets.map((asset) => ({ ...asset, route: manifest.input.route }))),
        manifestSetDigest,
        candidateInputs: manifests.map((manifest) => ({ productionInputId: manifest.input.id, productionInputVersion: manifest.input.version, productionInputDigest: manifest.input.digest, pageIdentity: manifest.input.pageIdentity, route: manifest.input.route, manifestDigest: manifest.manifestDigest })),
        redirectRules,
        redirectSnapshotDigest,
      });
      return { candidateId: candidate.id, artifactDigest, manifestSetDigest, routeCount: expectedRoutes.length, htmlRoutes: expectedRoutes, buildDurationMs: Date.now() - startedAt };
    } catch (error) {
      if (await exists(stagingDir)) await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  async loadManifests(input: { projectId: string; candidateId: string }): Promise<ProductionRenderManifest[]> {
    const candidate = await new ProductionStore(this.db).getCandidate(input.projectId, input.candidateId);
    if (!candidate?.artifactRef) throw buildError("production_candidate_not_found", "Built candidate not found.");
    return await this.compiler.readAllManifests(path.join(path.dirname(candidate.artifactRef), "manifests"));
  }
}

export async function collectHtmlRoutes(distDir: string): Promise<string[]> {
  const routes: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, `${prefix}/${entry.name}`);
      else if (entry.name === "index.html") routes.push(prefix === "" ? "/" : prefix);
      else if (entry.name.endsWith(".html")) routes.push(`${prefix}/${entry.name}`.replace(/\.html$/, ""));
    }
  }
  await walk(distDir, "");
  return routes.sort();
}

export async function computeArtifactDigest(root: string): Promise<string> {
  const files: Array<{ path: string; digest: string }> = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push({ path: path.relative(root, full).split(path.sep).join("/"), digest: createHash("sha256").update(await readFile(full)).digest("hex") });
    }
  }
  await walk(root);
  return deterministicDigest(files);
}

async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(value)) throw buildError("production_build_rejected", `Unsafe artifact identity: ${value}`);
  return value;
}

function buildError(code: string, message: string): FactoryError { return new FactoryError(code, message); }
