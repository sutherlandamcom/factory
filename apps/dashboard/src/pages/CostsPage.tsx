import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { queryKeys } from "../query/keys";

/**
 * Costs view (Run 11 §71, §39): provider/model/operation/page aggregation.
 * UNKNOWN cost is NEVER rendered as $0.00; sources without cost telemetry
 * are reported as NOT AVAILABLE.
 */
export function CostsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const costsQuery = useQuery({
    queryKey: queryKeys.costs(projectId ?? ""),
    queryFn: () => api.getWorkflowCosts(projectId!),
    enabled: Boolean(projectId),
  });

  if (!projectId || !costsQuery.data) {
    return <p className="text-gray-500">{costsQuery.isLoading ? "Loading…" : "No cost data."}</p>;
  }

  const costs = costsQuery.data;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-900">Provider cost & usage</h2>

      {costs.rows.length === 0 ? (
        <p className="text-sm text-gray-500">
          No provider usage recorded for this project yet. Rows appear here when governed provider calls execute.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
              <th className="py-2 pr-4">Provider</th>
              <th className="py-2 pr-4">Model</th>
              <th className="py-2 pr-4">Operation</th>
              <th className="py-2 pr-4">Page</th>
              <th className="py-2 pr-4">Calls</th>
              <th className="py-2 pr-4">Known cost</th>
              <th className="py-2 pr-4">Unknown-cost calls</th>
            </tr>
          </thead>
          <tbody>
            {costs.rows.map((row) => (
              <tr key={`${row.provider}-${row.model ?? ""}-${row.operation}-${row.pageIdentity ?? ""}`} className="border-b border-gray-100">
                <td className="py-2 pr-4 font-medium text-gray-900">{row.provider}</td>
                <td className="py-2 pr-4 text-gray-700">{row.model ?? "—"}</td>
                <td className="py-2 pr-4 text-gray-700">{row.operation}</td>
                <td className="py-2 pr-4 text-gray-700">{row.pageIdentity ?? "—"}</td>
                <td className="py-2 pr-4">{row.calls}</td>
                <td className="py-2 pr-4">
                  {row.knownCost.kind === "KNOWN" ? (
                    <span>${row.knownCost.amountUsd.toFixed(6)}</span>
                  ) : (
                    <span className="font-semibold uppercase text-amber-700">UNKNOWN</span>
                  )}
                </td>
                <td className="py-2 pr-4">{row.unknownCostCalls}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {costs.unavailableSources.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-600">Not available</h3>
          <ul className="space-y-1">
            {costs.unavailableSources.map((s) => (
              <li key={s.source} className="text-sm text-gray-600">
                <span className="font-medium">{s.source}</span>: {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
