interface FieldProps {
  label: string;
  value: string | number | undefined | null;
}

export function Field({ label, value }: FieldProps) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="mt-1 whitespace-pre-line text-sm text-gray-800">{value || "—"}</dd>
    </div>
  );
}
