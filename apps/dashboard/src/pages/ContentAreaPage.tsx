import { useState } from "react";
import { useParams } from "react-router-dom";
import { ContentPage } from "./ContentPage";
import { DerivativesPage } from "./DerivativesPage";

/**
 * Content area (Run 11 §62–63): the coherent writer pipeline progression
 * (Brief → Prompt → Prompt Approval → Proposal → QA → Accepted Content) is
 * rendered by the existing ContentPage authority surface; derivatives are a
 * subordinate page-level capability, never another global workflow truth.
 */
const SUBSECTIONS = ["Pipeline", "Derivatives"] as const;

export function ContentAreaPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [subsection, setSubsection] = useState<(typeof SUBSECTIONS)[number]>("Pipeline");
  if (!projectId) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Content subsections">
        {SUBSECTIONS.map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={subsection === s}
            onClick={() => setSubsection(s)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              subsection === s ? "bg-indigo-600 text-white" : "bg-white border text-gray-700 hover:bg-gray-50"
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      {subsection === "Pipeline" && <ContentPage projectId={projectId} />}
      {subsection === "Derivatives" && <DerivativesPage projectId={projectId} />}
    </div>
  );
}
