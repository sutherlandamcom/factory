import { useState, useEffect, useCallback } from "react";
import {
  productionApi,
  OperatorApiError,
  type ProductionWorkspace,
  type ProductionCandidateDetail,
} from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { Section } from "../components/Section";

/**
 * Production (Macro Run 9) — thin operator surface over the governed
 * production pipeline. The operator can inspect page/route/lineage/staleness,
 * build production candidates, run deterministic QA and inspect typed
 * evidence. There is NO Publish action (publication belongs to Run 13);
 * this view owns no governance logic — every rule is enforced server-side.
 */

const PRODUCTION_ERROR_COPY: Record<string, string> = {
  production_input_not_accepted: "No accepted project inputs exist; accept project inputs first.",
  production_authority_not_found: "Required accepted authority (content/design/visual set) does not exist for this page.",
  production_authority_stale: "A bound accepted authority is stale; re-accept or re-derive upstream first.",
  production_authority_digest_mismatch: "Authority digest mismatch; the production binding no longer matches accepted authority.",
  production_authority_wrong_project: "Authority belongs to a different project.",
  production_route_conflict: "Route authority conflict: duplicate route or contradictory canonical.",
  production_input_immutable: "Production input is immutable; a new version is required.",
  production_candidate_not_found: "Production candidate not found.",
  production_build_rejected: "Build rejected: readiness, staleness or renderer failure.",
  production_qa_failed: "A required QA gate verdict is FAIL; candidate acceptance blocked.",
  production_qa_not_found: "QA run not found or candidate has no completed build.",
  validation_error: "Invalid input; check the form fields.",
};

function productionErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof OperatorApiError) {
    return PRODUCTION_ERROR_COPY[error.code] ?? error.message ?? fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

function shortDigest(digest: string | null): string {
  if (!digest) return "—";
  return digest.length > 12 ? `${digest.slice(0, 12)}…` : digest;
}

const GROUP_LABELS: Record<string, string> = {
  content: "Content",
  html: "HTML",
  seo: "SEO",
  images: "Images",
  accessibility: "Accessibility",
  links: "Links",
  performance: "Performance",
  security: "Security",
};

function StateBadge({ state }: { state: string }) {
  const styles: Record<string, string> = {
    pending: "border-gray-300 bg-gray-100 text-gray-700",
    built: "border-blue-300 bg-blue-100 text-blue-800",
    qa_passed: "border-green-300 bg-green-100 text-green-800",
    qa_failed: "border-red-300 bg-red-100 text-red-800",
    stale: "border-amber-300 bg-amber-100 text-amber-800",
  };
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${styles[state] ?? "border-gray-300 bg-gray-100 text-gray-700"}`}>
      {state}
    </span>
  );
}

function QaVerdictBadge({ verdict }: { verdict: string }) {
  const styles: Record<string, string> = {
    PASS: "border-green-300 bg-green-100 text-green-800",
    REVIEW: "border-amber-300 bg-amber-100 text-amber-800",
    FAIL: "border-red-300 bg-red-100 text-red-800",
  };
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${styles[verdict] ?? "border-gray-300 bg-gray-100 text-gray-700"}`}>
      {verdict}
    </span>
  );
}

