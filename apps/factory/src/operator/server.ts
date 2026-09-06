import http from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATOR_ERROR_STATUS, OPERATOR_INTERNAL_ERROR_MESSAGE } from "@factory/contracts";
import { createOperatorApi, type OperatorApiDeps } from "./api.js";
import { ProjectIntakeStore } from "./intake-store.js";
import { FactoryStore } from "../persistence/store.js";
import { resolveDatabaseConfig } from "../persistence/config.js";
import { createDatabaseInstance } from "../persistence/db.js";
import { SearchStore } from "../search/search-store.js";
import { SearchIntelligenceService, DEFAULT_SEARCH_CONFIG, type SearchServiceConfig } from "../search/service.js";
import { BrightDataSerpProvider } from "../search/serp-brightdata.js";
import { DataForSeoSerpProvider } from "../search/serp-dataforseo.js";
import { FixtureSerpProvider } from "../search/serp-fixture.js";
import { FixtureGroundedSearchProvider } from "../search/grounded-types.js";
import { FixtureSearchAnalyst, OpenRouterSearchAnalyst } from "../search/analyst.js";
import { invokeModel } from "../models/gateway.js";
import { CompetitorStore } from "../competitors/competitor-store.js";
import { CompetitorContentGapService, buildCompetitorAnalysts } from "../competitors/service.js";

/**
 * Trusted backend provider selection for Search Intelligence.
 *
 * FACTORY_SEARCH_MODE: 'production' (default) | 'fixture'.
 * FACTORY_SERP_PROVIDER: 'brightdata' (default) | 'dataforseo'.
 * The browser can NEVER select providers or modes — this is config-only.
 */
export function buildSearchIntelligenceService(
  deps: { intake: ProjectIntakeStore; searchStore: SearchStore },
  config?: Partial<SearchServiceConfig>,
): SearchIntelligenceService {
  const mode = process.env.FACTORY_SEARCH_MODE === "fixture" ? "fixture" : "production";
  const env: NodeJS.ProcessEnv = process.env;
  const configuredSerpProvider = env.FACTORY_SERP_PROVIDER?.trim().toLowerCase() || "brightdata";
  const productionSerp =
    configuredSerpProvider === "brightdata"
      ? new BrightDataSerpProvider({ env })
      : configuredSerpProvider === "dataforseo"
        ? new DataForSeoSerpProvider({ env })
        : (() => {
            throw new Error("FACTORY_SERP_PROVIDER must be 'brightdata' or 'dataforseo'.");
          })();
  const fixtureSerp = new FixtureSerpProvider();

  // Grounded research is optional in v0. Fixture mode wires a deterministic
  // provider so the full UI/application journey is exercised; production
  // remains absent until an optional grounded-search adapter is deliberately
  // adopted. Structured SERP measurement does not depend on this capability.
  const grounded = mode === "fixture" ? new FixtureGroundedSearchProvider() : null;

  const analyst =
    mode === "fixture" || !env.OPENROUTER_API_KEY
      ? new FixtureSearchAnalyst()
      : new OpenRouterSearchAnalyst({
          model: "google/gemini-3.7-flash",
          callModel: async (prompt) => {
            const result = await invokeModel(
              {
                roleId: "search_analyst",
                model: "google/gemini-3.7-flash",
                systemPrompt:
                  "You are Factory's search analyst. Output only strict JSON matching the requested schema. Ground every claim in the provided evidence; never invent rankings, volumes, statistics, or business facts.",
                prompt,
                maxTokens: 4096,
                timeoutMs: 120_000,
              },
              { loadApiKey: () => env.OPENROUTER_API_KEY ?? null },
            );
            return {
              text: result.content,
              usage: {
                inputTokens: result.promptTokens,
                outputTokens: result.completionTokens,
                totalTokens: result.totalTokens,
                costMicros:
                  result.costUsd != null ? Math.round(result.costUsd * 1_000_000) : null,
              },
            };
          },
        });

  return new SearchIntelligenceService({
    intake: deps.intake,
    searchStore: deps.searchStore,
    productionSerpProvider: productionSerp,
    fixtureSerpProvider: fixtureSerp,
    groundedProvider: grounded,
    analyst,
    config: {
      ...DEFAULT_SEARCH_CONFIG,
      providerMode: mode,
      ...(process.env.FACTORY_SEARCH_FRESHNESS_HOURS
        ? { freshnessHours: Number(process.env.FACTORY_SEARCH_FRESHNESS_HOURS) }
        : {}),
      ...(process.env.FACTORY_SEARCH_DAILY_LIMIT_USD
        ? { dailyLimitUsd: Number(process.env.FACTORY_SEARCH_DAILY_LIMIT_USD) }
        : {}),
      ...config,
    },
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function errorResponse(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(new Error("payload_too_large"));
        // Stop consuming so the 413 response can be written; the request
        // stream is destroyed by the HTTP layer after the response ends.
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the built Dashboard dist directory for static serving.
 *
 * Precedence:
 * 1. FACTORY_OPERATOR_DIST (explicit operator-controlled override);
 * 2. monorepo layout `apps/dashboard/dist` relative to this source file
 *    (`apps/factory/src/operator` -> repo root -> `apps/dashboard/dist`);
 * 3. layout relative to the compiled output, when present.
 */
function resolveDashboardDist(): string {
  const override = process.env.FACTORY_OPERATOR_DIST?.trim();
  if (override) return path.resolve(override);
  // __dirname = apps/factory/src/operator (tsx) -> repo root is ../../..
  const monorepo = path.resolve(__dirname, "../../../dashboard/dist");
  if (existsSync(monorepo)) return monorepo;
  // Fallback for compiled layouts (dist/operator -> ../../dashboard/dist).
  return path.resolve(__dirname, "../../dashboard/dist");
}

const MAX_BODY_BYTES = 256 * 1024;

export function createOperatorServer(
  deps: OperatorApiDeps,
  options: { distDir?: string } = {},
): http.Server {
  const handleApiRequest = createOperatorApi(deps);
  const distDir = options.distDir ?? resolveDashboardDist();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;
      const host = req.headers.host ?? "";
      const origin = req.headers.origin;
      const method = req.method ?? "GET";

      // Host allowlist: the operator service is local-only.
      const hostname = host.split(":")[0]?.toLowerCase() ?? "";
      if (hostname !== "localhost" && hostname !== "127.0.0.1") {
        return errorResponse(res, 403, "invalid_host", "Invalid Host header.");
      }

      // Cross-origin mutation protection: state-changing requests must be
      // same-origin (Origin must match the Host, or be absent for
      // non-browser clients).
      const isMutation = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
      if (isMutation && origin !== undefined) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(origin).host === host;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) {
          return errorResponse(res, 403, "cross_origin_forbidden", "Cross-origin requests are not allowed.");
        }
      }

      if (pathname.startsWith("/api/")) {
        let body = "";
        if (isMutation) {
          const contentType = req.headers["content-type"] ?? "";
          if (!contentType.includes("application/json")) {
            return errorResponse(res, 415, "unsupported_media_type", "Content-Type must be application/json.");
          }
          try {
            body = await readBody(req);
          } catch (err) {
            if (err instanceof Error && err.message === "payload_too_large") {
              return errorResponse(res, 413, "payload_too_large", "Request body exceeds the size limit.");
            }
            throw err;
          }
        }
        return await handleApiRequest(req, res, pathname, body);
      }

      if (method === "GET" || method === "HEAD") {
        return await serveStatic(res, pathname, distDir);
      }

      return errorResponse(res, 405, "method_not_allowed", "Method not allowed.");
    } catch (error) {
      // Sanitized error output: never leak stack traces or environment details.
      const message = OPERATOR_INTERNAL_ERROR_MESSAGE;
      if (!res.headersSent) {
        res.writeHead(OPERATOR_ERROR_STATUS.internal_error, { "Content-Type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ error: { code: "internal_error", message } }));
    }
  });

  return server;
}

async function serveStatic(
  res: http.ServerResponse,
  pathname: string,
  distDir: string,
): Promise<void> {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(distDir, safePath === "/" ? "index.html" : safePath);
  if (!filePath.startsWith(distDir)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "forbidden", message: "Forbidden." } }));
    return;
  }
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath);    const mime =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js" || ext === ".mjs" ? "text/javascript; charset=utf-8" :
      ext === ".css" ? "text/css; charset=utf-8" :
      ext === ".svg" ? "image/svg+xml" :
      ext === ".json" ? "application/json" :
      "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    // SPA fallback: serve index.html for client-side routes.
    try {
      const content = await readFile(path.join(distDir, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    } catch {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "Not found." } }));
    }
  }
}

