const COLORS: Record<string, string> = {
  // Workflow states
  NOT_STARTED: "bg-gray-200 text-gray-700",
  READY: "bg-green-100 text-green-800",
  IN_PROGRESS: "bg-blue-100 text-blue-800",
  REVIEW_REQUIRED: "bg-amber-100 text-amber-800",
  ACCEPTED: "bg-green-100 text-green-800",
  STALE: "bg-amber-100 text-amber-800",
  BLOCKED: "bg-red-100 text-red-700",
  NOT_APPLICABLE: "bg-gray-100 text-gray-500",
  // Overall project states
  READY_FOR_DEPLOYMENT: "bg-green-600 text-white",
  // Authority relations
  CURRENT: "bg-green-100 text-green-800",
  HISTORICAL: "bg-gray-200 text-gray-600",
  // Verdicts
  PASS: "bg-green-100 text-green-800",
  REVIEW: "bg-amber-100 text-amber-800",
  FAIL: "bg-red-100 text-red-700",
  // Intake workspace statuses (legacy-compatible vocabulary)
  DRAFT: "bg-gray-200 text-gray-700",
  APPROVED: "bg-blue-100 text-blue-800",
  CHANGED: "bg-amber-100 text-amber-800",
};

/**
 * Text-first status badge (Run 11 §50): every state is carried by its text;
 * color only reinforces it. Never color-only. Renders the state verbatim
 * (APPROVED stays APPROVED, READY_FOR_DEPLOYMENT stays spaced uppercase).
 */
export function WorkflowStateBadge({ state, title }: { state: string; title?: string }) {
  const text =
    state === "READY_FOR_DEPLOYMENT" ? "READY FOR DEPLOYMENT" : state.replace(/_/g, " ");
  return (
    <span
      title={title}
      className={`inline-block rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${COLORS[state] ?? "bg-gray-200 text-gray-700"}`}
    >
      {text}
    </span>
  );
}
