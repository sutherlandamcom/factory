import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import path from "node:path";
import { URL } from "node:url";
import { FactoryError } from "./errors.js";
import { scrubCredentials } from "../models/gateway.js";
import { CODE_WORKER_POLICY } from "../models/policy.js";
import { dockerClientEnv } from "./isolation.js";
import {
  FACTORY_WORKER_NETWORK,
  FACTORY_RELAY_EGRESS_NETWORK,
  PINNED_NODE_IMAGE,
} from "./network.js";
import { runProcess } from "./process.js";

/**
 * Maximum output tokens the Factory model relay permits a code worker to request.
 * Caps runaway token consumption on OpenRouter.
 */
export const MAX_CODE_WORKER_OUTPUT_TOKENS = 16_000;

/**
 * Enforces the Factory relay token ceiling on incoming request bodies.
 */
export function applyTokenCeiling(parsedBody: unknown): unknown {
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return parsedBody;
  }
  const body = { ...(parsedBody as Record<string, unknown>) };
  if (typeof body.max_tokens === "number") {
    body.max_tokens = Math.min(body.max_tokens, MAX_CODE_WORKER_OUTPUT_TOKENS);
  } else if (typeof body.max_completion_tokens === "number") {
    body.max_completion_tokens = Math.min(body.max_completion_tokens, MAX_CODE_WORKER_OUTPUT_TOKENS);
  } else {
    body.max_tokens = MAX_CODE_WORKER_OUTPUT_TOKENS;
  }
  return body;
}

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
 * 5. Any request for an alternate or unpinned model is immediately rejected with HTTP 403
 *    and results in 0 upstream calls to OpenRouter.
 * 6. Each run generates a cryptographically random local relay token; missing or invalid
 *    tokens are rejected with HTTP 401/403.
 * 7. Path mapping is explicit: only required endpoints (/chat/completions, /v1/messages, /health)
 *    are routed. All unmapped paths return HTTP 404.
 */

export interface ModelRelayOptions {
  tier: "primary" | "senior";
  apiKey: string;
  repoRoot?: string;
  containerName?: string;
  upstreamBaseUrl?: string;
  relayToken?: string;
  inProcess?: boolean;
  port?: number;
  host?: string;
}

export interface ModelRelayServer {
  port: number;
  host: string;
  baseUrl: string;
  allowedModel: string;
  tier: "primary" | "senior";
  relayToken: string;
  close: () => Promise<void>;
}

export const DEFAULT_OPENROUTER_UPSTREAM = "https://openrouter.ai/api/v1";

/** Generates a cryptographically random local relay auth token per run. */
export function generateRelayToken(): string {
  return `factory-relay-${randomBytes(24).toString("hex")}`;
}

export type PathValidationResult =
  | { valid: true; type: "health" }
  | { valid: true; type: "chat_completions"; targetPath: string }
  | { valid: true; type: "messages"; targetPath: string }
  | { valid: false; error: string };

/**
 * Validates and explicitly maps incoming request paths per tier.
 * Unmapped endpoints are rejected (never generic proxying).
 */
export function validateRelayPath(
  method: string | undefined,
  urlPath: string,
  tier: "primary" | "senior",
): PathValidationResult {
  const normPath = urlPath.split("?")[0] || "/";
  if (normPath === "/health" || normPath === "/") {
    return { valid: true, type: "health" };
  }

  if (tier === "primary") {
    // OpenAI / Kimi format: POST /chat/completions or POST /v1/chat/completions or /api/v1/chat/completions
    if (
      method === "POST" &&
      (normPath === "/chat/completions" ||
        normPath === "/v1/chat/completions" ||
        normPath === "/api/v1/chat/completions")
    ) {
      return { valid: true, type: "chat_completions", targetPath: "/chat/completions" };
    }
    return {
      valid: false,
      error: `Unmapped endpoint '${normPath}' for primary worker tier (only /chat/completions allowed)`,
    };
  }

  if (tier === "senior") {
    // Anthropic / Claude format: POST /messages or POST /v1/messages or POST /api/v1/messages
    if (
      method === "POST" &&
      (normPath === "/messages" ||
        normPath === "/v1/messages" ||
        normPath === "/api/v1/messages")
    ) {
      return { valid: true, type: "messages", targetPath: "/messages" };
    }
    return {
      valid: false,
      error: `Unmapped endpoint '${normPath}' for senior worker tier (only /v1/messages allowed)`,
    };
  }

  return { valid: false, error: `Unknown tier '${tier}'` };
}

