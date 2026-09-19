import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ProjectWorkflowReadModel, WorkflowAreaId } from "../api/client";
import { queryKeys } from "../query/keys";
import { WorkflowStateBadge } from "../components/WorkflowStateBadge";

/**
 * Project workspace shell (Run 11 §49): stable side navigation, project
 * identity, overall derived state, blocker count and the deterministic
 * primary next action. The <Outlet/> renders the active area page.
 *
 * Navigation state is NOT authority (§103): the URL says where the operator
 * is LOOKING; the backend read model says what the project IS.
 */

const NAV: Array<{ area: WorkflowAreaId; label: string; path: string }> = [
  { area: "intake", label: "Overview", path: "overview" },
  { area: "intake", label: "Intake", path: "intake" },
  { area: "research", label: "Research", path: "research" },
  { area: "content", label: "Content", path: "content" },
  { area: "assets", label: "Assets", path: "assets" },
  { area: "design", label: "Design", path: "design" },
  { area: "production", label: "Production", path: "production" },
  { area: "qa", label: "QA", path: "qa" },
  { area: "versions", label: "Versions", path: "versions" },
  { area: "costs", label: "Costs", path: "costs" },
  { area: "deployment", label: "Deployment", path: "deployment" },
];

export function ProjectWorkspaceLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const workflowQuery = useQuery({
    queryKey: queryKeys.workflow(projectId ?? ""),
    queryFn: () => api.getWorkflow(projectId!),
    enabled: Boolean(projectId),
  });

  // Project display name comes from the intake workspace read model.
  const workspaceQuery = useQuery({
    queryKey: queryKeys.workspace(projectId ?? ""),
    queryFn: () => api.getWorkspace(projectId!),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });

  if (!projectId) {
    return <div className="p-8 text-gray-500">No project selected.</div>;
  }

  if (workflowQuery.isError) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <div className="rounded-md bg-red-50 p-4 text-sm text-red-700">
          Could not load the project workflow. {(workflowQuery.error as Error).message}
        </div>
        <button
          onClick={() => navigate("/projects")}
          className="mt-4 rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
        >
          &larr; All projects
        </button>
      </div>
    );
  }

  const workflow: ProjectWorkflowReadModel | undefined = workflowQuery.data;

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Side navigation (accessible compact equivalent collapses to a wrap row). */}
      <nav
        aria-label="Project areas"
        className="hidden w-56 shrink-0 border-r border-gray-200 bg-white p-4 md:block"
      >
        <button
          onClick={() => navigate("/projects")}
          className="mb-4 text-sm text-gray-500 hover:text-gray-800"
        >
          &larr; All projects
        </button>
        <ul className="space-y-1">
          {NAV.map((item) => (
            <li key={item.path}>
              <NavLink
                to={`/projects/${projectId}/${item.path}`}
                className={({ isActive }: { isActive: boolean }) =>
                  `block rounded-md px-3 py-2 text-sm font-medium ${
                    isActive
                      ? "bg-indigo-600 text-white"
                      : "text-gray-700 hover:bg-gray-100"
                  }`
                }
              >
                {({ isActive }: { isActive: boolean }) => (
                  <span aria-current={isActive ? "page" : undefined}>{item.label}</span>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <div className="flex-1">
        {/* Compact top navigation for narrow widths. */}
        <div className="border-b border-gray-200 bg-white p-3 md:hidden">
          <div className="flex flex-wrap gap-2">
            {NAV.map((item) => (
              <NavLink
                key={item.path}
                to={`/projects/${projectId}/${item.path}`}
                className={({ isActive }) =>
                  `rounded-md px-2 py-1 text-xs font-medium ${
                    isActive ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-700"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>

        {/* Workspace header: project identity + derived overall state + next action. */}
        <header className="border-b border-gray-200 bg-white px-6 py-4">
          {workflow ? (
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-xl font-bold text-gray-900">
                {workspaceQuery.data?.project.name ?? "Project"}
              </h1>
              <WorkflowStateBadge state={workflow.overall} />
              {workspaceQuery.data && (
                <WorkflowStateBadge state={workspaceQuery.data.status} />
              )}
              <span className="text-sm text-gray-500">
                {workflow.deployment.blockers.length} blocker
                {workflow.deployment.blockers.length === 1 ? "" : "s"}
              </span>
              {workflow.nextAction && (
                <button
                  onClick={() => navigate(`/projects/${projectId}${workflow.nextAction!.route}`)}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
                  title={workflow.nextAction.reasonMessage}
                >
                  Next: {workflow.nextAction.label} →
                </button>
              )}
            </div>
          ) : (
            <h1 className="text-xl font-bold text-gray-400">Loading…</h1>
          )}
        </header>

        <main className="p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
