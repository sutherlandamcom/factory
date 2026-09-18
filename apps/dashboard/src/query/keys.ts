/**
 * Centralized TanStack Query key factory.
 *
 * Every query key is scoped by projectId so switching projects can never
 * reuse another project's cache (Run 11 §135). Components must never invent
 * ad-hoc string keys.
 */

import type { WorkflowAreaId } from "../api/client";

export const queryKeys = {
  projects: ["projects"] as const,

  /** Intake workspace (draft/readiness/history) for one project. */
  workspace: (projectId: string) => ["workspace", projectId] as const,

  /** Derived operator workflow read model. */
  workflow: (projectId: string) => ["workflow", projectId] as const,

  /** Artifact version/history projection. */
  versions: (projectId: string) => ["versions", projectId] as const,

  /** Cost aggregation. */
  costs: (projectId: string) => ["costs", projectId] as const,

  /** Vertical-slice workspaces keyed by area. */
  area: (projectId: string, area: WorkflowAreaId) => ["area", area, projectId] as const,

  /** Parameterized detail queries (e.g. a specific search run). */
  detail: (projectId: string, area: WorkflowAreaId, id: string) =>
    ["detail", area, projectId, id] as const,
};

/** Areas whose data can change as a downstream consequence of a mutation. */
export const workflowInvalidationSets = {
  /** Accepting inputs affects everything downstream. */
  acceptInputs: (projectId: string) => [
    queryKeys.workspace(projectId),
    queryKeys.workflow(projectId),
    queryKeys.versions(projectId),
  ],
  /** Content acceptance propagates to derivatives/production/QA. */
  acceptContent: (projectId: string) => [
    queryKeys.workflow(projectId),
    queryKeys.versions(projectId),
    queryKeys.area(projectId, "content"),
    queryKeys.area(projectId, "production"),
    queryKeys.area(projectId, "qa"),
    queryKeys.area(projectId, "derivatives" as WorkflowAreaId),
  ],
  /** Production build/QA mutations. */
  production: (projectId: string) => [
    queryKeys.workflow(projectId),
    queryKeys.area(projectId, "production"),
    queryKeys.area(projectId, "qa"),
  ],
  /** Design/visual mutations. */
  design: (projectId: string) => [
    queryKeys.workflow(projectId),
    queryKeys.area(projectId, "design"),
    queryKeys.area(projectId, "assets"),
  ],
} as const;
