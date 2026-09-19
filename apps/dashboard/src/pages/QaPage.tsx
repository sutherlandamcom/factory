import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { queryKeys } from "../query/keys";
import { WorkflowStateBadge } from "../components/WorkflowStateBadge";

/**
 * QA view (Run 11 §67–69): renders ONLY actual registered production QA
 * evidence. A historical PASS remains a historical fact — shown as
 * "PASS — HISTORICAL / NOT CURRENT", never rewritten as FAILED. Lab
 * performance evidence is labeled "Performance — Lab", never field CWV.
 */
export function QaPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const workflowQuery = useQuery({
    queryKey: queryKeys.workflow(projectId ?? ""),
    queryFn: () => api.getWorkflow(projectId!),
    enabled: Boolean(projectId),
  });

  if (!projectId || !workflowQuery.data) {
    return <p className="text-gray-500">{workflowQuery.isLoading ? "Loading…" : "No workflow data."}</p>;
  }

  const wf = workflowQuery.data;
  const qaArea = wf.areas.find((a) => a.area === "qa");

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Production QA</h2>
        <WorkflowStateBadge state={qaArea?.state ?? "NOT_STARTED"} />
      </div>

      {wf.pages.length === 0 ? (
        <p className="text-sm text-gray-500">
          No production candidates exist yet, so no QA evidence is registered. QA rows appear here only after a real
          production QA run executes against a built candidate.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
                <th className="py-2 pr-4">Page</th>
                <th className="py-2 pr-4">Verdict</th>
                <th className="py-2 pr-4">Relation</th>
                <th className="py-2 pr-4">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {wf.pages.map((page) => {
                const meaning =
                  page.qa.state === "ACCEPTED" && page.qa.relation === "CURRENT"
                    ? "Current PASS on the current candidate."
                    : page.qa.state === "ACCEPTED" && page.qa.relation === "HISTORICAL"
                      ? "PASS — HISTORICAL / NOT CURRENT (binds a superseded candidate)."
                      : page.qa.state === "BLOCKED"
                        ? "QA FAILED on the current candidate."
                        : page.qa.state === "REVIEW_REQUIRED"
                          ? "QA requires human review."
                          : "No QA run registered for the current candidate.";
                return (
                  <tr key={page.pageIdentity} className="border-b border-gray-100">
                    <td className="py-2 pr-4 font-medium text-gray-900">{page.pageIdentity}</td>
                    <td className="py-2 pr-4"><WorkflowStateBadge state={page.qa.state} /></td>
                    <td className="py-2 pr-4 text-xs text-gray-600">{page.qa.relation ?? "—"}</td>
                    <td className="py-2 pr-4 text-gray-700">{meaning}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-500">
        Performance evidence shown by production QA is Lighthouse/lab evidence ("Performance — Lab"). Field Core Web
        Vitals do not exist until real traffic; Factory never fabricates field INP.
      </p>
    </div>
  );
}