export function ProductionPage({ projectId }: { projectId: string }) {
  const [ws, setWs] = useState<ProductionWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pageSlug, setPageSlug] = useState("home");
  const [canonicalOrigin, setCanonicalOrigin] = useState("https://sutherlandam.com");
  const [detail, setDetail] = useState<ProductionCandidateDetail | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await productionApi.workspace(projectId);
      setWs(data);
      setError(null);
    } catch (err) {
      setError(productionErrorMessage(err, "Failed to load production workspace."));
    }
  }, [projectId]);

  usePolling(load, 5000);
  useEffect(() => { load(); }, [load]);

  const openDetail = useCallback(async (candidateId: string) => {
    try {
      const data = await productionApi.candidateDetail(projectId, candidateId);
      setDetail(data);
    } catch (err) {
      setError(productionErrorMessage(err, "Failed to load candidate detail."));
    }
  }, [projectId]);

  const prepare = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await productionApi.prepareCandidate(projectId, pageSlug.trim(), canonicalOrigin.trim());
      await load();
    } catch (err) {
      setError(productionErrorMessage(err, "Failed to prepare candidate."));
    } finally {
      setBusy(false);
    }
  }, [projectId, pageSlug, canonicalOrigin, load]);

  const build = useCallback(async (candidateId: string) => {
    setBusy(true);
    setError(null);
    try {
      await productionApi.buildCandidate(projectId, candidateId);
      await load();
      await openDetail(candidateId);
    } catch (err) {
      setError(productionErrorMessage(err, "Failed to build candidate."));
    } finally {
      setBusy(false);
    }
  }, [projectId, load, openDetail]);

  const runQa = useCallback(async (candidateId: string) => {
    setBusy(true);
    setError(null);
    try {
      await productionApi.runQa(projectId, candidateId);
      await load();
      await openDetail(candidateId);
    } catch (err) {
      setError(productionErrorMessage(err, "Failed to run QA."));
    } finally {
      setBusy(false);
    }
  }, [projectId, load, openDetail]);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      <Section title="Derive production input + create candidate">
        <p className="mb-3 text-sm text-gray-600">
          Binds the exact accepted Content + Design + Visual Asset authorities for a page into an immutable
          production input, then creates a build candidate. Fails closed on any stale upstream authority.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs font-medium text-gray-700">
            Page slug
            <input
              className="mt-1 w-56 rounded border px-2 py-1.5 text-sm"
              value={pageSlug}
              onChange={(event) => setPageSlug(event.target.value)}
              placeholder="home"
            />
          </label>
          <label className="flex flex-col text-xs font-medium text-gray-700">
            Canonical origin
            <input
              className="mt-1 w-72 rounded border px-2 py-1.5 text-sm"
              value={canonicalOrigin}
              onChange={(event) => setCanonicalOrigin(event.target.value)}
              placeholder="https://sutherlandam.com"
            />
          </label>
          <button
            className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            onClick={prepare}
            disabled={busy || pageSlug.trim() === "" || canonicalOrigin.trim() === ""}
          >
            {busy ? "Working…" : "Prepare candidate"}
          </button>
        </div>
      </Section>

      <Section title="Production inputs (immutable authority manifests)">
        {!ws || ws.inputs.length === 0 ? (
          <p className="text-sm text-gray-500">No production inputs derived yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-2 pr-3">Page</th>
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3">Route</th>
                  <th className="py-2 pr-3">v</th>
                  <th className="py-2 pr-3">Content</th>
                  <th className="py-2 pr-3">Design</th>
                  <th className="py-2 pr-3">Visual set</th>
                  <th className="py-2 pr-3">Renderer</th>
                  <th className="py-2 pr-3">State</th>
                </tr>
              </thead>
              <tbody>
                {ws.inputs.map((input) => (
                  <tr key={input.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{input.pageIdentity}</td>
                    <td className="py-2 pr-3">{input.pageType}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{input.route}</td>
                    <td className="py-2 pr-3">{input.version}</td>
                    <td className="py-2 pr-3 text-xs">{shortDigest(input.acceptedContent.id)} v{input.acceptedContent.version}</td>
                    <td className="py-2 pr-3 text-xs">{shortDigest(input.acceptedDesign.id)} v{input.acceptedDesign.version}</td>
                    <td className="py-2 pr-3 text-xs">{shortDigest(input.acceptedVisualSet.id)} v{input.acceptedVisualSet.version}</td>
                    <td className="py-2 pr-3 text-xs">{input.renderer.id} {input.renderer.version}</td>
                    <td className="py-2 pr-3">
                      {input.stale ? (
                        <span
                          className="inline-block rounded border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                          title={input.staleReason ?? undefined}
                        >
                          stale
                        </span>
                      ) : (
                        <span className="inline-block rounded border border-green-300 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                          current
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Production candidates">
        {!ws || ws.candidates.length === 0 ? (
          <p className="text-sm text-gray-500">No candidates yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-2 pr-3">Candidate</th>
                  <th className="py-2 pr-3">Route</th>
                  <th className="py-2 pr-3">Canonical</th>
                  <th className="py-2 pr-3">State</th>
                  <th className="py-2 pr-3">Artifact digest</th>
                  <th className="py-2 pr-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {ws.candidates.map((candidate) => (
                  <tr key={candidate.id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">{shortDigest(candidate.id)}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{candidate.route}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{candidate.canonicalUrl}</td>
                    <td className="py-2 pr-3"><StateBadge state={candidate.state} /></td>
                    <td className="py-2 pr-3 font-mono text-xs">{shortDigest(candidate.artifactDigest)}</td>
                    <td className="py-2 pr-3">
                      <div className="flex gap-2">
                        <button
                          className="rounded border px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          onClick={() => build(candidate.id)}
                          disabled={busy || candidate.state !== "pending"}
                        >
                          Build
                        </button>
                        <button
                          className="rounded border px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          onClick={() => runQa(candidate.id)}
                          disabled={busy || !["built", "qa_passed", "qa_failed"].includes(candidate.state)}
                        >
                          Run QA
                        </button>
                        <button
                          className="rounded border px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                          onClick={() => openDetail(candidate.id)}
                        >
                          Inspect
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {detail && (
        <Section title={`Candidate ${shortDigest(detail.id)} — evidence`}>
          <div className="mb-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            <div><span className="font-medium">Route:</span> <span className="font-mono text-xs">{detail.route}</span></div>
            <div><span className="font-medium">Canonical:</span> <span className="font-mono text-xs">{detail.canonicalUrl}</span></div>
            <div><span className="font-medium">State:</span> <StateBadge state={detail.state} /></div>
            <div><span className="font-medium">Input digest:</span> <span className="font-mono text-xs">{shortDigest(detail.productionInputDigest)}</span></div>
          </div>
          {detail.qa ? (
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-medium">Latest QA:</span>
                <QaVerdictBadge verdict={detail.qa.overall} />
                <span className="text-xs text-gray-500">{new Date(detail.qa.createdAt).toLocaleString()}</span>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {Object.entries(
                  detail.qa.checks.reduce<Record<string, typeof detail.qa.checks>>((groups, check) => {
                    (groups[check.group] ??= []).push(check);
                    return groups;
                  }, {}),
                ).map(([group, checks]) => (
                  <div key={group} className="rounded border p-2">
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                      {GROUP_LABELS[group] ?? group}
                    </div>
                    <ul className="space-y-1">
                      {checks.map((check) => (
                        <li key={check.checkId} className="flex items-start gap-2 text-xs">
                          <QaVerdictBadge verdict={check.verdict} />
                          <div>
                            <span className="font-mono">{check.checkId}</span>
                            <div className="text-gray-600">{check.detail}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">No QA run recorded for this candidate yet.</p>
          )}
        </Section>
      )}
    </div>
  );
}
