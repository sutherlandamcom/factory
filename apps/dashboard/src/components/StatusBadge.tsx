const COLORS: Record<string, string> = {
  DRAFT: "bg-gray-200 text-gray-700",
  READY: "bg-green-100 text-green-800",
  APPROVED: "bg-blue-100 text-blue-800",
  CHANGED: "bg-amber-100 text-amber-800",
  BLOCKED: "bg-red-100 text-red-700",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${COLORS[status] ?? "bg-gray-200 text-gray-700"}`}
    >
      {status}
    </span>
  );
}
