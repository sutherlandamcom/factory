import { useState, useEffect, useCallback } from "react";
import {
  derivativesApi,
  OperatorApiError,
  type DerivativeWorkspace,
  type SummaryReview,
  type AudioReview,
} from "../api/client";
import { usePolling } from "../hooks/usePolling";
import { Section } from "../components/Section";

/**
 * Page Derivatives (Macro Run 10) — thin operator surface over the governed
 * derivative pipeline. The operator can set project defaults and page
 * overrides, derive intent, generate/review/accept summaries and audio, and
 * accept the page derivative set. There is NO authoring authority here:
 * every status (ACCEPTED/STALE/READY/DISABLED) is computed by the backend,
 * acceptance goes through the backend gate, and UI state is never authority.
 */

const DERIVATIVE_ERROR_COPY: Record<string, string> = {
  derivative_policy_not_found: "No project derivative policy exists; create project defaults first.",
  derivative_authority_stale: "A bound derivative authority is stale; re-derive or re-accept.",
  derivative_authority_digest_mismatch: "Derivative digest mismatch; the binding no longer matches accepted authority.",
  derivative_authority_wrong_project: "Derivative authority belongs to a different project.",
  derivative_required_artifact_missing: "A required derivative artifact does not exist.",
  derivative_fixture_not_production_authority: "Fixture/test output cannot become production authority.",
  derivative_binary_digest_mismatch: "Stored audio bytes do not match the recorded digest.",
  derivative_artifact_immutable: "This artifact is immutable; regenerate instead.",
  derivative_generation_blocked: "Generation blocked by preflight (readiness, budget or policy).",
  derivative_qa_failed: "Summary QA has failing gates; acceptance is blocked.",
  summary_provider_not_configured: "Summary provider credentials are not configured.",
  validation_error: "Invalid input; check the form fields.",
};

function derivativeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof OperatorApiError) {
    return DERIVATIVE_ERROR_COPY[error.code] ?? error.message ?? fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    DISABLED: "border-gray-300 bg-gray-100 text-gray-700",
    READY: "border-blue-300 bg-blue-100 text-blue-800",
    GENERATING: "border-yellow-300 bg-yellow-100 text-yellow-800",
    REVIEW: "border-purple-300 bg-purple-100 text-purple-800",
    ACCEPTED: "border-green-300 bg-green-100 text-green-800",
    STALE: "border-amber-300 bg-amber-100 text-amber-800",
  };
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${styles[status] ?? "border-gray-300 bg-gray-100 text-gray-700"}`}>
      {status}
    </span>
  );
}

function shortDigest(digest: string | null): string {
  if (!digest) return "—";
  return digest.length > 12 ? `${digest.slice(0, 12)}…` : digest;
}

export function DerivativesPage({ projectId }: { projectId: string }) {
  const [ws, setWs] = useState<DerivativeWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [summaryReview, setSummaryReview] = useState<SummaryReview | null>(null);
  const [audioReview, setAudioReview] = useState<AudioReview | null>(null);
  const [reviewPage, setReviewPage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await derivativesApi.workspace(projectId);
      setWs(data);
      setError(null);
    } catch (e) {
      setError(derivativeErrorMessage(e, "Failed to load derivatives workspace."));
    }
  }, [projectId]);

  usePolling(load, 5000);
  useEffect(() => { load(); }, [load]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
    } catch (e) {
      setError(derivativeErrorMessage(e, "Operation failed."));
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = (enabled: boolean) =>
    run(async () => {
      if (!ws) return;
      const current = ws.policy;
      await derivativesApi.updatePolicy(projectId, {
        summary: {
          enabled,
          language: current?.summary.language ?? "en",
          policyVersion: current?.summary.policyVersion ?? "summary-instructions-v1",
        },
        audio: {
          enabled,
          language: current?.audio.language ?? "en",
          voiceId: current?.audio.voiceId ?? (enabled ? "fixture-voice-1" : undefined),
          policyVersion: current?.audio.policyVersion ?? "narration-projection-v1",
        },
      });
    });

  const saveOverride = (pageIdentity: string, which: "summary" | "audio", mode: "inherit" | "enabled" | "disabled") =>
    run(async () => {
      const page = ws?.pages.find((p) => p.pageIdentity === pageIdentity);
      await derivativesApi.updateOverride(projectId, pageIdentity, {
        summary: which === "summary" ? { mode } : { mode: page?.summary.state === "enabled" ? "inherit" : "inherit" },
        audio: which === "audio" ? { mode } : { mode: "inherit" },
      });
    });

  return (
    <div className="space-y-8">
      <Section title="Derivative defaults (project)">
        {error && <p className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {ws?.policy ? (
          <div className="space-y-2 text-sm">
            <p>
              <span className="font-medium">Policy v{ws.policy.version}</span>{" "}
              <span className="text-gray-500">{shortDigest(ws.policy.digest)}</span>
            </p>
            <p>
              Summary: <StatusBadge status={ws.policy.summary.enabled ? "ACCEPTED" : "DISABLED"} />{" "}
              language {ws.policy.summary.language} · policy {ws.policy.summary.policyVersion}
            </p>
            <p>
              Audio: <StatusBadge status={ws.policy.audio.enabled ? "ACCEPTED" : "DISABLED"} />{" "}
              language {ws.policy.audio.language} · voice {ws.policy.audio.voiceId ?? "—"} · policy {ws.policy.audio.policyVersion}
            </p>
            <div className="flex gap-2 pt-2">
              <button
                disabled={busy}
                onClick={() => savePolicy(true)}
                className="rounded border border-green-400 bg-green-50 px-3 py-1 text-sm font-medium text-green-800 hover:bg-green-100 disabled:opacity-50"
              >
                Enable both
              </button>
              <button
                disabled={busy}
                onClick={() => savePolicy(false)}
                className="rounded border border-gray-400 bg-gray-50 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
              >
                Disable both
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-gray-600">No project derivative policy exists. Derivatives are explicitly disabled until you create defaults.</p>
            <div className="flex gap-2">
              <button
                disabled={busy}
                onClick={() => savePolicy(true)}
                className="rounded border border-green-400 bg-green-50 px-3 py-1 text-sm font-medium text-green-800 hover:bg-green-100 disabled:opacity-50"
              >
                Create policy (enable summary + audio)
              </button>
            </div>
          </div>
        )}
      </Section>

      <Section title="Per-page derivatives">
        {ws && ws.pages.length > 0 ? (
          <div className="space-y-6">
            {ws.pages.map((page) => (
              <div key={page.pageIdentity} className="rounded border border-gray-200 p-4">
                <h3 className="font-medium">{page.pageIdentity}</h3>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <div className="rounded bg-gray-50 p-3">
                    <p className="text-sm font-medium">Summary <StatusBadge status={page.summary.status} /></p>
                    <p className="mt-1 text-xs text-gray-600">
                      effective: {page.summary.state} · {page.summary.language} · policy {page.summary.policyVersion}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button disabled={busy} onClick={() => saveOverride(page.pageIdentity, "summary", "enabled")} className="rounded border px-2 py-0.5 text-xs hover:bg-white disabled:opacity-50">Enable</button>
                      <button disabled={busy} onClick={() => saveOverride(page.pageIdentity, "summary", "disabled")} className="rounded border px-2 py-0.5 text-xs hover:bg-white disabled:opacity-50">Disable</button>
                      <button disabled={busy} onClick={() => saveOverride(page.pageIdentity, "summary", "inherit")} className="rounded border px-2 py-0.5 text-xs hover:bg-white disabled:opacity-50">Inherit</button>
                      <button
                        disabled={busy || page.summary.state === "disabled"}
                        onClick={() =>
                          run(async () => {
                            await derivativesApi.deriveIntent(projectId, page.pageIdentity);
                            const result = await derivativesApi.generateSummary(projectId, page.pageIdentity);
                            const review = await derivativesApi.summaryReview(projectId, result.proposalId);
                            setReviewPage(page.pageIdentity);
                            setSummaryReview(review);
                          })
                        }
                        className="rounded border border-blue-300 bg-blue-50 px-2 py-0.5 text-xs text-blue-800 hover:bg-blue-100 disabled:opacity-50"
                      >
                        Generate
                      </button>
                    </div>
                  </div>
                  <div className="rounded bg-gray-50 p-3">
                    <p className="text-sm font-medium">Audio <StatusBadge status={page.audio.status} /></p>
                    <p className="mt-1 text-xs text-gray-600">
                      effective: {page.audio.state} · {page.audio.language} · voice {page.audio.voiceId ?? "—"} · policy {page.audio.policyVersion}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button disabled={busy} onClick={() => saveOverride(page.pageIdentity, "audio", "enabled")} className="rounded border px-2 py-0.5 text-xs hover:bg-white disabled:opacity-50">Enable</button>
                      <button disabled={busy} onClick={() => saveOverride(page.pageIdentity, "audio", "disabled")} className="rounded border px-2 py-0.5 text-xs hover:bg-white disabled:opacity-50">Disable</button>
                      <button disabled={busy} onClick={() => saveOverride(page.pageIdentity, "audio", "inherit")} className="rounded border px-2 py-0.5 text-xs hover:bg-white disabled:opacity-50">Inherit</button>
                      <button
                        disabled={busy || page.audio.state === "disabled"}
                        onClick={() =>
                          run(async () => {
                            await derivativesApi.deriveIntent(projectId, page.pageIdentity);
                            const result = await derivativesApi.generateAudio(projectId, page.pageIdentity);
                            const review = await derivativesApi.audioReview(projectId, result.candidateId);
                            setReviewPage(page.pageIdentity);
                            setAudioReview(review);
                          })
                        }
                        className="rounded border border-blue-300 bg-blue-50 px-2 py-0.5 text-xs text-blue-800 hover:bg-blue-100 disabled:opacity-50"
                      >
                        Generate
                      </button>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-gray-600">
                  <span>Intent: {shortDigest(page.intentSnapshotId)}</span>
                  {page.set && (
                    <span>
                      Set v{page.set.version} <StatusBadge status={page.set.summaryState === "disabled" && page.set.audioState === "disabled" ? "DISABLED" : "ACCEPTED"} /> {shortDigest(page.set.digest)}
                    </span>
                  )}
                  <button
                    disabled={busy}
                    onClick={() => run(async () => { await derivativesApi.acceptSet(projectId, page.pageIdentity); })}
                    className="rounded border border-green-400 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-800 hover:bg-green-100 disabled:opacity-50"
                  >
                    Accept derivative set
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-600">No pages with accepted content yet.</p>
        )}
      </Section>

      {reviewPage && summaryReview && (
        <Section title={`Summary review — ${summaryReview.pageIdentity}`}>
          <div className="space-y-2 text-sm">
            <p>Source content v{summaryReview.sourceContent.version} · provider {summaryReview.provider} / {summaryReview.model} · mode {summaryReview.providerMode}</p>
            <p>Cost: {summaryReview.cost.micros != null ? `${summaryReview.cost.micros} µ${summaryReview.cost.currency}` : "UNKNOWN"}</p>
            <blockquote className="whitespace-pre-wrap rounded border bg-gray-50 p-3">{summaryReview.summaryText}</blockquote>
            {summaryReview.qa && (
              <ul className="space-y-1">
                {summaryReview.qa.checks.map((check) => (
                  <li key={check.checkId} className="text-xs">
                    <span className={check.verdict === "PASS" ? "text-green-700" : check.verdict === "REVIEW" ? "text-amber-700" : "text-red-700"}>
                      {check.verdict}
                    </span>{" "}
                    {check.checkId} — {check.detail}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2 pt-2">
              <button
                disabled={busy || summaryReview.qaOverall === "FAIL"}
                onClick={() =>
                  run(async () => {
                    await derivativesApi.acceptSummary(projectId, summaryReview.pageIdentity, summaryReview.proposalId);
                    setReviewPage(null);
                    setSummaryReview(null);
                  })
                }
                className="rounded border border-green-400 bg-green-50 px-3 py-1 text-sm font-medium text-green-800 hover:bg-green-100 disabled:opacity-50"
              >
                Accept summary
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const result = await derivativesApi.generateSummary(projectId, summaryReview.pageIdentity);
                    const review = await derivativesApi.summaryReview(projectId, result.proposalId);
                    setSummaryReview(review);
                  })
                }
                className="rounded border px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                Regenerate
              </button>
              <button onClick={() => { setReviewPage(null); setSummaryReview(null); }} className="rounded border px-3 py-1 text-sm hover:bg-gray-50">
                Close
              </button>
            </div>
          </div>
        </Section>
      )}

      {reviewPage && audioReview && (
        <Section title={`Audio review — ${audioReview.pageIdentity}`}>
          <div className="space-y-2 text-sm">
            <p>
              {audioReview.sourceContent.version != null ? `Source content v${audioReview.sourceContent.version} · ` : ""}
              voice {audioReview.voiceId} · provider {audioReview.provider} / {audioReview.engine} · mode {audioReview.providerMode}
            </p>
            <p>Cost: {audioReview.cost.micros != null ? `${audioReview.cost.micros} µ${audioReview.cost.currency}` : "UNKNOWN"}</p>
            {audioReview.narrationText && (
              <details className="rounded border bg-gray-50 p-3">
                <summary className="cursor-pointer text-sm font-medium">Narration text ({audioReview.narrationText.length} chars)</summary>
                <pre className="mt-2 whitespace-pre-wrap text-xs">{audioReview.narrationText}</pre>
              </details>
            )}
            <div className="flex gap-2 pt-2">
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await derivativesApi.acceptAudio(projectId, audioReview.pageIdentity, audioReview.candidateId);
                    setReviewPage(null);
                    setAudioReview(null);
                  })
                }
                className="rounded border border-green-400 bg-green-50 px-3 py-1 text-sm font-medium text-green-800 hover:bg-green-100 disabled:opacity-50"
              >
                Accept audio
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const result = await derivativesApi.generateAudio(projectId, audioReview.pageIdentity);
                    const review = await derivativesApi.audioReview(projectId, result.candidateId);
                    setAudioReview(review);
                  })
                }
                className="rounded border px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                Regenerate
              </button>
              <button onClick={() => { setReviewPage(null); setAudioReview(null); }} className="rounded border px-3 py-1 text-sm hover:bg-gray-50">
                Close
              </button>
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}
