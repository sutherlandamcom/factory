import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { api, OperatorApiError } from "../api/client";
import type { ProjectOperatorWorkspace } from "../api/client";
import { queryKeys } from "../query/keys";
import { Section } from "../components/Section";
import { WorkflowStateBadge } from "../components/WorkflowStateBadge";
import type { ProjectIntakePayload } from "@factory/contracts";

/**
 * Intake (Run 11 §57–60): structured draft editing with React Hook Form.
 *
 * Authority rules preserved:
 * - form values are DRAFT UI state, never authority (§104);
 * - save sends baseRevision; accept sends expectedRevision/expectedDigest;
 * - a stale server revision never silently overwrites local edits;
 * - reset() happens ONLY on explicit authority transitions: project change,
 *   initial load, successful Save Draft, or an explicit operator reload.
 *   Background TanStack refetches NEVER clobber dirty fields (§56).
 */

type IntakeForm = ProjectIntakePayload;

const SECTION_TABS = [
  "Business",
  "Offering",
  "Audience",
  "Markets",
  "Site Identity",
  "Conversion",
  "Evidence & Claims",
  "Search Seeds",
  "Competitor Seeds",
  "Brand",
  "References",
  "Assets",
  "Constraints",
  "Content Constitution",
  "Review",
] as const;

