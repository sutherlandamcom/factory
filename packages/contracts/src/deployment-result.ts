import { z } from "zod";

export const deploymentStatusSchema = z.enum([
  "preparing",
  "uploaded",
  "preview_verified",
  "promoting",
  "promoted",
  "verified",
  "rolled_back",
  "failed",
  "needs_review",
]);

export const deploymentResultSchema = z.object({
  deploymentId: z.string().min(1),
  siteId: z.string().min(1),
  status: deploymentStatusSchema,
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  artifactDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  versionId: z.string().min(1).nullable(),
  previewUrl: z.string().url().nullable(),
  productionUrl: z.string().url(),
  previousVersionId: z.string().min(1).nullable(),
  previewVerified: z.boolean(),
  productionVerified: z.boolean(),
  rolledBack: z.boolean(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  timestamps: z.object({
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    promotedAt: z.string().datetime().nullable(),
    verifiedAt: z.string().datetime().nullable(),
  }),
});

export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;
export type DeploymentResult = z.infer<typeof deploymentResultSchema>;
