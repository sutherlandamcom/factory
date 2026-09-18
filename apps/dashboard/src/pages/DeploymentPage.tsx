import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { queryKeys } from "../query/keys";
import { WorkflowStateBadge } from "../components/WorkflowStateBadge";

/**
 * Deployment readiness view (Run 11 §41–42, §15–16).
 *
 * READ-ONLY. Run 11 ends at READY_FOR_DEPLOYMENT; the Preview → Approve →
 * Publish → Verify → Rollback lifecycle belongs to Macro Run 13 and is
 * rendered here only as a labeled future diagram with NO action buttons.
 * PUBLISHED is never derived here — it is a real deployment fact.
 */
export function DeploymentPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const workflowQuery = useQuery({
    queryKey: queryKeys.workflow(projectId ?? ""),
    queryFn: () => api.getWorkflow(projectId!),
    enabled: Boolean(projectId),
  });

  if (!projectId || !workflowQuery.data) {
    return <p className="text-gray-500">{workflowQuery.isLoading ? "Loading…" : "No workflow data."}</p>
  }

  const wf = workflowQuery.data;
  const d = wf.deployment;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Deployment readiness</h2>
        <WorkflowStateBadge state={d.state} />
      </div>

      {d.candidate && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Current candidate</div>
          <div className="mt-1 font-mono text-sm text-gray-900">
            {d.candidate.kind} {d.candidate.pageIdentity ? `· ${d.candidate.pageIdentity} ` : ""}v{d.candidate.version}
          </div>
          {d.candidate.digest && (
            <div className="font-mono text-xs text-gray-500">digest {d.candidate.digest.slice(0, 32)}…</div>
          )}
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">QA status</div>
        <div className="mt-1 text-sm text-gray-900">
          {d.qaCurrent ? "All current candidates have a current QA PASS." : "QA is not current for all pages."}
        </div>
      </div>

      {d.blockers.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-600">
            Blocking reasons ({d.blockers.length})
          </h3>
          <ul className="space-y-2">
            {d.blockers.map((b, i) => (
              <li key={`${b.code}-${b.pageIdentity ?? "project"}-${i}`} className="rounded-md border border-red-200 bg-red-50 p-3 text-sm">
                <span className="font-mono text-xs font-semibold text-red-700">{b.code}</span>
                <span className="ml-2 text-red-800">{b.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {d.state === "READY_FOR_DEPLOYMENT" && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-800">
          READY_FOR_DEPLOYMENT — all current authorities are accepted and QA is current. This is the Run 11 terminal
          state; publication itself is a future governed lifecycle fact, not a QA outcome.
        </div>
      )}

      {/* Future lifecycle — explicitly NOT implemented in Run 11. */}
      <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Production delivery lifecycle — implemented in Macro Run 13
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-500">
          {["Preview", "Approval", "Production", "Verification", "Rollback"].map((step, i) => (
            <span key={step} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden>→</span>}
              <span className="rounded bg-white px-2 py-1 font-medium text-gray-600">{step}</span>
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-500">
          No publish, rollback or preview actions exist in this run. Factory will expose them only through the governed
          Run 13 lifecycle.
        </p>
      </div>
    </div>
  );
}
