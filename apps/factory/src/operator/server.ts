import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleApiRequest } from "./api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "../../dashboard/dist");

const MAX_BODY_BYTES = 256 * 1024;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "OPTIONS"]);
const ALLOWED_ORIGINS = new Set(["null"]);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
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
    req.on("error", (err) => reject(err));
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function errorResponse(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

export function createOperatorServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, pathname: string, body: string) => Promise<void>,
) {
  return http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = reqUrl.pathname;
    const origin = req.headers.origin ?? null;
    const host = req.headers.host ?? "";

    try {
      if (!ALLOWED_METHODS.has(req.method ?? "")) {
        return errorResponse(res, 405, "method_not_allowed", "Method not allowed.");
      }

      const hostOk = host === "localhost" || host.startsWith("localhost:") ||
        host === "127.0.0.1" || host.startsWith("127.0.0.1:");
      if (!hostOk) {
        return errorResponse(res, 403, "invalid_host", "Invalid Host header.");
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": origin === "null" ? "null" : `http://${host}`,
          "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        });
        res.end();
        return;
      }

      const isMutation = req.method === "POST" || req.method === "PUT";
      if (isMutation) {
        const sameOrigin = origin === null || origin === `http://${host}` ||
          (origin === "null" && host.startsWith("127.0.0.1:"));
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
          } catch {
            return errorResponse(res, 413, "payload_too_large", `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
          }
        }
        return await handleApiRequest(req, res, pathname, body);
      }

      if (req.method === "GET") {
        const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
        const filePath = path.join(DIST_DIR, safePath === "/" ? "index.html" : safePath);
        if (!filePath.startsWith(DIST_DIR)) {
          return errorResponse(res, 403, "forbidden", "Forbidden.");
        }
        try {
          const content = await readFile(filePath);
          const ext = path.extname(filePath);
          const mime = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "application/octet-stream";
          res.writeHead(200, { "Content-Type": `${mime}; charset=utf-8` });
          res.end(content);
          return;
        } catch {
          return errorResponse(res, 404, "not_found", "Not found.");
        }
      }

      return errorResponse(res, 405, "method_not_allowed", "Method not allowed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal server error";
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ error: { code: "internal_error", message } }));
    }
  });
}

export function startOperatorServer(): Promise<http.Server> {
  const port = Number(process.env.FACTORY_OPERATOR_PORT || 3000);
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse, pathname: string, body: string) => {
    await handleApiRequest(req, res, pathname, body);
  };
  const server = createOperatorServer(handler);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startOperatorServer().then((server) => {
    console.log(`Operator server listening on ${JSON.stringify(server.address())}`);
  });
}