/**
 * Validates incoming Authorization header against the expected per-run random relay token.
 */
export function validateRelayAuth(
  authHeader: string | undefined,
  expectedToken: string,
): { valid: boolean; code?: number; error?: string } {
  if (!authHeader || authHeader.trim() === "") {
    return { valid: false, code: 401, error: "Missing Authorization header" };
  }
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (token !== expectedToken) {
    return { valid: false, code: 403, error: "Invalid relay authorization token" };
  }
  return { valid: true };
}

/**
 * Validates that the request body matches the authorized model for the relay tier.
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
 * Creates the HTTP request handler for the Factory Model Relay.
 */
export function createRelayRequestHandler(params: {
  tier: "primary" | "senior";
  allowedModel: string;
  apiKey: string;
  relayToken: string;
  upstreamBaseUrl: string;
  onForward?: (req: { path: string; model: string; headers: Record<string, string> }) => void;
}): (req: IncomingMessage, res: ServerResponse) => void {
  const { tier, allowedModel, apiKey, relayToken, upstreamBaseUrl, onForward } = params;

  return (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathCheck = validateRelayPath(req.method, req.url ?? "/", tier);
    if (!pathCheck.valid) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `Factory Model Relay: ${pathCheck.error}`,
            type: "invalid_request_error",
            code: "not_found",
          },
        }),
      );
      return;
    }

    // Health check endpoint (no auth required)
    if (pathCheck.type === "health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", tier, allowedModel }));
      return;
    }

    // Collect body
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      // Validate Authorization header
      const authCheck = validateRelayAuth(req.headers.authorization, relayToken);
      if (!authCheck.valid) {
        res.writeHead(authCheck.code ?? 401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `Factory Model Relay: ${authCheck.error}`,
              type: "authentication_error",
              code: authCheck.code === 403 ? "forbidden" : "unauthorized",
            },
          }),
        );
        return;
      }

      const rawBody = Buffer.concat(chunks).toString("utf8");
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

      const cappedBody = applyTokenCeiling(parsedBody);
      const serializedBody = Buffer.from(JSON.stringify(cappedBody), "utf8");

      // Build upstream target URL
      const cleanBase = upstreamBaseUrl.replace(/\/+$/, "");
      const targetUrl = new URL(
        pathCheck.targetPath.replace(/^\//, ""),
        cleanBase.endsWith("/api/v1") || cleanBase.endsWith("/v1")
          ? cleanBase + "/"
          : cleanBase + "/api/v1/",
      );

      const upstreamHeaders: Record<string, string> = {
        "content-type": "application/json",
        "content-length": String(serializedBody.length),
        authorization: `Bearer ${apiKey}`,
        "user-agent": "Factory-Model-Relay/0.1",
      };

      if (req.headers["anthropic-version"]) {
        upstreamHeaders["anthropic-version"] = String(req.headers["anthropic-version"]);
      }

      if (onForward) {
        onForward({
          path: targetUrl.pathname,
          model: modelCheck.requestedModel!,
          headers: upstreamHeaders,
        });
      }

      const transport = targetUrl.protocol === "https:" ? https : http;
      try {
        const upstreamReq = transport.request(
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

        if (serializedBody.length > 0) {
          upstreamReq.write(serializedBody);
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
  };
}

/**
 * Builds standalone JavaScript code for running the relay inside a Docker container sidecar.
 */
export function buildRelayContainerScript(config: {
  tier: "primary" | "senior";
  allowedModel: string;
  apiKey: string;
  relayToken: string;
  upstreamBaseUrl: string;
  port: number;
}): string {
  return `// Factory Model Relay Sidecar
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const config = ${JSON.stringify(config)};
const MAX_CODE_WORKER_OUTPUT_TOKENS = 16000;

function applyTokenCeiling(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const copy = Object.assign({}, body);
  if (typeof copy.max_tokens === 'number') {
    copy.max_tokens = Math.min(copy.max_tokens, MAX_CODE_WORKER_OUTPUT_TOKENS);
  } else if (typeof copy.max_completion_tokens === 'number') {
    copy.max_completion_tokens = Math.min(copy.max_completion_tokens, MAX_CODE_WORKER_OUTPUT_TOKENS);
  } else {
    copy.max_tokens = MAX_CODE_WORKER_OUTPUT_TOKENS;
  }
  return copy;
}

function validateRelayPath(method, urlPath, tier) {
  const normPath = (urlPath || '/').split('?')[0];
  if (normPath === '/health' || normPath === '/') return { valid: true, type: 'health' };
  if (tier === 'primary') {
    if (method === 'POST' && (normPath === '/chat/completions' || normPath === '/v1/chat/completions' || normPath === '/api/v1/chat/completions')) {
      return { valid: true, type: 'chat_completions', targetPath: '/chat/completions' };
    }
    return { valid: false, error: 'Unmapped endpoint for primary tier' };
  }
  if (tier === 'senior') {
    if (method === 'POST' && (normPath === '/messages' || normPath === '/v1/messages' || normPath === '/api/v1/messages')) {
      return { valid: true, type: 'messages', targetPath: '/messages' };
    }
    return { valid: false, error: 'Unmapped endpoint for senior tier' };
  }
  return { valid: false, error: 'Unknown tier' };
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const pathCheck = validateRelayPath(req.method, req.url || '/', config.tier);
  if (!pathCheck.valid) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: pathCheck.error, code: 'not_found' } }));
    return;
  }
  if (pathCheck.type === 'health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', tier: config.tier, allowedModel: config.allowedModel }));
    return;
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\\s+/i, '').trim();
    if (!token || token !== config.relayToken) {
      res.writeHead(token ? 403 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized relay token', code: 'unauthorized' } }));
      return;
    }

    const rawBody = Buffer.concat(chunks).toString('utf8');
    let parsedBody;
    try { parsedBody = JSON.parse(rawBody); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON body', code: 'invalid_json' } }));
      return;
    }

    if (!parsedBody || parsedBody.model !== config.allowedModel) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized model', code: 'unauthorized_model', allowedModel: config.allowedModel } }));
      return;
    }

    const cappedBody = applyTokenCeiling(parsedBody);
    const serializedBody = Buffer.from(JSON.stringify(cappedBody));

    const cleanBase = config.upstreamBaseUrl.replace(/\\/+$/, '');
    const targetUrl = new URL(
      pathCheck.targetPath.replace(/^\\//, ''),
      (cleanBase.endsWith('/api/v1') || cleanBase.endsWith('/v1')) ? cleanBase + '/' : cleanBase + '/api/v1/'
    );

    const upstreamHeaders = {
      'content-type': 'application/json',
      'content-length': String(serializedBody.length),
      authorization: 'Bearer ' + config.apiKey,
      'user-agent': 'Factory-Model-Relay/0.1'
    };
    if (req.headers['anthropic-version']) {
      upstreamHeaders['anthropic-version'] = req.headers['anthropic-version'];
    }

    const transport = targetUrl.protocol === 'https:' ? https : http;
    const upstreamReq = transport.request(targetUrl, { method: req.method, headers: upstreamHeaders }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 500, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', err => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream connection error', code: 'upstream_error' } }));
      }
    });
    if (serializedBody.length > 0) upstreamReq.write(serializedBody);
    upstreamReq.end();
  });
});

server.listen(config.port, '0.0.0.0', () => {
  console.log('RELAY_READY on port ' + config.port);
});
`;
}

/**
 * Starts the Factory Model Relay:
 * - If running with Docker/repoRoot: starts an ephemeral sidecar container attached to `FACTORY_WORKER_NETWORK`
 *   with alias `factory-model-relay` or `factory-relay-${containerName}`, dual-homed to `FACTORY_RELAY_EGRESS_NETWORK`.
 * - If running in unit test / inProcess mode: starts an in-process Node http.Server.
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

  const relayToken = options.relayToken ?? generateRelayToken();
  const upstreamBaseUrl = options.upstreamBaseUrl ?? DEFAULT_OPENROUTER_UPSTREAM;

  // In-process server mode (for unit tests / mock mode)
  if (options.inProcess || !options.repoRoot || !options.containerName) {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 0;

    const handler = createRelayRequestHandler({
      tier,
      allowedModel,
      apiKey,
      relayToken,
      upstreamBaseUrl,
    });

    const server = http.createServer(handler);

    await new Promise<void>((resolve, reject) => {
      server.listen(port, host, () => resolve());
      server.on("error", reject);
    });

    const address = server.address();
    const assignedPort = typeof address === "object" && address ? address.port : port;
    const baseUrl = `http://${host}:${assignedPort}`;

    return {
      port: assignedPort,
      host,
      baseUrl,
      allowedModel,
      tier,
      relayToken,
      close: async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      },
    };
  }

  // Container sidecar mode: dual-homed to worker network + relay egress network
  const repoRoot = options.repoRoot;
  const relayContainerName = `factory-relay-${options.containerName}`;
  const relayPort = 8080;
  const scriptContent = buildRelayContainerScript({
    tier,
    allowedModel,
    apiKey,
    relayToken,
    upstreamBaseUrl,
    port: relayPort,
  });

  const dockerArgs = [
    "run",
    "-d",
    "--name",
    relayContainerName,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=64",
    "--memory=256m",
    "--cpus=1",
    "--user",
    "65534:65534",
    "--network",
    FACTORY_WORKER_NETWORK,
    "--network-alias",
    "factory-model-relay",
    "--network-alias",
    relayContainerName,
    PINNED_NODE_IMAGE,
    "node",
    "-e",
    scriptContent,
  ];

  try {
    const launchResult = await runProcess("docker", dockerArgs, {
      cwd: repoRoot,
      env: dockerClientEnv(repoRoot),
      timeoutMs: 30_000,
    });

    if (launchResult.exitCode !== 0) {
      throw new FactoryError(
        "strong_execution_isolation_unavailable",
        `Failed to launch Factory model relay sidecar: ${launchResult.stderr.trim() || `exit ${launchResult.exitCode}`}`,
      );
    }

    // Connect relay container to the dedicated relay egress network (dual-homed)
    const connectEgress = await runProcess(
      "docker",
      ["network", "connect", FACTORY_RELAY_EGRESS_NETWORK, relayContainerName],
      {
        cwd: repoRoot,
        env: dockerClientEnv(repoRoot),
        timeoutMs: 15_000,
      },
    );
    if (connectEgress.exitCode !== 0) {
      throw new FactoryError(
        "strong_execution_isolation_unavailable",
        `Failed to attach Factory model relay to egress network: ${connectEgress.stderr.trim() || `exit ${connectEgress.exitCode}`}`,
      );
    }

    // Wait for sidecar to become ready from the worker network
    const probeArgs = [
      "run",
      "--rm",
      "--network",
      FACTORY_WORKER_NETWORK,
      PINNED_NODE_IMAGE,
      "node",
      "-e",
      `fetch('http://${relayContainerName}:${relayPort}/health', { signal: AbortSignal.timeout(10000) })
        .then(r => r.json())
        .then(j => { if (j.status === 'ok') process.exit(0); else process.exit(1); })
        .catch(() => process.exit(1))`,
    ];

    let ready = false;
    for (let i = 0; i < 15; i++) {
      const probe = await runProcess("docker", probeArgs, {
        cwd: repoRoot,
        env: dockerClientEnv(repoRoot),
        timeoutMs: 15_000,
      }).catch(() => ({ exitCode: 1 }));
      if (probe.exitCode === 0) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!ready) {
      throw new FactoryError(
        "strong_execution_isolation_unavailable",
        "Factory model relay sidecar failed health check inside the worker network (fail closed)",
      );
    }

    const baseUrl = `http://${relayContainerName}:${relayPort}`;

    return {
      port: relayPort,
      host: relayContainerName,
      baseUrl,
      allowedModel,
      tier,
      relayToken,
      close: async () => {
        await runProcess("docker", ["rm", "--force", relayContainerName], {
          cwd: repoRoot,
          env: dockerClientEnv(repoRoot),
          timeoutMs: 15_000,
        }).catch(() => undefined);
      },
    };
  } catch (error) {
    await runProcess("docker", ["rm", "--force", relayContainerName], {
      cwd: repoRoot,
      env: dockerClientEnv(repoRoot),
      timeoutMs: 15_000,
    }).catch(() => undefined);
    throw error;
  }
}
