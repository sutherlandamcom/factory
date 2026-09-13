import { useState, useEffect, useCallback } from "react";
import {
  visualApi,
  OperatorApiError,
  type VisualWorkspace,
  type VisualSlotView,
  type DesignCandidateView,
} from "../api/client";
import { usePolling } from "../hooks/usePolling";

/**
 * Visual Assets (Macro Run 7) — thin operator surface over the governed
 * final-asset-resolution service. Human review is the visual authority:
 * this view presents the plan (truth-class proposals with confirm/override),
 * prompt snapshots with exact-digest approval, provider candidates with
 * lineage/provenance badges, and the explicit accept actions. It owns no
 * governance logic; every rule is enforced server-side.
 */

const VISUAL_ERROR_COPY: Record<string, string> = {
  visual_design_not_eligible: "No eligible accepted design exists; accept a live (non-fixture) design first, or re-derive a stale design.",
  visual_plan_stale: "The plan is stale versus the accepted design; re-derive the plan.",
  visual_classification_required: "Confirm the slot's truth classification before this operation.",
  visual_truth_policy_violation: "Truth policy violation: the requested resolution mode is not allowed for this slot's classification.",
  visual_prompt_not_approved: "The exact prompt snapshot must be human-approved before generation.",
  visual_provider_not_configured: "Gemini image credentials are not configured.",
  visual_provider_unavailable: "Provider execution failed; check provider status.",
  visual_provider_output_invalid: "Provider output failed validation; nothing was persisted.",
  visual_budget_blocked: "Provider spend blocked by the daily visual budget.",
  visual_not_found: "Visual artifact not found for this project.",
  visual_acceptance_failed: "Acceptance rejected: digest mismatch or invalid state.",
  visual_set_immutable: "The accepted set is immutable; resolve remaining slots or re-accept.",
  visual_slot_unresolved: "Every slot must be resolved before accepting the set.",
  validation_error: "Invalid input; check the form fields.",
};

function visualErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof OperatorApiError) {
    return VISUAL_ERROR_COPY[error.code] ?? error.message ?? fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

function shortDigest(digest: string): string {
  return digest.length > 12 ? `${digest.slice(0, 12)}…` : digest;
}

const TRUTH_CLASSES = ["documentary", "documentary_edited", "illustrative", "decorative", "data_visualization"] as const;

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

function ModeBadge({ mode }: { mode: string }) {
  const styles: Record<string, string> = {
    reuse_real: "border-green-300 bg-green-100 text-green-800",
    deterministic_transform: "border-blue-300 bg-blue-100 text-blue-800",
    ai_edit: "border-purple-300 bg-purple-100 text-purple-800",
    ai_generate: "border-orange-300 bg-orange-100 text-orange-800",
  };
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${styles[mode] ?? "border-gray-300 bg-gray-100 text-gray-700"}`}>
      {mode}
    </span>
  );
}

function FixtureBadge({ mode }: { mode: string }) {
  if (mode !== "fixture") return null;
  return (
    <span
      className="inline-block rounded border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
      title="Fixture evidence — NOT live provider output"
    >
      FIXTURE
    </span>
  );
}

export function VisualAssetsPage({ projectId }: { projectId: string }) {
  const [ws, setWs] = useState<VisualWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [promptDigestInputs, setPromptDigestInputs] = useState<Record<string, string>>({});
  const [sourceVersionInputs, setSourceVersionInputs] = useState<Record<string, string>>({});
  const [downgradeConfirm, setDowngradeConfirm] = useState<Record<string, boolean>>({});
  const [finalCandidate, setFinalCandidate] = useState<DesignCandidateView | null>(null);
  const [finalReviewNotes, setFinalReviewNotes] = useState("fixture acceptance — final design freeze");

  const load = useCallback(async () => {
    try {
      setWs(await visualApi.workspace(projectId));
      setError(null);
    } catch (err) {
      setError(visualErrorMessage(err, "Failed to load the visual workspace."));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);
  usePolling(load, 5000);

  const run = useCallback(
    async (fn: () => Promise<string | void>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const message = await fn();
        if (message) setNotice(message);
        await load();
      } catch (err) {
        setError(visualErrorMessage(err, "Operation failed."));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!ws) {
    return <div className="p-6 text-gray-500">{error ?? "Loading visual workspace…"}</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-2 text-lg font-semibold">Visual Assets</h2>
        <p className="text-sm text-gray-600">
          Final visual asset resolution: every design slot resolved with the best available approved asset — real
          photography preferred, deterministic transforms before AI, full generation only for non-documentary slots.
        </p>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">{notice}</div>
      )}

      <div className="rounded border p-4">
        <h3 className="mb-2 font-medium">Visual Provider</h3>
        <div className="flex items-center gap-2 text-sm">
          <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${ws.provider.preflight.configured ? "border-green-300 bg-green-100 text-green-800" : "border-red-300 bg-red-100 text-red-800"}`}>
            {ws.provider.preflight.configured ? "configured" : "not configured"}
          </span>
          <FixtureBadge mode={ws.provider.providerMode} />
          {ws.provider.preflight.reason && <span className="text-gray-600">{ws.provider.preflight.reason}</span>}
        </div>
        <div className="mt-2 text-xs text-gray-500">
          Budget today: ${((ws.budget.accountedTodayMicros + ws.budget.activeReservationMicros) / 1_000_000).toFixed(2)} reserved/accounted
        </div>
      </div>

      {!ws.plan && (
        <div className="rounded border p-4">
          <button
            className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            disabled={busy}
            onClick={() => run(async () => {
              const plan = await visualApi.derivePlan(projectId);
              return `Visual plan v${plan.version} derived (${shortDigest(plan.planDigest)}).`;
            })}
          >
            Derive visual plan
          </button>
          <p className="mt-2 text-xs text-gray-500">Requires a current, non-stale accepted design.</p>
        </div>
      )}

      {ws.plan && (
        <div className="rounded border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">Plan v{ws.plan.version}</h3>
            <StalenessBadge stale={ws.plan.stale} reason={ws.plan.staleReason} />
            <FixtureBadge mode={ws.plan.designProviderMode} />
            <span className="text-xs text-gray-500">design v{ws.plan.designArtifactVersion} · {shortDigest(ws.plan.designCandidateDigest)}</span>
          </div>
          <button
            className="mt-2 rounded border px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            disabled={busy}
            onClick={() => run(async () => {
              const plan = await visualApi.derivePlan(projectId);
              return `Visual plan re-derived (v${plan.version}).`;
            })}
          >
            Re-derive visual plan
          </button>
        </div>
      )}

      {ws.plan && ws.slots.length > 0 && !ws.acceptedSet && (
        <div className="space-y-4">
          {ws.slots.every((s) => s.resolved) && (
            <button
              className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const set = await visualApi.acceptSet(projectId, ws.plan!.id);
                  return `Accepted Visual Asset Set v${set.version} (${shortDigest(set.setDigest)}). The accepted design is now intentionally stale — run the final design pass to freeze.`;
                })
              }
            >
              Accept visual asset set
            </button>
          )}
          {ws.slots.map((slot) => (
            <VisualSlotCard
              key={slot.slot}
              projectId={projectId}
              planId={ws.plan!.id}
              slot={slot}
              busy={busy}
              run={run}
              promptDigestInput={promptDigestInputs[slot.slot] ?? ""}
              setPromptDigestInput={(value) => setPromptDigestInputs((prev) => ({ ...prev, [slot.slot]: value }))}
              sourceVersionInput={sourceVersionInputs[slot.slot] ?? ""}
              setSourceVersionInput={(value) => setSourceVersionInputs((prev) => ({ ...prev, [slot.slot]: value }))}
              downgradeConfirm={downgradeConfirm[slot.slot] ?? false}
              setDowngradeConfirm={(value) => setDowngradeConfirm((prev) => ({ ...prev, [slot.slot]: value }))}
            />
          ))}
        </div>
      )}

      {ws.acceptedSet && (
        <div className="space-y-4">
          <div className="rounded border border-green-300 bg-green-50 p-4">
            <h3 className="font-medium text-green-900">Accepted Visual Asset Set v{ws.acceptedSet.version}</h3>
            <p className="mt-1 text-xs text-gray-600">
              Set digest {shortDigest(ws.acceptedSet.setDigest)} · mode: {ws.acceptedSet.providerMode} · accepted {ws.acceptedSet.acceptedAt}
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {ws.acceptedSet.slots.map((s) => (
                <li key={s.slot} className="flex items-center gap-2">
                  <ModeBadge mode={s.resolutionMode} />
                  <span>{s.slot} → {s.pageSlug}/{s.role} (v {shortDigest(s.versionId)})</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded border border-indigo-200 bg-indigo-50/50 p-4 space-y-3">
            <h3 className="font-medium text-indigo-950">Final Design Pass &amp; Freeze</h3>
            <p className="text-xs text-gray-600">
              Re-binds the accepted design system to the actual approved visual assets in Run 5,
              eliminating design staleness and freezing design authority for page implementation.
            </p>
            {ws.finalDesignPass?.frozen ? (
              <div className="rounded bg-green-100 p-3 text-sm text-green-900 font-medium">
                ✓ Design frozen (Accepted design v{ws.finalDesignPass.acceptedDesignVersion} is UP_TO_DATE with actual visual assets).
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const candidate = await visualApi.runFinalDesignPass(projectId);
                      setFinalCandidate(candidate);
                      if (candidate.providerMode === "fixture") {
                        setFinalReviewNotes("fixture acceptance — final design freeze");
                      }
                      return `Final design pass complete: candidate ${shortDigest(candidate.candidateDigest)} generated with actual assets.`;
                    })
                  }
                >
                  Run final design pass
                </button>
                {finalCandidate && (
                  <div className="rounded border border-gray-300 bg-white p-3 space-y-2">
                    <p className="text-xs font-mono text-gray-700">Candidate digest: {finalCandidate.candidateDigest}</p>
                    <div>
                      <label htmlFor="final-design-review-notes" className="block text-xs font-medium text-gray-700 mb-1">
                        Review notes:
                      </label>
                      <input
                        id="final-design-review-notes"
                        type="text"
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs"
                        value={finalReviewNotes}
                        onChange={(e) => setFinalReviewNotes(e.target.value)}
                        placeholder="Review notes (e.g. fixture acceptance — final design freeze)"
                      />
                    </div>
                    <button
                      className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const notes =
                            finalReviewNotes ||
                            (finalCandidate.providerMode === "fixture"
                              ? "fixture acceptance — final design freeze"
                              : "Approved final design freeze");
                          const accepted = await visualApi.acceptFinalDesign(projectId, {
                            candidateId: finalCandidate.id,
                            expectedCandidateDigest: finalCandidate.candidateDigest,
                            reviewNotes: notes,
                          });
                          setFinalCandidate(null);
                          return `Final design accepted (v${accepted.version})! Design authority frozen with actual assets.`;
                        })
                      }
                    >
                      Accept and freeze design
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function VisualSlotCard({
  projectId,
  planId,
  slot,
  busy,
  run,
  promptDigestInput,
  setPromptDigestInput,
  sourceVersionInput,
  setSourceVersionInput,
  downgradeConfirm,
  setDowngradeConfirm,
}: {
  projectId: string;
  planId: string;
  slot: VisualSlotView;
  busy: boolean;
  run: (fn: () => Promise<string | void>) => Promise<void>;
  promptDigestInput: string;
  setPromptDigestInput: (value: string) => void;
  sourceVersionInput: string;
  setSourceVersionInput: (value: string) => void;
  downgradeConfirm: boolean;
  setDowngradeConfirm: (value: boolean) => void;
}) {
  return (
    <div className="rounded border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{slot.slot}</h3>
        <span className="text-xs text-gray-500">{slot.pageSlug}/{slot.role} · {slot.aspectRatio}</span>
        {slot.resolved && (
          <span className="inline-block rounded border border-green-300 bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
            resolved
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-gray-600">{slot.requirement}</p>
      <p className="mt-1 text-xs text-gray-500">
        Proposal: {slot.truthClassProposal} — {slot.truthClassRationale}
      </p>

      {/* Truth-class confirmation (classification authority) */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-xs font-medium text-gray-700" htmlFor={`truth-${slot.slot}`}>
          Truth class
        </label>
        <select
          id={`truth-${slot.slot}`}
          className="rounded border px-2 py-1 text-sm"
          value={slot.truthClass ?? slot.truthClassProposal}
          disabled={busy || slot.resolved}
          onChange={(e) =>
            run(async () => {
              await visualApi.classify(projectId, planId, slot.slot, e.target.value);
              return `Truth class for ${slot.slot} confirmed: ${e.target.value}.`;
            })
          }
        >
          {TRUTH_CLASSES.map((tc) => (
            <option key={tc} value={tc}>{tc}</option>
          ))}
        </select>
        {slot.truthClass && (
          <span className="text-xs text-green-700">confirmed</span>
        )}
      </div>

      {/* Prompt snapshot state + approve */}
      {slot.promptSnapshot && (
        <div className="mt-3 rounded bg-gray-50 p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Prompt snapshot</span>
            <span
              className="font-mono text-gray-500"
              data-prompt-digest={slot.promptSnapshot.digest}
              title={`Full prompt digest: ${slot.promptSnapshot.digest}`}
            >
              {slot.promptSnapshot.operation} · {shortDigest(slot.promptSnapshot.digest)}
            </span>
            <span className={`inline-block rounded border px-2 py-0.5 font-medium ${slot.promptSnapshot.approvalState === "approved" ? "border-green-300 bg-green-100 text-green-800" : "border-amber-300 bg-amber-100 text-amber-800"}`}>
              {slot.promptSnapshot.approvalState}
            </span>
          </div>
          {slot.promptSnapshot.approvalState === "pending" && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                className="w-64 rounded border px-2 py-1 font-mono text-xs"
                placeholder={`Confirm digest ${shortDigest(slot.promptSnapshot.digest)}`}
                value={promptDigestInput}
                onChange={(e) => setPromptDigestInput(e.target.value)}
              />
              <button
                type="button"
                className="rounded border px-2 py-1 text-xs font-mono text-gray-600 hover:bg-gray-100"
                title="Copy the exact prompt digest"
                onClick={() => void navigator.clipboard?.writeText(slot.promptSnapshot!.digest).catch(() => undefined)}
              >
                copy
              </button>
              <button
                className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await visualApi.approvePrompt(projectId, slot.promptSnapshot!.id, promptDigestInput.trim());
                    return `Prompt snapshot approved for ${slot.slot}.`;
                  })
                }
              >
                Approve exact digest
              </button>
            </div>
          )}
        </div>
      )}

      {/* Resolution actions */}
      {!slot.resolved && slot.truthClass && (
        <div className="mt-3 space-y-2">
          {slot.existingVersionId && (
            <button
              className="rounded border border-green-300 bg-green-50 px-3 py-1 text-xs font-medium text-green-800 hover:bg-green-100 disabled:opacity-50"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await visualApi.resolveReuse(projectId, planId, slot.slot, slot.existingVersionId ?? undefined);
                  return `Slot ${slot.slot} reuses approved version ${shortDigest(r.versionId)} (zero provider spend).`;
                })
              }
            >
              Reuse existing approved asset
            </button>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="w-56 rounded border px-2 py-1 text-xs"
              placeholder="Source AssetVersion id (for edit/transform)"
              value={sourceVersionInput}
              onChange={(e) => setSourceVersionInput(e.target.value)}
            />
            <button
              className="rounded border px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              disabled={busy || !sourceVersionInput.trim()}
              onClick={() =>
                run(async () => {
                  const r = await visualApi.resolveTransform(projectId, planId, slot.slot, {
                    sourceVersionId: sourceVersionInput.trim(),
                    aspectRatioCrop: slot.aspectRatio === "16:9" ? "16:9" : "3:2",
                    maxWidth: slot.minDimensions.width,
                  });
                  return `Slot ${slot.slot} resolved via deterministic transform (${r.transformation ?? "identity"}).`;
                })
              }
            >
              Deterministic transform (no AI)
            </button>
            {slot.promptSnapshot?.approvalState !== "approved" && (
              <button
                className="rounded border px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const needsSource = slot.truthClass === "documentary" || slot.truthClass === "documentary_edited";
                    if (needsSource && !sourceVersionInput.trim()) {
                      throw new Error("Documentary slots require an exact source AssetVersion for AI edit.");
                    }
                    const snapshot = await visualApi.compilePrompt(
                      projectId,
                      planId,
                      slot.slot,
                      needsSource ? "edit" : "generate",
                      needsSource ? sourceVersionInput.trim() : undefined,
                    );
                    return `Prompt snapshot compiled for ${slot.slot} (${shortDigest(snapshot.promptDigest)}) — review and approve before generating.`;
                  })
                }
              >
                Compile prompt snapshot
              </button>
            )}
            {slot.promptSnapshot?.approvalState === "approved" && slot.candidates.length === 0 && (
              <button
                className="rounded bg-orange-600 px-3 py-1 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const needsSource = slot.truthClass === "documentary" || slot.truthClass === "documentary_edited";
                    const result = await visualApi.generate(
                      projectId,
                      planId,
                      slot.slot,
                      needsSource ? sourceVersionInput.trim() || undefined : undefined,
                    );
                    return result.reused
                      ? `Existing candidates reused for ${slot.slot} (dedup — no second provider call).`
                      : `${result.candidates.length} candidate(s) generated for ${slot.slot} (${result.providerMode}/${result.model}).`;
                  })
                }
              >
                Generate candidates
              </button>
            )}
          </div>
        </div>
      )}

      {/* Candidates */}
      {slot.candidates.length > 0 && (
        <div className="mt-3 space-y-2">
          <h4 className="text-xs font-semibold text-gray-700">Candidates</h4>
          {slot.candidates.map((candidate) => (
            <div key={candidate.id} className="rounded border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <img
                  src={visualApi.candidateUrl(projectId, candidate.id)}
                  alt={`Candidate ${candidate.candidateIndex} for ${slot.slot}`}
                  className="h-16 w-24 rounded border object-cover"
                />
                <div className="space-y-0.5">
                  <div>
                    <ModeBadge mode={candidate.providerMode === "fixture" ? "ai_generate" : candidate.model.includes("pro") ? "ai_generate" : "ai_edit"} />
                    <FixtureBadge mode={candidate.providerMode} />
                    <span className="ml-1 font-mono">{shortDigest(candidate.binaryDigest)}</span>
                  </div>
                  <div className="text-gray-500">
                    {candidate.width}×{candidate.height} · {candidate.mediaType} · C2PA: {candidate.c2paStatus}
                  </div>
                  <div className="text-gray-500">
                    parents: {candidate.parentLineage.map((p) => shortDigest(p.versionId)).join(", ") || "none (generated)"}
                  </div>
                </div>
                {candidate.state === "pending" && !slot.resolved && (
                  <div className="ml-auto space-y-1">
                    {(slot.truthClass === "documentary") && (
                      <label className="flex items-center gap-1 text-[11px] text-amber-700">
                        <input
                          type="checkbox"
                          checked={downgradeConfirm}
                          onChange={(e) => setDowngradeConfirm(e.target.checked)}
                        />
                        Reclassify as documentary_edited
                      </label>
                    )}
                    <button
                      className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const r = await visualApi.acceptCandidate(
                            projectId,
                            planId,
                            slot.slot,
                            candidate.id,
                            candidate.binaryDigest,
                            downgradeConfirm || undefined,
                          );
                          return `Slot ${slot.slot} accepted: version ${shortDigest(r.versionId)} approved and assigned (${r.truthClass}).`;
                        })
                      }
                    >
                      Accept candidate
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Accepted resolution */}
      {slot.acceptedResolution && (
        <div className="mt-3 rounded bg-green-50 p-2 text-xs text-green-900">
          <ModeBadge mode={slot.acceptedResolution.resolutionMode} />
          <span className="ml-2">version {shortDigest(slot.acceptedResolution.versionId)} · assigned to {slot.pageSlug}/{slot.role}</span>
        </div>
      )}
    </div>
  );
}
