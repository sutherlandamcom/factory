import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOperatorApi, type OperatorApiDeps } from "./api.js";
import { ProjectIntakeStore } from "./intake-store.js";
import { FactoryStore } from "../persistence/store.js";
import { resolveDatabaseConfig } from "../persistence/config.js";
import { createDatabaseInstance } from "../persistence/db.js";

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
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "../../dashboard/dist");

const MAX_BODY_BYTES = 256 * 1024;

export function createOperatorServer(deps: OperatorApiDeps): http.Server {
  const handleApiRequest = createOperatorApi(deps);

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
        return await serveStatic(res, pathname);
      }

      return errorResponse(res, 405, "method_not_allowed", "Method not allowed.");
    } catch (error) {
      // Sanitized error output: never leak stack traces or environment details.
      const message = error instanceof Error ? "Internal server error" : "Internal server error";
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ error: { code: "internal_error", message } }));
    }
  });

  return server;
}

async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(DIST_DIR, safePath === "/" ? "index.html" : safePath);
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "forbidden", message: "Forbidden." } }));
    return;
  }
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath);
    const mime =
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
      const content = await readFile(path.join(DIST_DIR, "index.html"));
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
  const deps: OperatorApiDeps = {
    store: new FactoryStore(dbInstance.db),
    intake: new ProjectIntakeStore(dbInstance.db),
  };
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
