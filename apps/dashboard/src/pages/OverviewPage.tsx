import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { queryKeys } from "../query/keys";
import { WorkflowStateBadge } from "../components/WorkflowStateBadge";
import { Section } from "../components/Section";

/**
 * Overview (Run 11 §72): answers the four operator questions in seconds —
 * what is current, what is accepted, what is stale/blocked and why, and
 * what to do next — entirely from the backend-derived read model.
 */
export function OverviewPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const workflowQuery = useQuery({
    queryKey: queryKeys.workflow(projectId ?? ""),
    queryFn: () => api.getWorkflow(projectId!),
    enabled: Boolean(projectId),
  });

  if (!projectId || !workflowQuery.data) {
    return <p className="text-gray-500">{workflowQuery.isLoading ? "Loading…" : "No workflow data."}</p>;
  }

  const wf = workflowQuery.data;
  const areaOrder = [
    "intake",
    "research",
    "content",
    "assets",
    "design",
    "production",
    "qa",
    "deployment",
  ] as const;
  const areas = wf.areas
    .filter((a) => (areaOrder as readonly string[]).includes(a.area))
    .sort((a, b) => areaOrder.indexOf(a.area as typeof areaOrder[number]) - areaOrder.indexOf(b.area as typeof areaOrder[number]));

  return (
    <div className="space-y-6">
      {/* Project state */}
      <Section title="Project state">
        <div className="flex flex-wrap items-center gap-3">
          <WorkflowStateBadge state={wf.overall} />
          <span className="text-sm text-gray-600">
            Deployment: {wf.deployment.state === "READY_FOR_DEPLOYMENT" ? "READY" : "BLOCKED"} ·{" "}
            {wf.deployment.qaCurrent ? "QA current" : "QA not current"}
          </span>
        </div>
      </Section>

      {/* Primary next action */}
      {wf.nextAction && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-5">
          <div className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Primary next action</div>
          <div className="mt-1 text-lg font-semibold text-indigo-900">{wf.nextAction.label}</div>
          <div className="mt-1 text-sm text-indigo-800">{wf.nextAction.reasonMessage}</div>
          {wf.secondaryActionCount > 0 && (
            <div className="mt-1 text-xs text-indigo-600">
              +{wf.secondaryActionCount} further pending action{wf.secondaryActionCount === 1 ? "" : "s"}
            </div>
          )}
          <button
            onClick={() => navigate(`/projects/${projectId}${wf.nextAction!.route}`)}
            className="mt-3 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Go to {wf.nextAction.area} →
          </button>
        </div>
      )}

      {/* Blockers */}
      {wf.deployment.blockers.length > 0 && (
        <Section title={`Blockers (${wf.deployment.blockers.length})`}>
          <ul className="space-y-2">
            {wf.deployment.blockers.map((b, i) => (
              <li key={`${b.code}-${b.pageIdentity ?? "project"}-${i}`} className="rounded-md border border-red-200 bg-red-50 p-3 text-sm">
                <span className="font-mono text-xs font-semibold text-red-700">{b.code}</span>
                <span className="ml-2 text-red-800">{b.message}</span>
                {b.resolutionRoute && (
                  <button
                    onClick={() => navigate(`/projects/${projectId}${b.resolutionRoute}`)}
                    className="ml-2 text-xs font-medium text-indigo-600 underline hover:text-indigo-800"
                  >
                    Resolve →
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Workflow areas */}
      <Section title="Workflow areas">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {areas.map((area) => (
            <button
              key={area.area}
              onClick={() => navigate(`/projects/${projectId}/${area.area === "intake" ? "intake" : area.area}`)}
              className="rounded-lg border border-gray-200 bg-white p-4 text-left shadow-sm hover:border-indigo-300"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold capitalize text-gray-900">{area.area}</span>
                <WorkflowStateBadge state={area.state} />
              </div>
              {area.blockers.length > 0 && (
                <div className="mt-1 text-xs text-red-600">{area.blockers.length} blocker(s)</div>
              )}
              {area.staleReasons.length > 0 && (
                <div className="mt-1 text-xs text-amber-600">{area.staleReasons.length} stale reason(s)</div>
              )}
              {area.currentAuthorities.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {area.currentAuthorities.slice(0, 2).map((a) => (
                    <div key={a.id} className="font-mono text-[10px] text-gray-500">
                      {a.kind} v{a.version} · {a.digest?.slice(0, 12)}…
                    </div>
                  ))}
                </div>
              )}
            </button>
          ))}
        </div>
      </Section>

      {/* Pages readiness matrix */}
      <Section title={`Pages (${wf.pages.length})`}>
        {wf.pages.length === 0 ? (
          <p className="text-sm text-gray-500">
            No accepted page content exists yet. Next action: {wf.nextAction?.label ?? "follow the workflow areas above"}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
                  <th className="py-2 pr-4">Page</th>
                  <th className="py-2 pr-4">Content</th>
                  <th className="py-2 pr-4">Design</th>
                  <th className="py-2 pr-4">Derivatives</th>
                  <th className="py-2 pr-4">Production</th>
                  <th className="py-2 pr-4">QA</th>
                </tr>
              </thead>
              <tbody>
                {wf.pages.map((page) => (
                  <tr key={page.pageIdentity} className="border-b border-gray-100">
                    <td className="py-2 pr-4 font-medium text-gray-900">{page.pageIdentity}</td>
                    <td className="py-2 pr-4"><PageCell cell={page.content} /></td>
                    <td className="py-2 pr-4"><PageCell cell={page.design} /></td>
                    <td className="py-2 pr-4"><PageCell cell={page.derivatives} /></td>
                    <td className="py-2 pr-4"><PageCell cell={page.production} /></td>
                    <td className="py-2 pr-4"><PageCell cell={page.qa} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

function PageCell({ cell }: { cell: import("../api/client").PageWorkflowCell }) {
  return (
    <div className="flex flex-col gap-0.5">
      <WorkflowStateBadge state={cell.state} />
      <span className="text-[10px] text-gray-500">
        {cell.relation ?? ""}
        {cell.relation && cell.freshness ? " · " : ""}
        {cell.freshness ?? ""}
        {cell.version != null ? ` · v${cell.version}` : ""}
      </span>
    </div>
  );
}
