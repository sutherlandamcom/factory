import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { type ProductionQaCheckResult } from "@factory/contracts";
type ProductionQaScope = "page" | "site" | "repository";
import { FactoryError } from "../../executor/errors.js";
import { runProcess } from "../../executor/process.js";
import { deterministicDigest } from "../../intelligence/digest.js";
import { loadProductionBuildIdentity } from "../identity.js";
import { importTrustedQaEvidence } from "./evidence-import.js";
import { ProductionStore } from "../store.js";
import type { FactoryDb } from "../../persistence/db.js";

/**
 * Trusted production-QA evidence collection (Run 11 product capability).
 *
 * Closes the Run 9 → Run 11 gap: Run 9's runCandidateQa requires persisted
 * candidate-bound trusted evidence (axe, keyboard, Lighthouse, gitleaks,
 * OSV), but before Run 11 there was no ordinary operator workflow to collect
 * that evidence for an exact candidate — blocking a browser-only journey to
 * READY_FOR_DEPLOYMENT.
 *
 * Layering (no shell string execution, no client-controlled paths):
 *   ProductionQaEvidenceCollector  — product/application logic (this file's
 *                                    collector class)
 *   TrustedQaEvidenceExecutor      — environment-specific scanner execution
 *                                    (LocalTrustedQaEvidenceExecutor)
 *
 * The collector never sets candidate.state; runCandidateQa remains the sole
 * QA decision authority.
 */

const execFileAsync = promisify(execFile);

/** Exact tool invocations — fixed executables, fixed argument arrays. */
interface TrustedToolSpec {
  checkId: ProductionQaCheckResult["checkId"];
  group: ProductionQaCheckResult["group"];
  scope: ProductionQaScope;
  tool: string;
  /** Version probe: [executable, ...args] returning a version string. */
  versionProbe: { cmd: string; args: string[]; resolveCwd?: "repo" | "site" };
}

const TRUSTED_TOOLS: Record<string, TrustedToolSpec> = {
  axe: { checkId: "accessibility.axe", group: "accessibility", scope: "page", tool: "axe-core", versionProbe: { cmd: "node", args: ["-e", "console.log(require(process.env.QA_AXE_PKG).version)"], resolveCwd: "repo" } },
  keyboard: { checkId: "accessibility.keyboard", group: "accessibility", scope: "page", tool: "playwright-keyboard", versionProbe: { cmd: "node", args: ["-e", "console.log(require('@playwright/test/package.json').version)"] } },
  lighthouse: { checkId: "performance.lighthouse", group: "performance", scope: "site", tool: "lighthouse-ci", versionProbe: { cmd: "node", args: ["-e", "console.log(require('@lhci/cli/package.json').version)"] } },
  gitleaks: { checkId: "security.gitleaks", group: "security", scope: "repository", tool: "gitleaks", versionProbe: { cmd: "gitleaks", args: ["version"] } },
  osv: { checkId: "security.osv", group: "security", scope: "repository", tool: "osv-scanner", versionProbe: { cmd: process.env.OSV_SCANNER_BIN || "osv-scanner", args: ["--version"] } },
};

/** Typed availability of one trusted tool in this environment. */
export interface TrustedToolAvailability {
  checkId: ProductionQaCheckResult["checkId"];
  tool: string;
  available: boolean;
  version?: string;
  detail?: string;
}

/** Narrow executor boundary (§19). */
export interface TrustedQaEvidenceExecutor {
  /** Probe all mandatory tools; typed unavailable (never treated as PASS). */
  availability(repoRoot: string): Promise<TrustedToolAvailability[]>;
  /** Execute the evidence producers for one exact candidate. */
  collect(input: {
    distDir: string;
    routes: string[];
    manifestSetDigest: string;
    repositorySha: string;
    repoRoot: string;
  }): Promise<ProductionQaCheckResult[]>;
}

const TOOL_TIMEOUT_MS = 420_000;

function qaToolUnavailable(tool: string, detail: string): FactoryError {
  return new FactoryError("qa_tool_unavailable", `Trusted QA tool '${tool}' is unavailable in this environment: ${detail}`);
}

