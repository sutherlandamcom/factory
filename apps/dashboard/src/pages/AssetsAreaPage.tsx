import { useState } from "react";
import { useParams } from "react-router-dom";
import { AssetsPage } from "./AssetsPage";
import { VisualAssetsPage } from "./VisualAssetsPage";

/**
 * Assets area (Run 11 §64): uploads/provenance/rights/assignments plus
 * visual slot resolution and accepted visual sets. Truthful provider
 * evidence is preserved from Runs 5/7 — never simplified into thumbnails.
 */
const SUBSECTIONS = ["Asset Library", "Visual Slots"] as const;

export function AssetsAreaPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const [subsection, setSubsection] = useState<(typeof SUBSECTIONS)[number]>("Asset Library");
  if (!projectId) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Assets subsections">
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
      {subsection === "Asset Library" && <AssetsPage projectId={projectId} />}
      {subsection === "Visual Slots" && <VisualAssetsPage projectId={projectId} />}
    </div>
  );
}
