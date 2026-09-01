import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { FactoryError } from "./errors.js";
import { scrubCredentials } from "../models/gateway.js";
import { CODE_WORKER_POLICY } from "../models/policy.js";

/**
 * FACTORY MODEL RELAY (code-worker-routing-v0).
 *
 * Security & Trust Invariants:
 * 1. Worker containers possess NO real provider credentials (NO real OPENROUTER_API_KEY).
 * 2. Worker containers have NO direct access to openrouter.ai or the public internet.
 * 3. All model invocations from worker containers must route through this trusted Factory relay.
 * 4. The relay owns the real OPENROUTER_API_KEY and enforces exact model bindings:
 *    - primary (Kimi): strictly `moonshotai/kimi-k3`
 *    - senior (Claude): strictly `anthropic/claude-opus-5`
 * 5. Any request for an alternate or unpinned model is immediately rejected with HTTP 400/403
 *    and results in 0 upstream calls to OpenRouter.
 */

export interface ModelRelayOptions {
  tier: "primary" | "senior";
  apiKey: string;
  upstreamBaseUrl?: string;
  port?: number;
  host?: string;
}

export interface ModelRelayServer {
  port: number;
  host: string;
  baseUrl: string;
  allowedModel: string;
  tier: "primary" | "senior";
  close: () => Promise<void>;
}

export const RELAY_DUMMY_TOKEN = "factory-relay-token-authorized";
export const DEFAULT_OPENROUTER_UPSTREAM = "https://openrouter.ai/api/v1";

/**
 * Validate that the request body matches the authorized model for the relay tier.
 * Returns null if valid, or an error message if invalid.
 */
export function validateRelayModel(
  body: unknown,
  allowedModel: string,
): { valid: boolean; requestedModel: string | null; error?: string } {
  if (!body || typeof body !== "object") {
    return { valid: false, requestedModel: null, error: "Invalid JSON request body" };
  }
  const rec = body as Record<string, unknown>;
  const requestedModel = typeof rec.model === "string" ? rec.model : null;
  if (!requestedModel) {
    return { valid: false, requestedModel: null, error: "Missing required 'model' field in request body" };
  }
  if (requestedModel !== allowedModel) {
    return {
      valid: false,
      requestedModel,
      error: `Unauthorized model '${requestedModel}'. Tier policy strictly restricts requests to '${allowedModel}'`,
    };
  }
  return { valid: true, requestedModel };
}

/**
 * Starts an ephemeral local HTTP model relay for one worker execution tier.
 */
export async function startModelRelay(options: ModelRelayOptions): Promise<ModelRelayServer> {
  const tier = options.tier;
  const allowedModel =
    tier === "primary" ? CODE_WORKER_POLICY.primary.model : CODE_WORKER_POLICY.senior.model;
  const apiKey = options.apiKey;
  if (!apiKey || apiKey.trim() === "") {
    throw new FactoryError(
      `${tier === "primary" ? "kimi" : "claude"}_credentials_unavailable`,
      `Cannot start ${tier} model relay: OPENROUTER_API_KEY is not configured`,
    );
  }

  const upstreamUrl = new URL(options.upstreamBaseUrl ?? DEFAULT_OPENROUTER_UPSTREAM);

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Enable basic CORS for local tools
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check endpoint
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", tier, allowedModel }));
      return;
    }

    // Collect request body
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");

      // Validate model for POST / completion requests
      if (req.method === "POST") {
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "Factory Model Relay: invalid JSON body",
                type: "invalid_request_error",
                code: "invalid_json",
              },
            }),
          );
          return;
        }

        const modelCheck = validateRelayModel(parsedBody, allowedModel);
        if (!modelCheck.valid) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: `Factory Model Relay: ${modelCheck.error}`,
                type: "model_policy_violation",
                code: "unauthorized_model",
                requestedModel: modelCheck.requestedModel,
                allowedModel,
              },
            }),
          );
          return;
        }
      }

      // Prepare upstream URL
      // If incoming path starts with /api/v1 or /v1, resolve correctly against upstream
      const incomingPath = req.url ?? "/";
      const targetUrl = new URL(
        incomingPath.startsWith("/v1")
          ? incomingPath.replace(/^\/v1/, "")
          : incomingPath,
        upstreamUrl.toString().replace(/\/$/, "") + "/",
      );

      // Forward request to upstream OpenRouter with the real API key
      const upstreamHeaders: Record<string, string> = {
        "content-type": req.headers["content-type"] ?? "application/json",
        authorization: `Bearer ${apiKey}`,
        "user-agent": "Factory-Model-Relay/0.1",
      };

      if (req.headers["anthropic-version"]) {
        upstreamHeaders["anthropic-version"] = String(req.headers["anthropic-version"]);
      }

      try {
        const upstreamReq = https.request(
          targetUrl,
          {
            method: req.method,
            headers: upstreamHeaders,
          },
          (upstreamRes) => {
            const responseHeaders: Record<string, string | string[] | undefined> = {
              ...upstreamRes.headers,
              "access-control-allow-origin": "*",
            };
            res.writeHead(upstreamRes.statusCode ?? 500, responseHeaders);
            upstreamRes.pipe(res);
          },
        );

        upstreamReq.on("error", (err) => {
          const safeMsg = scrubCredentials(err.message, apiKey);
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message: `Factory Model Relay upstream connection error: ${safeMsg}`,
                  type: "upstream_error",
                },
              }),
            );
          }
        });

        if (rawBody.length > 0) {
          upstreamReq.write(rawBody);
        }
        upstreamReq.end();
      } catch (err) {
        const safeMsg = scrubCredentials(err instanceof Error ? err.message : String(err), apiKey);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: `Factory Model Relay internal error: ${safeMsg}`,
                type: "internal_error",
              },
            }),
          );
        }
      }
    });
  });

  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 0;

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  const assignedPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${assignedPort}`;

  return {
    port: assignedPort,
    host,
    baseUrl,
    allowedModel,
    tier,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
