import { z } from "zod";
import { deploymentStatusSchema } from "./deployment-result.js";

/** Explicit project-scoped permissions for release governance. */
export const DEPLOYMENT_APPROVE_PERMISSION = "DEPLOYMENT:APPROVE";
export const DEPLOYMENT_PUBLISH_PERMISSION = "DEPLOYMENT:PUBLISH";

export const releaseApprovalSealStatusSchema = z.enum(["SEALED", "LEGACY_UNSEALED"]);
export type ReleaseApprovalSealStatus = z.infer<typeof releaseApprovalSealStatusSchema>;

/**
 * Immutable release approval record.
 * Binds project + site + candidate + QA run + candidate artifact digest +
 * preview version ID + target Worker & canonical production origin.
 */
export const releaseApprovalSchema = z.object({
  id: z.string().min(1).max(128),
  projectId: z.string().min(1).max(64),
  siteId: z.string().min(1).max(64),
  candidateId: z.string().min(1).max(128),
  qaRunId: z.string().min(1).max(128),
  artifactDigest: z.string().regex(/^[0-9a-f]{64}$/, "artifactDigest must be a 64-hex SHA-256"),
  previewVersionId: z.string().min(1).max(128),
  targetWorkerName: z.string().min(1).max(128),
  targetProductionUrl: z.string().url(),
  actorId: z.string().min(1).max(128),
  actorName: z.string().min(1).max(200),
  actorRole: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(128),
  isSynthetic: z.boolean(),
  verificationSeal: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  sealKeyId: z.string().min(1).max(64),
  sealStatus: releaseApprovalSealStatusSchema,
  revoked: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
});
export type ReleaseApproval = z.infer<typeof releaseApprovalSchema>;

/** Input payload to request creation of a release approval. */
export const createReleaseApprovalRequestSchema = z.object({
  candidateId: z.string().min(1).max(128),
  previewVersionId: z.string().min(1).max(128),
  sessionToken: z.string().min(1),
});
export type CreateReleaseApprovalRequest = z.infer<typeof createReleaseApprovalRequestSchema>;

/** Input payload to request publishing an approved version. */
export const publishApprovedReleaseRequestSchema = z.object({
  candidateId: z.string().min(1).max(128),
  previewVersionId: z.string().min(1).max(128),
  approvalId: z.string().min(1).max(128),
  sessionToken: z.string().min(1),
});
export type PublishApprovedReleaseRequest = z.infer<typeof publishApprovedReleaseRequestSchema>;

/** Deployment history item in operator view. */
export const deploymentHistoryItemSchema = z.object({
  id: z.string().min(1),
  siteId: z.string().min(1),
  candidateId: z.string().nullable(),
  sourceCommit: z.string(),
  artifactDigest: z.string().nullable(),
  versionId: z.string().nullable(),
  previewUrl: z.string().nullable(),
  productionUrl: z.string(),
  previousVersionId: z.string().nullable(),
  status: deploymentStatusSchema,
  previewVerified: z.boolean(),
  productionVerified: z.boolean(),
  rolledBack: z.boolean(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  promotedAt: z.string().datetime({ offset: true }).nullable(),
  verifiedAt: z.string().datetime({ offset: true }).nullable(),
});
export type DeploymentHistoryItem = z.infer<typeof deploymentHistoryItemSchema>;

/** Full governed operator deployment read model. */
export const governedDeploymentViewSchema = z.object({
  projectId: z.string().min(1),
  siteId: z.string().min(1),
  siteKey: z.string().min(1),
  targetWorkerName: z.string().min(1),
  targetProductionUrl: z.string().url(),
  readinessState: z.enum(["BLOCKED", "READY_FOR_DEPLOYMENT"]),
  candidate: z
    .object({
      id: z.string(),
      route: z.string(),
      canonicalUrl: z.string(),
      state: z.string(),
      artifactDigest: z.string().nullable(),
      repositorySha: z.string().nullable(),
      createdAt: z.string(),
      routes: z.array(z.string()),
    })
    .nullable(),
  latestQa: z
    .object({
      id: z.string(),
      overall: z.enum(["PASS", "REVIEW", "FAIL"]),
      publicationEligible: z.boolean(),
      createdAt: z.string(),
    })
    .nullable(),
  activePreview: z
    .object({
      deploymentId: z.string(),
      versionId: z.string(),
      previewUrl: z.string(),
      previewVerified: z.boolean(),
      createdAt: z.string(),
    })
    .nullable(),
  activeApproval: releaseApprovalSchema.nullable(),
  currentProduction: z
    .object({
      activeVersionId: z.string().nullable(),
      knownGoodVersionId: z.string().nullable(),
      lastVerifiedAt: z.string().nullable(),
      executionOrigin: z.enum(["REAL_CLOUDFLARE", "TEST_SIMULATION"]).optional(),
      deliveryMode: z.string().optional(),
    })
    .nullable(),
  history: z.array(deploymentHistoryItemSchema),
  blockers: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      area: z.string(),
    }),
  ),
});
export type GovernedDeploymentView = z.infer<typeof governedDeploymentViewSchema>;
