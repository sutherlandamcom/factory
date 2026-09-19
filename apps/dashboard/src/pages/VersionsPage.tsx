import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import { queryKeys } from "../query/keys";
import { WorkflowStateBadge } from "../components/WorkflowStateBadge";

/**
 * Versions view (Run 11 §70, §37): artifact history answering what is
 * current, what was current before, what superseded it, and what exact
 * version/digest production binds. A table projection — no raw JSON.
 */
export function VersionsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const versionsQuery = useQuery({
    queryKey: queryKeys.versions(projectId ?? ""),
    queryFn: () => api.getWorkflowVersions(projectId!),
    enabled: Boolean(projectId),
  });

  if (!projectId || !versionsQuery.data) {
    return <p className="text-gray-500">{versionsQuery.isLoading ? "Loading…" : "No version data."}</p>;
  }

  const artifacts = versionsQuery.data.artifacts;
  const kinds = [...new Set(artifacts.map((a) => a.artifactKind))].sort();

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-900">Artifact versions</h2>
      {artifacts.length === 0 ? (
        <p className="text-sm text-gray-500">
          No versioned artifacts exist yet. As authorities are accepted (inputs, content, design, visual sets,
          candidates) they appear here with exact versions and digests.
        </p>
      ) : (
        kinds.map((kind) => (
          <div key={kind}>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-600">{kind.replace(/_/g, " ")}</h3>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
                  <th className="py-2 pr-4">Page</th>
                  <th className="py-2 pr-4">Version</th>
                  <th className="py-2 pr-4">Digest</th>
                  <th className="py-2 pr-4">Accepted</th>
                  <th className="py-2 pr-4">Relation</th>
                  <th className="py-2 pr-4">Freshness</th>
                </tr>
              </thead>
              <tbody>
                {artifacts
                  .filter((a) => a.artifactKind === kind)
                  .map((a) => (
                    <tr key={a.id} className="border-b border-gray-100">
                      <td className="py-2 pr-4 text-gray-700">{a.pageIdentity ?? "—"}</td>
                      <td className="py-2 pr-4 font-medium text-gray-900">v{a.version}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-gray-600">{a.digest.slice(0, 16)}…</td>
                      <td className="py-2 pr-4 text-xs text-gray-600">
                        {a.acceptedAt ? new Date(a.acceptedAt).toLocaleString() : "—"}
                      </td>
                      <td className="py-2 pr-4"><WorkflowStateBadge state={a.relation} /></td>
                      <td className="py-2 pr-4">
                        {a.freshness ? <WorkflowStateBadge state={a.freshness} /> : <span className="text-xs text-gray-400">—</span>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );
}
