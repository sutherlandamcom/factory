import { useState, useEffect, useCallback } from "react";
import { api, OperatorApiError } from "../api/client";
import type {
  CompetitorsWorkspaceReadModel,
  CompetitorRunReadModel,
} from "../api/client";
import { Section } from "../components/Section";
import { StatusBadge } from "../components/StatusBadge";
import { usePolling } from "../hooks/usePolling";

/**
 * Competitors workspace (Macro Run 3).
 *
 * Operator surface for the governed competitor pipeline: pick a search run's
 * SERP evidence, acquire + analyze competitors, review classification and
 * per-page evidence. No raw JSON, no provider plumbing, no secrets, no full
 * competitor page text dumps.
 */

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof OperatorApiError) return e.message;
  return fallback;
}

export function CompetitorsPage({ projectId }: { projectId: string }) {
  const [ws, setWs] = useState<CompetitorsWorkspaceReadModel | null>(null);
  const [lastRun, setLastRun] = useState<CompetitorRunReadModel | null>(null);
  const [selectedSerp, setSelectedSerp] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    try {
      const w = await api.getCompetitorsWorkspace(projectId);
      setWs(w);
      setSelectedSerp((prev) => prev || w.serpRuns[0]?.serpSnapshotId || "");
    } catch (e) {
      setError(errorMessage(e, "Competitors workspace failed to load."));
    }
  }, [projectId]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);
  usePolling(loadWorkspace, 8000);

  const run = async () => {
    if (!selectedSerp) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.runCompetitors(projectId, { serpSnapshotId: selectedSerp });
      setLastRun(result);
      await loadWorkspace();
    } catch (e) {
      setError(errorMessage(e, "Competitor run failed."));
    } finally {
      setBusy(false);
    }
  };

  const openRun = async (runId: string) => {
    setBusy(true);
    try {
      setLastRun(await api.getCompetitorRun(projectId, runId));
    } catch (e) {
      setError(errorMessage(e, "Could not load run."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
      )}

      <Section title="Competitor evidence run">
        {ws?.readiness.canRun ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm text-gray-700">
              Search evidence
              <select
                className="mt-1 block w-96 rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm"
                value={selectedSerp}
                onChange={(e) => setSelectedSerp(e.target.value)}
              >
                {ws.serpRuns.map((s) => (
                  <option key={s.serpSnapshotId} value={s.serpSnapshotId}>
                    {s.query} — observed {new Date(s.observedAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              disabled={busy || !selectedSerp}
              onClick={run}
            >
              {busy ? "Running…" : "Acquire competitors"}
            </button>
          </div>
        ) : (
          <ul className="list-disc pl-5 text-sm text-gray-600">
            {(ws?.readiness.blockers ?? ["Loading…"]).map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
      </Section>

      {ws && ws.recentRuns.length > 0 && (
        <Section title="Run history">
          <div className="space-y-1 text-sm">
            {ws.recentRuns.map((r) => (
              <button
                key={r.id}
                className="flex w-full items-center gap-3 rounded-md border border-gray-100 bg-white px-3 py-1.5 text-left hover:bg-gray-50"
                onClick={() => openRun(r.id)}
              >
                <StatusBadge status={r.status} />
                <span className="text-gray-700">{new Date(r.startedAt).toLocaleString()}</span>
                {r.errorCode && <span className="text-red-600">{r.errorCode}</span>}
              </button>
            ))}
          </div>
        </Section>
      )}

      {lastRun && (
        <Section title={`Candidates (${lastRun.candidates.length})`}>
          <div className="mb-3 flex gap-4 text-xs text-gray-500">
            <span>Fetched: {lastRun.usage.competitorPagesFetched}</span>
            <span>Analyzed: {lastRun.usage.analyzedCount}</span>
            <span>Blocked: {lastRun.usage.blockedCount}</span>
            <span>Failed: {lastRun.usage.failedCount}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-2 py-1">Rank</th>
                  <th className="px-2 py-1">Domain</th>
                  <th className="px-2 py-1">Class</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Observed</th>
                  <th className="px-2 py-1">Analysis</th>
                </tr>
              </thead>
              <tbody>
                {lastRun.candidates.map((c) => (
                  <tr key={c.pageSnapshotId} className="border-t border-gray-100 align-top">
                    <td className="px-2 py-1.5">{c.serpPosition}</td>
                    <td className="px-2 py-1.5">
                      <div className="font-medium text-gray-800">{c.domain}</div>
                      <div className="text-xs text-gray-400">{c.classificationReason}</div>
                    </td>
                    <td className="px-2 py-1.5">{c.classification}</td>
                    <td className="px-2 py-1.5">
                      <StatusBadge
                        status={c.acquisitionStatus}
                      />
                      {c.httpStatus != null && <span className="ml-1 text-xs text-gray-400">{c.httpStatus}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-gray-500">{new Date(c.observedAt).toLocaleString()}</td>
                    <td className="px-2 py-1.5">
                      {c.analyzed ? (
                        <div className="space-y-0.5">
                          <div className="text-xs font-medium text-gray-700">{c.pageType}</div>
                          <div className="text-xs text-gray-500">{c.topics.slice(0, 3).join(", ")}</div>
                          {c.questions.length > 0 && (
                            <div className="text-xs text-gray-400">Q: {c.questions[0]}</div>
                          )}
                          {c.freshness && <div className="text-xs text-gray-400">{c.freshness}</div>}
                        </div>
                      ) : c.dedupedFromSnapshotId ? (
                        <span className="text-xs text-gray-400">deduped (identical content)</span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}
