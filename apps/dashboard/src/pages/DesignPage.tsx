import { useState, useEffect, useCallback } from "react";
import {
  designApi,
  OperatorApiError,
  type DesignWorkspace,
  type DesignCandidateView,
} from "../api/client";
import { usePolling } from "../hooks/usePolling";

/**
 * Design (Macro Run 6) — thin operator surface over the governed design
 * application service. Human review is the visual authority: this view
 * presents provider lineage, DESIGN.md validation state, candidate previews
 * (sandboxed iframes only) and the explicit accept/reject actions. It owns
 * no governance logic; every rule is enforced server-side.
 */

const DESIGN_ERROR_COPY: Record<string, string> = {
  design_input_not_accepted: "No accepted project inputs exist; accept project inputs first.",
  design_input_stale: "The design input is stale versus upstream authority; re-derive the snapshot.",
  design_provider_not_configured: "Google Stitch is not configured; provider credentials are missing.",
  design_provider_unavailable: "Stitch generation failed; check provider status and retry.",
  design_provider_output_invalid: "Provider output failed validation; nothing was accepted.",
  design_md_invalid: "DESIGN.md failed validation; the candidate was rejected before persistence.",
  design_approval_failed: "Review action rejected: the digest you confirmed does not match the stored candidate, or the acceptance is not permitted for this candidate's evidence mode (fixture candidates require an explicit fixture declaration in the review notes).",
  design_immutable: "Accepted design is immutable; generate a new candidate instead.",
  design_not_found: "Design artifact not found for this project.",
  design_budget_blocked: "Provider spend blocked by budget policy.",
  validation_error: "Invalid input; check the form fields.",
};

function designErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof OperatorApiError) {
    return DESIGN_ERROR_COPY[error.code] ?? error.message ?? fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

function shortDigest(digest: string): string {
  return digest.length > 12 ? `${digest.slice(0, 12)}…` : digest;
}

function StalenessBadge({ stale, reason }: { stale: boolean; reason: string | null }) {
  if (!stale) {
    return (
      <span className="inline-block rounded border border-green-300 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
        current
      </span>
    );
  }
  return (
    <span
      className="inline-block rounded border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
      title={reason ?? undefined}
    >
      stale{reason ? `: ${reason}` : ""}
    </span>
  );
}

function StateBadge({ state }: { state: string }) {
  const style =
    state === "accepted"
      ? "bg-green-100 text-green-800 border-green-300"
      : state === "rejected"
        ? "bg-red-100 text-red-800 border-red-300"
        : "bg-amber-100 text-amber-800 border-amber-300";
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${style}`}>{state}</span>;
}

/** Provider HTML preview: sandboxed iframe, no same-origin, no scripts. */
function SandboxedPreview({ projectId, digest }: { projectId: string; digest: string }) {
  const url = designApi.artifactUrl(projectId, digest);
  return (
    <iframe
      title={`Design preview ${shortDigest(digest)}`}
      src={url}
      sandbox="allow-same-origin"
      // The server sends a script-free Content-Security-Policy on the artifact
      // response; the sandbox attribute blocks scripts/forms/popups anyway.
      className="h-96 w-full rounded border border-gray-300 bg-white"
      loading="lazy"
    />
  );
}

interface DesignPageProps {
  projectId: string;
}

export function DesignPage({ projectId }: DesignPageProps) {
  const [workspace, setWorkspace] = useState<DesignWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewNotes, setReviewNotes] = useState("");

  const load = useCallback(async () => {
    try {
      const ws = await designApi.workspace(projectId);
      setWorkspace(ws);
      setError(null);
    } catch (err) {
      setError(designErrorMessage(err, "Failed to load design workspace."));
    }
  }, [projectId]);

  usePolling(load, 5000);
  useEffect(() => {
    load();
  }, [load]);

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setActionError(designErrorMessage(err, "Action failed."));
    } finally {
      setBusy(false);
    }
  };

  if (error && !workspace) {
    return <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error}</div>;
  }
  if (!workspace) {
    return <div className="text-sm text-gray-500">Loading design workspace…</div>;
  }

  const pendingCandidates = workspace.candidates.filter((c) => c.approvalState === "pending");
  const latestCandidate: DesignCandidateView | undefined = workspace.candidates[0];

  return (
    <div className="space-y-6">
      {error && <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
      {actionError && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{actionError}</div>
      )}

      {/* Provider status */}
      <section className="rounded border border-gray-200 p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-900">Design Provider</h3>
        <div className="text-sm text-gray-700">
          <span className="font-medium">{workspace.provider.preflight.provider}</span>{" "}
          {workspace.provider.preflight.configured ? (
            <span className="ml-2 inline-block rounded border border-green-300 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
              configured & reachable
            </span>
          ) : (
            <span className="ml-2 inline-block rounded border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              not configured
            </span>
          )}
          {!workspace.provider.preflight.configured && workspace.provider.preflight.reason && (
            <p className="mt-1 text-xs text-gray-500">{workspace.provider.preflight.reason}</p>
          )}
        </div>
      </section>

      {/* Inputs */}
      <section className="rounded border border-gray-200 p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-900">Design Input (authority-bound)</h3>
        {workspace.latestInputSnapshot ? (
          <div className="space-y-2 text-sm text-gray-700">
            <div className="flex items-center gap-2">
              <span className="font-medium">v{workspace.latestInputSnapshot.version}</span>
              <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                {shortDigest(workspace.latestInputSnapshot.inputDigest)}
              </code>
              <StalenessBadge stale={workspace.latestInputSnapshot.stale} reason={workspace.latestInputSnapshot.staleReason} />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction(() => designApi.deriveInputSnapshot(projectId))}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Re-derive input snapshot
            </button>
            {(() => {
              const data = workspace.latestInputSnapshot?.data as {
                contentRefs?: Array<{ slug: string }>;
                assetRefs?: Array<{ pageSlug: string; role: string }>;
                representativePages?: Array<{ archetype: string; slug: string }>;
              } | null;
              if (!data) return null;
              return (
                <div className="space-y-1 text-xs text-gray-600">
                  {data.representativePages && data.representativePages.length > 0 && (
                    <div>
                      Representative pages:{" "}
                      {data.representativePages.map((r) => `${r.archetype} → ${r.slug}`).join(", ")}
                    </div>
                  )}
                  {data.contentRefs && data.contentRefs.length > 0 && (
                    <div>
                      Accepted content: {data.contentRefs.map((c) => c.slug).join(", ")}
                    </div>
                  )}
                  {data.assetRefs && data.assetRefs.length > 0 && (
                    <div>
                      Approved asset assignments:{" "}
                      {data.assetRefs.map((a) => `${a.pageSlug} / ${a.role}`).join(", ")}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-gray-500">
              No design input snapshot yet. Derive one from accepted project inputs, content and assets.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction(() => designApi.deriveInputSnapshot(projectId))}
              className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Derive input snapshot
            </button>
          </div>
        )}
      </section>

      {/* Generation */}
      <section className="rounded border border-gray-200 p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-900">Generate Candidate (Google Stitch)</h3>
        <p className="mb-2 text-xs text-gray-500">
          Runs trusted preflight first (fail before spend), then one provider generation for the site design system
          plus representative archetypes. Accepted copy is embedded verbatim; the provider may not rewrite it.
        </p>
        <button
          type="button"
          disabled={busy || !workspace.provider.preflight.configured || !workspace.latestInputSnapshot
            || workspace.latestInputSnapshot.stale}
          onClick={() => runAction(() => designApi.generate(projectId))}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Generate design candidate
        </button>
      </section>

      {/* Candidates + review */}
      {latestCandidate && (
        <section className="rounded border border-gray-200 p-4">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">Candidate Design</h3>
          <div className="mb-3 space-y-1 text-sm text-gray-700">
            <div className="flex flex-wrap items-center gap-2">
              <StateBadge state={latestCandidate.approvalState} />
              <StalenessBadge stale={latestCandidate.stale} reason={latestCandidate.staleReason} />
              <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">{shortDigest(latestCandidate.candidateDigest)}</code>
              <span
                className={
                  latestCandidate.providerMode === "fixture"
                    ? "rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800"
                    : "rounded bg-green-100 px-1.5 py-0.5 text-xs font-semibold text-green-800"
                }
                title={
                  latestCandidate.providerMode === "fixture"
                    ? "Deterministic fixture candidate — NOT live Google Stitch evidence"
                    : "Live Google Stitch provider execution"
                }
              >
                {latestCandidate.providerMode === "fixture" ? "FIXTURE" : "LIVE"}
              </span>
              <span className="text-xs text-gray-500">provider: {latestCandidate.providerProjectName}</span>
            </div>
            <div className="text-xs text-gray-500">
              DESIGN.md {latestCandidate.data.designMdToolVersion} — lint: {latestCandidate.data.designMdLint.errors}{" "}
              errors, {latestCandidate.data.designMdLint.warnings} warnings
            </div>
            {latestCandidate.data.rationale && (
              <p className="text-xs italic text-gray-600">{latestCandidate.data.rationale}</p>
            )}
          </div>

          {/* Design tokens summary */}
          <div className="mb-3 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
            <div className="rounded border border-gray-200 p-2">
              <div className="mb-1 font-semibold text-gray-900">Colors</div>
              <div className="space-y-1">
                {Object.entries(latestCandidate.data.tokens.colors)
                  .filter(([, value]) => Boolean(value))
                  .map(([name, value]) => (
                    <div key={name} className="flex items-center gap-1.5">
                      <span
                        className="inline-block h-3 w-3 rounded border border-gray-300"
                        style={{ backgroundColor: value }}
                      />
                      <span>
                        {name}: {value}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
            <div className="rounded border border-gray-200 p-2">
              <div className="mb-1 font-semibold text-gray-900">Typography</div>
              <div>
                {latestCandidate.data.tokens.typography.headingFont} /{" "}
                {latestCandidate.data.tokens.typography.bodyFont}
              </div>
            </div>
            <div className="rounded border border-gray-200 p-2">
              <div className="mb-1 font-semibold text-gray-900">Archetypes</div>
              <div>{latestCandidate.data.archetypes.map((a) => a.kind).join(", ")}</div>
            </div>
            <div className="rounded border border-gray-200 p-2">
              <div className="mb-1 font-semibold text-gray-900">Screens</div>
              <div>{latestCandidate.data.screens.length}</div>
            </div>
          </div>

          {/* Sandboxed previews */}
          {latestCandidate.data.screens.some((s) => s.htmlDigest) && (
            <div className="mb-3">
              <div className="mb-1 text-xs font-semibold text-gray-900">
                Screen previews (sandboxed; provider HTML is untrusted and cannot execute scripts)
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {latestCandidate.data.screens
                  .filter((s) => s.htmlDigest)
                  .map((s) => (
                    <div key={s.id}>
                      <div className="mb-1 text-xs text-gray-500">
                        {s.title} ({s.deviceType.toLowerCase()})
                      </div>
                      <SandboxedPreview projectId={projectId} digest={s.htmlDigest!} />
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* DESIGN.md + evidence links */}
          <div className="mb-3 flex flex-wrap gap-3 text-xs">
            <a
              href={designApi.artifactUrl(projectId, latestCandidate.data.designMdDigest)}
              target="_blank"
              rel="noreferrer"
              className="text-blue-600 underline"
            >
              DESIGN.md
            </a>
            <span className="text-gray-500">
              provider lineage: {latestCandidate.provider} ·{" "}
              {latestCandidate.providerMode === "fixture" ? "FIXTURE (not live Stitch evidence)" : "LIVE"} ·{" "}
              {latestCandidate.providerProjectName}
              {latestCandidate.data.providerSessionId ? ` · session ${latestCandidate.data.providerSessionId}` : ""}
            </span>
          </div>

          {/* Review actions (human review is the authority) */}
          {pendingCandidates.some((c) => c.id === latestCandidate.id) && (
            <div className="space-y-2 border-t border-gray-200 pt-3">
              <label htmlFor="design-review-notes" className="block text-xs font-medium text-gray-700">
                Review notes
              </label>
              <input
                id="design-review-notes"
                type="text"
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs"
                placeholder="Optional notes recorded with the decision"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    runAction(() =>
                      designApi.accept(projectId, latestCandidate.id, latestCandidate.candidateDigest, reviewNotes || undefined),
                    )
                  }
                  className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                >
                  Accept design
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    runAction(() =>
                      designApi.reject(projectId, latestCandidate.id, latestCandidate.candidateDigest, reviewNotes || undefined),
                    )
                  }
                  className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Accepted design */}
      <section className="rounded border border-gray-200 p-4">
        <h3 className="mb-2 text-sm font-semibold text-gray-900">Accepted Design</h3>
        {workspace.accepted ? (
          <div className="space-y-1 text-sm text-gray-700">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">v{workspace.accepted.version}</span>
              <span
                className={
                  workspace.accepted.providerMode === "fixture"
                    ? "rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800"
                    : "rounded bg-green-100 px-1.5 py-0.5 text-xs font-semibold text-green-800"
                }
                title={
                  workspace.accepted.providerMode === "fixture"
                    ? "Accepted from a deterministic fixture candidate — NOT live Google Stitch evidence"
                    : "Accepted from live Google Stitch provider evidence"
                }
              >
                {workspace.accepted.providerMode === "fixture" ? "FIXTURE" : "LIVE"}
              </span>
              <StalenessBadge stale={workspace.accepted.stale} reason={workspace.accepted.staleReason} />
              <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                {shortDigest(workspace.accepted.candidateDigest)}
              </code>
              <span className="text-xs text-gray-500">
                accepted {new Date(workspace.accepted.acceptedAt).toLocaleString()}
              </span>
            </div>
            <div className="text-xs text-gray-500">
              Bound upstream: input snapshot {workspace.accepted.inputSnapshotVersion} (
              {shortDigest(workspace.accepted.inputDigest)}) · provider {workspace.accepted.providerProjectName}
            </div>
            <div className="text-xs text-gray-500">
              {workspace.acceptedVersions.length} accepted version(s); accepted designs are immutable.
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-500">No accepted design yet.</p>
        )}
      </section>
    </div>
  );
}
