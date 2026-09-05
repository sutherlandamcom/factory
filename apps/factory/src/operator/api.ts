import type http from "node:http";
import { z } from "zod";
import {
  OPERATOR_ERROR_STATUS,
  OPERATOR_INTERNAL_ERROR_MESSAGE,
  type OperatorErrorCode,
} from "@factory/contracts";
import { FactoryError } from "../executor/errors.js";
import { ProjectIntakeStore } from "./intake-store.js";
import { FactoryStore } from "../persistence/store.js";
import { getProjectOperatorWorkspace } from "./workspace.js";
import type { SearchIntelligenceService } from "../search/service.js";

export interface OperatorApiDeps {
  readonly store: FactoryStore;
  readonly intake: ProjectIntakeStore;
  /** Search Intelligence v0; optional for backward-compatible construction. */
  readonly search?: SearchIntelligenceService;
}

const projectKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "key must be lowercase letters, digits and hyphens");

const createProjectSchema = z
  .object({
    key: projectKeySchema,
    name: z.string().trim().min(1).max(200),
  })
  .strict();

const saveDraftSchema = z
  .object({
    baseRevision: z.number().int().min(0),
    payload: z.unknown(),
  })
  .strict();

const acceptSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    expectedDigest: z.string().trim().min(1).max(128),
  })
  .strict();

const searchRunSchema = z
  .object({
    query: z.string().min(1).max(200),
    location: z.string().trim().max(200).optional(),
    language: z.string().trim().max(35).optional(),
    device: z.enum(["desktop", "mobile", "tablet"]).default("desktop"),
    refresh: z.boolean().default(false),
  })
  .strict();

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Single serialization point for the stable typed error contract:
 * `{ error: { code: OperatorErrorCode, message: string } }` with a fixed
 * HTTP status per code. No other response path may emit errors.
 */
function sendError(
  res: http.ServerResponse,
  code: OperatorErrorCode,
  message: string,
): void {
  sendJson(res, OPERATOR_ERROR_STATUS[code], { error: { code, message } });
}

function parseJsonBody(raw: string): unknown {
  if (!raw) {
    throw new FactoryError("invalid_json", "Request body is required and must be valid JSON.");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new FactoryError("invalid_json", "Request body must be valid JSON.");
  }
}

function parseOr400<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues.map((i) => i.message).join("; ");
    throw new FactoryError("validation_error", message);
  }
  return result.data;
}

/**
 * FactoryError codes that follow the stable operator error contract map
 * directly onto the contract's status table. Any other code is treated as
 * an unexpected internal fault and sanitized.
 */
const CONTRACT_ERROR_CODES = new Set<string>(Object.keys(OPERATOR_ERROR_STATUS));

export function createOperatorApi(deps: OperatorApiDeps) {
  return async function handleApiRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    body: string,
  ): Promise<void> {
    const segments = pathname.replace(/^\/api\//, "").split("/").filter(Boolean);

    try {
      if (req.method === "POST" && pathname === "/api/projects") {
        const parsed = parseJsonBody(body);
        const input = parseOr400(createProjectSchema, parsed);
        if (deps.store.getProjectByKey) {
          const existing = await deps.store.getProjectByKey(input.key);
          if (existing) {
            throw new FactoryError("validation_error", `Project key "${input.key}" already exists.`);
          }
        }
        const project = await deps.store.createProject(input);
        return sendJson(res, 201, project);
      }

      if (req.method === "GET" && pathname === "/api/projects") {
        const projects = await deps.store.listProjects();
        return sendJson(res, 200, { projects });
      }

      if (req.method === "GET" && segments.length === 3 && segments[0] === "projects" && segments[2] === "workspace") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        const ws = await getProjectOperatorWorkspace(deps.intake, {
          id: project.id,
          key: project.key,
          name: project.name,
        });
        if (!ws) return sendError(res, "not_found", "Project not found.");
        return sendJson(res, 200, ws);
      }

      if (req.method === "PUT" && segments.length === 3 && segments[0] === "projects" && segments[2] === "intake-draft") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(saveDraftSchema, parsed);
        const result = await deps.intake.saveDraft({ projectId: segments[1]!, ...input });
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "intake" && segments[3] === "accept") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(acceptSchema, parsed);
        const result = await deps.intake.accept({ projectId: segments[1]!, ...input });
        return sendJson(res, 200, result);
      }

      if (req.method === "GET" && segments.length === 4 && segments[0] === "projects" && segments[2] === "intake" && segments[3] === "versions") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        const versions = await deps.intake.listSnapshots(segments[1]!);
        return sendJson(res, 200, { versions });
      }

      if (req.method === "GET" && segments.length === 5 && segments[0] === "projects" && segments[2] === "intake" && segments[3] === "versions") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        const version = Number.parseInt(segments[4]!, 10);
        if (!Number.isFinite(version) || version < 1) {
          return sendError(res, "invalid_version", "Version must be a positive integer.");
        }
        const snapshot = await deps.intake.getSnapshot(segments[1]!, version);
        if (!snapshot) return sendError(res, "not_found", "Snapshot not found.");
        return sendJson(res, 200, snapshot);
      }

      if (req.method === "GET" && segments.length === 4 && segments[0] === "projects" && segments[2] === "search" && segments[3] === "workspace") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.search) return sendError(res, "not_found", "Search is not available.");
        const ws = await deps.search.workspace(project.id);
        return sendJson(res, 200, ws);
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "search" && segments[3] === "runs") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.search) return sendError(res, "not_found", "Search is not available.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(searchRunSchema, parsed);
        const result = await deps.search.runSearch({ projectId: project.id, ...input });
        return sendJson(res, 200, result);
      }

      if (req.method === "GET" && segments.length === 4 && segments[0] === "projects" && segments[2] === "search" && segments[3] === "runs") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.search) return sendError(res, "not_found", "Search is not available.");
        const ws = await deps.search.workspace(project.id);
        return sendJson(res, 200, { runs: ws.recentRuns });
      }

      if (req.method === "GET" && segments.length === 5 && segments[0] === "projects" && segments[2] === "search" && segments[3] === "runs") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.search) return sendError(res, "not_found", "Search is not available.");
        const detail = await deps.search.runDetail(project.id, segments[4]!);
        if (!detail) return sendError(res, "search_run_not_found", "Search run not found.");
        return sendJson(res, 200, detail);
      }

      return sendError(res, "not_found", "Unknown endpoint.");
    } catch (error) {
      if (error instanceof FactoryError && CONTRACT_ERROR_CODES.has(error.code)) {
        return sendError(res, error.code as OperatorErrorCode, error.message);
      }
      if (error instanceof z.ZodError) {
        return sendError(res, "validation_error", error.issues.map((i) => i.message).join("; "));
      }
      // Sanitized: unexpected internal failures never leak error.message
      // (stacks, driver text, DB URLs, provider secrets) to the client.
      return sendError(res, "internal_error", OPERATOR_INTERNAL_ERROR_MESSAGE);
    }
  };
}
