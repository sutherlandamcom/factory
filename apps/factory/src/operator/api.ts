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
import type { AssetService } from "../assets/service.js";
import type { DesignService } from "../design/service.js";
import { activeModelOverrides } from "../models/policy.js";
import {
  assetApprovalSchema,
  assetAssignSchema,
  assetReplaceSchema,
  assetSettingsSchema,
  assetUploadSchema,
  assetVersionMetadataSchema,
  visualTruthClassSchema,
} from "@factory/contracts";
import type { VisualService } from "../visual/service.js";

export interface OperatorApiDeps {
  readonly store: FactoryStore;
  readonly intake: ProjectIntakeStore;
  /** Search Intelligence v0; optional for backward-compatible construction. */
  readonly search?: SearchIntelligenceService;
  /** Competitors + Content Gap v0; optional for backward compatibility. */
  readonly competitors?: CompetitorContentGapService;
  /** Writer pipeline v0 (Macro Run 4); optional for backward compatibility. */
  readonly writer?: WriterService;
  /** Assets v0 (Macro Run 5); optional for backward-compatible construction. */
  readonly assets?: AssetService;
  /** Design pipeline v0 (Macro Run 6); optional for backward compatibility. */
  readonly design?: DesignService;
  /** Visual asset pipeline v0 (Macro Run 7); optional for backward compatibility. */
  readonly visual?: VisualService;
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
    noGapLineageAcknowledged: z.boolean().optional(),
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

const designCandidateActionSchema = z
  .object({
    candidateId: z.string().trim().min(1).max(128),
    expectedCandidateDigest: z.string().trim().regex(/^[0-9a-f]{64}$/),
    reviewNotes: z.string().trim().max(2000).optional(),
  })
  .strict();

const visualClassificationBodySchema = z
  .object({
    truthClass: visualTruthClassSchema,
    acknowledged: z.literal(true),
  })
  .strict();

const visualPromptCompileSchema = z
  .object({
    operation: z.enum(["edit", "generate"]),
    sourceVersionId: z.string().trim().regex(/^asv-[0-9a-f-]{36}$/).optional(),
  })
  .strict();

const visualPromptApproveSchema = z
  .object({
    promptDigest: z.string().trim().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const visualGenerateSchema = z
  .object({
    sourceVersionId: z.string().trim().regex(/^asv-[0-9a-f-]{36}$/).optional(),
    escalationReason: z
      .enum(["composition_complexity", "brand_consistency", "text_rendering", "reference_composition", "quality_floor_failure"])
      .optional(),
  })
  .strict();

const visualReuseSchema = z
  .object({
    versionId: z.string().trim().regex(/^asv-[0-9a-f-]{36}$/).optional(),
  })
  .strict();

const visualTransformSchema = z
  .object({
    sourceVersionId: z.string().trim().regex(/^asv-[0-9a-f-]{36}$/),
    maxWidth: z.number().int().min(1).max(8000).optional(),
    aspectRatioCrop: z.enum(["16:9", "3:2", "4:3", "1:1"]).optional(),
    grayscale: z.boolean().optional(),
    brightness: z.number().min(0.5).max(1.5).optional(),
  })
  .strict();

const visualAcceptCandidateSchema = z
  .object({
    candidateId: z.string().trim().min(1).max(128),
    expectedBinaryDigest: z.string().trim().regex(/^[0-9a-f]{64}$/),
    confirmTruthDowngrade: z.boolean().optional(),
  })
  .strict();

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Serve exact asset bytes (GET only; immutable content-addressed objects). */
function sendBytes(res: http.ServerResponse, mediaType: string, bytes: Uint8Array): void {
  res.writeHead(200, {
    "Content-Type": mediaType,
    "Content-Length": String(bytes.byteLength),
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(Buffer.from(bytes));
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

      // ---- Assets (Macro Run 5) ----------------------------------------------

      if (segments.length >= 4 && segments[0] === "projects" && segments[2] === "assets") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.assets) return sendError(res, "not_found", "Assets are not available.");
        const assets = deps.assets;

        // GET workspace: full read model (assets, versions, assignments, strategy).
        if (req.method === "GET" && segments.length === 4 && segments[3] === "workspace") {
          return sendJson(res, 200, await assets.workspace(project.id));
        }

        // POST upload: raised-cap JSON body; full server-side byte validation.
        if (req.method === "POST" && segments.length === 4 && segments[3] === "uploads") {
          const parsed = parseJsonBody(body);
          const input = parseOr400(assetUploadSchema, parsed);
          const result = await assets.uploadAsset(project.id, input);
          return sendJson(res, 201, {
            assetId: result.asset.id,
            versionId: result.version.id,
            version: result.version.version,
            binaryDigest: result.version.binaryDigest,
            mediaType: result.version.mediaType,
            byteSize: result.version.byteSize,
            width: result.version.width,
            height: result.version.height,
            derivatives: result.derivatives.map((d) => ({ id: d.id, kind: d.kind, width: d.width, height: d.height })),
          });
        }

        // PUT settings: imagery strategy.
        if (req.method === "PUT" && segments.length === 4 && segments[3] === "settings") {
          const parsed = parseJsonBody(body);
          const input = parseOr400(assetSettingsSchema, parsed);
          const strategy = await assets.setImageryStrategy(project.id, input.imageryStrategy);
          return sendJson(res, 200, { imageryStrategy: strategy });
        }

        // GET original bytes: /projects/:id/assets/versions/:versionId/original
        if (req.method === "GET" && segments.length === 6 && segments[3] === "versions" && segments[5] === "original") {
          const bytes = await assets.readOriginal(project.id, segments[4]!);
          return sendBytes(res, bytes.mediaType, bytes.bytes);
        }

        // PUT metadata: /projects/:id/assets/versions/:versionId/metadata
        if (req.method === "PUT" && segments.length === 6 && segments[3] === "versions" && segments[5] === "metadata") {
          const parsed = parseJsonBody(body);
          const input = parseOr400(assetVersionMetadataSchema, parsed);
          const version = await assets.updateVersionMetadata(project.id, segments[4]!, input);
          return sendJson(res, 200, { id: version.id, rightsStatus: version.rightsStatus, altIntent: version.altIntent });
        }

        // POST approve/reject: /projects/:id/assets/versions/:versionId/{approve,reject}
        if (req.method === "POST" && segments.length === 6 && segments[3] === "versions" && (segments[5] === "approve" || segments[5] === "reject")) {
          const parsed = parseJsonBody(body);
          const input = parseOr400(assetApprovalSchema, parsed);
          const version =
            segments[5] === "approve"
              ? await assets.approveVersion(project.id, segments[4]!, input.expectedBinaryDigest)
              : await assets.rejectVersion(project.id, segments[4]!, input.expectedBinaryDigest);
          return sendJson(res, 200, {
            id: version.id,
            approvalState: version.approvalState,
            binaryDigest: version.binaryDigest,
            governanceDigest: version.governanceDigest,
          });
        }

        // GET derivative bytes: /projects/:id/assets/derivatives/:derivativeId
        if (req.method === "GET" && segments.length === 5 && segments[3] === "derivatives") {
          const bytes = await assets.readDerivative(project.id, segments[4]!);
          return sendBytes(res, bytes.mediaType, bytes.bytes);
        }

        // POST assignment: /projects/:id/assets/assignments
        if (req.method === "POST" && segments.length === 4 && segments[3] === "assignments") {
          const parsed = parseJsonBody(body);
          const input = parseOr400(assetAssignSchema, parsed);
          const assignment = await assets.assignVersion(project.id, input);
          return sendJson(res, 201, {
            id: assignment.id,
            assetId: assignment.assetId,
            versionId: assignment.versionId,
            pageSlug: assignment.pageSlug,
            role: assignment.role,
            binaryDigest: assignment.binaryDigest,
          });
        }

        // POST explicit replacement: /projects/:id/assets/assignments/:assignmentId/replace
        if (req.method === "POST" && segments.length === 6 && segments[3] === "assignments" && segments[5] === "replace") {
          const parsed = parseJsonBody(body);
          const input = parseOr400(assetReplaceSchema, parsed);
          const assignment = await assets.replaceAssignment(project.id, segments[4]!, input);
          return sendJson(res, 200, {
            id: assignment.id,
            versionId: assignment.versionId,
            binaryDigest: assignment.binaryDigest,
          });
        }

        return sendError(res, "not_found", "Unknown endpoint.");
      }

      if (req.method === "GET" && segments.length === 5 && segments[0] === "projects" && segments[2] === "writer" && segments[3] === "accepted") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.writer) return sendError(res, "not_found", "Writer is not available.");
        return sendJson(res, 200, await deps.writer.acceptedContentDetail(project.id, segments[4]!));
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

      // ---- Design pipeline (Macro Run 6) ------------------------------------

      if (segments.length >= 4 && segments[0] === "projects" && segments[2] === "design") {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        if (!deps.design) return sendError(res, "not_found", "Design is not available.");
        const design = deps.design;

        // GET workspace: full read model (provider preflight, snapshots,
        // candidates, accepted design + staleness).
        if (req.method === "GET" && segments.length === 4 && segments[3] === "workspace") {
          return sendJson(res, 200, await design.workspace(project.id));
        }

        // POST input-snapshot: derive the authority-bound design input snapshot.
        if (req.method === "POST" && segments.length === 4 && segments[3] === "input-snapshot") {
          if (body.trim()) parseJsonBody(body);
          const view = await design.deriveInputSnapshotDraft(project.id);
          return sendJson(res, 201, {
            id: view.id,
            version: view.version,
            inputDigest: view.inputDigest,
            stale: view.stale,
            staleReason: view.staleReason,
          });
        }

        // POST generate: run the governed provider generation from the LATEST
        // input snapshot (trusted preflight runs server-side first).
        if (req.method === "POST" && segments.length === 4 && segments[3] === "generate") {
          if (body.trim()) parseJsonBody(body);
          const view = await design.generateCandidate({ projectId: project.id });
          return sendJson(res, 201, {
            id: view.id,
            candidateDigest: view.candidateDigest,
            provider: view.provider,
            providerProjectName: view.providerProjectName,
            approvalState: view.approvalState,
            screens: view.data.screens.map((s) => ({ id: s.id, title: s.title, deviceType: s.deviceType })),
          });
        }

        // POST accept/reject: /projects/:id/design/candidates/:candidateId/{accept,reject}
        if (
          req.method === "POST" &&
          segments.length === 6 &&
          segments[3] === "candidates" &&
          (segments[5] === "accept" || segments[5] === "reject")
        ) {
          const parsed = parseJsonBody(body);
          const input = parseOr400(designCandidateActionSchema, parsed);
          if (input.candidateId !== segments[4]!) {
            return sendError(res, "validation_error", "candidateId must match the URL path candidate.");
          }
          if (segments[5] === "accept") {
            const accepted = await design.acceptCandidate({
              projectId: project.id,
              candidateId: segments[4]!,
              expectedCandidateDigest: input.expectedCandidateDigest,
              reviewNotes: input.reviewNotes ?? null,
            });
            return sendJson(res, 200, {
              id: accepted.id,
              version: accepted.version,
              candidateDigest: accepted.candidateDigest,
              inputDigest: accepted.inputDigest,
              designMdDigest: accepted.designMdDigest,
              acceptedAt: accepted.acceptedAt,
            });
          }
          const rejected = await design.rejectCandidate({
            projectId: project.id,
            candidateId: segments[4]!,
            expectedCandidateDigest: input.expectedCandidateDigest,
            reviewNotes: input.reviewNotes ?? null,
          });
          return sendJson(res, 200, {
            id: rejected.id,
            approvalState: rejected.approvalState,
            reviewNotes: rejected.reviewNotes,
          });
        }

        // GET artifact bytes: /projects/:id/design/artifacts/:digest
        // Provider HTML is UNTRUSTED external content: served with a
        // script-free, form-free, self-framed-only CSP + nosniff. The
        // Dashboard renders it ONLY inside a sandboxed iframe (fail closed).
        if (req.method === "GET" && segments.length === 5 && segments[3] === "artifacts") {
          const digest = segments[4]!;
          if (!/^[0-9a-f]{64}$/.test(digest)) {
            return sendError(res, "validation_error", "Artifact digest must be a lowercase SHA-256 hex digest.");
          }
          const artifact = await design.readArtifact(project.id, digest);
          if (!artifact) return sendError(res, "not_found", "Design artifact not found.");
          res.writeHead(200, {
            "Content-Type": artifact.mediaType,
            "Content-Length": String(artifact.bytes.byteLength),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy":
              "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'; form-action 'none'",
            "Cache-Control": "private, no-store",
          });
          res.end(Buffer.from(artifact.bytes));
          return;
        }

        return sendError(res, "not_found", "Unknown endpoint.");
      }

      // ---- Visual Assets (Macro Run 7) ----
      // /projects/:id/visual/... — final visual asset resolution over the
      // accepted design + Run 5 asset authority. Governance is entirely
      // server-side (truth gates, prompt approval, fail-before-spend,
      // request dedup); the Dashboard is a thin operator surface.
      if (segments[2] === "visual" && deps.visual) {
        const project = await deps.store.getProjectById(segments[1]!);
        if (!project) return sendError(res, "not_found", "Project not found.");
        const visual = deps.visual;

        // GET workspace: full read model.
        if (req.method === "GET" && segments.length === 4 && segments[3] === "workspace") {
          return sendJson(res, 200, await visual.workspace(project.id));
        }

        // POST plan: derive the visual plan from the current accepted design.
        if (req.method === "POST" && segments.length === 4 && segments[3] === "plan") {
          if (body.trim()) parseJsonBody(body);
          const plan = await visual.derivePlan({ projectId: project.id });
          return sendJson(res, 201, { id: plan.id, version: plan.version, planDigest: plan.planDigest });
        }

        // PUT classification: /projects/:id/visual/plans/:planId/slots/:slot/classification
        if (
          req.method === "PUT" &&
          segments.length === 8 &&
          segments[3] === "plans" &&
          segments[5] === "slots" &&
          segments[7] === "classification"
        ) {
          const parsed = parseJsonBody(body);
          const input = parseOr400(visualClassificationBodySchema, parsed);
          await visual.confirmClassification({
            projectId: project.id,
            planId: segments[4]!,
            slot: segments[6]!,
            truthClass: input.truthClass,
          });
          return sendJson(res, 200, { ok: true });
        }

        // POST prompt-snapshot: /projects/:id/visual/plans/:planId/slots/:slot/prompt-snapshot
        if (
          req.method === "POST" &&
          segments.length === 8 &&
          segments[3] === "plans" &&
          segments[5] === "slots" &&
          segments[7] === "prompt-snapshot"
        ) {
          const parsed = parseJsonBody(body);
          const input = parseOr400(visualPromptCompileSchema, parsed);
          const snapshot = await visual.compilePromptSnapshot({
            projectId: project.id,
            planId: segments[4]!,
            slot: segments[6]!,
            operation: input.operation,
            sourceVersionId: input.sourceVersionId,
          });
          return sendJson(res, 201, { id: snapshot.id, promptDigest: snapshot.promptDigest, approvalState: snapshot.approvalState });
        }

        // POST prompt approve: /projects/:id/visual/prompt-snapshots/:snapshotId/approve
        if (
          req.method === "POST" &&
          segments.length === 6 &&
          segments[3] === "prompt-snapshots" &&
          segments[5] === "approve"
        ) {
          const parsed = parseJsonBody(body);
          const input = parseOr400(visualPromptApproveSchema, parsed);
          const snapshot = await visual.approvePromptSnapshot({
            projectId: project.id,
            snapshotId: segments[4]!,
            expectedPromptDigest: input.promptDigest,
          });
          return sendJson(res, 200, { id: snapshot.id, approvalState: snapshot.approvalState, promptDigest: snapshot.promptDigest });
        }

        // POST generate: /projects/:id/visual/plans/:planId/slots/:slot/generate
        if (
          req.method === "POST" &&
          segments.length === 8 &&
          segments[3] === "plans" &&
          segments[5] === "slots" &&
          segments[7] === "generate"
        ) {
          const parsed = body.trim() ? parseJsonBody(body) : {};
          const input = parseOr400(visualGenerateSchema, parsed);
          const result = await visual.generateForSlot({
            projectId: project.id,
            planId: segments[4]!,
            slot: segments[6]!,
            sourceVersionId: input.sourceVersionId,
            escalationReason: input.escalationReason ?? null,
          });
          return sendJson(res, 201, {
            requestId: result.request.id,
            reused: result.reused,
            model: result.request.model,
            providerMode: result.request.providerMode,
            candidates: result.candidates.map((c) => ({
              id: c.id,
              candidateIndex: c.candidateIndex,
              binaryDigest: c.binaryDigest,
              mediaType: c.mediaType,
              width: c.width,
              height: c.height,
              state: c.state,
            })),
          });
        }

        // POST reuse: /projects/:id/visual/plans/:planId/slots/:slot/resolve-reuse
        if (
          req.method === "POST" &&
          segments.length === 8 &&
          segments[3] === "plans" &&
          segments[5] === "slots" &&
          segments[7] === "resolve-reuse"
        ) {
          const parsed = body.trim() ? parseJsonBody(body) : {};
          const input = parseOr400(visualReuseSchema, parsed);
          const resolved = await visual.resolveReuse({
            projectId: project.id,
            planId: segments[4]!,
            slot: segments[6]!,
            versionId: input.versionId,
          });
          return sendJson(res, 200, {
            versionId: resolved.version.id,
            binaryDigest: resolved.version.binaryDigest,
            governanceDigest: resolved.version.governanceDigest,
            assetId: resolved.asset.id,
          });
        }

        // POST deterministic transform: /projects/:id/visual/plans/:planId/slots/:slot/resolve-transform
        if (
          req.method === "POST" &&
          segments.length === 8 &&
          segments[3] === "plans" &&
          segments[5] === "slots" &&
          segments[7] === "resolve-transform"
        ) {
          const parsed = parseJsonBody(body);
          const input = parseOr400(visualTransformSchema, parsed);
          const resolved = await visual.resolveDeterministicTransform({
            projectId: project.id,
            planId: segments[4]!,
            slot: segments[6]!,
            sourceVersionId: input.sourceVersionId,
            transform: {
              maxWidth: input.maxWidth,
              aspectRatioCrop: input.aspectRatioCrop,
              grayscale: input.grayscale,
              brightness: input.brightness,
            },
          });
          return sendJson(res, 200, {
            versionId: resolved.version.id,
            binaryDigest: resolved.version.binaryDigest,
            governanceDigest: resolved.version.governanceDigest,
            assetId: resolved.asset.id,
            transformation: resolved.derivation.transformation ?? null,
          });
        }

        // POST accept candidate: /projects/:id/visual/plans/:planId/slots/:slot/accept
        if (
          req.method === "POST" &&
          segments.length === 8 &&
          segments[3] === "plans" &&
          segments[5] === "slots" &&
          segments[7] === "accept"
        ) {
          const parsed = parseJsonBody(body);
          const input = parseOr400(visualAcceptCandidateSchema, parsed);
          const accepted = await visual.acceptCandidate({
            projectId: project.id,
            planId: segments[4]!,
            slot: segments[6]!,
            candidateId: input.candidateId,
            expectedBinaryDigest: input.expectedBinaryDigest,
            confirmTruthDowngrade: input.confirmTruthDowngrade,
          });
          return sendJson(res, 200, {
            versionId: accepted.version.id,
            binaryDigest: accepted.version.binaryDigest,
            governanceDigest: accepted.version.governanceDigest,
            assetId: accepted.asset.id,
            assignmentId: accepted.assignmentId,
            truthClass: accepted.truthClass,
            boundExisting: accepted.boundExisting,
          });
        }

        // POST accept set: /projects/:id/visual/plans/:planId/accept-set
        if (req.method === "POST" && segments.length === 6 && segments[3] === "plans" && segments[5] === "accept-set") {
          if (body.trim()) parseJsonBody(body);
          const set = await visual.acceptSet({ projectId: project.id, planId: segments[4]! });
          return sendJson(res, 200, { id: set.id, version: set.version, setDigest: set.setDigest });
        }

        // GET candidate bytes: /projects/:id/visual/candidates/:candidateId/bytes
        if (req.method === "GET" && segments.length === 6 && segments[3] === "candidates" && segments[5] === "bytes") {
          const bytes = await visual.readCandidateBytes(project.id, segments[4]!);
          return sendBytes(res, bytes.mediaType, bytes.bytes);
        }

        return sendError(res, "not_found", "Unknown endpoint.");
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