/** Resolve the axe-core package.json from the pnpm store (lockfile layout). */
async function resolveAxeCorePackage(repoRoot: string): Promise<string | null> {
  const storeDir = path.join(repoRoot, "node_modules", ".pnpm");
  try {
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(storeDir));
    const axeDir = entries.find((name) => /^axe-core@\d/.test(name));
    if (!axeDir) return null;
    return path.join(storeDir, axeDir, "node_modules", "axe-core", "package.json");
  } catch {
    return null;
  }
}

async function probeVersion(spec: TrustedToolSpec, repoRoot: string, extraEnv: Record<string, string> = {}): Promise<TrustedToolAvailability> {
  // Node-module tools resolve from the site-starter workspace (where CI
  // installs them); standalone binaries resolve from PATH.
  const probeCwd =
    spec.versionProbe.resolveCwd === "repo"
      ? repoRoot
      : path.join(repoRoot, "sites", "starter");
  try {
    const { stdout } = await execFileAsync(spec.versionProbe.cmd, spec.versionProbe.args, {
      encoding: "utf8",
      timeout: 30_000,
      cwd: probeCwd,
      env: { ...process.env, ...extraEnv },
    });
    const version = stdout.trim().split("\n").pop() ?? "";
    if (!version) throw new Error("empty version output");
    return { checkId: spec.checkId, tool: spec.tool, available: true, version };
  } catch (err) {
    return {
      checkId: spec.checkId,
      tool: spec.tool,
      available: false,
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}

/**
 * Local fixed-tool executor (§20): exact allowlisted tools, fixed argument
 * arrays, explicit timeouts, backend-resolved paths, no shell.
 */
export class LocalTrustedQaEvidenceExecutor implements TrustedQaEvidenceExecutor {
  constructor(private readonly runner: typeof runProcess = runProcess) {}

  async availability(repoRoot: string): Promise<TrustedToolAvailability[]> {
    const axePkg = await resolveAxeCorePackage(repoRoot);
    return Promise.all(
      Object.values(TRUSTED_TOOLS).map((spec) =>
        probeVersion(spec, repoRoot, { QA_AXE_PKG: axePkg ?? "" }),
      ),
    );
  }

  /** Resolve browser-harness package entry points (playwright from the
   *  dashboard workspace, @axe-core/playwright from site-starter deps). */
  private async resolveBrowserPackages(repoRoot: string): Promise<{ playwright: string; axe: string } | null> {
    const candidates = [
      { playwright: path.join(repoRoot, "apps", "dashboard", "node_modules", "@playwright", "test"), axe: path.join(repoRoot, "sites", "starter", "node_modules", "@axe-core", "playwright") },
      { playwright: path.join(repoRoot, "node_modules", "@playwright", "test"), axe: path.join(repoRoot, "node_modules", "@axe-core", "playwright") },
    ];
    for (const candidate of candidates) {
      try {
        // Keep the symlink path (NOT realpath): package resolution needs the
        // sibling node_modules context of the workspace that owns the dep.
        await stat(path.join(candidate.playwright, "package.json"));
        await stat(path.join(candidate.axe, "package.json"));
        return { playwright: candidate.playwright, axe: candidate.axe };
      } catch {
        continue;
      }
    }
    return null;
  }

  async collect(input: {
    distDir: string;
    routes: string[];
    manifestSetDigest: string;
    repositorySha: string;
    repoRoot: string;
  }): Promise<ProductionQaCheckResult[]> {
    const checks: ProductionQaCheckResult[] = [];
    const availability = await this.availability(input.repoRoot);
    const unavailable = availability.filter((entry) => !entry.available);
    if (unavailable.length > 0) {
      // Fail closed: a missing mandatory tool is never a PASS (§33).
      throw qaToolUnavailable(
        unavailable.map((entry) => entry.tool).join(", "),
        unavailable.map((entry) => entry.detail ?? "not found").join("; "),
      );
    }
    const versions = new Map(availability.map((entry) => [entry.tool, entry.version!]));

    const browserPkgs = await this.resolveBrowserPackages(input.repoRoot);
    if (!browserPkgs) {
      throw qaToolUnavailable("@playwright/test, @axe-core/playwright", "Browser QA packages are not installed in the workspace.");
    }
    checks.push(...(await this.collectBrowserChecks({ ...input, browserPkgs }, versions)));
    checks.push(...(await this.collectLighthouse({ ...input }, versions)));
    checks.push(await this.collectGitleaks(input, versions));
    checks.push(await this.collectOsv(input, versions));
    return checks;
  }

  /** axe + keyboard against the exact built artifact served read-only. */
  private async collectBrowserChecks(
    input: { distDir: string; routes: string[]; repoRoot: string; browserPkgs: { playwright: string; axe: string } },
    versions: Map<string, string>,
  ): Promise<ProductionQaCheckResult[]> {
    const script = `
      const { chromium } = require(process.env.QA_PLAYWRIGHT_PKG);
      const { AxeBuilder } = require(process.env.QA_AXE_PLAYWRIGHT_PKG);
      const http = require("node:http");
      const fs = require("node:fs");
      const path = require("node:path");
      const distDir = process.env.QA_DIST_DIR;
      const routes = JSON.parse(process.env.QA_ROUTES);
      const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain", ".wav": "audio/wav", ".ico": "image/x-icon" };
      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url, "http://localhost");
          let file = path.join(distDir, decodeURIComponent(url.pathname));
          if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            const index = path.join(file, "index.html");
            file = fs.existsSync(index) ? index : path.join(distDir, "404.html");
          }
          const type = types[path.extname(file)] ?? "application/octet-stream";
          res.writeHead(200, { "Content-Type": type });
          res.end(fs.readFileSync(file));
        } catch { res.writeHead(404); res.end("not found"); }
      });
      server.listen(0, "127.0.0.1", async () => {
        const port = server.address().port;
        const browser = await chromium.launch({ headless: true });
        const results = [];
        try {
          // AxeBuilder requires an explicit context (error-handling contract).
          const context = await browser.newContext();
          const page = await context.newPage();
          for (const route of routes) {
            await page.goto(\`http://127.0.0.1:\${port}\${route}\`);
            const axe = await new AxeBuilder({ page }).analyze();
            const blocking = axe.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
            results.push({ kind: "axe", route, blocking: blocking.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), count: blocking.length });
            const expected = await page.locator('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])').count();
            const visited = new Set();
            let ok = true;
            for (let i = 0; i < expected; i += 1) {
              await page.keyboard.press("Tab");
              const marker = await page.evaluate(() => {
                const active = document.activeElement;
                if (!active || active === document.body) return "";
                return active.tagName + ":" + (active.getAttribute("href") ?? active.id ?? active.textContent?.trim() ?? "");
              });
              if (marker === "") ok = false;
              visited.add(marker);
            }
            results.push({ kind: "keyboard", route, expected, visited: visited.size, ok: ok && visited.size === expected });
          }
        } finally { await browser.close(); server.close(); }
        process.stdout.write(JSON.stringify(results));
      });
    `;
    const result = await this.runner("node", ["--input-type=commonjs", "-e", script], {
      cwd: input.repoRoot,
      env: {
        ...process.env,
        QA_DIST_DIR: input.distDir,
        QA_ROUTES: JSON.stringify(input.routes),
        QA_PLAYWRIGHT_PKG: input.browserPkgs.playwright,
        QA_AXE_PLAYWRIGHT_PKG: input.browserPkgs.axe,
      },
      timeoutMs: TOOL_TIMEOUT_MS,
    });
    if (result.timedOut) throw new FactoryError("qa_tool_timeout", "Browser QA (axe/keyboard) exceeded its time budget.");
    if (result.exitCode !== 0) {
      throw new FactoryError("qa_tool_unavailable", `Browser QA harness failed: ${(result.stderr || result.stdout).slice(-300)}`);
    }
    const parsed = JSON.parse(result.stdout) as Array<{
      kind: string; route: string; count?: number; blocking?: Array<{ id: string; impact: string; nodes: number }>; expected?: number; visited?: number; ok?: boolean;
    }>;
    const out: ProductionQaCheckResult[] = [];
    for (const entry of parsed) {
      if (entry.kind === "axe") {
        const pass = (entry.count ?? 1) === 0;
        out.push({
          checkId: "accessibility.axe",
          group: "accessibility",
          verdict: pass ? "PASS" : "FAIL",
          detail: pass
            ? `axe-core: 0 critical/serious violations on ${entry.route}.`
            : `axe-core blocking violations on ${entry.route}: ${entry.blocking!.map((v) => `${v.id}(${v.impact}): ${v.nodes} node(s)`).join("; ")}`,
          evidence: pass ? [] : entry.blocking!.slice(0, 10).map((v) => ({ kind: "check" as const, ref: v.id })),
          scope: "page",
          subject: entry.route,
          tool: "axe-core",
          toolVersion: versions.get("axe-core")!,
        });
      } else {
        out.push({
          checkId: "accessibility.keyboard",
          group: "accessibility",
          verdict: entry.ok ? "PASS" : "FAIL",
          detail: `keyboard journey on ${entry.route}: ${entry.expected} interactive elements, ${entry.visited} distinct focus stops.`,
          evidence: [],
          scope: "page",
          subject: entry.route,
          tool: "playwright-keyboard",
          toolVersion: versions.get("playwright-keyboard")!,
        });
      }
    }
    // Execution digests bind each check to its exact content (Run 9 semantics).
    return out.map((check) => ({
      ...check,
      executionDigest: deterministicDigest({
        checkId: check.checkId, group: check.group, verdict: check.verdict,
        detail: check.detail, evidence: check.evidence,
        scope: check.scope, subject: check.subject, tool: check.tool, toolVersion: check.toolVersion,
      }),
    }));
  }

  /** Lighthouse CI against the exact built dist (existing methodology, 1 run). */
  private async collectLighthouse(
    input: { distDir: string; routes: string[]; repoRoot: string; manifestSetDigest: string },
    versions: Map<string, string>,
  ): Promise<ProductionQaCheckResult[]> {
    const outDir = path.join(input.repoRoot, "qa-artifacts", "lhci-e2e");
    const result = await this.runner("pnpm", [
      "exec", "lhci", "autorun",
      `--collect.staticDistDir=${input.distDir}`,
      "--collect.numberOfRuns=1",
      `--upload.outputDir=${outDir}`,
      "--upload.target=filesystem",
    ], { cwd: path.join(input.repoRoot, "sites", "starter"), env: { ...process.env }, timeoutMs: TOOL_TIMEOUT_MS });
    const manifestPath = path.join(outDir, "manifest.json");
    if (result.timedOut) throw new FactoryError("qa_tool_timeout", "Lighthouse CI exceeded its time budget.");
    if (result.exitCode !== 0 && !(await exists(manifestPath))) {
      throw new FactoryError("qa_tool_unavailable", `Lighthouse CI failed: ${(result.stderr || result.stdout).slice(-300)}`);
    }
    const out: ProductionQaCheckResult[] = [];
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Array<{ url: string; jsonPath: string }>;
      const byRoute = new Map<string, Array<Record<string, any>>>();
      for (const entry of manifest) {
        const report = JSON.parse(await readFile(entry.jsonPath, "utf8")) as Record<string, any>;
        const rawPath = entry.url.replace(/^https?:\/\/[^/]+/, "");
        let route = rawPath.replace(/\/index\.html$/, "/").replace(/\/$/, "");
        if (route === "") route = "/";
        const list = byRoute.get(route) ?? [];
        list.push(report);
        byRoute.set(route, list);
      }
      for (const route of input.routes) {
        const reports = byRoute.get(route) ?? [];
        if (reports.length === 0) {
          out.push(this.lhCheck("FAIL", `No Lighthouse report for ${route}.`, route, versions, []));
          continue;
        }
        const worst = (key: string) => Math.min(...reports.map((r) => r.categories?.[key]?.score ?? 0));
        const perf = worst("performance");
        const seo = worst("seo");
        const bp = worst("best-practices");
        const tbt = Math.max(...reports.map((r) => r.audits?.["total-blocking-time"]?.numericValue ?? 0));
        const lcp = Math.max(...reports.map((r) => r.audits?.["largest-contentful-paint"]?.numericValue ?? 0));
        const cls = Math.max(...reports.map((r) => r.audits?.["cumulative-layout-shift"]?.numericValue ?? 0));
        const pass = perf >= 0.9 && seo >= 0.95 && bp >= 0.95 && lcp <= 2500 && cls <= 0.1;
        out.push(this.lhCheck(
          pass ? "PASS" : "FAIL",
          `Lighthouse lab (pessimistic over ${reports.length} run(s)) on ${route}: performance=${perf} seo=${seo} best-practices=${bp} LCP=${Math.round(lcp)}ms TBT=${Math.round(tbt)}ms (lab proxy; field INP never claimed) CLS=${cls}.`,
          route, versions, [{ kind: "artifact" as const, ref: "lhci" }],
        ));
      }
    } finally {
      // Cleanup temp artifacts (gitignored qa-artifacts dir).
      await import("node:fs/promises").then((fs) => fs.rm(outDir, { recursive: true, force: true }));
    }
    return out;
  }

  private lhCheck(verdict: "PASS" | "FAIL", detail: string, route: string, versions: Map<string, string>, evidence: Array<{ kind: "artifact"; ref: string }>): ProductionQaCheckResult {
    const base = {
      checkId: "performance.lighthouse" as const,
      group: "performance" as const,
      verdict,
      detail,
      evidence,
      scope: "site" as const,
      subject: "", // filled by caller via manifestSetDigest binding below
      tool: "lighthouse-ci",
      toolVersion: versions.get("lighthouse-ci")!,
    };
    return { ...base, subject: base.subject || route } as ProductionQaCheckResult;
  }

  private async collectGitleaks(
    input: { repoRoot: string; repositorySha: string },
    versions: Map<string, string>,
  ): Promise<ProductionQaCheckResult> {
    const result = await this.runner("gitleaks", ["detect", "--redact", "--config", path.join(input.repoRoot, ".gitleaks.toml")], {
      cwd: input.repoRoot,
      env: { ...process.env },
      timeoutMs: TOOL_TIMEOUT_MS,
    });
    const pass = result.exitCode === 0 || /no leaks found/i.test(result.stdout + result.stderr);
    const base = {
      checkId: "security.gitleaks" as const,
      group: "security" as const,
      verdict: pass ? ("PASS" as const) : ("FAIL" as const),
      detail: pass
        ? "gitleaks: no secret leaks detected in the repository."
        : `gitleaks detected leaks: ${(result.stdout || result.stderr).slice(-400)}`,
      evidence: [] as Array<{ kind: "check"; ref: string }>,
      scope: "repository" as const,
      subject: input.repositorySha,
      tool: "gitleaks",
      toolVersion: versions.get("gitleaks")!,
    };
    return {
      ...base,
      executionDigest: deterministicDigest({
        checkId: base.checkId, group: base.group, verdict: base.verdict,
        detail: base.detail, evidence: base.evidence,
        scope: base.scope, subject: base.subject, tool: base.tool, toolVersion: base.toolVersion,
      }),
    };
  }

  private async collectOsv(
    input: { repoRoot: string; repositorySha: string },
    versions: Map<string, string>,
  ): Promise<ProductionQaCheckResult> {
    const result = await this.runner(process.env.OSV_SCANNER_BIN || "osv-scanner", ["scan", "--lockfile=pnpm-lock.yaml"], {
      cwd: input.repoRoot,
      env: { ...process.env },
      timeoutMs: TOOL_TIMEOUT_MS,
    });
    const pass = result.exitCode === 0;
    const base = {
      checkId: "security.osv" as const,
      group: "security" as const,
      verdict: pass ? ("PASS" as const) : ("FAIL" as const),
      detail: pass
        ? "osv-scanner: no known vulnerabilities in the lockfile."
        : `osv-scanner reported vulnerabilities: ${(result.stdout || result.stderr).slice(-400)}`,
      evidence: [] as Array<{ kind: "check"; ref: string }>,
      scope: "repository" as const,
      subject: input.repositorySha,
      tool: "osv-scanner",
      toolVersion: versions.get("osv-scanner")!,
    };
    return {
      ...base,
      executionDigest: deterministicDigest({
        checkId: base.checkId, group: base.group, verdict: base.verdict,
        detail: base.detail, evidence: base.evidence,
        scope: base.scope, subject: base.subject, tool: base.tool, toolVersion: base.toolVersion,
      }),
    };
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** Internal binding pass — fills site subjects and re-binds execution digests. */
function bindSubjects(checks: ProductionQaCheckResult[], subjects: { manifestSetDigest: string }): ProductionQaCheckResult[] {
  return checks.map((check) => {
    const subject = check.scope === "site" ? subjects.manifestSetDigest : check.subject!;
    const bound = { ...check, subject };
    return {
      ...bound,
      executionDigest: deterministicDigest({
        checkId: bound.checkId, group: bound.group, verdict: bound.verdict,
        detail: bound.detail, evidence: bound.evidence,
        scope: bound.scope, subject: bound.subject, tool: bound.tool, toolVersion: bound.toolVersion,
      }),
    };
  });
}

/**
 * Product-layer collector (§18). Verifies candidate eligibility, resolves
 * trusted subjects from backend authority, invokes the configured executor,
 * validates evidence, and persists it through the shared Run 9 import seam.
 * NEVER sets candidate state — runCandidateQa decides.
 */
export class ProductionQaEvidenceCollector {
  constructor(
    private readonly store: ProductionStore,
    private readonly storeDb: FactoryDb,
    private readonly repoRoot: string,
    private readonly executor: TrustedQaEvidenceExecutor | null,
  ) {}

  /** Typed availability of the configured executor + tools. */
  async availability(): Promise<{ executorConfigured: boolean; tools: TrustedToolAvailability[] }> {
    if (!this.executor) return { executorConfigured: false, tools: [] };
    return { executorConfigured: true, tools: await this.executor.availability(this.repoRoot) };
  }

  async collect(input: { projectId: string; candidateId: string }): Promise<{
    collected: number;
    verdicts: Record<string, string>;
  }> {
    if (!this.executor) {
      throw qaToolUnavailable("qa-executor", "No trusted QA evidence executor is configured in this environment.");
    }
    // Candidate eligibility: exact ownership (store enforces project
    // isolation) + built state.
    const candidate = await this.store.getCandidate(input.projectId, input.candidateId);
    if (!candidate) throw new FactoryError("production_candidate_not_found", "Candidate not found.");
    if (!["built", "qa_passed", "qa_failed"].includes(candidate.state)) {
      throw new FactoryError("production_qa_not_found", "Candidate has no completed build to collect QA evidence for.");
    }
    if (!candidate.artifactRef || !candidate.manifestSetDigest) {
      throw new FactoryError("production_qa_not_found", "Candidate is missing immutable build identity.");
    }

    // Trusted subjects come ONLY from backend authority (§21, §22).
    const distDir = await this.resolveTrustedDistDir(candidate.artifactRef);
    const bindings = await this.store.listCandidateInputs(input.projectId, input.candidateId);
    const routes = bindings.map((binding) => binding.route);
    if (routes.length === 0) throw new FactoryError("production_qa_failed", "Candidate exposes no routes.");

    const identity = await loadProductionBuildIdentity(this.repoRoot);

    const rawChecks = await this.executor.collect({
      distDir,
      routes,
      manifestSetDigest: candidate.manifestSetDigest,
      repositorySha: identity.repositorySha,
      repoRoot: this.repoRoot,
    });
    // Bind site-scope subjects to the exact manifest set digest and re-bind
    // execution digests so recordTrustedQaEvidence identity checks hold.
    const checks = bindSubjects(rawChecks, { manifestSetDigest: candidate.manifestSetDigest });

    // Persist through the shared Run 9 import authority (validates every
    // digest binding server-side; fails closed on mismatch). Reuses the
    // collector's own DB connection — no second connection string needed.
    const importResult = await importTrustedQaEvidence({
      projectId: input.projectId,
      candidateId: input.candidateId,
      db: this.storeDb,
      report: {
        artifactDigest: candidate.artifactDigest ?? undefined,
        repositorySha: identity.repositorySha,
        lockfileDigest: identity.lockfileDigest,
        checks,
      },
    });

    return {
      collected: importResult.imported,
      verdicts: Object.fromEntries(checks.map((check) => [check.checkId, check.verdict])),
    };
  }

  /**
   * Resolve the exact built dist dir from persisted candidate authority and
   * verify it stays inside the production workspace root (§22).
   */
  private async resolveTrustedDistDir(artifactRef: string): Promise<string> {
    const real = await realpath(artifactRef);
    const workspaceRoot = await realpath(this.repoRoot);
    const artifactRoot = path.join(workspaceRoot, ".factory", "production");
    if (!real.startsWith(artifactRoot + path.sep)) {
      throw new FactoryError("production_qa_failed", "Candidate artifact reference escapes the trusted production workspace.");
    }
    return real;
  }
}