export function IntakePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const workspaceQuery = useQuery({
    queryKey: queryKeys.workspace(projectId ?? ""),
    queryFn: () => api.getWorkspace(projectId!),
    enabled: Boolean(projectId),
    // Intake drafts change only through operator actions; no polling.
    staleTime: 30_000,
  });

  const [activeSection, setActiveSection] = useState<(typeof SECTION_TABS)[number]>("Business");
  const [serverError, setServerError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [lastSavedRevision, setLastSavedRevision] = useState<number | null>(null);

  const workspace: ProjectOperatorWorkspace | undefined = workspaceQuery.data;
  const serverPayload = workspace?.currentDraft.payload ?? null;
  const serverRevision = workspace?.currentDraft.revision ?? 0;
  const serverDigest = workspace?.currentDraft.digest ?? null;

  const defaultValues = useMemo(() => serverPayload as IntakeForm | undefined, [serverPayload]);

  const form = useForm<IntakeForm>({
    values: undefined, // never bind server values reactively (§59: no reset on refetch)
    defaultValues: defaultValues as IntakeForm,
  });

  // Adopt server values ONLY on explicit authority transitions.
  const adoptedRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (!defaultValues) return;
    const isFirstAdoption = adoptedRevisionRef.current === null;
    const isNewProjectLoad = adoptedRevisionRef.current !== null && adoptedRevisionRef.current !== serverRevision && form.formState.isSubmitSuccessful === false && !form.formState.isDirty;
    if (isFirstAdoption || isNewProjectLoad) {
      form.reset(defaultValues);
      adoptedRevisionRef.current = serverRevision;
      setLastSavedRevision(serverRevision);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValues, serverRevision, projectId]);

  const saveMutation = useMutation({
    mutationFn: (input: { payload: IntakeForm; baseRevision: number }) =>
      api.saveDraft(projectId!, { baseRevision: input.baseRevision, payload: input.payload }),
    onSuccess: async (result) => {
      setServerError(null);
      setConflict(null);
      setLastSavedRevision(result.revision);
      form.reset(form.getValues(), { keepValues: true, keepDirty: false, keepDirtyValues: false });
      adoptedRevisionRef.current = result.revision;
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspace(projectId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.workflow(projectId!) });
    },
    onError: (err) => {
      if (err instanceof OperatorApiError && err.code === "intake_stale_revision") {
        setConflict("The draft changed elsewhere while you were editing. Your edits were kept — reload the latest server draft to merge.");
      } else {
        setServerError(operatorMessage(err, "Save failed."));
      }
    },
  });

  const acceptMutation = useMutation({
    mutationFn: (input: { expectedRevision: number; expectedDigest: string }) =>
      api.accept(projectId!, input),
    onSuccess: async () => {
      setServerError(null);
      setConflict(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.workspace(projectId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.workflow(projectId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.versions(projectId!) });
    },
    onError: (err) => {
      if (err instanceof OperatorApiError) {
        if (err.code === "intake_blocked") {
          setServerError("Acceptance blocked: resolve the listed blockers first.");
        } else if (err.code === "intake_revision_mismatch" || err.code === "intake_digest_mismatch") {
          setConflict("Inputs changed since review — re-check the draft and accept again. Your local edits were kept.");
        } else {
          setServerError(err.message);
        }
      } else {
        setServerError(operatorMessage(err, "Accept failed."));
      }
    },
  });

  if (!projectId) return null;
  if (workspaceQuery.isLoading || !workspace) {
    return <p className="text-gray-500">Loading…</p>;
  }

  const blocked = workspace.readiness.blockers.length > 0;
  const dirty = form.formState.isDirty;

  const reloadServerDraft = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspace(projectId) });
    form.reset((workspaceQuery.data!.currentDraft.payload ?? undefined) as IntakeForm | undefined);
    adoptedRevisionRef.current = workspaceQuery.data!.currentDraft.revision;
    setConflict(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <WorkflowStateBadge state={workspace.status} />
        <span className="text-sm text-gray-500">
          Accepted: {workspace.currentAcceptedSnapshot ? `v${workspace.currentAcceptedSnapshot.version}` : "—"} · Draft r
          {workspace.currentDraft.revision}
          {dirty && <span className="ml-2 font-semibold text-amber-600">UNSAVED EDITS</span>}
        </span>
        <button
          onClick={() => navigate(`/projects/${projectId}/intake`)}
          className="text-sm text-gray-400"
          aria-hidden
          tabIndex={-1}
        />
      </div>

      {conflict && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800" role="alert">
          {conflict}
          <button
            onClick={reloadServerDraft}
            className="ml-3 rounded-md bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700"
          >
            Reload latest server draft
          </button>
        </div>
      )}
      {serverError && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700" role="alert">
          {serverError}
        </div>
      )}

      {/* Section navigation (UI-only subsections of one Intake authority area). */}
      <div className="flex flex-wrap gap-2">
        {SECTION_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveSection(tab)}
            aria-current={activeSection === tab ? "true" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              activeSection === tab ? "bg-indigo-600 text-white" : "bg-white border text-gray-700 hover:bg-gray-50"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <form onSubmit={form.handleSubmit((values) => saveMutation.mutateAsync({ payload: values, baseRevision: serverRevision }))}>
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          {activeSection === "Review" ? (
            <ReviewSection payload={form.getValues()} blockers={workspace.readiness.blockers} />
          ) : (
            <SectionForm section={activeSection} form={form} />
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saveMutation.isPending || !dirty}
            className="rounded-md bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50"
          >
            {saveMutation.isPending ? "Saving…" : "Save Draft"}
          </button>
          <button
            type="button"
            disabled={acceptMutation.isPending || blocked || !serverDigest}
            onClick={() =>
              acceptMutation.mutate({
                expectedRevision: serverRevision,
                expectedDigest: serverDigest!,
              })
            }
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
            title={blocked ? "Resolve blockers before accepting" : "Create an immutable accepted snapshot of the current draft"}
          >
            {acceptMutation.isPending ? "Accepting…" : "ACCEPT INPUTS"}
          </button>
          {blocked && (
            <div className="text-sm text-red-600">
              Blockers: {workspace.readiness.blockers.map((b) => b.code).join(", ")}
            </div>
          )}
          {lastSavedRevision != null && !dirty && (
            <span className="text-xs text-gray-400">saved r{lastSavedRevision}</span>
          )}
        </div>
      </form>
    </div>
  );
}

