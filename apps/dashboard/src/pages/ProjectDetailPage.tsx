import { useState, useEffect, useCallback } from "react";
import { api, OperatorApiError } from "../api/client";
import type { ProjectOperatorWorkspace } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { Section } from "../components/Section";
import { Field } from "../components/Field";
import { usePolling } from "../hooks/usePolling";

const TABS = [
  "Overview", "Business", "Offering", "Audience", "Markets", "Site Identity",
  "Conversion", "Evidence & Claims", "Search Seeds", "Competitors", "Brand",
  "References", "Assets", "Constraints", "Content Constitution", "Review",
  "Versions",
] as const;

type Tab = (typeof TABS)[number];

export function ProjectDetailPage({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [ws, setWs] = useState<ProjectOperatorWorkspace | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      const w = await api.getWorkspace(projectId);
      setWs(w);
      // Keep local edits when polling refreshes; adopt the server payload
      // when the form is empty (fresh project) or belongs to another revision.
      setForm((prev: any) => prev ?? w.currentDraft?.payload ?? null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const saveDraft = async () => {
    if (!ws) return;
    setBusy(true); setError(null);
    try {
      await api.saveDraft(projectId, { baseRevision: ws.currentDraft.revision, payload: form });
      await load();
    } catch (e: unknown) {
      if (e instanceof OperatorApiError) {
        if (e.code === "intake_stale_revision") {
          setError("Draft changed elsewhere — reloading the latest version.");
        } else if (e.code === "validation_error" || e.code === "intake_schema_invalid") {
          setError(e.message);
        } else {
          setError(e.message);
        }
      } else {
        setError(e instanceof Error ? e.message : "Save failed.");
      }
      await load();
    } finally { setBusy(false); }
  };

  const acceptInputs = async () => {
    if (!ws?.currentDraft?.digest) return;
    setBusy(true); setError(null);
    try {
      await api.accept(projectId, {
        expectedRevision: ws.currentDraft.revision,
        expectedDigest: ws.currentDraft.digest,
      });
      await load();
    } catch (e: unknown) {
      if (e instanceof OperatorApiError) {
        if (e.code === "intake_blocked") {
          setError("Acceptance blocked: resolve the listed blockers first.");
        } else if (e.code === "intake_revision_mismatch" || e.code === "intake_digest_mismatch") {
          setError("Inputs changed since review — re-check the draft and accept again.");
        } else {
          setError(e.message);
        }
      } else {
        setError(e instanceof Error ? e.message : "Accept failed.");
      }
      await load();
    } finally { setBusy(false); }
  };

  if (!ws) return <div className="p-8 text-gray-500">{error ?? "Loading…"}</div>;

  const { project, currentDraft, readiness, currentAcceptedSnapshot, history, draftDiffersFromAccepted, status } = ws;

  return (
    <div className="mx-auto max-w-6xl p-8">
      <button onClick={onBack} className="mb-4 text-sm text-gray-500 hover:text-gray-800">&larr; All projects</button>
      <div className="flex items-center gap-4 mb-6">
        <h1 className="text-2xl font-bold">{project.name}</h1>
        <StatusBadge status={status} />
        <span className="text-sm text-gray-500">/ {project.key}</span>
      </div>

      {error && <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="mb-6 grid grid-cols-4 gap-4">
        <div className="rounded-lg bg-white border p-4">
          <div className="text-xs uppercase text-gray-500">Accepted Version</div>
          <div className="text-lg font-bold">{currentAcceptedSnapshot ? `v${currentAcceptedSnapshot.version}` : "—"}</div>
        </div>
        <div className="rounded-lg bg-white border p-4">
          <div className="text-xs uppercase text-gray-500">Draft Revision</div>
          <div className="text-lg font-bold">{currentDraft?.revision ?? "—"}</div>
        </div>
        <div className="rounded-lg bg-white border p-4">
          <div className="text-xs uppercase text-gray-500">Draft Digest</div>
          <div className="text-sm font-mono truncate">{currentDraft?.digest ?? "—"}</div>
        </div>
        <div className={`rounded-lg border p-4 ${draftDiffersFromAccepted ? "bg-amber-50 border-amber-300" : "bg-white"}`}>
          <div className="text-xs uppercase text-gray-500">State</div>
          <div className="text-lg font-bold">{draftDiffersFromAccepted ? "CHANGED SINCE ACCEPTANCE" : status}</div>
        </div>
      </div>

      {draftDiffersFromAccepted && (
        <div className="mb-4 rounded-md bg-amber-50 border border-amber-300 p-3 text-sm text-amber-800">
          ⚠ Draft differs from accepted v{currentAcceptedSnapshot?.version}. Save &amp; accept to update.
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium ${tab === t ? "bg-indigo-600 text-white" : "bg-white border text-gray-700 hover:bg-gray-50"}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        {tab === "Overview" && <Overview ws={ws} />}
        {tab === "Review" && <Review ws={ws} onAccept={acceptInputs} busy={busy} />}
        {tab === "Versions" && <History history={history} currentAccepted={currentAcceptedSnapshot} />}
        {tab === "Content Constitution" && <Constitution form={form} setForm={setForm} />}
        {["Business","Offering","Audience","Markets","Site Identity","Conversion","Evidence & Claims","Search Seeds","Competitors","Brand","References","Assets","Constraints"].includes(tab) && (
          <GenericForm tab={tab} form={form} setForm={setForm} />
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={saveDraft}
          disabled={busy || !form}
          className="rounded-md bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
        >
          Save Draft
        </button>
        {readiness.blockers.length > 0 && (
          <div className="text-sm text-red-600">
            Blockers: {readiness.blockers.map((b) => b.code).join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}

function Overview({ ws }: { ws: ProjectOperatorWorkspace }) {
  return (
    <div className="grid grid-cols-2 gap-6">
      <dl className="space-y-3">
        <Field label="Project" value={ws.project.name} />
        <Field label="Key" value={ws.project.key} />
        <Field label="Status" value={ws.status} />
      </dl>
      <dl className="space-y-3">
        <Field label="Accepted" value={ws.currentAcceptedSnapshot ? `v${ws.currentAcceptedSnapshot.version} @ ${new Date(ws.currentAcceptedSnapshot.acceptedAt).toLocaleString()}` : "Not yet accepted"} />
        <Field label="Draft Revision" value={String(ws.currentDraft.revision)} />
        <Field label="Digest" value={ws.currentDraft.digest ?? ""} />
      </dl>
    </div>
  );
}

function Review({ ws, onAccept, busy }: { ws: ProjectOperatorWorkspace; onAccept: () => void; busy: boolean }) {
  const p = ws.currentDraft?.payload as any;
  if (!p) return <p className="text-gray-500">No draft to review.</p>;
  const blocked = ws.readiness.blockers.length > 0;

  return (
    <div className="space-y-4">
      <Section title="Business">
        <Field label="Name" value={p.business?.name} />
        <Field label="Description" value={p.business?.description} />
        <Field label="Model" value={p.business?.businessModel} />
      </Section>
      <Section title="Audience">
        <Field label="Segments" value={(p.audience?.segments ?? []).map((s: any) => s.label).join(", ")} />
        <Field label="Needs" value={(p.audience?.needs ?? []).join("; ")} />
      </Section>
      <Section title="Site Identity">
        <Field label="Site Name" value={p.siteIdentity?.siteName} />
        <Field label="Domain" value={p.siteIdentity?.candidateDomain} />
        <Field label="Language" value={p.siteIdentity?.language} />
      </Section>
      <Section title="Conversion">
        <Field label="Objective" value={p.conversion?.primaryObjective} />
        <Field label="CTA" value={p.conversion?.ctaDestination?.value} />
        <Field label="Verification" value={p.conversion?.verificationState} />
      </Section>
      <Section title="Content Constitution">
        <Field label="Brand Voice" value={p.contentConstitution?.brandVoice} />
        <Field label="Custom Writer Instructions" value={p.contentConstitution?.customWriterInstructions} />
      </Section>
      <div className="border-t pt-4">
        <div className="mb-3 text-sm text-gray-600">
          Draft revision <b>{ws.currentDraft.revision}</b> · Digest <code className="text-xs">{ws.currentDraft.digest?.slice(0, 16)}…</code>
        </div>
        {blocked && (
          <div className="mb-3 rounded-md bg-red-50 p-3 text-sm text-red-700">
            Cannot accept: {ws.readiness.blockers.map((b) => b.message).join("; ")}
          </div>
        )}
        <button
          onClick={onAccept}
          disabled={busy || blocked}
          className="rounded-md bg-green-600 px-6 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
        >
          {busy ? "Accepting…" : "ACCEPT INPUTS"}
        </button>
      </div>
    </div>
  );
}

function History({
  history,
  currentAccepted,
}: {
  history: any[];
  currentAccepted: { version: number; digest: string; acceptedAt: string; sourceRevision: number } | null;
}) {
  if (history.length === 0) return <p className="text-gray-500">No accepted versions yet.</p>;
  return (
    <div className="space-y-3">
      {history.map((s) => {
        // Exactly the latest accepted version is CURRENT ACCEPTED; older
        // versions remain inspectable in history without the badge.
        const isCurrent = currentAccepted !== null && s.version === currentAccepted.version;
        return (
          <div key={s.id ?? s.version} className={`rounded-lg border p-4 ${isCurrent ? "border-green-400 bg-green-50" : "border-gray-200"}`}>
            <div className="flex items-center justify-between">
              <div className="font-bold">
                v{s.version} {isCurrent && <span className="ml-2 text-xs bg-green-600 text-white px-2 py-0.5 rounded">CURRENT ACCEPTED</span>}
              </div>
              <div className="text-sm text-gray-500">{new Date(s.acceptedAt).toLocaleString()}</div>
            </div>
            <div className="mt-2 text-xs font-mono text-gray-600">digest: {s.digest}</div>
            <div className="text-xs text-gray-500">source revision: r{s.sourceRevision}</div>
          </div>
        );
      })}
    </div>
  );
}

function Constitution({ form, setForm }: { form: any; setForm: (f: any) => void }) {
  const c = form?.contentConstitution ?? {};
  const set = (k: string, v: any) => setForm({ ...form, contentConstitution: { ...c, [k]: v } });
  const listField = (label: string, key: string) => (
    <div key={key}>
      <label className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <textarea
        rows={2}
        value={(c[key] ?? []).join("\n")}
        onChange={(e) => set(key, e.target.value.split("\n").filter(Boolean))}
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
      />
    </div>
  );
  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Brand Voice</label>
        <textarea rows={2} value={c.brandVoice ?? ""} onChange={(e) => set("brandVoice", e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Tone</label>
        <textarea rows={2} value={c.tone ?? ""} onChange={(e) => set("tone", e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
      </div>
      {listField("Audience Communication Principles", "audiencePrinciples")}
      {listField("Writing Principles", "writingPrinciples")}
      {listField("Preferred Terminology (one per line)", "preferredTerminology")}
      {listField("Forbidden Terminology (one per line)", "forbiddenTerminology")}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Evidence / Factuality Policy</label>
        <textarea rows={2} value={c.evidencePolicy ?? ""} onChange={(e) => set("evidencePolicy", e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
      </div>
      {listField("People-First Principles", "peopleFirstPrinciples")}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Trust Expectations</label>
        <textarea rows={2} value={c.trustExpectations ?? ""} onChange={(e) => set("trustExpectations", e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
      </div>
      {listField("AI-Language to Avoid", "aiLanguageAvoidance")}
      {listField("Marketing Clichés to Avoid", "clicheAvoidance")}
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Locale / Language Preferences</label>
        <input value={c.localePreferences ?? ""} onChange={(e) => set("localePreferences", e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div>
        <label htmlFor="field-contentConstitution-customWriterInstructions" className="mb-1 block text-sm font-medium text-gray-700">
          Custom Project Writer Instructions <span className="text-red-500">*</span>
        </label>
        <textarea
          id="field-contentConstitution-customWriterInstructions"
          rows={8}
          value={c.customWriterInstructions ?? ""}
          onChange={(e) => set("customWriterInstructions", e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono"
          placeholder="Free-form instructions that apply to all content written for this project…"
        />
      </div>
    </div>
  );
}

function GenericForm({ tab, form, setForm }: { tab: string; form: any; setForm: (f: any) => void }) {
  const keyMap: Record<string, string> = {
    "Business": "business", "Offering": "business", "Audience": "audience",
    "Markets": "markets", "Site Identity": "siteIdentity", "Conversion": "conversion",
    "Evidence & Claims": "evidence", "Search Seeds": "searchSeeds", "Competitors": "searchSeeds",
    "Brand": "brand", "References": "designReferences", "Assets": "assetAvailability",
    "Constraints": "constraints",
  };
  const sectionKey = keyMap[tab];
  if (!form || !sectionKey) return null;
  const section = form[sectionKey] ?? {};
  const set = (k: string, v: any) => setForm({ ...form, [sectionKey]: { ...section, [k]: v } });

  const textField = (label: string, key: string, rows = 2) => (
    <div key={key}>
      <label htmlFor={`field-${sectionKey}-${key}`} className="mb-1 block text-sm font-medium text-gray-700">{label}</label>
      <textarea id={`field-${sectionKey}-${key}`} rows={rows} value={section[key] ?? ""} onChange={(e) => set(key, e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
    </div>
  );
  const listField = (label: string, key: string) => (
    <div key={key}>
      <label htmlFor={`field-${sectionKey}-${key}`} className="mb-1 block text-sm font-medium text-gray-700">{label} <span className="text-xs text-gray-400">(one per line)</span></label>
      <textarea id={`field-${sectionKey}-${key}`} rows={3} value={(section[key] ?? []).join("\n")} onChange={(e) => set(key, e.target.value.split("\n").filter(Boolean))} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
    </div>
  );

  switch (tab) {
    case "Business":
      return (<div className="space-y-4">
        <div><label htmlFor="field-business-name" className="mb-1 block text-sm font-medium text-gray-700">Business Name *</label>
          <input id="field-business-name" value={section.name ?? ""} onChange={(e) => set("name", e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" /></div>
        {textField("Description *", "description", 3)}
        {textField("Business Model", "businessModel")}
        {textField("Positioning", "positioning")}
        {listField("Offerings / Services", "offerings")}
        {listField("Priorities", "priorities")}
      </div>);
    case "Audience":
      return (<div className="space-y-4">
        {listField("Segments", "segments")}
        {listField("Needs", "needs")}
        {textField("Decision Context", "decisionContext")}
      </div>);
    case "Markets":
      return (<div className="space-y-4">
        {listField("Geographies", "geographies")}
        {listField("Priority Locations", "priorityLocations")}
      </div>);
    case "Site Identity":
      return (<div className="space-y-4">
        <div><label htmlFor="field-siteIdentity-siteName" className="mb-1 block text-sm font-medium text-gray-700">Site Name</label>
          <input id="field-siteIdentity-siteName" value={section.siteName ?? ""} onChange={(e) => set("siteName", e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" /></div>
        <div><label htmlFor="field-siteIdentity-candidateDomain" className="mb-1 block text-sm font-medium text-gray-700">Candidate Domain</label>
          <input id="field-siteIdentity-candidateDomain" value={section.candidateDomain ?? ""} onChange={(e) => set("candidateDomain", e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="e.g. example.com" /></div>
        <div><label htmlFor="field-siteIdentity-language" className="mb-1 block text-sm font-medium text-gray-700">Language</label>
          <input id="field-siteIdentity-language" value={section.language ?? ""} onChange={(e) => set("language", e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="e.g. en" /></div>
        <div><label htmlFor="field-siteIdentity-locale" className="mb-1 block text-sm font-medium text-gray-700">Locale</label>
          <input id="field-siteIdentity-locale" value={section.locale ?? ""} onChange={(e) => set("locale", e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="e.g. en-US" /></div>
      </div>);
    case "Conversion":
      return (<div className="space-y-4">
        {textField("Primary Objective", "primaryObjective")}
        {textField("CTA Type", "ctaType")}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">CTA Destination</label>
          <input value={section.ctaDestination?.value ?? ""} onChange={(e) => set("ctaDestination", { ...section.ctaDestination, kind: section.ctaDestination?.kind ?? "url", value: e.target.value })} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Verification State</label>
          <select value={section.verificationState ?? "UNKNOWN"} onChange={(e) => set("verificationState", e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm">
            <option>VERIFIED</option><option>UNVERIFIED</option><option>UNKNOWN</option><option>DEFERRED</option>
          </select>
        </div>
      </div>);
    case "Evidence & Claims":
      return (<div className="space-y-4">
        {listField("Operator Facts", "operatorFacts")}
        {listField("Evidence Notes", "evidenceNotes")}
        {listField("Allowed Claims", "allowedClaims")}
        {listField("Prohibited Claims", "prohibitedClaims")}
        {listField("Unknown / Unverified Claims", "unknownClaims")}
      </div>);
    case "Search Seeds":
      return (<div className="space-y-4">
        {listField("Topics", "topics")}
        {listField("Seed Queries", "queries")}
        {listField("Market / Topic Hints", "marketHints")}
      </div>);
    case "Competitors":
      return (<div className="space-y-4">
        {listField("Known Competitors (one name per line)", "competitors")}
      </div>);
    case "Brand":
      return (<div className="space-y-4">
        {listField("Brand Facts", "facts")}
        {textField("Positioning", "positioning")}
        {textField("Tone", "tone")}
        {textField("Visual Identity Notes", "visualIdentityNotes")}
      </div>);
    case "References":
      return (<div className="space-y-4">
        {listField("Reference URLs (learn from)", "referenceUrls")}
        {listField("Anti-Reference URLs (avoid)", "antiReferenceUrls")}
        {listField("Learn Notes", "learn")}
        {listField("Avoid Notes", "avoid")}
        {textField("Preferred Perception", "preferredPerception")}
      </div>);
    case "Assets":
      return (<div className="space-y-4">
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={section.hasLogo ?? false} onChange={(e) => set("hasLogo", e.target.checked)} /> Has logo</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={section.hasAuthenticPhotography ?? false} onChange={(e) => set("hasAuthenticPhotography", e.target.checked)} /> Authentic photography</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={section.hasLocalFirstPartyPhotography ?? false} onChange={(e) => set("hasLocalFirstPartyPhotography", e.target.checked)} /> Local first-party photography</label>
        </div>
        {listField("Other Assets", "otherAssets")}
        {textField("Notes", "notes")}
      </div>);
    case "Constraints":
      return (<div className="space-y-4">
        {listField("Legal", "legal")}
        {listField("Editorial", "editorial")}
        {listField("Technical", "technical")}
        {listField("Regulatory", "regulatory")}
        {listField("Must Not (things the system must not claim/do)", "mustNot")}
      </div>);
    default:
      return null;
  }
}
