import type http from "node:http";
import { z } from "zod";
import { FactoryError } from "../executor/errors.js";
import { ProjectIntakeStore } from "./intake-store.js";
import { FactoryStore } from "../persistence/store.js";

export interface OperatorApiDeps {
  readonly store: FactoryStore;
  readonly intake: ProjectIntakeStore;
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function errorResponse(res: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
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
        const project = await deps.store.createProject(input);
        return sendJson(res, 201, project);
      }

      if (req.method === "GET" && pathname === "/api/projects") {
        const projects = await deps.store.listProjects();
        return sendJson(res, 200, { projects });
      }

      if (req.method === "GET" && segments.length === 3 && segments[0] === "projects" && segments[2] === "workspace") {
        const ws = await deps.intake.getWorkspace(segments[1]!);
        if (!ws) return errorResponse(res, 404, "not_found", "Project not found.");
        return sendJson(res, 200, ws);
      }

      if (req.method === "PUT" && segments.length === 3 && segments[0] === "projects" && segments[2] === "intake-draft") {
        const parsed = parseJsonBody(body);
        const input = parseOr400(saveDraftSchema, parsed);
        const result = await deps.intake.saveDraft({ projectId: segments[1]!, ...input });
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "intake" && segments[3] === "accept") {
        const parsed = parseJsonBody(body);
        const input = parseOr400(acceptSchema, parsed);
        const result = await deps.intake.accept({ projectId: segments[1]!, ...input });
        return sendJson(res, 200, result);
      }

      if (req.method === "GET" && segments.length === 4 && segments[0] === "projects" && segments[2] === "intake" && segments[3] === "versions") {
        const versions = await deps.intake.listSnapshots(segments[1]!);
        return sendJson(res, 200, { versions });
      }

      if (req.method === "GET" && segments.length === 5 && segments[0] === "projects" && segments[2] === "intake" && segments[3] === "versions") {
        const version = Number.parseInt(segments[4]!, 10);
        if (!Number.isFinite(version) || version < 1) {
          return errorResponse(res, 400, "invalid_version", "Version must be a positive integer.");
        }
        const snapshot = await deps.intake.getSnapshot(segments[1]!, version);
        if (!snapshot) return errorResponse(res, 404, "not_found", "Snapshot not found.");
        return sendJson(res, 200, snapshot);
      }

      return errorResponse(res, 404, "not_found", "Unknown endpoint.");
    } catch (error) {
      if (error instanceof FactoryError) {
        return errorResponse(res, 422, error.code, error.message);
      }
      if (error instanceof z.ZodError) {
        return errorResponse(res, 400, "validation_error", error.issues.map((i) => i.message).join("; "));
      }
      const message = error instanceof Error ? error.message : "Internal server error";
      return errorResponse(res, 500, "internal_error", message);
    }
  };
}
