import { useState, useEffect, useCallback } from "react";
import { api, OperatorApiError } from "../api/client";
import type {
  ContentGapsWorkspaceReadModel,
  ContentGapReportDetail,
  AcceptedGapDetail,
  GapDecisionView,
} from "../api/client";
import { Section } from "../components/Section";
import { StatusBadge } from "../components/StatusBadge";
import { usePolling } from "../hooks/usePolling";

/**
 * Content Gaps workspace (Macro Run 3).
 *
 * Operator review authority: inspect the proposed gap report (user need,
 * competitor coverage, our evidence, differentiation), set disposition and
 * priority per gap with a bounded note, then accept the reviewed set as an
 * immutable versioned snapshot. Staleness is backend-computed; acceptance
 * is backend-enforced (UI buttons are not governance).
 */

const DISPOSITIONS = ["REQUIRED", "OPTIONAL", "EXCLUDE"] as const;
const PRIORITIES = ["HIGH", "MEDIUM", "LOW"] as const;

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof OperatorApiError) return e.message;
  return fallback;
}

export function ContentGapsPage({ projectId }: { projectId: string }) {
  const [ws, setWs] = useState<ContentGapsWorkspaceReadModel | null>(null);
  const [detail, setDetail] = useState<ContentGapReportDetail | null>(null);
  const [acceptedDetail, setAcceptedDetail] = useState<AcceptedGapDetail | null>(null);
  const [drafts, setDrafts] = useState<Record<string, GapDecisionView>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    try {
      setWs(await api.getContentGapsWorkspace(projectId));
    } catch (e) {
      setError(errorMessage(e, "Content gaps workspace failed to load."));
    }
  }, [projectId]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);
  usePolling(loadWorkspace, 10000);

  const openReport = async (reportId: string) => {
    setBusy(true);
    setError(null);
    setAcceptedDetail(null);
    try {
      const d = await api.getContentGapReport(projectId, reportId);
      setDetail(d);
      const seeded: Record<string, GapDecisionView> = {};
      for (const gap of d.report.data.gaps) {
        const existing = d.decisions.find((dec) => dec.gapId === gap.id);
        seeded[gap.id] = existing ?? {
          gapId: gap.id,
          disposition: gap.recommendedDisposition as GapDecisionView["disposition"],
          priority: gap.priority as GapDecisionView["priority"],
          note: null,
        };
      }
      setDrafts(seeded);
    } catch (e) {
      setError(errorMessage(e, "Could not load report."));
    } finally {
      setBusy(false);
    }
  };

  const openAccepted = async (version: number) => {
    setBusy(true);
    setError(null);
    try {
      setAcceptedDetail(await api.getAcceptedGapDetail(projectId, version));
      setDetail(null);
    } catch (e) {
      setError(errorMessage(e, "Could not load accepted snapshot."));
    } finally {
      setBusy(false);
    }
  };

  const propose = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { reportId } = await api.proposeContentGaps(projectId);
      await loadWorkspace();
      await openReport(reportId);
      setNotice("Gap report proposed. Review each gap, then accept.");
    } catch (e) {
      setError(errorMessage(e, "Gap proposal failed."));
    } finally {
      setBusy(false);
    }
  };

  const saveDecisions = async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.saveGapDecisions(
        projectId,
        detail.report.id,
        {
          expectedReviewRevision: detail.report.reviewRevision,
          decisions: Object.values(drafts).map((d) => ({
            gapId: d.gapId,
            disposition: d.disposition,
            ...(d.priority ? { priority: d.priority } : {}),
            ...(d.note?.trim() ? { note: d.note.trim() } : {}),
          })),
        },
      );
      if (res.reviewRevision !== undefined && res.decisionsDigest !== undefined) {
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                report: {
                  ...prev.report,
                  reviewRevision: res.reviewRevision!,
                  decisionsDigest: res.decisionsDigest!,
                  reviewState: "operator_reviewed",
                },
                decisions: Object.values(drafts).map((d) => ({
                  gapId: d.gapId,
                  disposition: d.disposition,
                  priority: d.priority,
                  note: d.note?.trim() || null,
                })),
              }
            : null,
        );
      } else {
        await openReport(detail.report.id);
      }
      setNotice("Decisions saved.");
    } catch (e) {
      const msg = errorMessage(e, "Saving decisions failed.");
      await openReport(detail.report.id);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.acceptContentGaps(projectId, detail.report.id, {
        expectedReportDigest: detail.report.snapshotDigest,
        expectedReviewRevision: detail.report.reviewRevision,
        expectedDecisionsDigest: detail.report.decisionsDigest ?? "",
      });
      setNotice(`Content gaps accepted as version ${result.version}.`);
      setDetail(null);
      await loadWorkspace();
      await openAccepted(result.version);
    } catch (e) {
      const msg = errorMessage(e, "Acceptance failed.");
      await openReport(detail.report.id);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const allDecided = detail ? Object.keys(drafts).length === detail.report.data.gaps.length : false;

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
      )}
      {notice && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">{notice}</div>
      )}

      <Section title="Gap reports">
        <div className="space-y-2 text-sm">
          {ws && ws.reports.length === 0 && ws.accepted.length === 0 && (
            <div className="flex flex-col items-start gap-2">
              <p className="text-gray-500">No gap report yet. Acquire competitors first, then propose gaps.</p>
              <button
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                disabled={busy}
                onClick={propose}
              >
                Propose gap report
              </button>
            </div>
          )}
          {ws?.reports.map((r) => (
            <button
              key={r.id}
              className="flex w-full flex-wrap items-center gap-3 rounded-md border border-gray-100 bg-white px-3 py-2 text-left hover:bg-gray-50"
              onClick={() => openReport(r.id)}
            >
              <StatusBadge status={r.reviewState} />
              <span className="text-gray-700">
                {r.gapCounts.total} gaps ({r.gapCounts.required} required / {r.gapCounts.optional} optional / {r.gapCounts.excluded} excluded)
              </span>
              <span className="text-xs text-gray-400">{new Date(r.createdAt).toLocaleString()}</span>
              {r.stale && <span className="text-xs font-semibold text-amber-600">STALE: {r.staleReasons.join(" ")}</span>}
            </button>
          ))}
          {ws && ws.reports.length > 0 && (
            <button
              className="rounded-md border border-indigo-200 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
              disabled={busy}
              onClick={propose}
            >
              Propose new gap report
            </button>
          )}
        </div>
      </Section>

      {ws && ws.accepted.length > 0 && (
        <Section title="Accepted versions">
          <div className="space-y-1 text-sm">
            {ws.accepted.map((a) => (
              <button
                key={a.id}
                className="flex w-full flex-wrap items-center gap-3 rounded-md border border-gray-100 bg-white px-3 py-1.5 text-left hover:bg-gray-50"
                onClick={() => openAccepted(a.version)}
              >
                <StatusBadge status={`v${a.version}`} />
                <span className="text-gray-700">{a.gapCounts.total} gaps</span>
                <span className="text-xs text-gray-400">accepted {new Date(a.acceptedAt).toLocaleString()}</span>
                {a.stale && <span className="text-xs font-semibold text-amber-600">STALE</span>}
              </button>
            ))}
          </div>
        </Section>
      )}

      {detail && (
        <>
          {(detail.stale || detail.report.reviewState === "accepted") && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              {detail.stale ? `Upstream evidence changed: ${detail.staleReasons.join(" ")}` : "This report has been accepted."}
            </div>
          )}
          {detail.report.data.searchSemantics && (
            <Section title="Search intelligence semantics">
              <div className="space-y-2 text-xs text-gray-700">
                <div data-testid="search-primary-intent">
                  <span className="font-semibold text-gray-800">Primary search intent: </span>
                  <span className="font-mono text-indigo-700">{detail.report.data.searchSemantics.primaryIntent}</span>
                </div>
                <div>
                  <span className="font-semibold text-gray-800">Semantic coverage requirements: </span>
                  <ul className="mt-1 list-disc pl-5 space-y-0.5" data-testid="search-coverage-requirements">
                    {detail.report.data.searchSemantics.semanticCoverageRequirements.map((req, i) => (
                      <li key={i}>{req}</li>
                    ))}
                  </ul>
                </div>
                {detail.report.data.searchSemantics.userNeeds && detail.report.data.searchSemantics.userNeeds.length > 0 && (
                  <div>
                    <span className="font-semibold text-gray-800">User needs: </span>
                    <ul className="mt-1 list-disc pl-5 space-y-0.5" data-testid="search-user-needs">
                      {detail.report.data.searchSemantics.userNeeds.map((need, i) => (
                        <li key={i}>{need}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="text-gray-400">
                  Bound intelligence: <code className="font-mono">{detail.report.data.searchSemantics.intelligenceSnapshotDigest.slice(0, 16)}…</code>
                </div>
              </div>
            </Section>
          )}
          <Section title={`Review gaps (${detail.report.data.gaps.length})`}>
            <div className="mb-2 flex flex-wrap gap-4 text-xs text-gray-500">
              <span>Report digest: <code className="font-mono">{detail.report.snapshotDigest.slice(0, 16)}…</code></span>
              <span>Review revision: <code className="font-mono">{detail.report.reviewRevision}</code></span>
              {detail.report.decisionsDigest && (
                <span>Decisions digest: <code className="font-mono">{detail.report.decisionsDigest.slice(0, 16)}…</code></span>
              )}
            </div>
            <div className="space-y-4">
              {detail.report.data.gaps.map((gap) => {
                const draft = drafts[gap.id];
                return (
                  <div key={gap.id} className="rounded-md border border-gray-200 bg-white p-3">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <h4 className="font-medium text-gray-800">{gap.userNeed}</h4>
                      <span className="text-xs text-gray-400">competitor coverage: {gap.competitorCoverage}</span>
                    </div>
                    <p className="text-sm text-gray-600">{gap.topicQuestion}</p>
                    <p className="mt-1 text-xs text-gray-500">{gap.treatmentPattern}</p>
                    <div className="mt-2 grid gap-2 text-xs text-gray-600 md:grid-cols-2">
                      <div>
                        <span className="font-semibold">Our evidence available: </span>
                        {gap.ourEvidenceAvailable.length > 0
                          ? gap.ourEvidenceAvailable.map((e) => e.excerpt).join("; ")
                          : "none"}
                      </div>
                      <div>
                        <span className="font-semibold">Evidence missing: </span>
                        {gap.ourEvidenceMissing.join("; ") || "none"}
                      </div>
                      <div>
                        <span className="font-semibold">Claim constraints: </span>
                        {gap.claimConstraints.join("; ") || "none"}
                      </div>
                      <div>
                        <span className="font-semibold">Differentiation: </span>
                        {gap.differentiationOpportunity}
                      </div>
                    </div>
                    {draft && (
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <select
                          className="rounded border border-gray-300 px-2 py-1 text-sm"
                          value={draft.disposition}
                          onChange={(e) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [gap.id]: { ...draft, disposition: e.target.value as GapDecisionView["disposition"] },
                            }))
                          }
                        >
                          {DISPOSITIONS.map((d) => (
                            <option key={d} value={d}>{d}</option>
                          ))}
                        </select>
                        <select
                          className="rounded border border-gray-300 px-2 py-1 text-sm"
                          value={draft.priority ?? ""}
                          onChange={(e) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [gap.id]: { ...draft, priority: (e.target.value || null) as GapDecisionView["priority"] },
                            }))
                          }
                        >
                          <option value="">priority…</option>
                          {PRIORITIES.map((p) => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                        <input
                          className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                          placeholder="Bounded review note (optional)"
                          maxLength={500}
                          value={draft.note ?? ""}
                          onChange={(e) =>
                            setDrafts((prev) => ({ ...prev, [gap.id]: { ...draft, note: e.target.value } }))
                          }
                        />
                      </div>
                    )}
                    <div className="mt-2 text-xs text-gray-400">
                      Evidence anchors: {gap.evidenceRefs.length > 0 ? gap.evidenceRefs.map((r) => `${r.pageSnapshotId.slice(0, 8)}…/${r.segmentId}`).join(", ") : "none"}
                    </div>
                  </div>
                );
              })}
            </div>
            {detail.report.reviewState !== "accepted" && (
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  disabled={busy || !allDecided}
                  onClick={saveDecisions}
                >
                  Save review
                </button>
                <button
                  className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50"
                  disabled={
                    busy ||
                    !allDecided ||
                    detail.decisions.length !== detail.report.data.gaps.length ||
                    !detail.report.decisionsDigest ||
                    detail.stale
                  }
                  onClick={accept}
                >
                  Accept as v{ws?.accepted[0] ? ws.accepted[0].version + 1 : 1}
                </button>
              </div>
            )}
          </Section>
          <Section title="Differentiation requirements">
            <ul className="list-disc pl-5 text-sm text-gray-700">
              {detail.report.data.differentiationRequirements.items.map((item, i) => (
                <li key={i}>
                  {item.requirement} <span className="text-xs text-gray-400">({item.basis})</span>
                </li>
              ))}
              {detail.report.data.differentiationRequirements.items.length === 0 && (
                <li className="text-gray-400">None proposed.</li>
              )}
            </ul>
          </Section>
        </>
      )}

      {acceptedDetail && (
        <Section title={`Accepted snapshot v${acceptedDetail.snapshot.version} (immutable)`}>
          {acceptedDetail.stale && (
            <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              STALE: {acceptedDetail.staleReasons.join(" ")}
            </div>
          )}
          <div className="space-y-1 text-xs text-gray-500">
            <div>Report digest: {acceptedDetail.snapshot.reportDigest.slice(0, 16)}…</div>
            <div>Decisions digest: {acceptedDetail.snapshot.decisionsDigest.slice(0, 16)}…</div>
            <div>Accepted: {new Date(acceptedDetail.snapshot.acceptedAt).toLocaleString()}</div>
          </div>
          {acceptedDetail.snapshot.data.searchSemantics && (
            <div className="mt-4 rounded-md border border-gray-100 bg-gray-50 p-3 text-xs text-gray-700">
              <div className="font-semibold text-gray-800 mb-1">Accepted search semantics:</div>
              <div data-testid="accepted-primary-intent">
                <span className="font-medium">Primary intent: </span>
                <span className="font-mono text-indigo-700">{acceptedDetail.snapshot.data.searchSemantics.primaryIntent}</span>
              </div>
              <div className="mt-1">
                <span className="font-medium">Coverage requirements: </span>
                <ul className="mt-0.5 list-disc pl-5 space-y-0.5" data-testid="accepted-coverage-requirements">
                  {acceptedDetail.snapshot.data.searchSemantics.semanticCoverageRequirements.map((req, i) => (
                    <li key={i}>{req}</li>
                  ))}
                </ul>
              </div>
              <div className="mt-1 text-gray-400">
                Bound intelligence: <code className="font-mono">{acceptedDetail.snapshot.data.searchSemantics.intelligenceSnapshotDigest.slice(0, 16)}…</code>
              </div>
            </div>
          )}
          <ul className="mt-2 list-disc pl-5 text-sm text-gray-700">
            {acceptedDetail.snapshot.data.gaps.map((g) => (
              <li key={g.id} className="mb-2">
                <div>
                  <span className="font-medium">{g.userNeed}</span> —{" "}
                  <span className="font-semibold text-indigo-700">{g.disposition}</span>
                  {g.priority ? ` (${g.priority})` : ""}
                  {g.recommendedDisposition !== g.disposition && (
                    <span className="ml-2 text-xs text-gray-400">
                      (model proposed: {g.recommendedDisposition})
                    </span>
                  )}
                </div>
                {g.note && (
                  <div className="mt-0.5 text-xs text-gray-600 italic">
                    Note: {g.note}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
