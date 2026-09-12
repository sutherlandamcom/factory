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
import type { CompetitorContentGapService } from "../competitors/service.js";
import type { WriterService } from "../writer/service.js";
import { activeModelOverrides } from "../models/policy.js";

export interface OperatorApiDeps {
  readonly store: FactoryStore;
  readonly intake: ProjectIntakeStore;
  /** Search Intelligence v0; optional for backward-compatible construction. */
  readonly search?: SearchIntelligenceService;
  /** Competitors + Content Gap v0; optional for backward compatibility. */
  readonly competitors?: CompetitorContentGapService;
  /** Writer pipeline v0 (Macro Run 4); optional for backward compatibility. */
  readonly writer?: WriterService;
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

const competitorRunSchema = z
  .object({
    serpSnapshotId: z.string().trim().min(1).max(128),
    maxPages: z.number().int().min(1).max(10).optional(),
  })
  .strict();

const classificationSchema = z
  .object({
    classification: z.enum(["INCLUDE", "EXCLUDE", "REFERENCE_ONLY"]),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const gapProposalSchema = z
  .object({
    competitorRunId: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const gapDecisionsSchema = z
  .object({
    expectedReviewRevision: z.number().int().min(0),
    decisions: z
      .array(
        z
          .object({
            gapId: z.string().trim().min(1).max(64),
            disposition: z.enum(["REQUIRED", "OPTIONAL", "EXCLUDE"]),
            priority: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
            note: z.string().trim().max(500).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();

const gapAcceptSchema = z
  .object({
    expectedReportDigest: z.string().trim().min(1).max(128).optional(),
    expectedDigest: z.string().trim().min(1).max(128).optional(),
    expectedReviewRevision: z.number().int().min(0),
    expectedDecisionsDigest: z.string().trim().min(1).max(128),
  })
  .strict()
  .refine((data) => Boolean(data.expectedReportDigest || data.expectedDigest), {
    message: "expectedReportDigest (or expectedDigest) is required",
  });

const writerPolicyApproveSchema = z
  .object({
    policyId: z.string().trim().min(1).max(128),
    expectedVersion: z.number().int().min(1),
    expectedDigest: z.string().trim().min(1).max(128),
  })
  .strict();

const writerBriefDraftSchema = z
  .object({
    pageTarget: z.unknown(),
    contentBriefKeyPoints: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
    expectedRevision: z.number().int().min(1).optional(),
  })
  .strict();

const writerBriefApproveSchema = z
  .object({
    briefId: z.string().trim().min(1).max(128),
    expectedVersion: z.number().int().min(1),
    expectedDigest: z.string().trim().min(1).max(128),
    noGapLineageAcknowledged: z.boolean().optional(),
  })
  .strict();

const writerSnapshotCompileSchema = z.object({}).strict();

const writerSnapshotApproveSchema = z
  .object({
    snapshotId: z.string().trim().min(1).max(128),
    expectedVersion: z.number().int().min(1),
    expectedDigest: z.string().trim().min(1).max(128),
  })
  .strict();

const writerGenerateSchema = z
  .object({
    snapshotId: z.string().trim().min(1).max(128),
  })
  .strict();

const writerAcceptSchema = z
  .object({
    proposalId: z.string().trim().min(1).max(128),
    expectedProposalDigest: z.string().trim().min(1).max(128),
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

      // ---- Competitors + Content Gap (Macro Run 3) --------------------------

      if (req.method === "GET" && segments.length === 4 && segments[0] === "projects" && segments[2] === "competitors" && segments[3] === "workspace") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.competitors) return sendError(res, "not_found", "Competitors are not available.");
        return sendJson(res, 200, await deps.competitors.workspace(project.id));
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "competitors" && segments[3] === "runs") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.competitors) return sendError(res, "not_found", "Competitors are not available.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(competitorRunSchema, parsed);
        const result = await deps.competitors.runCompetitors({ projectId: project.id, ...input });
        return sendJson(res, 200, result);
      }

      if (req.method === "GET" && segments.length === 5 && segments[0] === "projects" && segments[2] === "competitors" && segments[3] === "runs") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.competitors) return sendError(res, "not_found", "Competitors are not available.");
        const detail = await deps.competitors.runReadModel(project.id, segments[4]!);
        return sendJson(res, 200, detail);
      }

      if (req.method === "PATCH" && segments.length === 6 && segments[0] === "projects" && segments[2] === "competitors" && segments[3] === "candidates" && segments[5] === "classification") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.competitors) return sendError(res, "not_found", "Competitors are not available.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(classificationSchema, parsed);
        await deps.competitors.setClassification({
          projectId: project.id,
          pageSnapshotId: segments[4]!,
          classification: input.classification,
          reason: input.reason,
        });
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "GET" && segments.length === 4 && segments[0] === "projects" && segments[2] === "content-gaps" && segments[3] === "workspace") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.competitors) return sendError(res, "not_found", "Content gaps are not available.");
        return sendJson(res, 200, await deps.competitors.gapWorkspace(project.id));
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "content-gaps" && segments[3] === "proposals") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.competitors) return sendError(res, "not_found", "Content gaps are not available.");
        const parsed = body.trim() ? parseJsonBody(body) : {};
        const input = parseOr400(gapProposalSchema, parsed);
        const result = await deps.competitors.proposeGaps({ projectId: project.id, competitorRunId: input.competitorRunId });
        return sendJson(res, 200, result);
      }

      if (req.method === "GET" && segments.length === 5 && segments[0] === "projects" && segments[2] === "content-gaps" && segments[3] === "reports") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.competitors) return sendError(res, "not_found", "Content gaps are not available.");
        const detail = await deps.competitors.getGapReportDetail(project.id, segments[4]!);
        return sendJson(res, 200, detail);
      }

      if (req.method === "PUT" && segments.length === 6 && segments[0] === "projects" && segments[2] === "content-gaps" && segments[3] === "reports" && segments[5] === "decisions") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.competitors) return sendError(res, "not_found", "Content gaps are not available.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(gapDecisionsSchema, parsed);
        const result = await deps.competitors.saveGapDecisions({
          projectId: project.id,
          reportId: segments[4]!,
          expectedReviewRevision: input.expectedReviewRevision,
          decisions: input.decisions,
        });
        return sendJson(res, 200, { ok: true, reviewRevision: result.reviewRevision, decisionsDigest: result.decisionsDigest });
      }

      if (req.method === "POST" && segments.length === 6 && segments[0] === "projects" && segments[2] === "content-gaps" && segments[3] === "reports" && segments[5] === "accept") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.competitors) return sendError(res, "not_found", "Content gaps are not available.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(gapAcceptSchema, parsed);
        const result = await deps.competitors.acceptGapReport({
          projectId: project.id,
          reportId: segments[4]!,
          expectedReportDigest: input.expectedReportDigest ?? input.expectedDigest,
          expectedReviewRevision: input.expectedReviewRevision,
          expectedDecisionsDigest: input.expectedDecisionsDigest,
        });
        return sendJson(res, 200, result);
      }

      if (req.method === "GET" && segments.length === 6 && segments[0] === "projects" && segments[2] === "content-gaps" && segments[3] === "accepted" && segments[5] === "detail") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.competitors) return sendError(res, "not_found", "Content gaps are not available.");
        const version = Number.parseInt(segments[4]!, 10);
        if (!Number.isFinite(version) || version < 1) {
          return sendError(res, "invalid_version", "Version must be a positive integer.");
        }
        const detail = await deps.competitors.acceptedGapDetail(project.id, version);
        return sendJson(res, 200, detail);
      }

      // ---- Writer pipeline (Macro Run 4) ------------------------------------

      if (req.method === "GET" && segments.length === 4 && segments[0] === "projects" && segments[2] === "writer" && segments[3] === "workspace") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.writer) return sendError(res, "not_found", "Writer is not available.");
        const [policy, brief, snapshot, proposal, accepted] = await Promise.all([
          deps.writer.writerPolicyWorkspace(project.id),
          deps.writer.briefWorkspace(project.id),
          deps.writer.snapshotWorkspace(project.id),
          deps.writer.proposalWorkspace(project.id),
          deps.writer.acceptedContentWorkspace(project.id),
        ]);
        // Dev-time model override banner: surfaced in human terms whenever an
        // override affects the current run (from the Phase 0 seam).
        const overrides = activeModelOverrides(process.env);
        return sendJson(res, 200, {
          policy,
          brief,
          snapshot,
          proposal,
          accepted,
          devModelOverride:
            overrides.length > 0
              ? {
                  active: true,
                  roles: overrides.map((o) => ({
                    roleId: o.roleId,
                    model: o.model,
                    championModel: o.championModel,
                  })),
                }
              : { active: false, roles: [] },
        });
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "writer" && segments[3] === "policy-draft") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.writer) return sendError(res, "not_found", "Writer is not available.");
        if (body.trim()) parseJsonBody(body);
        const policy = await deps.writer.deriveWriterPolicyDraft(project.id);
        return sendJson(res, 201, policy);
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "writer" && segments[3] === "policy-approve") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.writer) return sendError(res, "not_found", "Writer is not available.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(writerPolicyApproveSchema, parsed);
        const result = await deps.writer.approveWriterPolicy({ projectId: project.id, ...input });
        return sendJson(res, 200, result);
      }

      if (req.method === "PUT" && segments.length === 4 && segments[0] === "projects" && segments[2] === "writer" && segments[3] === "brief-draft") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.writer) return sendError(res, "not_found", "Writer is not available.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(writerBriefDraftSchema, parsed);
        const result = await deps.writer.saveBriefDraft({ projectId: project.id, ...input });
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "writer" && segments[3] === "brief-approve") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.writer) return sendError(res, "not_found", "Writer is not available.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(writerBriefApproveSchema, parsed);
        const result = await deps.writer.approveBrief({ projectId: project.id, ...input });
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "writer" && segments[3] === "snapshot-compile") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.writer) return sendError(res, "not_found", "Writer is not available.");
        if (body.trim()) parseJsonBody(body);
        const snapshot = await deps.writer.compileSnapshot({ projectId: project.id });
        return sendJson(res, 201, snapshot);
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "writer" && segments[3] === "snapshot-approve") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.writer) return sendError(res, "not_found", "Writer is not available.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(writerSnapshotApproveSchema, parsed);
        const result = await deps.writer.approveSnapshot({ projectId: project.id, ...input });
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "writer" && segments[3] === "generate") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.writer) return sendError(res, "not_found", "Writer is not available.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(writerGenerateSchema, parsed);
        const proposal = await deps.writer.generateProposal({ projectId: project.id, snapshotId: input.snapshotId });
        return sendJson(res, 201, proposal);
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "writer" && segments[3] === "qa") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.writer) return sendError(res, "not_found", "Writer is not available.");
        if (body.trim()) parseJsonBody(body);
        const qa = await deps.writer.runQa({ projectId: project.id });
        return sendJson(res, 200, qa);
      }

      if (req.method === "POST" && segments.length === 4 && segments[0] === "projects" && segments[2] === "writer" && segments[3] === "accept") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.writer) return sendError(res, "not_found", "Writer is not available.");
        const parsed = parseJsonBody(body);
        const input = parseOr400(writerAcceptSchema, parsed);
        const accepted = await deps.writer.acceptContent({ projectId: project.id, ...input });
        return sendJson(res, 201, accepted);
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