export async function startOperatorServer(): Promise<http.Server> {
  const config = resolveDatabaseConfig(process.env);
  const dbInstance = createDatabaseInstance(config);
  const store = new FactoryStore(dbInstance.db);
  const intake = new ProjectIntakeStore(dbInstance.db);
  const searchStore = new SearchStore(dbInstance.db);
  const search = buildSearchIntelligenceService({ intake, searchStore });
  const competitorStore = new CompetitorStore(dbInstance.db);
  const { competitorAnalyst, gapAnalyst } = buildCompetitorAnalysts(process.env, invokeModel);
  const competitors = new CompetitorContentGapService({
    intake,
    competitorStore,
    competitorAnalyst,
    gapAnalyst,
    config: {
      mode: process.env.FACTORY_COMPETITOR_MODE === "fixture" ? "fixture" : "production",
      ...(process.env.FACTORY_COMPETITOR_MAX_PAGES
        ? { maxPages: Math.max(1, Math.min(10, Number(process.env.FACTORY_COMPETITOR_MAX_PAGES))) }
        : {}),
      ...(process.env.FACTORY_COMPETITOR_DAILY_LIMIT_USD
        ? { dailyLimitUsd: Number(process.env.FACTORY_COMPETITOR_DAILY_LIMIT_USD) }
        : {}),
    },
  });
  const deps: OperatorApiDeps = { store, intake, search, competitors };
  const server = createOperatorServer(deps);
  const host = process.env.FACTORY_OPERATOR_HOST ?? "127.0.0.1";
  const port = Number(process.env.FACTORY_OPERATOR_PORT ?? 3000);
  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startOperatorServer()
    .then((server) => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 3000;
      console.log(`Factory operator server listening on http://127.0.0.1:${port}`);
    })
    .catch((err) => {
      console.error("Failed to start operator server:", err);
      process.exit(1);
    });
}
