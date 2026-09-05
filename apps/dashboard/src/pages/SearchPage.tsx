import { useState, useEffect, useCallback } from "react";
import { api, OperatorApiError } from "../api/client";
import type {
  SearchWorkspaceReadModel,
  SearchRunReadModel,
} from "../api/types";
import { Section } from "../components/Section";
import { StatusBadge } from "../components/StatusBadge";
import { usePolling } from "../hooks/usePolling";

/**
 * Search workspace (Search Intelligence v0).
 *
 * Operator surface for the governed Search pipeline: seeds in, one query
 * form, readiness in human terms, exact SERP results, GROUNDED RESEARCH
 * (visually/conceptually separate from SERP rankings), and derived Search
 * Intelligence. No raw JSON, no provider plumbing, no secrets.
 */
export function SearchPage({ projectId }: { projectId: string }) {
  const [ws, setWs] = useState<SearchWorkspaceReadModel | null>(null);
  const [lastRun, setLastRun] = useState<SearchRunReadModel | null>(null);
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("");
  const [language, setLanguage] = useState("");
  const [device, setDevice] = useState<"desktop" | "mobile" | "tablet">("desktop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    try {
      const w = await api.getSearchWorkspace(projectId);
      setWs(w);
      setError(null);
    } catch (e) {
      setError(searchErrorMessage(e, "Search workspace failed to load."));
    }
  }, [projectId]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);
  usePolling(loadWorkspace, 5000);

  const run = async (refresh = false) => {
    if (!ws) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.runSearch(projectId, {
        query,
        ...(location.trim() ? { location: location.trim() } : {}),
        ...(language.trim() ? { language: language.trim() } : {}),
        device,
        refresh,
      });
      setLastRun(result);
    } catch (e) {
      setError(searchErrorMessage(e, "Search run failed."));
    } finally {
      setBusy(false);
    }
  };

  const openRun = async (runId: string) => {
    setBusy(true);
    setError(null);
    try {
      const detail = await api.getSearchRun(projectId, runId);
      setLastRun(detail);
    } catch (e) {
      setError(searchErrorMessage(e, "Could not load run."));
    } finally {
      setBusy(false);
    }
  };

  const pickSeed = (q: string) => {
    setQuery(q);
    const loc = ws?.seeds.marketHints.at(0);
    if (loc && !location) setLocation(loc);
  };

  return (
    <div className="space-y-6" data-testid="search-workspace">
      {/* Accepted-input lineage */}
      <Section title="Accepted Inputs">
        {ws?.acceptedInput ? (
          <div className="space-y-1 text-sm">
            <p>
              Accepted version:{" "}
              <strong data-testid="search-accepted-version">v{ws.acceptedInput.version}</strong>
            </p>
            <p className="font-mono text-xs text-gray-500 break-all">digest: {ws.acceptedInput.digest}</p>
            <p className="text-gray-500">accepted {new Date(ws.acceptedInput.acceptedAt).toLocaleString()}</p>
          </div>
        ) : (
          <p className="text-sm text-gray-500" data-testid="search-no-accepted">
            No accepted project inputs yet. Complete Intake acceptance first — Search runs against
            accepted inputs only.
          </p>
        )}
        <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="mb-1 font-medium text-gray-700">Seed topics</div>
            <div className="flex flex-wrap gap-1">
              {(ws?.seeds.topics ?? []).map((t) => (
                <span key={t} className="rounded bg-gray-100 px-2 py-0.5 text-xs">{t}</span>
              ))}
              {(ws?.seeds.topics.length ?? 0) === 0 && <span className="text-gray-400">—</span>}
            </div>
          </div>
          <div>
            <div className="mb-1 font-medium text-gray-700">Seed queries</div>
            <div className="flex flex-wrap gap-1">
              {(ws?.seeds.queries ?? []).map((q) => (
                <button
                  key={q}
                  onClick={() => pickSeed(q)}
                  className="rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-100"
                >
                  {q}
                </button>
              ))}
              {(ws?.seeds.queries.length ?? 0) === 0 && <span className="text-gray-400">—</span>}
            </div>
          </div>
        </div>
      </Section>

      {/* Readiness + run form */}
      <Section title="Run a Search">
        <div className="mb-4 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm" data-testid="search-readiness">
          {ws?.readiness.canRun ? (
            <p className="text-green-800">
              ✓ Ready — provider configured ({ws.readiness.providerMode === "fixture" ? "deterministic test provider" : "live provider"}).
            </p>
          ) : (
            <ul className="list-disc pl-5 text-amber-800">
              {(ws?.readiness.blockers ?? ["Loading readiness…"]).map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="grid grid-cols-4 gap-3">
          <div className="col-span-2">
            <label htmlFor="search-query" className="mb-1 block text-sm font-medium text-gray-700">Query</label>
            <input
              id="search-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={200}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="e.g. roof repair austin"
            />
          </div>
          <div>
            <label htmlFor="search-location" className="mb-1 block text-sm font-medium text-gray-700">Location</label>
            <input
              id="search-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              maxLength={200}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              placeholder="e.g. Austin, TX"
            />
          </div>
          <div>
            <label htmlFor="search-device" className="mb-1 block text-sm font-medium text-gray-700">Device</label>
            <select
              id="search-device"
              value={device}
              onChange={(e) => setDevice(e.target.value as typeof device)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="desktop">Desktop</option>
              <option value="mobile">Mobile</option>
              <option value="tablet">Tablet</option>
            </select>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={() => run(false)}
            disabled={busy || !ws?.readiness.canRun || query.trim().length === 0}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? "Running…" : "Run Search"}
          </button>
          <button
            onClick={() => run(true)}
            disabled={busy || !ws?.readiness.canRun || query.trim().length === 0}
            className="rounded-md border border-indigo-300 px-4 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
            title="Force a new observation even if a fresh cached result exists"
          >
            Refresh (new observation)
          </button>
          <span className="text-xs text-gray-400">
            Language: {language.trim() || "provider default"}
          </span>
        </div>
        {error && <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700" data-testid="search-error">{error}</div>}
      </Section>

      {/* Last/current run */}
      {lastRun && <RunDetail run={lastRun} onOpenRun={openRun} />}

      {/* History */}
      <Section title="Previous Runs">
        {(ws?.recentRuns.length ?? 0) === 0 ? (
          <p className="text-sm text-gray-500" data-testid="search-no-history">No search runs yet.</p>
        ) : (
          <table className="w-full text-sm" data-testid="search-history">
            <thead>
              <tr className="text-left text-xs uppercase text-gray-500">
                <th className="pb-2">Status</th>
                <th className="pb-2">Query</th>
                <th className="pb-2">Provider</th>
                <th className="pb-2">Started</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {(ws?.recentRuns ?? []).map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="py-2">
                    <StatusBadge status={r.status === "succeeded" ? "READY" : "BLOCKED"} />
                  </td>
                  <td className="py-2">{r.query}</td>
                  <td className="py-2">{r.provider}</td>
                  <td className="py-2 text-gray-500">{new Date(r.startedAt).toLocaleString()}</td>
                  <td className="py-2 text-right">
                    <button onClick={() => openRun(r.id)} className="text-indigo-600 hover:underline">
                      Inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

function RunDetail({ run, onOpenRun }: { run: SearchRunReadModel; onOpenRun: (id: string) => void }) {
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="space-y-6" data-testid="search-run-detail">
      {/* Run status */}
      <Section title={`Run ${run.run.id.slice(0, 8)}…`}>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge status={run.run.status === "succeeded" ? "READY" : "BLOCKED"} />
          {run.run.cacheReused && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800" data-testid="search-cache-reused">
              CACHED RESULT — observed {new Date(run.serp?.observedAt ?? run.run.startedAt).toLocaleString()}
            </span>
          )}
          {run.run.refreshRequested && (
            <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">REFRESHED</span>
          )}
          {run.acceptedInput.stale && (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800" data-testid="search-stale-badge">
              BASED ON OLDER ACCEPTED INPUTS (v{run.acceptedInput.version})
            </span>
          )}
          <span className="text-gray-500">provider: {run.run.provider}</span>
          <span className="text-gray-500">device: {run.run.device}</span>
          {run.run.location && <span className="text-gray-500">location: {run.run.location}</span>}
        </div>
        {run.run.status === "failed" && (
          <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">
            {run.run.errorCode}: {run.run.errorMessage}
          </div>
        )}
      </Section>

      {/* Exact SERP */}
      {run.serp && (
        <Section title="Exact SERP Results (measured)">
          <p className="mb-3 text-xs text-gray-500">
            Observed {new Date(run.serp.observedAt).toLocaleString()} via {run.serp.provider}
            {run.serp.providerRequestId ? ` · request ${run.serp.providerRequestId}` : ""}
            {run.serp.usage?.costMicros != null
              ? ` · cost ${(run.serp.usage.costMicros / 1_000_000).toFixed(4)} ${run.serp.usage.currency ?? "USD"}`
              : " · cost unknown"}
            {" · digest "}
            <span className="font-mono">{run.serp.snapshotDigest.slice(0, 12)}…</span>
          </p>
          <ol className="space-y-3" data-testid="serp-organic">
            {run.serp.organic.map((r) => (
              <li key={r.position} className="rounded-md border border-gray-100 p-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-bold text-gray-400">#{r.position}</span>
                  <a href={r.url} className="text-sm font-medium text-indigo-700 hover:underline" target="_blank" rel="noreferrer">
                    {r.title}
                  </a>
                  <span className="text-xs text-gray-400">{r.domain}</span>
                </div>
                <p className="mt-1 text-sm text-gray-600">{r.snippet}</p>
              </li>
            ))}
          </ol>
          {run.serp.features && run.serp.features.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-sm font-medium text-gray-700">SERP features</div>
              <div className="flex flex-wrap gap-1">
                {run.serp.features.map((f) => (
                  <span key={f} className="rounded bg-gray-100 px-2 py-0.5 text-xs">{f}</span>
                ))}
              </div>
            </div>
          )}
          {run.serp.peopleAlsoAsk && run.serp.peopleAlsoAsk.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-sm font-medium text-gray-700">People Also Ask</div>
              <ul className="list-disc pl-5 text-sm text-gray-600" data-testid="serp-paa">
                {run.serp.peopleAlsoAsk.map((p) => (
                  <li key={p.question}>{p.question}</li>
                ))}
              </ul>
            </div>
          )}
          {run.serp.relatedSearches && run.serp.relatedSearches.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-sm font-medium text-gray-700">Related searches</div>
              <div className="flex flex-wrap gap-1" data-testid="serp-related">
                {run.serp.relatedSearches.map((s) => (
                  <span key={s} className="rounded bg-gray-100 px-2 py-0.5 text-xs">{s}</span>
                ))}
              </div>
            </div>
          )}
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="mt-4 text-xs text-gray-400 hover:text-gray-600"
          >
            {showRaw ? "Hide" : "Show"} raw provider evidence (digest {run.serp.rawDigest.slice(0, 10)}…)
          </button>
          {showRaw && (
            <p className="mt-2 rounded bg-gray-50 p-2 font-mono text-xs text-gray-500 break-all" data-testid="serp-raw-digest">
              raw digest: {run.serp.rawDigest}
            </p>
          )}
        </Section>
      )}

      {/* Grounded research — conceptually separate from SERP */}
      {run.grounded && (
        <Section title="GROUNDED RESEARCH (model-mediated web evidence — not rankings)">
          <p className="mb-3 text-xs text-gray-500" data-testid="grounded-label">
            Model {run.grounded.model} · prompt {run.grounded.promptVersion} · observed{" "}
            {new Date(run.grounded.observedAt).toLocaleString()}
          </p>
          {run.grounded.webSearchQueries.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-sm font-medium text-gray-700">Google searches executed</div>
              <ul className="list-disc pl-5 text-sm text-gray-600" data-testid="grounded-queries">
                {run.grounded.webSearchQueries.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="mb-1 text-sm font-medium text-gray-700">Sources consulted</div>
            <ul className="list-disc pl-5 text-sm" data-testid="grounded-sources">
              {run.grounded.sources.map((s) => (
                <li key={s.uri}>
                  <a href={s.uri} className="text-indigo-700 hover:underline" target="_blank" rel="noreferrer">
                    {s.title ?? s.uri}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )}
      {!run.grounded && run.run.status === "succeeded" && (
        <p className="text-xs text-gray-400" data-testid="grounded-absent">
          Grounded research not configured for this run — exact SERP evidence only.
        </p>
      )}

      {/* Intelligence */}
      {run.intelligence && (
        <Section title="Search Intelligence (derived from evidence)">
          <p className="mb-3 text-xs text-gray-500" data-testid="intel-meta">
            Model {run.intelligence.model} · prompt {run.intelligence.promptVersion} · state{" "}
            {run.intelligence.data.reviewState}
          </p>
          <div className="space-y-4 text-sm" data-testid="intel-body">
            <div>
              <span className="font-medium text-gray-700">Primary intent:</span>{" "}
              <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-800">
                {run.intelligence.data.primaryIntent}
              </span>
              <p className="mt-1 text-gray-600">{run.intelligence.data.intentRationale}</p>
            </div>
            <ClusterList title="Query clusters" clusters={run.intelligence.data.queryClusters} />
            <TagList title="Long-tail opportunities" items={run.intelligence.data.longTailOpportunities.map((o) => o.query)} testId="intel-longtail" />
            <TagList title="Entities" items={run.intelligence.data.entities.map((e) => e.name)} testId="intel-entities" />
            <TagList title="Topics" items={run.intelligence.data.topics.map((t) => t.topic)} testId="intel-topics" />
            <TagList title="Questions" items={run.intelligence.data.questions} testId="intel-questions" />
            <TagList title="Modifiers" items={run.intelligence.data.modifiers} testId="intel-modifiers" />
            <TagList title="Search vocabulary" items={run.intelligence.data.searchVocabulary} testId="intel-vocabulary" />
            <TagList title="Related concepts" items={run.intelligence.data.relatedConcepts} testId="intel-concepts" />
            <TagList title="Semantic coverage requirements" items={run.intelligence.data.semanticCoverageRequirements} testId="intel-coverage" />
            <TagList title="User needs" items={run.intelligence.data.userNeeds} testId="intel-needs" />
            <div>
              <div className="mb-1 font-medium text-gray-700">Evidence</div>
              <ul className="list-disc pl-5 text-xs text-gray-500" data-testid="intel-evidence">
                {run.intelligence.data.evidenceRefs.map((ref) => (
                  <li key={`${ref.kind}-${ref.id}`}>
                    {ref.kind} {ref.id.slice(0, 8)}… (digest {ref.digest.slice(0, 10)}…)
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Section>
      )}
      <button onClick={() => onOpenRun(run.run.id)} className="text-xs text-gray-400 hover:text-gray-600">
        Reload this run from history
      </button>
    </div>
  );
}

function ClusterList({
  title,
  clusters,
}: {
  title: string;
  clusters: SearchRunReadModel["intelligence"] extends null ? never : NonNullable<SearchRunReadModel["intelligence"]>["data"]["queryClusters"];
}) {
  if (clusters.length === 0) return null;
  return (
    <div>
      <div className="mb-1 font-medium text-gray-700">{title}</div>
      <ul className="space-y-2" data-testid="intel-clusters">
        {clusters.map((c) => (
          <li key={c.id} className="rounded-md border border-gray-100 p-2">
            <div className="flex items-center gap-2">
              <span className="font-medium">{c.label}</span>
              <span className="rounded bg-gray-100 px-2 py-0.5 text-xs">{c.intent}</span>
              <span className="text-xs text-gray-400">confidence {c.confidence.toFixed(2)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {c.queries.map((q) => (
                <span
                  key={q}
                  className={`rounded px-2 py-0.5 text-xs ${q === c.primaryQuery ? "bg-indigo-100 text-indigo-800 font-semibold" : "bg-gray-100 text-gray-600"}`}
                >
                  {q}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TagList({ title, items, testId }: { title: string; items: string[]; testId: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-1 font-medium text-gray-700">{title}</div>
      <div className="flex flex-wrap gap-1" data-testid={testId}>
        {items.map((item) => (
          <span key={item} className="rounded bg-gray-100 px-2 py-0.5 text-xs">{item}</span>
        ))}
      </div>
    </div>
  );
}

/** Map typed search error codes to operator-facing copy (no raw errors). */
export function searchErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof OperatorApiError) {
    switch (error.code) {
      case "search_input_not_accepted":
        return "No accepted project inputs. Complete Intake acceptance before running searches.";
      case "search_query_invalid":
        return "That query is not valid. Check length and characters, then try again.";
      case "search_provider_not_configured":
        return "No search provider is configured yet. Ask the administrator to add provider credentials.";
      case "search_provider_budget_blocked":
        return "The daily search budget is used up. Try again tomorrow.";
      case "search_provider_rate_limited":
        return "The search provider is rate-limiting us. Wait a moment and retry.";
      case "search_provider_auth_failed":
        return "The search provider rejected its credentials. The administrator must fix the configuration.";
      case "search_provider_unavailable":
        return "The search provider could not be reached. Try again shortly.";
      case "search_response_invalid":
      case "search_normalization_failed":
        return "The provider returned an unusable response. The failure has been recorded — try again.";
      case "search_intelligence_invalid":
        return "Search analysis produced invalid output. The run was rejected (nothing was saved).";
      case "search_run_not_found":
        return "That search run no longer exists.";
      default:
        return error.code === "internal_error" ? "Search failed unexpectedly. Try again." : fallback;
    }
  }
  return error instanceof Error ? error.message : fallback;
}
