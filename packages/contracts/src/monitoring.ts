import { z } from "zod";

export const monitoringObservationTypeSchema = z.enum([
  "technical_verification",
  "operational_check",
  "search_console_indexing",
  "lighthouse_lab",
  "crux_field_cwv",
]);
export type MonitoringObservationType = z.infer<typeof monitoringObservationTypeSchema>;

export const monitoringObservationStatusSchema = z.enum([
  "PASS",
  "WARN",
  "FAIL",
  "NOT_CONFIGURED",
  "UNAVAILABLE",
  "INSUFFICIENT_DATA",
]);
export type MonitoringObservationStatus = z.infer<typeof monitoringObservationStatusSchema>;

export const monitoringObservationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  siteId: z.string().min(1),
  route: z.string().min(1),
  deploymentId: z.string().nullable(),
  versionId: z.string().nullable(),
  observationType: monitoringObservationTypeSchema,
  source: z.enum(["playwright", "operational_crawler", "google_search_console", "lighthouse", "crux"]),
  status: monitoringObservationStatusSchema,
  collectionWindow: z.string().default("realtime"),
  freshness: z.string().default("fresh"),
  metrics: z.record(z.string(), z.unknown()).nullable(),
  evidenceRef: z.string().nullable(),
  errorMessage: z.string().nullable(),
  observedAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
});
export type MonitoringObservation = z.infer<typeof monitoringObservationSchema>;

export const monitoringSummarySchema = z.object({
  projectId: z.string().min(1),
  siteId: z.string().min(1),
  targetProductionUrl: z.string().url(),
  activeVersionId: z.string().nullable(),
  technicalVerification: z.object({
    status: monitoringObservationStatusSchema,
    checkedAt: z.string().nullable(),
    summary: z.string(),
  }),
  lastOperationalCheck: z.object({
    status: monitoringObservationStatusSchema,
    checkedAt: z.string().nullable(),
    summary: z.string(),
  }),
  searchConsole: z.object({
    status: monitoringObservationStatusSchema,
    checkedAt: z.string().nullable(),
    indexCoverage: z.string().nullable(),
    issues: z.array(z.string()),
    property: z.string().nullable(),
  }),
  lighthouse: z.object({
    status: monitoringObservationStatusSchema,
    checkedAt: z.string().nullable(),
    score: z.number().nullable(),
    p75LcpMs: z.number().nullable(),
    p75Cls: z.number().nullable(),
  }),
  fieldCwv: z.object({
    status: monitoringObservationStatusSchema,
    checkedAt: z.string().nullable(),
    p75LcpMs: z.number().nullable(),
    p75InpMs: z.number().nullable(),
    p75Cls: z.number().nullable(),
  }),
  observations: z.array(monitoringObservationSchema),
});
export type MonitoringSummary = z.infer<typeof monitoringSummarySchema>;
