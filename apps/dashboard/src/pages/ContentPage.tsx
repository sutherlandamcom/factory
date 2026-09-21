import { useState, useEffect, useCallback } from "react";
import { writerApi, OperatorApiError, type WriterWorkspace, type WriterQaView, type AcceptedContentView } from "../api/client";
import { Section } from "../components/Section";
import { StatusBadge } from "../components/StatusBadge";
import { useQueryClient } from "@tanstack/react-query";
import { usePolling } from "../hooks/usePolling";
import { queryKeys } from "../query/keys";

/**
 * Content workspace (Macro Run 4): operator surface over the writer pipeline.
 * Brief editor (Page Target fields) with full lineage display, Factory Writer
 * Policy approval, exact-digest WriterPromptSnapshot preview + approval,
 * proposal view with the three deterministic QA verdicts, and the ACCEPT
 * CONTENT action. The backend enforces every gate; UI buttons are not
 * governance.
 */

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof OperatorApiError) return e.message;
  return fallback;
}

const VERDICT_STYLES: Record<string, string> = {
  PASS: "bg-green-100 text-green-800",
  REVIEW: "bg-amber-100 text-amber-800",
  FAIL: "bg-red-100 text-red-800",
};

function VerdictBadge({ verdict }: { verdict: string }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${VERDICT_STYLES[verdict] ?? "bg-gray-100 text-gray-800"}`}>
      {verdict}
    </span>
  );
}

function Digest({ digest }: { digest: string }) {
  return <code className="text-xs break-all text-gray-500">{digest}</code>;
}

export function ContentPage({ projectId }: { projectId: string }) {
  const [inspectedContent, setInspectedContent] = useState<AcceptedContentView | null>(null);
  const [initialWorkspaceLoaded, setInitialWorkspaceLoaded] = useState(false);
  useEffect(() => {
    setInspectedContent(null);
    setInitialWorkspaceLoaded(false);
  }, [projectId]);
  const [ws, setWs] = useState<WriterWorkspace | null>(null);
  const [qa, setQa] = useState<WriterQaView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    archetype: "",
    slug: "",
    title: "",
    objective: "",
    audience: "",
    structureGuidance: "",
    internalLinkIntent: "",
    ctaIntent: "",
  });
  const [keyPoints, setKeyPoints] = useState("");
  const [noGapAck, setNoGapAck] = useState(false);

  const loadWorkspace = useCallback(async () => {
    try {
      const data = await writerApi.workspace(projectId);
      setWs(data);
      if (data.brief.latest) {
        const pt = data.brief.latest.pageTarget;
        setForm({
          archetype: pt.designBinding?.archetype ?? "",
          slug: pt.slug,
          title: pt.title,
          objective: pt.objective,
          audience: pt.audience,
          structureGuidance: pt.structureGuidance.join("\n"),
          internalLinkIntent: pt.internalLinkIntent.join("\n"),
          ctaIntent: pt.ctaIntent,
        });
        setNoGapAck(Boolean(data.brief.latest.noGapLineageAcknowledged));
      }
      setInitialWorkspaceLoaded(true);
    } catch (e) {
      setError(errorMessage(e, "Content workspace failed to load."));
    }
  }, [projectId]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);
  usePolling(loadWorkspace, 10000);

  const run = async (action: () => Promise<string | void>, fallback: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      if (typeof message === "string") setNotice(message);
      await loadWorkspace();
    } catch (e) {
      setError(errorMessage(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const splitLines = (value: string): string[] =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  const brief = ws?.brief.latest ?? null;
  const policy = ws?.policy.latest ?? null;
  const snapshot = ws?.snapshot.latest ?? null;
  const queryClient = useQueryClient();
  const proposal = ws?.proposal.latest ?? null;
  const accepted = inspectedContent ?? ws?.accepted.latest ?? null;
  const acceptedCopy = accepted?.data as { title?: string; introduction?: string; sections?: Array<{ heading: string; body: string }>; conclusion?: string; cta?: string } | undefined;

  return (
    <div className="space-y-6">
      {ws?.devModelOverride?.active && (
        <div className="rounded-md bg-amber-50 border border-amber-300 p-3 text-sm font-medium text-amber-900">
          DEV MODEL OVERRIDE ACTIVE
          {ws.devModelOverride.roles.map((r) => (
            <span key={r.roleId} className="ml-2 font-normal">
              ({r.roleId} → {r.model} instead of champion {r.championModel})
            </span>
          ))}
          — dev-time only; forbidden in CI/acceptance/live-proof.
        </div>
      )}
      {error && <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-800">{error}</div>}
      {notice && <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm text-green-800">{notice}</div>}

      {/* 1. Factory Writer Policy */}
      <Section title="Factory Writer Policy">
        {policy === null ? (
          <div className="space-y-2">
            <p className="text-sm text-gray-600">
              Derives the non-negotiable writing rules from the accepted Content Constitution. Approve the exact digest to
              make it immutable.
            </p>
            <button
              onClick={() =>
                run(async () => {
                  await writerApi.derivePolicyDraft(projectId);
                  return "Writer policy draft created from the accepted Content Constitution.";
                }, "Could not derive writer policy draft.")
              }
              disabled={busy}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              Derive draft
            </button>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <StatusBadge status={policy.state === "approved" ? "approved" : "draft"} />
              {policy.stale && <StatusBadge status="STALE" />}
              <span className="text-gray-500">v{policy.version}</span>
            </div>
            <div>
              Digest: <Digest digest={policy.digest} />
            </div>
            <div className="text-gray-600">
              Lineage: accepted input v{policy.lineage.acceptedInputSnapshotVersion} (<Digest digest={policy.lineage.acceptedInputDigest} />)
            </div>
            {policy.staleReason && <div className="text-amber-700">Stale: {policy.staleReason}</div>}
            {policy.state === "draft" && !policy.stale && (
              <button
                onClick={() =>
                  run(async () => {
                    await writerApi.approvePolicy(projectId, {
                      policyId: policy.id,
                      expectedVersion: policy.version,
                      expectedDigest: policy.digest,
                    });
                    return `Writer policy v${policy.version} approved and immutable.`;
                  }, "Writer policy approval rejected.")
                }
                disabled={busy}
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Approve exact digest
              </button>
            )}
          </div>
        )}
      </Section>

      {/* 2. Content Production Brief */}
      <Section title="Content Production Brief">
        <fieldset disabled={busy || !initialWorkspaceLoaded} className="space-y-3 text-sm border-0 p-0 m-0">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="block">
              <span className="text-gray-700">Slug</span>
              <input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
                placeholder="roof-replacement-denver"
              />
            </label>
            <label className="block">
              <span className="text-gray-700">Title</span>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-gray-700">Page archetype</span>
            <select aria-label="Page archetype" value={form.archetype} onChange={(e) => setForm({ ...form, archetype: e.target.value })} className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5">
              <option value="">Select before design generation</option>
              <option value="homepage">Homepage</option><option value="service">Service</option><option value="location">Location</option><option value="editorial">Editorial</option><option value="investment_advisory">Investment advisory</option>
            </select>
          </label>
          <label className="block">
            <span className="text-gray-700">Objective</span>
            <textarea
              value={form.objective}
              onChange={(e) => setForm({ ...form, objective: e.target.value })}
              rows={2}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
            />
          </label>
          <label className="block">
            <span className="text-gray-700">Audience</span>
            <textarea
              value={form.audience}
              onChange={(e) => setForm({ ...form, audience: e.target.value })}
              rows={2}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
            />
          </label>
          <label className="block">
            <span className="text-gray-700">Structure guidance (one per line)</span>
            <textarea
              value={form.structureGuidance}
              onChange={(e) => setForm({ ...form, structureGuidance: e.target.value })}
              rows={3}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
            />
          </label>
          <label className="block">
            <span className="text-gray-700">Internal link intent (one per line)</span>
            <textarea
              value={form.internalLinkIntent}
              onChange={(e) => setForm({ ...form, internalLinkIntent: e.target.value })}
              rows={2}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
            />
          </label>
          <label className="block">
            <span className="text-gray-700">CTA intent</span>
            <input
              value={form.ctaIntent}
              onChange={(e) => setForm({ ...form, ctaIntent: e.target.value })}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
            />
          </label>
          <label className="block">
            <span className="text-gray-700">Key points (transitional, one per line)</span>
            <textarea
              value={keyPoints}
              onChange={(e) => setKeyPoints(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={noGapAck} onChange={(e) => setNoGapAck(e.target.checked)} />
            Explicitly draft/approve WITHOUT accepted gap lineage (acknowledgement is persisted and digest-bound)
          </label>
          <button
            onClick={() =>
              run(async () => {
                const result = await writerApi.saveBriefDraft(projectId, {
                  pageTarget: {
                    ...(form.archetype ? { designBinding: { schemaVersion: "page-design-binding-v1" as const, archetype: form.archetype as "homepage" | "service" | "location" | "editorial" | "investment_advisory" } } : {}),
                    slug: form.slug,
                    title: form.title,
                    objective: form.objective,
                    audience: form.audience,
                    structureGuidance: splitLines(form.structureGuidance),
                    internalLinkIntent: splitLines(form.internalLinkIntent),
                    ctaIntent: form.ctaIntent,
                  },
                  contentBriefKeyPoints: splitLines(keyPoints),
                  ...(brief && brief.state === "draft" ? { expectedRevision: brief.version } : {}),
                  ...(noGapAck ? { noGapLineageAcknowledged: true } : {}),
                });
                return `Brief draft v${result.version} saved (digest ${result.digest.slice(0, 12)}…).`;
              }, "Brief draft rejected.")
            }
            disabled={busy || !initialWorkspaceLoaded}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {brief && brief.state === "draft" ? "Update draft" : "Create draft"}
          </button>

          {brief && (
            <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
              <div className="flex items-center gap-2">
                <StatusBadge status={brief.state === "approved" ? "approved" : "draft"} />
                {brief.stale && <StatusBadge status="STALE" />}
                <span className="text-gray-500">v{brief.version}</span>
                {brief.noGapLineageAcknowledged && (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                    NO GAP LINEAGE — EXPLICIT OPERATOR ACKNOWLEDGEMENT
                  </span>
                )}
              </div>
              <div className="mt-2">
                Digest: <Digest digest={brief.digest} />
              </div>
              <div className="mt-1 text-gray-600">
                Lineage: input v{String((brief.lineage as Record<string, unknown>).acceptedInputSnapshotVersion ?? "?")} · policy v
                {String((brief.lineage as Record<string, unknown>).writerPolicyVersion ?? "?")} ·{" "}
                {(brief.lineage as Record<string, unknown>).gapSnapshotDigest
                  ? "gap " + String((brief.lineage as Record<string, unknown>).gapSnapshotDigest).slice(0, 12) + "…"
                  : "no gap lineage"}
              </div>
              {brief.staleReason && <div className="mt-1 text-amber-700">Stale: {brief.staleReason}</div>}
              {brief.state === "draft" && !brief.stale && (
                <div className="mt-2 space-y-2">
                  <button
                    onClick={() =>
                      run(async () => {
                        await writerApi.approveBrief(projectId, {
                          briefId: brief.id,
                          expectedVersion: brief.version,
                          expectedDigest: brief.digest,
                          ...(noGapAck ? { noGapLineageAcknowledged: true } : {}),
                        });
                        return `Brief v${brief.version} approved.`;
                      }, "Brief approval rejected.")
                    }
                    disabled={busy || !initialWorkspaceLoaded}
                    className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    Approve exact digest
                  </button>
                </div>
              )}
            </div>
          )}
        </fieldset>
      </Section>

      {/* 3. WriterPromptSnapshot */}
      <Section title="Writer Prompt Snapshot">
        {snapshot === null ? (
          <div className="space-y-2">
            <p className="text-sm text-gray-600">Compile the exact prompt packet from the approved brief.</p>
            <button
              onClick={() =>
                run(async () => {
                  const s = await writerApi.compileSnapshot(projectId);
                  return `Snapshot v${s.version} compiled (digest ${s.digest.slice(0, 12)}…).`;
                }, "Snapshot compilation failed.")
              }
              disabled={busy}
              className="rounded-md bg-gray-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
            >
              Compile new snapshot
            </button>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <StatusBadge status={snapshot.state === "approved" ? "approved" : "draft"} />
              {snapshot.stale && <StatusBadge status="STALE" />}
              <span className="text-gray-500">v{snapshot.version}</span>
            </div>
            <div>
              Digest: <Digest digest={snapshot.digest} />
            </div>
            {snapshot.staleReason && <div className="text-amber-700">Stale: {snapshot.staleReason}</div>}
            <details className="rounded border border-gray-200 bg-gray-50 p-2">
              <summary className="cursor-pointer text-gray-700">Review exact prompt packet</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-gray-700">{snapshot.systemPrompt}</pre>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-gray-700">{snapshot.userPrompt}</pre>
            </details>
            <div className="flex gap-2">
              <button
                onClick={() =>
                  run(async () => {
                    const s = await writerApi.compileSnapshot(projectId);
                    return `Snapshot v${s.version} compiled (digest ${s.digest.slice(0, 12)}…).`;
                  }, "Snapshot compilation failed.")
                }
                disabled={busy}
                className="rounded-md bg-gray-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
              >
                {snapshot.state === "draft" ? "Recompile draft" : "Compile new snapshot"}
              </button>
              {snapshot.state === "draft" && !snapshot.stale && (
                <button
                  onClick={() =>
                    run(async () => {
                      await writerApi.approveSnapshot(projectId, {
                        snapshotId: snapshot.id,
                        expectedVersion: snapshot.version,
                        expectedDigest: snapshot.digest,
                      });
                      return `Snapshot v${snapshot.version} approved. Generation is now authorized for this exact digest.`;
                    }, "Snapshot approval rejected.")
                  }
                  disabled={busy}
                  className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  Approve exact digest
                </button>
              )}
            </div>
          </div>
        )}
      </Section>

      {/* 4. Proposal + QA */}
      <Section title="Proposal & QA">
        {proposal === null && (
          <div className="space-y-2">
            <p className="text-sm text-gray-600">
              {snapshot?.state === "approved" && !snapshot.stale
                ? "Generate a proposal from the approved snapshot (budget-governed)."
                : "Approve a snapshot first — no writer call can run without an approved exact digest."}
            </p>
            {snapshot?.state === "approved" && !snapshot.stale && (
              <button
                onClick={() =>
                  run(async () => {
                    await writerApi.generate(projectId, snapshot.id);
                    return "Proposal generated from the approved snapshot.";
                  }, "Generation failed.")
                }
                disabled={busy}
                className="rounded-md bg-gray-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
              >
                Generate proposal
              </button>
            )}
          </div>
        )}
        {proposal !== null && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              {proposal.stale && <StatusBadge status="STALE" />}
              <span className="text-gray-500">v{proposal.version}</span>
              <span className="text-gray-500">
                model {proposal.model}
                {proposal.overrideApplied ? " (DEV OVERRIDE)" : ""}
              </span>
            </div>
            <div>
              Proposal digest: <Digest digest={proposal.digest} />
            </div>
            <div className="rounded border border-gray-200 p-3">
              <div className="font-semibold text-gray-900">{proposal.data.title}</div>
              <div className="text-gray-600">{proposal.data.metaDescription}</div>
              <p className="mt-2 text-gray-800">{proposal.data.introduction}</p>
              {proposal.data.sections.map((s, i) => (
                <div key={i} className="mt-2">
                  <div className="font-medium text-gray-900">{s.heading}</div>
                  <p className="text-gray-800">{s.body}</p>
                </div>
              ))}
              <p className="mt-2 text-gray-800">{proposal.data.conclusion}</p>
              <div className="mt-2 font-medium text-indigo-700">{proposal.data.cta}</div>
            </div>
            <div className="flex gap-2">
              {proposal.stale && snapshot?.state === "approved" && !snapshot.stale ? (
                /* Stale proposal: the recovery action generates a fresh
                   proposal from the CURRENT approved snapshot (the old one
                   stays visible as history). */
                <button
                  onClick={() =>
                    run(async () => {
                      await writerApi.generate(projectId, snapshot.id);
                      return "New proposal generated from the current approved snapshot.";
                    }, "Generation failed.")
                  }
                  disabled={busy}
                  className="rounded-md bg-gray-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
                >
                  Generate proposal
                </button>
              ) : (
                <button
                  onClick={() =>
                    run(async () => {
                      await writerApi.generate(projectId, proposal.snapshotId);
                      return "New proposal generated from the approved snapshot.";
                    }, "Generation failed.")
                  }
                  disabled={busy}
                  className="rounded-md bg-gray-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
                >
                  Regenerate
                </button>
              )}
              <button
                onClick={() =>
                  run(async () => {
                    const result = await writerApi.runQa(projectId);
                    setQa(result);
                    return `QA verdict: ${result.overall}`;
                  }, "QA run failed.")
                }
                disabled={busy || proposal.stale}
                className="rounded-md bg-gray-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
              >
                Run QA
              </button>
            </div>
            {qa && (
              <div className="space-y-2 rounded border border-gray-200 bg-gray-50 p-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-900">Overall:</span> <VerdictBadge verdict={qa.overall} />
                </div>
                {(
                  [
                    ["Factual", qa.factual],
                    ["Search", qa.search],
                    ["Editorial", qa.editorial],
                  ] as const
                ).map(([label, checks]) => (
                  <div key={label}>
                    <div className="font-medium text-gray-800">{label}</div>
                    <ul className="ml-4 list-disc space-y-1">
                      {checks.map((c) => (
                        <li key={c.checkId}>
                          <VerdictBadge verdict={c.verdict} /> <span className="text-gray-700">{c.checkId}</span> —{" "}
                          <span className="text-gray-600">{c.detail}</span>
                          {c.evidence.length > 0 && (
                            <span className="text-gray-500"> [{c.evidence.map((ev) => ev.ref).join(", ")}]</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() =>
                run(async () => {
                  const result = await writerApi.acceptContent(projectId, {
                    proposalId: proposal.id,
                    expectedProposalDigest: proposal.digest,
                  });
                  // Content acceptance mutates downstream authority: the
                  // derived workflow read model must refetch everywhere
                  // (the layout header keeps the query observer active, so
                  // navigation alone would never trigger a refetch).
                  await queryClient.invalidateQueries({ queryKey: queryKeys.workflow(projectId) });
                  await queryClient.invalidateQueries({ queryKey: queryKeys.versions(projectId) });
                  return `AcceptedPageContent v${result.version} created for ${result.slug}.`;
                }, "Acceptance rejected.")
              }
              disabled={busy || proposal.stale}
              className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-800 disabled:opacity-50"
            >
              ACCEPT CONTENT
            </button>
          </div>
        )}
      </Section>

      {/* 5. Accepted content */}
      {accepted && (
        <Section title="Accepted Page Content">
          <div className="flex flex-wrap gap-2 mb-3" aria-label="Accepted content versions">
            {ws?.accepted.versions?.map(version => (
              <button key={version.id} className="rounded border px-2 py-1 text-sm" onClick={() => {
                void writerApi.acceptedDetail(projectId, version.id).then(setInspectedContent).catch(error => setError(errorMessage(error, "Could not load accepted content.")));
              }}>Inspect {version.slug} v{version.version}</button>
            ))}
          </div>
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              <StatusBadge status="accepted" />
              <span className="text-gray-500">v{accepted.version}</span>
              {accepted.lineageQualification !== "complete" && <span className="text-amber-700">Incomplete lineage: {accepted.lineageQualification ?? "unqualified"}</span>}
              <span className="text-gray-500">{accepted.slug}</span>
            </div>
            <div>
              Digest: <Digest digest={accepted.digest} />
            </div>
            <div className="text-gray-500">
              Proposal: <Digest digest={accepted.proposalDigest} /> · QA report: <Digest digest={accepted.qaReportDigest} />
            </div>
            <div className="text-gray-500">Accepted at {accepted.acceptedAt}</div>
            {acceptedCopy ? <article className="mt-4 space-y-3">
              <h3 className="font-semibold">{acceptedCopy.title}</h3>
              <p>{acceptedCopy.introduction}</p>
              {acceptedCopy.sections?.map((section, index) => <section key={index}><h4 className="font-medium">{section.heading}</h4><p className="whitespace-pre-wrap">{section.body}</p></section>)}
              <p>{acceptedCopy.conclusion}</p><p>{acceptedCopy.cta}</p>
            </article> : null}
          </div>
        </Section>
      )}
    </div>
  );
}