function operatorMessage(err: unknown, fallback: string): string {
  if (err instanceof OperatorApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

function ReviewSection({
  payload,
  blockers,
}: {
  payload: IntakeForm;
  blockers: Array<{ code: string; message: string }>;
}) {
  const p = payload as IntakeForm;
  return (
    <div className="space-y-4">
      <Section title="Business">
        <ReviewRow label="Name" value={p.business?.name} />
        <ReviewRow label="Description" value={p.business?.description} />
      </Section>
      <Section title="Audience">
        <ReviewRow label="Segments" value={(p.audience?.segments ?? []).join(", ")} />
      </Section>
      <Section title="Site Identity">
        <ReviewRow label="Site Name" value={p.siteIdentity?.siteName} />
        <ReviewRow label="Language" value={p.siteIdentity?.language} />
      </Section>
      <Section title="Conversion">
        <ReviewRow label="CTA" value={typeof p.conversion?.ctaDestination === "string" ? p.conversion.ctaDestination : ""} />
      </Section>
      <Section title="Content Constitution">
        <ReviewRow label="Custom Writer Instructions" value={p.contentConstitution?.customWriterInstructions} />
      </Section>
      {blockers.length > 0 && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          Cannot accept: {blockers.map((b) => b.message).join("; ")}
        </div>
      )}
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className="col-span-2 text-gray-900">{value || "—"}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section forms (React Hook Form bindings; no `form: any`)
// ---------------------------------------------------------------------------

import { Field } from "../components/Field";
type SectionFormProps = {
  section: (typeof SECTION_TABS)[number];
  form: ReturnType<typeof useForm<IntakeForm>>;
};

function SectionForm({ section, form }: SectionFormProps) {
  const { register } = form;
  const err = (path: string) => {
    const parts = path.split(".");
    let cur: unknown = form.formState.errors;
    for (const part of parts) {
      cur = (cur as Record<string, unknown>)?.[part];
    }
    return (cur as { message?: string } | undefined)?.message;
  };

  switch (section) {
    case "Business":
      return (
        <div className="space-y-4">
          <Field label="Business Name *" htmlFor="field-business-name" error={err("business.name")}>
            <input id="field-business-name" {...register("business.name", { required: "Business name is required." })} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Description *" htmlFor="field-business-description" error={err("business.description")}>
            <textarea id="field-business-description" rows={3} {...register("business.description", { required: "Description is required." })} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Business Model" htmlFor="field-business-model">
            <textarea id="field-business-model" rows={2} {...register("business.businessModel")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Positioning" htmlFor="field-business-positioning">
            <textarea id="field-business-positioning" rows={2} {...register("business.positioning")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <ListField form={form} section="business" field="offerings" label="Offerings / Services" />
          <ListField form={form} section="business" field="priorities" label="Priorities" />
        </div>
      );
    case "Offering":
      return (
        <div className="space-y-4">
          <ListField form={form} section="business" field="offerings" label="Offerings / Services" />
          <ListField form={form} section="business" field="priorities" label="Priorities" />
        </div>
      );
    case "Audience":
      return (
        <div className="space-y-4">
          <ListField form={form} section="audience" field="segments" label="Segments" />
          <ListField form={form} section="audience" field="needs" label="Needs" />
          <Field label="Decision Context" htmlFor="field-audience-decisionContext">
            <textarea id="field-audience-decisionContext" rows={2} {...register("audience.decisionContext")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
        </div>
      );
    case "Markets":
      return (
        <div className="space-y-4">
          <ListField form={form} section="markets" field="geographies" label="Geographies" />
          <ListField form={form} section="markets" field="priorityLocations" label="Priority Locations" />
        </div>
      );
    case "Site Identity":
      return (
        <div className="space-y-4">
          <Field label="Site Name" htmlFor="field-siteIdentity-siteName">
            <input id="field-siteIdentity-siteName" {...register("siteIdentity.siteName")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Candidate Domain" htmlFor="field-siteIdentity-candidateDomain">
            <input id="field-siteIdentity-candidateDomain" placeholder="e.g. example.com" {...register("siteIdentity.candidateDomain")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Language" htmlFor="field-siteIdentity-language">
            <input id="field-siteIdentity-language" placeholder="e.g. en" {...register("siteIdentity.language")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Locale" htmlFor="field-siteIdentity-locale">
            <input id="field-siteIdentity-locale" placeholder="e.g. en-US" {...register("siteIdentity.locale")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
        </div>
      );
    case "Conversion":
      return (
        <div className="space-y-4">
          <Field label="Primary Objective" htmlFor="field-conversion-primaryObjective">
            <textarea id="field-conversion-primaryObjective" rows={2} {...register("conversion.primaryObjective")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="CTA Type" htmlFor="field-conversion-ctaType">
            <input id="field-conversion-ctaType" {...register("conversion.ctaType")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="CTA Destination" htmlFor="field-conversion-ctaDestination">
            <input id="field-conversion-ctaDestination" {...register("conversion.ctaDestination")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Destination Type" htmlFor="field-conversion-ctaDestinationType">
            <select id="field-conversion-ctaDestinationType" {...register("conversion.ctaDestinationType")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm">
              <option value="phone">phone</option>
              <option value="email">email</option>
              <option value="url">url</option>
              <option value="form">form</option>
              <option value="in_person">in_person</option>
              <option value="other">other</option>
            </select>
          </Field>
          <Field label="Verification State" htmlFor="field-conversion-verificationState">
            <select id="field-conversion-verificationState" {...register("conversion.verificationState")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm">
              <option>VERIFIED</option>
              <option>UNVERIFIED</option>
              <option>UNKNOWN</option>
              <option>DEFERRED</option>
            </select>
          </Field>
        </div>
      );
    case "Evidence & Claims":
      return (
        <div className="space-y-4">
          <ListField form={form} section="evidence" field="operatorFacts" label="Operator Facts" />
          <ListField form={form} section="evidence" field="evidenceNotes" label="Evidence Notes" />
          <ListField form={form} section="evidence" field="allowedClaims" label="Allowed Claims" />
          <ListField form={form} section="evidence" field="prohibitedClaims" label="Prohibited Claims" />
          <ListField form={form} section="evidence" field="unknownClaims" label="Unknown / Unverified Claims" />
        </div>
      );
    case "Search Seeds":
      return (
        <div className="space-y-4">
          <ListField form={form} section="searchSeeds" field="topics" label="Topics" />
          <ListField form={form} section="searchSeeds" field="queries" label="Seed Queries" />
          <ListField form={form} section="searchSeeds" field="marketHints" label="Market / Topic Hints" />
        </div>
      );
    case "Competitor Seeds":
      return <ListField form={form} section="searchSeeds" field="competitors" label="Known Competitors" />;
    case "Brand":
      return (
        <div className="space-y-4">
          <ListField form={form} section="brand" field="facts" label="Brand Facts" />
          <Field label="Positioning" htmlFor="field-brand-positioning">
            <textarea id="field-brand-positioning" rows={2} {...register("brand.positioning")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Tone" htmlFor="field-brand-tone">
            <textarea id="field-brand-tone" rows={2} {...register("brand.tone")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Visual Identity Notes" htmlFor="field-brand-visualIdentityNotes">
            <textarea id="field-brand-visualIdentityNotes" rows={2} {...register("brand.visualIdentityNotes")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
        </div>
      );
    case "References":
      return (
        <div className="space-y-4">
          <ListField form={form} section="designReferences" field="referenceUrls" label="Reference URLs (learn from)" />
          <ListField form={form} section="designReferences" field="antiReferenceUrls" label="Anti-Reference URLs (avoid)" />
          <ListField form={form} section="designReferences" field="learn" label="Learn Notes" />
          <ListField form={form} section="designReferences" field="avoid" label="Avoid Notes" />
          <Field label="Preferred Perception" htmlFor="field-designReferences-preferredPerception">
            <input id="field-designReferences-preferredPerception" {...register("designReferences.preferredPerception")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
        </div>
      );
    case "Assets":
      return (
        <div className="space-y-4">
          <label htmlFor="field-assets-hasLogo" className="flex items-center gap-2 text-sm">
            <input id="field-assets-hasLogo" type="checkbox" {...register("assetAvailability.hasLogo")} /> Has logo
          </label>
          <label htmlFor="field-assets-hasAuthenticPhotography" className="flex items-center gap-2 text-sm">
            <input id="field-assets-hasAuthenticPhotography" type="checkbox" {...register("assetAvailability.hasAuthenticPhotography")} /> Authentic photography
          </label>
          <label htmlFor="field-assets-hasLocalFirstPartyPhotography" className="flex items-center gap-2 text-sm">
            <input id="field-assets-hasLocalFirstPartyPhotography" type="checkbox" {...register("assetAvailability.hasLocalFirstPartyPhotography")} /> Local first-party photography
          </label>
          <ListField form={form} section="assetAvailability" field="otherAssets" label="Other Assets" />
          <Field label="Notes" htmlFor="field-assetAvailability-notes">
            <textarea id="field-assetAvailability-notes" rows={2} {...register("assetAvailability.notes")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
        </div>
      );
    case "Constraints":
      return (
        <div className="space-y-4">
          <ListField form={form} section="constraints" field="legal" label="Legal" />
          <ListField form={form} section="constraints" field="editorial" label="Editorial" />
          <ListField form={form} section="constraints" field="technical" label="Technical" />
          <ListField form={form} section="constraints" field="regulatory" label="Regulatory" />
          <ListField form={form} section="constraints" field="mustNot" label="Must Not (things the system must not claim/do)" />
        </div>
      );
    case "Content Constitution":
      return (
        <div className="space-y-4">
          <Field label="Brand Voice" htmlFor="field-contentConstitution-brandVoice">
            <textarea id="field-contentConstitution-brandVoice" rows={2} {...register("contentConstitution.brandVoice")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Tone" htmlFor="field-contentConstitution-tone">
            <textarea id="field-contentConstitution-tone" rows={2} {...register("contentConstitution.tone")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <ListField form={form} section="contentConstitution" field="audiencePrinciples" label="Audience Communication Principles" />
          <ListField form={form} section="contentConstitution" field="writingPrinciples" label="Writing Principles" />
          <ListField form={form} section="contentConstitution" field="preferredTerminology" label="Preferred Terminology" />
          <ListField form={form} section="contentConstitution" field="forbiddenTerminology" label="Forbidden Terminology" />
          <Field label="Evidence / Factuality Policy" htmlFor="field-contentConstitution-evidencePolicy">
            <textarea id="field-contentConstitution-evidencePolicy" rows={2} {...register("contentConstitution.evidencePolicy")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <ListField form={form} section="contentConstitution" field="peopleFirstPrinciples" label="People-First Principles" />
          <Field label="Trust Expectations" htmlFor="field-contentConstitution-trustExpectations">
            <textarea id="field-contentConstitution-trustExpectations" rows={2} {...register("contentConstitution.trustExpectations")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <ListField form={form} section="contentConstitution" field="aiLanguageAvoidance" label="AI-Language to Avoid" />
          <ListField form={form} section="contentConstitution" field="clicheAvoidance" label="Marketing Clichés to Avoid" />
          <Field label="Locale / Language Preferences" htmlFor="field-contentConstitution-localePreferences">
            <input id="field-contentConstitution-localePreferences" {...register("contentConstitution.localePreferences")} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
          </Field>
          <Field label="Custom Project Writer Instructions *" htmlFor="field-contentConstitution-customWriterInstructions">
            <textarea
              id="field-contentConstitution-customWriterInstructions"
              rows={8}
              {...register("contentConstitution.customWriterInstructions")}
              className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
              placeholder="Free-form instructions that apply to all content written for this project…"
            />
          </Field>
        </div>
      );
    default:
      return null;
  }
}

/** List field: newline-separated textarea bound to a string[] RHF path. */
function ListField({
  form,
  section,
  field,
  label,
}: {
  form: SectionFormProps["form"];
  section: string;
  field: string;
  label: string;
}) {
  const { register, watch, setValue } = form;
  const name = `${section}.${field}` as never;
  const value = watch(name) as string[] | undefined;
  const id = `field-${section}-${field}`;
  return (
    <Field label={`${label} (one per line)`} htmlFor={id}>
      <textarea
        id={id}
        rows={3}
        value={(Array.isArray(value) ? value : []).join("\n")}
        onChange={(e) =>
          setValue(
            name,
            e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) as never,
            { shouldDirty: true },
          )
        }
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
      />
      {/* register keeps the field registered for dirty tracking */}
      <input type="hidden" {...register(name)} />
    </Field>
  );
}
