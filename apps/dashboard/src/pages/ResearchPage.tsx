import { useParams } from "react-router-dom";
import { SearchPage } from "./SearchPage";
import { CompetitorsPage } from "./CompetitorsPage";
import { ContentGapsPage } from "./ContentGapsPage";
import { useState } from "react";

/**
 * Research workspace (Run 11 §61): composes the existing Search /
 * Competitors / Content Gaps capabilities into one area. These are UI
 * subsections, not new authority states — the underlying services remain
 * the Runs 2–3 authorities.
 */
const SUBSECTIONS = ["Search", "Competitors", "Content Gaps"] as const;

export function ResearchPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [subsection, setSubsection] = useState<(typeof SUBSECTIONS)[number]>("Search");
  if (!projectId) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Research subsections">
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
      {subsection === "Search" && <SearchPage projectId={projectId} />}
      {subsection === "Competitors" && <CompetitorsPage projectId={projectId} />}
      {subsection === "Content Gaps" && <ContentGapsPage projectId={projectId} />}
    </div>
  );
}
